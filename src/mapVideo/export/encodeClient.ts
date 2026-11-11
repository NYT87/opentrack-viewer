import { removeArchive, removeStaleArchives } from '../../overlay/export/archiveSink';
import { ownArchive } from '../../overlay/export/archiveOwnership';
import { CANCEL_GRACE_MS, newArchiveName, type ExportOutput, type WorkerLike } from '../../overlay/export/client';
import { OverlayExportError } from '../../overlay/export/errors';
import type { MapVideoEncodeRequest } from '../../overlay/export/protocol';

/**
 * AV-1209. The page's handle on a map video's encoding in the export worker:
 * frames go in one by one, with at most a few in flight so the page never
 * outruns the encoder; the file comes out at the end. The stored file is
 * owned under the same lock, cleaned up the same way and discarded on a stop
 * as every other export's (the 25 October 2026 review's storage rules).
 */
export interface MapVideoEncoder {
  /** Resolves once the worker can take frames. */
  ready: Promise<void>;
  /** Hands a frame over (transferred) and resolves once there is room for the next. */
  addFrame: (frame: VideoFrame) => Promise<void>;
  /** No more frames: resolves with the finished file. */
  finish: () => Promise<ExportOutput>;
  /** Stops, keeping nothing. Whatever is waiting rejects with `cancelled`. */
  cancel: () => void;
}

/** Frames handed over before the page waits for the encoder. */
const IN_FLIGHT = 3;

const defaultWorker = (): WorkerLike =>
  new Worker(new URL('../../overlay/export/exportWorker.ts', import.meta.url), { type: 'module' });

export function startMapVideoEncode(
  request: Omit<MapVideoEncodeRequest, 'archiveName'>,
  deps: { createWorker?: () => WorkerLike } = {},
): MapVideoEncoder {
  const archiveName = newArchiveName();
  let worker: WorkerLike;
  try {
    worker = (deps.createWorker ?? defaultWorker)();
  } catch (error) {
    const failed = Promise.reject(new OverlayExportError('render_failed', `The video encoder could not be started. (${String(error)})`));
    failed.catch(() => undefined);
    return { ready: failed, addFrame: () => failed, finish: () => failed, cancel: () => undefined };
  }

  let settled = false;
  let release: () => void = () => undefined;
  let failure: OverlayExportError | undefined;
  let sent = 0;
  let done = 0;
  const waiters: (() => void)[] = [];
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: OverlayExportError) => void = () => undefined;
  let finishResolve: (output: ExportOutput) => void = () => undefined;
  let finishReject: (error: OverlayExportError) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finished = new Promise<ExportOutput>((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  // Whoever is not waiting on one of these when it fails is told by the other.
  ready.catch(() => undefined);
  finished.catch(() => undefined);

  const discard = async () => {
    try {
      await removeArchive(archiveName);
    } finally {
      release();
    }
  };
  const end = (error: OverlayExportError) => {
    if (settled) return;
    settled = true;
    failure = error;
    if (cancelTimer) clearTimeout(cancelTimer);
    worker.terminate();
    void discard();
    readyReject(error);
    finishReject(error);
    waiters.splice(0).forEach((wake) => wake());
  };

  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'mapVideoReady') readyResolve();
    else if (message.type === 'mapVideoFrameDone') {
      done += 1;
      waiters.shift()?.();
    } else if (message.type === 'done') {
      settled = true;
      worker.terminate();
      if (cancelTimer) clearTimeout(cancelTimer);
      finishResolve({ file: message.file, bytes: message.bytes, frameCount: message.frameCount, notes: message.notes ?? [], dispose: discard });
      if (message.storage !== 'opfs') release();
    } else if (message.type === 'error') {
      // After a stop, the worker's own report of it is the stop.
      end(failure?.code === 'cancelled' ? failure : new OverlayExportError(message.code, message.message));
    }
  };
  worker.onerror = (event) => end(new OverlayExportError('render_failed', event.message || 'The video encoder stopped unexpectedly.'));

  // Leftovers from an interrupted export go first, then the work starts under its own lock.
  void ownArchive(archiveName)
    .then(async (owned) => {
      release = owned;
      if (settled) return release();
      await removeStaleArchives(archiveName);
      if (settled) return release();
      worker.postMessage({ type: 'mapVideoStart', request: { ...request, archiveName } });
    })
    .catch((error: unknown) => end(new OverlayExportError('storage_failed', `The video could not be given a file. (${String(error)})`)));

  return {
    ready,
    async addFrame(frame) {
      if (failure) {
        frame.close();
        throw failure;
      }
      sent += 1;
      (worker as unknown as { postMessage: (message: unknown, transfer: Transferable[]) => void }).postMessage(
        { type: 'mapVideoFrame', frame, index: sent - 1 },
        [frame],
      );
      while (!failure && sent - done > IN_FLIGHT) await new Promise<void>((wake) => waiters.push(wake));
      if (failure) throw failure;
    },
    finish() {
      if (!failure && !settled) worker.postMessage({ type: 'mapVideoFinish' });
      return finished;
    },
    cancel() {
      if (settled || failure) return;
      const stopped = new OverlayExportError('cancelled', 'The export was stopped.');
      // No more frames from here; the worker lets go of its file and says so, or is ended.
      failure = stopped;
      waiters.splice(0).forEach((wake) => wake());
      try {
        worker.postMessage({ type: 'cancel' });
      } catch {
        end(stopped);
        return;
      }
      cancelTimer = setTimeout(() => end(stopped), CANCEL_GRACE_MS);
    },
  };
}
