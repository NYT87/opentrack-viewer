import { describe, expect, it } from 'vitest';
import { extractGpmf } from './extractGpmf';
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
    expect(payload.timing.frameDurationMs).toBeGreaterThan(0);
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
    expect(payload.timing.frameDurationMs).toBeCloseTo(18.018 / 511, 6);
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

  it('says a container with no index has no telemetry', async () => {
    // `ftyp` and an `mdat`, and then nothing: a recording the camera never
    // finished writing. There is no `moov`, so there is nothing to look in.
    const header = new Uint8Array([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x31, 0, 0, 0, 0, // ftyp
      0, 0, 0, 16, 0x6d, 0x64, 0x61, 0x74, 1, 2, 3, 4, 5, 6, 7, 8, // mdat
    ]);

    await expect(extractGpmf(new File([header], 'cut.mp4'))).rejects.toMatchObject({
      code: 'no_telemetry_track',
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
