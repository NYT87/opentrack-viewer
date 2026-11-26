import { describe, expect, it } from 'vitest';
import { NoTelemetryTrackError, extractGpmf, type ReadableVideo } from './extractGpmf';
import { formatStartTimecode } from '../../overlay/timecode';
import { readBinaryFixture } from '../../test/helpers/fixtures';
import { virtualVideo } from '../../test/helpers/virtualVideo';
import { ActivityError } from '../../domain/errors';
import { detectFormat } from '../detectFormat';
import { box, concat, splitDevcChunks } from '../../test/helpers/goproMp4.mjs';

/** A real GoPro HERO8 clip, ~4.2 MB, © GoPro under Apache-2.0 or MIT. */
const heroVideo = (name = 'GH010042.mp4') =>
  new File([readBinaryFixture('hero8.mp4')], name, { type: 'video/mp4' });

/** The HERO7 payload inside a generated container: a video with a real fix. */
const syntheticVideo = () =>
  new File([readBinaryFixture('hero7-synthetic.mp4')], 'GH010007.MP4', { type: 'video/mp4' });

const hero7Payload = () => new Uint8Array(readBinaryFixture('hero7.raw'));

describe('extracting GPMF from a real GoPro video (AV-903)', () => {
  it('finds the metadata track and returns its payload with timing', async () => {
    const payload = await extractGpmf(heroVideo());

    // The payload is a fraction of the video: 86 KB out of 4.2 MB. That ratio
    // is the whole reason this can run on a multi-gigabyte file.
    expect(payload.rawData).toBeInstanceOf(Uint8Array);
    expect(payload.rawData.length).toBeGreaterThan(10_000);
    expect(payload.rawData.length).toBeLessThan(readBinaryFixture('hero8.mp4').byteLength / 10);

    expect(payload.timing.videoDurationSeconds).toBeCloseTo(12.6, 0);
    expect(payload.timing.frameIntervalSeconds).toBeGreaterThan(0);
    expect(payload.timing.samples.length).toBeGreaterThan(1);
    // The container's own creation time, not shifted by this machine's zone.
    expect(payload.timing.start?.toISOString()).toBe('2019-11-18T15:41:25.000Z');
  });

  it('reports timing per sample, in order, from the first frame', async () => {
    const { timing } = await extractGpmf(heroVideo());

    const times = timing.samples.map((sample) => sample.cts);
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(timing.samples.every((sample) => sample.duration > 0)).toBe(true);
    // Milliseconds: GoPro writes one sample a second, at a 1000 timescale.
    expect(timing.samples[1]?.cts).toBeCloseTo(1001, 0);
  });

  it('reports progress as it reads', async () => {
    const seen: number[] = [];
    await extractGpmf(heroVideo(), { onProgress: (fraction) => seen.push(fraction) });

    expect(seen.length).toBeGreaterThan(0);
    // Fractions, never going backwards, and ending complete.
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('reads the same payload whatever the file is called', async () => {
    // Nothing about the extraction depends on the name, which is one of the
    // things §5 says never leaves the device.
    const [named, renamed] = await Promise.all([
      extractGpmf(heroVideo('GH010042.mp4')),
      extractGpmf(heroVideo('holiday clip.MOV')),
    ]);

    expect(named.rawData.length).toBe(renamed.rawData.length);
  });
});

describe('a generated container around a real payload (AV-906)', () => {
  it('is detected as a GoPro video', async () => {
    expect(await detectFormat(syntheticVideo())).toEqual({ format: 'gopro', via: 'signature' });
  });

  it('returns the payload byte for byte, in its samples', async () => {
    const payload = await extractGpmf(syntheticVideo());

    // Nothing about the container changes the payload: what went in comes out.
    expect(payload.rawData).toEqual(hero7Payload());
    expect(payload.timing.samples).toHaveLength(17);
    expect(payload.timing.samples[0]).toEqual({ cts: 0, duration: 1001 });
    expect(payload.timing.videoDurationSeconds).toBeCloseTo(17.017, 3);
    expect(payload.timing.start?.toISOString()).toBe('2024-06-01T10:00:00.000Z');
  });

  it('includes samples from a fragment after the movie index', async () => {
    const sample = splitDevcChunks(hero7Payload())[0]!;
    const number = (value: number) => {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value);
      return bytes;
    };
    const fragment = (dataOffset: number) =>
      box(
        'moof',
        box('mfhd', number(0), number(1)),
        box(
          'traf',
          box('tfhd', new Uint8Array([0, 2, 0, 0]), number(1)),
          box('tfdt', number(0), number(17 * 1001)),
          box(
            'trun',
            new Uint8Array([0, 0, 3, 1]),
            number(1),
            number(dataOffset),
            number(1001),
            number(sample.length),
          ),
        ),
        box(
          'traf',
          box('tfhd', new Uint8Array([0, 2, 0, 0]), number(2)),
          box('tfdt', number(0), number(17 * 30030)),
          box(
            'trun',
            new Uint8Array([0, 0, 3, 1]),
            number(1),
            number(dataOffset + sample.length),
            number(30030),
            number(0),
          ),
        ),
      );
    const moof = fragment(fragment(0).length + 8);
    const video = new File(
      [
        readBinaryFixture('hero7-synthetic.mp4'),
        Uint8Array.from(moof),
        Uint8Array.from(box('mdat', sample)),
      ],
      'fragmented.mp4',
    );

    const payload = await extractGpmf(video);

    expect(payload.rawData).toEqual(concat([hero7Payload(), sample]));
    expect(payload.timing.samples).toHaveLength(18);
    expect(payload.timing.videoDurationSeconds).toBeCloseTo(18.018, 3);
    expect(payload.timing.frameIntervalSeconds).toBeCloseTo(18.018 / 511, 6);
  });
});

describe('a large video costs what its telemetry costs, not what it weighs (AV-906)', () => {
  // Eight gigabytes: past the 4 GB a 32-bit box size can state, so the `mdat`
  // takes the 64-bit form a long recording actually uses. The picture is
  // generated for the ranges read, and nothing else exists.
  const EIGHT_GB = 8 * 1024 ** 3;

  // A quarter-megabyte of picture between samples, so each is its own read.
  const GAP = 256 * 1024;
  const SAMPLE_COUNT = 17;

  it('reads kilobytes of an eight-gigabyte recording', async () => {
    const video = virtualVideo({
      payload: hero7Payload(),
      fillerBytes: EIGHT_GB,
      gapBytes: GAP,
      videoFrames: 510,
    });
    expect(video.size).toBeGreaterThan(2 ** 32);

    const before = process.memoryUsage().arrayBuffers;
    const started = performance.now();
    const payload = await extractGpmf(video);
    const elapsed = performance.now() - started;
    const after = process.memoryUsage().arrayBuffers;

    expect(payload.rawData).toEqual(hero7Payload());

    // The headers, the moov, and the telemetry. Not the video.
    expect(video.bytesRead).toBeLessThan(200 * 1024);
    expect(video.bytesRead).toBeGreaterThanOrEqual(hero7Payload().length);
    // One read per sample, plus the few that found the index.
    expect(video.reads.length).toBeLessThan(SAMPLE_COUNT + 8);
    // The picture was never read: no range touches the filler or a gap.
    const touchesFiller = video.reads.some(
      (read) => read.start < video.filler.end && read.end > video.filler.start,
    );
    expect(touchesFiller).toBe(false);
    const sampleBytes = video.reads
      .filter((read) => read.start > 64 && read.end <= video.filler.start)
      .reduce((sum, read) => sum + (read.end - read.start), 0);
    expect(sampleBytes).toBe(hero7Payload().length);

    // Memory grew by the payload, give or take, when the previous extractor
    // grew by the file: two gigabytes measured for a two-gigabyte file (TD-038).
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('reports progress over the telemetry, from nothing to done', async () => {
    const video = virtualVideo({ payload: hero7Payload(), fillerBytes: EIGHT_GB, gapBytes: GAP });
    const seen: number[] = [];

    await extractGpmf(video, { onProgress: (fraction) => seen.push(fraction) });

    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('stops within one read of being told to', async () => {
    const video = virtualVideo({ payload: hero7Payload(), fillerBytes: EIGHT_GB, gapBytes: GAP });
    const controller = new AbortController();
    let readsAtAbort = 0;

    const error = await extractGpmf(video, {
      signal: controller.signal,
      onProgress: (fraction) => {
        if (fraction > 0 && !controller.signal.aborted) {
          controller.abort();
          readsAtAbort = video.reads.length;
        }
      },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toBe('extraction_cancelled');
    // The read in flight finishes; nothing further is asked for.
    expect(video.reads.length).toBe(readsAtAbort);
  });

  it('bounds contiguous reads and stops before the remaining payload', async () => {
    const video = virtualVideo({ payload: hero7Payload() });
    const controller = new AbortController();
    const error = await extractGpmf(video, {
      signal: controller.signal,
      onProgress: (fraction) => {
        if (fraction > 0) controller.abort();
      },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toBe('extraction_cancelled');
    // The moov is only a few kilobytes; no read may consume the whole run.
    expect(Math.max(...video.reads.map(({ start, end }) => end - start))).toBeLessThanOrEqual(32 * 1024);
    expect(video.bytesRead).toBeLessThan(hero7Payload().length);
  });
});

describe('extraction limits and failures (AV-903)', () => {
  it('says a file that is not a container is not one, instead of hanging', async () => {
    // The previous extractor neither resolved nor rejected here: it read to
    // the end and stopped. Walking box headers fails on the first one.
    const notAVideo = new File(['this is not a video'], 'lies.mp4');

    await expect(extractGpmf(notAVideo)).rejects.toMatchObject({
      code: 'gopro_extract_failed',
      message: expect.stringMatching(/not an MP4 or MOV container/i),
    });
  });

  it('fails typed on a container whose index it cannot read', async () => {
    // A shell of an MP4 whose `moov` is not a real one. Whatever the demuxer
    // makes of it, a caller sees an ActivityError.
    const plain = new File([readBinaryFixture('plain-video.mp4')], 'holiday.mp4');

    const error = await extractGpmf(plain).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toMatch(/gopro_extract_failed|no_telemetry_track/);
  });

  it('says a container with no index cannot be read at all', async () => {
    // `ftyp` and an `mdat`, and then nothing: a recording the camera never
    // finished writing. There is no `moov`, so there is nothing to look in.
    const header = new Uint8Array([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x31, 0, 0, 0, 0, // ftyp
      0, 0, 0, 16, 0x6d, 0x64, 0x61, 0x74, 1, 2, 3, 4, 5, 6, 7, 8, // mdat
    ]);

    await expect(extractGpmf(new File([header], 'cut.mp4'))).rejects.toMatchObject({
      code: 'no_video_index',
      message: expect.stringMatching(/no index/i),
    });
  });

  it('refuses before reading anything when already aborted, as a stop', async () => {
    const controller = new AbortController();
    controller.abort();
    const video = virtualVideo({ payload: hero7Payload() });

    // Typed, not a DOMException: a stop while the demuxer loads is a stop.
    await expect(extractGpmf(video, { signal: controller.signal })).rejects.toMatchObject({
      code: 'extraction_cancelled',
    });
    expect(video.reads).toEqual([]);
  });

  it('honours a stop that lands during the last read', async () => {
    const video = virtualVideo({ payload: hero7Payload(), gapBytes: 1024 });
    const controller = new AbortController();

    const error = await extractGpmf(video, {
      signal: controller.signal,
      // Progress reaches 1 only after the final read; there is nothing left
      // to check before, so the result itself has to be withheld.
      onProgress: (fraction) => {
        if (fraction === 1) controller.abort();
      },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toBe('extraction_cancelled');
  });

  it('refuses an index that points outside the file', async () => {
    // The synthetic clip, cut short after its moov is declared: the sample
    // table still points at bytes that are no longer there.
    const bytes = new Uint8Array(readBinaryFixture('hero7-synthetic.mp4'));
    const moovAt = bytes.length - 8 - findMoovSize(bytes);
    const truncated = new Uint8Array(bytes.length - 4096);
    truncated.set(bytes.subarray(0, moovAt - 4096), 0);
    truncated.set(bytes.subarray(moovAt), moovAt - 4096);

    const error = await extractGpmf(new File([truncated], 'short.mp4')).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toBe('gopro_extract_failed');
  });
});

describe('hand-built boxes it refuses (audit #48, #64)', () => {
  const ftyp = box('ftyp', new Uint8Array([0x6d, 0x70, 0x34, 0x31, 0, 0, 0, 0]));
  const header = (size: number, type: string, size64?: number) => {
    const bytes = new Uint8Array(size64 === undefined ? 8 : 16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, size);
    bytes.set([...type].map((char) => char.charCodeAt(0)), 4);
    if (size64 !== undefined) view.setBigUint64(8, BigInt(size64));
    return bytes;
  };
  /** A file of `size` bytes, zero but for `head` and `tail`: a huge box costs nothing. */
  const sparse = (head: Uint8Array, size = head.length, tail = new Uint8Array()): ReadableVideo => ({
    size,
    slice: (start, end) => ({
      arrayBuffer: async () => {
        const out = new Uint8Array(Math.max(0, Math.min(end, size) - start));
        out.set(head.subarray(start, Math.min(end, head.length)));
        const tailAt = size - tail.length;
        if (end > tailAt) out.set(tail.subarray(Math.max(0, start - tailAt), end - tailAt), Math.max(0, tailAt - start));
        return out.buffer;
      },
    }),
  });
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value);
    return bytes;
  };
  const refusal = (video: ReadableVideo) => extractGpmf(video).catch((thrown: unknown) => thrown);
  const synthetic = () => new Uint8Array(readBinaryFixture('hero7-synthetic.mp4'));

  it('refuses each malformed or implausible box as gopro_extract_failed', async () => {
    const MB = 1024 * 1024;
    // Every stsz entry in the synthetic clip made 768 MB: a payload past MAX_PAYLOAD_BYTES.
    const oversized = synthetic();
    const view = new DataView(oversized.buffer);
    for (let at = 0; at + 20 <= oversized.length; at += 1) {
      if (view.getUint32(at) !== 0x7374737a) continue;
      for (let entry = 0; entry < view.getUint32(at + 12); entry += 1) view.setUint32(at + 16 + entry * 4, 768 * MB);
    }
    const cases: [string, ReadableVideo, RegExp][] = [
      ['a moov past MAX_MOOV_BYTES', sparse(concat([ftyp, header(257 * MB, 'moov')]), 16 + 257 * MB), /index .+ implausibly large/],
      [
        'a free box past MAX_OTHER_BOX_BYTES',
        sparse(concat([ftyp, header(17 * MB, 'free')]), 16 + 17 * MB + 8, header(8, 'moov')),
        /holds an implausibly large box/,
      ],
      ['more boxes than MAX_TOP_LEVEL_BOXES', sparse(concat([ftyp, ...Array.from({ length: 4096 }, () => header(8, 'free'))])), /not an MP4/],
      ['a box smaller than its header', sparse(concat([ftyp, header(4, 'free')])), /not an MP4/],
      ['a size-1 header cut short', sparse(concat([ftyp, header(1, 'mdat'), new Uint8Array(4)])), /not an MP4/],
      ['a payload past MAX_PAYLOAD_BYTES', sparse(oversized), /telemetry track .+ implausibly large/],
      [
        // #48: mp4box would build one object per claimed sample, synchronously.
        'an stsz claiming more samples than MAX_TRACK_SAMPLES',
        sparse(concat([ftyp, box('moov', box('stsz', u32(0), u32(1), u32(20_000_000)))])),
        /implausible number of samples/,
      ],
    ];

    for (const [name, video, message] of cases) {
      expect(await refusal(video), name).toMatchObject({ code: 'gopro_extract_failed', message: expect.stringMatching(message) });
    }
  });
});

describe('the timecode read in the same pass (AV-1026)', () => {
  const generated = (options: Partial<Parameters<typeof virtualVideo>[0]> = {}) =>
    virtualVideo({ payload: hero7Payload(), videoFrames: 510, ...options });

  it('reads the real HERO8 clip’s timecode track: its counter, its rate, non-drop', async () => {
    const { timing } = await extractGpmf(heroVideo());
    expect(timing.timecode).toMatchObject({
      source: 'timecode-track',
      rate: { numerator: 30000, denominator: 1001 },
      timebase: 30,
      dropFrame: false,
    });
    // The clip's counter at its first frame, 1,692,868, is 15:40:28 and 28 frames at 30 to the second
    // (the sample entry states 29 frames a second for its 29.97; the label counts to 30).
    expect(timing.timecode!.startFrame).toBe(1_692_868);
    expect(formatStartTimecode(timing.timecode!)).toBe('15:40:28:28');
  });

  it('reads a drop-frame track at 29.97 as the file states it', async () => {
    const { timing } = await extractGpmf(
      generated({
        timecode: { counter: 1800, timescale: 30000, frameDuration: 1001, framesPerSecond: 30, flags: 0x1 },
      }),
    );
    expect(timing.timecode).toMatchObject({
      startFrame: 1800,
      dropFrame: true,
      source: 'timecode-track',
      rate: { numerator: 30000, denominator: 1001 },
    });
    expect(formatStartTimecode(timing.timecode!)).toBe('00:01:00;02');
  });

  it('reads a drop-frame track at 59.94 from a 90000 timescale, as the HERO8 writes it', async () => {
    const { timing } = await extractGpmf(
      generated({
        timecode: { counter: 3600, timescale: 60000, frameDuration: 1001, framesPerSecond: 59, flags: 0x3 },
      }),
    );
    expect(timing.timecode).toMatchObject({ dropFrame: true, timebase: 60 });
    expect(formatStartTimecode(timing.timecode!)).toBe('00:01:00;04');
  });

  it('reads a non-drop track at 25 fps', async () => {
    const { timing } = await extractGpmf(
      generated({
        timecode: { counter: 25 * 3723 + 7, timescale: 25_000, frameDuration: 1000, framesPerSecond: 25 },
      }),
    );
    expect(timing.timecode).toMatchObject({ dropFrame: false, rate: { numerator: 25, denominator: 1 } });
    expect(formatStartTimecode(timing.timecode!)).toBe('01:02:03:07');
  });

  it('treats a drop-frame flag at 25 fps as non-drop, and notes it', async () => {
    const { timing } = await extractGpmf(
      generated({ timecode: { counter: 0, timescale: 25_000, frameDuration: 1000, framesPerSecond: 25, flags: 1 } }),
    );
    expect(timing.timecode?.dropFrame).toBe(false);
    expect(timing.timecode?.note).toMatch(/counted without dropping/);
  });

  it('falls back to the creation time, read as a time of day, when there is no timecode track', async () => {
    const { timing } = await extractGpmf(generated({ createdAt: new Date('2024-06-01T10:20:30Z') }));
    expect(timing.timecode).toMatchObject({ source: 'creation-time', dropFrame: false, timebase: 30 });
    expect(formatStartTimecode(timing.timecode!)).toBe('10:20:30:00');
  });

  it('has none when the file states neither a timecode track nor a creation time', async () => {
    const { timing } = await extractGpmf(generated({ createdAt: new Date(-2_082_844_800_000) }));
    expect(timing.timecode).toBeUndefined();
  });

  it('prefers the track over the creation time', async () => {
    const withTrack = await extractGpmf(
      generated({
        createdAt: new Date('2024-06-01T10:20:30Z'),
        timecode: { counter: 30, timescale: 30000, frameDuration: 1001, framesPerSecond: 30 },
      }),
    );
    expect(withTrack.timing.timecode?.source).toBe('timecode-track');
  });

  it.each([
    ['a timescale of zero', { timescale: 0, frameDuration: 1001 }],
    ['a frame duration of zero', { timescale: 30000, frameDuration: 0 }],
    ['a rate no camera records at', { timescale: 300_000, frameDuration: 1000 }],
  ])('treats a track with %s as absent and falls back to the creation time', async (_name, fields) => {
    const { timing } = await extractGpmf(
      generated({ createdAt: new Date('2024-06-01T10:20:30Z'), timecode: { counter: 5, framesPerSecond: 30, ...fields } }),
    );
    expect(timing.timecode?.source).toBe('creation-time');
  });

  it('keeps the timecode of a video that has no telemetry track', async () => {
    const error = await extractGpmf(
      generated({
        omitTelemetryTrack: true,
        timecode: { counter: 90, timescale: 30000, frameDuration: 1001, framesPerSecond: 30 },
      }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NoTelemetryTrackError);
    expect((error as NoTelemetryTrackError).code).toBe('no_telemetry_track');
    expect(formatStartTimecode((error as NoTelemetryTrackError).timecode!)).toBe('00:00:03:00');
  });

  it('reads the counter, four bytes, and no more of the file for it', async () => {
    const video = generated({
      timecode: { counter: 1, timescale: 30000, frameDuration: 1001, framesPerSecond: 30 },
    });
    await extractGpmf(video);
    const small = video.reads.filter((read) => read.end - read.start === 4);
    expect(small).toHaveLength(1);
  });
});

/** The size of the final `moov` box, read from its header at the file's end. */
function findMoovSize(bytes: Uint8Array): number {
  // The generated clip ends with its moov; its size is the moov's own header.
  let at = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'moov') return size - 8;
    at += size;
  }
  throw new Error('no moov');
}
