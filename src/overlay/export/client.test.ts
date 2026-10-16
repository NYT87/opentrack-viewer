import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANCEL_GRACE_MS,
  PROBE_TIMEOUT_MS,
  probeExportStorage,
  resetStorageProbe,
  startOverlayExport,
  type WorkerLike,
} from './client';
import type { ExportRequest, FromWorker, ToWorker } from './protocol';
import { getExportSupport } from './support';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';

function fakeWorker() {
  const posted: ToWorker[] = [];
  const worker: WorkerLike & { terminated: boolean; emit: (message: FromWorker) => void } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage: (message) => void posted.push(message),
    terminate() {
      worker.terminated = true;
    },
    emit(message) {
      worker.onmessage?.({ data: message } as MessageEvent<FromWorker>);
    },
  };
  return { worker, posted };
}

const activity = makeActivity([{ time: new Date(0) }, { time: new Date(1000) }]);
const request: Omit<ExportRequest, 'archiveName'> = {
  width: 320,
  height: 180,
  fps: 10,
  frameCount: 3,
  videoDurationSeconds: 0.3,
  offsetSeconds: 0,
  units: 'metric',
  template: buildOverlay(DEFAULT_OVERLAY_CONTROLS, buildOverlayTimeline(activity)).template,
  activity,
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the export client (AV-1006)', () => {
  it('sends the request to the worker, with an archive name of its own choosing', async () => {
    const { worker, posted } = fakeWorker();
    startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await tick();
    expect(posted).toHaveLength(1);
    const start = posted[0] as Extract<ToWorker, { type: 'start' }>;
    expect(start.request).toMatchObject({ width: 320, frameCount: 3, units: 'metric' });
    expect(start.request.archiveName).toMatch(/^overlay-export-.+\.zip$/);
  });

  it('relays progress and resolves with the finished file, ending the worker', async () => {
    const { worker } = fakeWorker();
    const onProgress = vi.fn();
    const job = startOverlayExport(request, onProgress, { createWorker: () => worker });
    await tick();
    worker.emit({ type: 'progress', done: 2, total: 3 });
    expect(onProgress).toHaveBeenCalledWith(2, 3);

    const file = new Blob(['zip']);
    worker.emit({ type: 'done', file, bytes: 3, frameCount: 3, storage: 'memory' });
    const output = await job.done;
    expect(output).toMatchObject({ file, bytes: 3, frameCount: 3 });
    expect(worker.terminated).toBe(true);
    await expect(output.dispose()).resolves.toBeUndefined();
  });

  it('rejects with the worker\'s reason', async () => {
    const { worker } = fakeWorker();
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await tick();
    worker.emit({ type: 'error', code: 'storage_failed', message: 'disk full' });
    await expect(job.done).rejects.toMatchObject({ code: 'storage_failed', message: 'disk full' });
    expect(worker.terminated).toBe(true);
  });

  it('turns a crashed worker into a clear failure', async () => {
    const { worker } = fakeWorker();
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await tick();
    worker.onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(job.done).rejects.toMatchObject({ code: 'render_failed', message: 'boom' });
  });

  it('asks the worker to stop, and reports the stop the worker confirms', async () => {
    const { worker, posted } = fakeWorker();
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await tick();
    job.cancel();
    expect(posted.at(-1)).toEqual({ type: 'cancel' });
    worker.emit({ type: 'error', code: 'cancelled', message: 'The export was stopped.' });
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
  });

  describe('with a worker that does not answer a stop', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('ends it after the grace period', async () => {
      const { worker } = fakeWorker();
      const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
      await vi.advanceTimersByTimeAsync(1);
      job.cancel();
      const settled = job.done.catch((error: unknown) => error);
      expect(worker.terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS + 1);
      expect(worker.terminated).toBe(true);
      expect(await settled).toMatchObject({ code: 'cancelled' });
    });
  });

  it('never starts the worker on a stop that came first', async () => {
    const { worker, posted } = fakeWorker();
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    job.cancel();
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
    expect(posted).toEqual([]);
    expect(worker.terminated).toBe(true);
  });

  it('discards a finished archive that arrives after a stop, and reports the stop', async () => {
    const { worker } = fakeWorker();
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await tick();
    job.cancel();
    // The last frame was already written: `done` is queued behind the stop.
    worker.emit({ type: 'done', file: new Blob(['zip']), bytes: 3, frameCount: 3, storage: 'opfs' });
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminated).toBe(true);
  });

  it('ignores a stop after the end', async () => {
    const { worker, posted } = fakeWorker();
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await tick();
    worker.emit({ type: 'done', file: new Blob([]), bytes: 0, frameCount: 3, storage: 'memory' });
    await job.done;
    job.cancel();
    expect(posted.some((message) => message.type === 'cancel')).toBe(false);
  });
});

