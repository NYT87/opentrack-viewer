import { describe, expect, it, vi } from 'vitest';
import { OverlayExportError } from './errors';
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
      template: 'Metric strip',
      firstFrame: 'frame_000001.png',
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
