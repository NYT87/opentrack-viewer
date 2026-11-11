import { describe, expect, it } from 'vitest';
import type { WorkerLike } from '../../overlay/export/client';
import type { FromWorker, ToWorker } from '../../overlay/export/protocol';
import { startMapVideoEncode } from './encodeClient';

/** A stand-in for the export worker: it records what the page sends, and says what a test tells it to. */
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = { width: 640, height: 360, fps: 30, bitrate: 1_000_000, format: 'mp4' as const, allowMemory: true };

describe('the map video encoder client (AV-1209)', () => {
  it('starts the worker with a file of its own choosing, and hands back the finished file', async () => {
    const { worker, posted } = fakeWorker();
    const encoder = startMapVideoEncode(request, { createWorker: () => worker });
    await tick();
    expect(posted[0]).toMatchObject({ type: 'mapVideoStart', request: { width: 640, format: 'mp4', archiveName: expect.stringMatching(/^overlay-export-/) } });
    worker.emit({ type: 'mapVideoReady' });
    await encoder.ready;
    const finished = encoder.finish();
    expect(posted.at(-1)).toEqual({ type: 'mapVideoFinish' });
    worker.emit({ type: 'done', file: new Blob(['video']), bytes: 5, frameCount: 0, storage: 'memory' });
    await expect(finished).resolves.toMatchObject({ bytes: 5 });
  });

  it('lets the file go when the worker finishes after Stop was pressed (TD-073)', async () => {
    const { worker, posted } = fakeWorker();
    const encoder = startMapVideoEncode(request, { createWorker: () => worker });
    await tick();
    worker.emit({ type: 'mapVideoReady' });
    await encoder.ready;
    const finished = encoder.finish();
    encoder.cancel();
    expect(posted.at(-1)).toEqual({ type: 'cancel' });
    // The last frame was already being written: the worker finishes before it reads the stop.
    worker.emit({ type: 'done', file: new Blob(['video']), bytes: 5, frameCount: 150, storage: 'opfs' });
    await expect(finished).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminated).toBe(true);
  });
});
