import { describe, expect, it, vi } from 'vitest';
import { OverlayExportError } from './errors';
import { addSeconds, makeSourceTimecode } from '../timecode';
import { METADATA_FILE_NAME, frameFileName, runExport, type RunExportOptions } from './runExport';
import { concatChunks, readZip } from '../../test/helpers/zipReader';

const png = (index: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, index & 0xff]);

function setup(overrides: Partial<RunExportOptions> = {}) {
  const chunks: Uint8Array[] = [];
  const times: number[] = [];
  const options: RunExportOptions = {
    frameCount: 5,
    fps: 10,
    width: 320,
    height: 180,
    videoDurationSeconds: 0.5,
    telemetryOffsetSeconds: -1.5,
    templateName: 'Metric strip',
    modified: new Date(2024, 0, 2, 3, 4, 6),
    sink: { write: (chunk) => void chunks.push(chunk.slice()) },
    renderFrame: async (index, time) => {
      times.push(time);
      return png(index);
    },
    ...overrides,
  };
  return { options, chunks, times, archive: () => readZip(concatChunks(chunks)) };
}

describe('the export loop (AV-1006)', () => {
  it('writes the metadata and one numbered PNG per frame, each at its own video time', async () => {
    const { options, times, archive, chunks } = setup();
    const result = await runExport(options);

    expect(result.frameCount).toBe(5);
    expect(times).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    const entries = archive();
    expect(entries.map((entry) => entry.name)).toEqual([
      METADATA_FILE_NAME,
      'frame_000001.png',
      'frame_000002.png',
      'frame_000003.png',
      'frame_000004.png',
      'frame_000005.png',
    ]);
    expect([...entries[3]!.data]).toEqual([...png(2)]);
    // The reported size is the archive's size, byte for byte.
    expect(result.bytes).toBe(concatChunks(chunks).length);
  });

  it('records the output dimensions, rate, duration and offset — and nothing identifying', async () => {
    const { options, archive } = setup();
    await runExport(options);
    const metadata = JSON.parse(new TextDecoder().decode(archive()[0]!.data));
    expect(metadata).toEqual({
      format: 'png-sequence',
      transparent: true,
      width: 320,
      height: 180,
      frameRate: 10,
      frameCount: 5,
      durationSeconds: 0.5,
      videoDurationSeconds: 0.5,
      telemetryOffsetSeconds: -1.5,
      videoStartSeconds: 0,
      template: 'Metric strip',
      firstFrame: 'frame_000001.png',
      // AV-1026: the fields added; every one above is as it was.
      timecode: null,
      timecodeNote: 'The source video has no timecode, so none is written.',
    });
  });

  it('stamps every file with the given time', async () => {
    const { options, chunks } = setup();
    await runExport(options);
    const archive = concatChunks(chunks);
    const view = new DataView(archive.buffer);
    // 03:04:06 -> hours<<11 | minutes<<5 | seconds/2, in the first local header.
    expect(view.getUint16(10, true)).toBe((3 << 11) | (4 << 5) | 3);
    expect(view.getUint16(12, true)).toBe(((2024 - 1980) << 9) | (1 << 5) | 2);
  });

  it('reports progress from none to all', async () => {
    const onProgress = vi.fn();
    await runExport(setup({ onProgress }).options);
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(onProgress).toHaveBeenLastCalledWith(5, 5);
  });

  it('numbers frames with enough digits for a long export', () => {
    expect(frameFileName(0, 10)).toBe('frame_000001.png');
    expect(frameFileName(1_234_566, 1_234_567)).toBe('frame_1234567.png');
  });

  it('stops at once when asked, writes no directory, and says it was cancelled', async () => {
    const controller = new AbortController();
    const { options, chunks, times } = setup({
      signal: controller.signal,
      renderFrame: async (index) => {
        if (index === 2) controller.abort();
        return png(index);
      },
    });
    const failure = await runExport(options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OverlayExportError);
    expect((failure as OverlayExportError).code).toBe('cancelled');
    // The frame drawn as the stop arrived is not kept, and no directory follows.
    expect(times).toEqual([]);
    const written = concatChunks(chunks);
    expect(() => readZip(written)).toThrow();
  });

  it('does not start when it is already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, chunks } = setup({ signal: controller.signal });
    await expect(runExport(options)).rejects.toMatchObject({ code: 'cancelled' });
    expect(chunks).toEqual([]);
  });

  it('names the frame that could not be drawn', async () => {
    const { options } = setup({
      renderFrame: async (index) => {
        if (index === 3) throw new Error('canvas lost');
        return png(index);
      },
    });
    const failure = (await runExport(options).catch((error: unknown) => error)) as OverlayExportError;
    expect(failure.code).toBe('render_failed');
    expect(failure.message).toBe('Frame 4 of 5 could not be drawn.');
    expect((failure.cause as Error).message).toBe('canvas lost');
  });

  it('lets a failure to store the output through, unchanged', async () => {
    const full = new OverlayExportError('storage_failed', 'disk full');
    const { options } = setup({
      sink: {
        write: () => {
          throw full;
        },
      },
    });
    await expect(runExport(options)).rejects.toBe(full);
  });

  it('refuses a frame that would overflow the archive', async () => {
    const { options } = setup({
      renderFrame: async () => ({ length: 0xffffffff }) as unknown as Uint8Array,
    });
    await expect(runExport(options)).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('the source’s timecode in the metadata and the file names (AV-1026, TD-095)', () => {
  const ntsc = makeSourceTimecode({
    startFrame: 1800,
    rate: { numerator: 30000, denominator: 1001 },
    timebase: 30,
    dropFrame: true,
    source: 'timecode-track',
  })!;
  const metadataOf = async (overrides: Partial<RunExportOptions>) => {
    const { options, archive } = setup({ fps: 30000 / 1001, ...overrides });
    await runExport(options);
    const entries = archive();
    return { metadata: JSON.parse(new TextDecoder().decode(entries[0]!.data)), names: entries.map((entry) => entry.name) };
  };

  it('writes the start, the exact rate as a fraction, drop-frame and where it came from', async () => {
    const { metadata } = await metadataOf({ startTimecode: ntsc });
    expect(metadata.timecode).toEqual({
      start: '00:01:00;02',
      startFrame: 1800,
      frameRate: { numerator: 30000, denominator: 1001 },
      dropFrame: true,
      source: 'timecode-track',
    });
    expect(metadata).not.toHaveProperty('timecodeNote');
  });

  it('writes the cut’s start already added: the start moves with the cut', async () => {
    const cut = addSeconds(ntsc, 10);
    const { metadata } = await metadataOf({ startTimecode: cut, videoStartSeconds: 10 });
    // 10 s at 29.97 is 299.7 frames: 300, so 2100, one drop-frame minute and 300 frames in.
    expect(metadata.timecode.startFrame).toBe(2100);
    expect(metadata.timecode.start).toBe('00:01:10;02');
    expect(metadata.videoStartSeconds).toBe(10);
  });

  it('says a creation-time timecode came from there, and a plain one is not drop-frame', async () => {
    const created = makeSourceTimecode({
      startFrame: 25 * 3723,
      rate: { numerator: 25, denominator: 1 },
      timebase: 25,
      dropFrame: false,
      source: 'creation-time',
    })!;
    const { metadata } = await metadataOf({ fps: 25, startTimecode: created });
    expect(metadata.timecode).toMatchObject({ start: '01:02:03:00', dropFrame: false, source: 'creation-time' });
  });

  it('names the frames from 1 by default, even with a timecode', async () => {
    const { metadata, names } = await metadataOf({ startTimecode: ntsc, frameCount: 3 });
    expect(names.slice(1)).toEqual(['frame_000001.png', 'frame_000002.png', 'frame_000003.png']);
    expect(metadata.firstFrame).toBe('frame_000001.png');
  });

  it('numbers the frames by the source’s counter when asked, and says the first in the metadata', async () => {
    const { metadata, names } = await metadataOf({
      startTimecode: addSeconds(ntsc, 10),
      numberFramesBySource: true,
      frameCount: 3,
    });
    expect(names).toEqual([METADATA_FILE_NAME, 'frame_002100.png', 'frame_002101.png', 'frame_002102.png']);
    expect(metadata.firstFrame).toBe('frame_002100.png');
  });

  it('refuses source numbering at another frame rate, so the names are not source frames', async () => {
    const { metadata, names } = await metadataOf({ fps: 30, startTimecode: ntsc, numberFramesBySource: true, frameCount: 2 });
    expect(names.slice(1)).toEqual(['frame_000001.png', 'frame_000002.png']);
    expect(metadata.firstFrame).toBe('frame_000001.png');
  });

  it('does not number by the source without a timecode', async () => {
    const { names } = await metadataOf({ numberFramesBySource: true, frameCount: 2 });
    expect(names.slice(1)).toEqual(['frame_000001.png', 'frame_000002.png']);
  });

  it('keeps names one width when the counter passes a digit', () => {
    expect(frameFileName(0, 3, 999_998)).toBe('frame_0999998.png');
    expect(frameFileName(2, 3, 999_998)).toBe('frame_1000000.png');
  });
});