describe('starting the export can fail, and says so (AV-1006)', () => {
  it('rejects, rather than throws, when the worker cannot be constructed', async () => {
    const job = startOverlayExport(request, () => undefined, {
      createWorker: () => {
        throw new Error('blocked by policy');
      },
    });
    await expect(job.done).rejects.toMatchObject({
      code: 'render_failed',
      message: 'The export engine could not be started: blocked by policy',
    });
    expect(() => job.cancel()).not.toThrow();
  });

  it('rejects when the request cannot be sent to the worker', async () => {
    const { worker } = fakeWorker();
    worker.postMessage = () => {
      throw new Error('could not be cloned');
    };
    const job = startOverlayExport(request, () => undefined, { createWorker: () => worker });
    await expect(job.done).rejects.toMatchObject({ code: 'render_failed' });
    expect(worker.terminated).toBe(true);
  });
});

describe('probing the worker\'s storage (AV-1006)', () => {
  beforeEach(() => resetStorageProbe());

  it('asks the worker, reports what it says, and ends it', async () => {
    const { worker, posted } = fakeWorker();
    const answer = probeExportStorage({ createWorker: () => worker });
    expect(posted[0]).toMatchObject({ type: 'probe' });
    expect((posted[0] as { archiveName: string }).archiveName).toMatch(/^overlay-export-/);
    worker.emit({ type: 'probed', storage: 'memory' });
    await expect(answer).resolves.toBe('memory');
    expect(worker.terminated).toBe(true);
  });

  it('asks only once: the answer does not change while the page is open', async () => {
    const { worker } = fakeWorker();
    const createWorker = vi.fn(() => worker);
    const first = probeExportStorage({ createWorker });
    worker.emit({ type: 'probed', storage: 'opfs' });
    await first;
    await expect(probeExportStorage({ createWorker })).resolves.toBe('opfs');
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('rejects when the worker cannot be started, and tries again next time', async () => {
    await expect(
      probeExportStorage({
        createWorker: () => {
          throw new Error('blocked');
        },
      }),
    ).rejects.toMatchObject({ code: 'render_failed', message: expect.stringContaining('blocked') });

    const { worker } = fakeWorker();
    const retry = probeExportStorage({ createWorker: () => worker });
    worker.emit({ type: 'probed', storage: 'opfs' });
    await expect(retry).resolves.toBe('opfs');
  });

  it('rejects when the worker errors', async () => {
    const { worker } = fakeWorker();
    const answer = probeExportStorage({ createWorker: () => worker });
    worker.onerror?.({ message: 'script failed to load' } as ErrorEvent);
    await expect(answer).rejects.toMatchObject({ message: 'script failed to load' });
    expect(worker.terminated).toBe(true);
  });

  it('gives up on a worker that never answers', async () => {
    vi.useFakeTimers();
    try {
      const { worker } = fakeWorker();
      const answer = probeExportStorage({ createWorker: () => worker });
      const settled = answer.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
      expect(await settled).toMatchObject({ code: 'render_failed' });
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('export capability (AV-1006)', () => {
  const full = { Worker: function () {}, OffscreenCanvas: Object.assign(function () {}, { prototype: { convertToBlob() {} } }) };

  it('is supported with a worker and an offscreen canvas that can encode', () => {
    expect(getExportSupport(full as unknown as typeof globalThis)).toEqual({ supported: true });
  });

  it('says what is missing, by capability', () => {
    const noWorker = getExportSupport({ ...full, Worker: undefined } as unknown as typeof globalThis);
    expect(noWorker.supported).toBe(false);
    expect(noWorker.reason).toMatch(/background tasks/);

    const noCanvas = getExportSupport({ ...full, OffscreenCanvas: undefined } as unknown as typeof globalThis);
    expect(noCanvas.supported).toBe(false);
    expect(noCanvas.reason).toMatch(/draw and encode images/);

    const noEncode = getExportSupport({
      ...full,
      OffscreenCanvas: Object.assign(function () {}, { prototype: {} }),
    } as unknown as typeof globalThis);
    expect(noEncode.supported).toBe(false);
  });
});
