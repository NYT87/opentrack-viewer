import { removeArchive, removeStaleArchives } from './archiveSink';
import { ownArchive } from './archiveOwnership';
import { OverlayExportError } from './errors';
import { hasMapInset } from '../insetCamera';
import { buildOverlayTimeline } from '../timeline';
import type { OverlayTemplate } from '../template';
import type { Activity } from '../../domain/activity';
import { createInsetMaps, type InsetMapSession, type InsetMapsInput } from './insetMaps';
import {
  ARCHIVE_NAME_PREFIX,
  type ArchiveStorage,
  type BurnRequest,
  type BurnSourceInfo,
  type ExportRequest,
  type FromWorker,
  type ToWorker,
} from './protocol';

/**
 * AV-1006. Runs an export in a worker and gives the page a handle on it:
 * progress, a stop, and the finished file. The page never sees the worker.
 */

export interface ExportOutput {
  file: Blob;
  bytes: number;
  frameCount: number;
  /** Things the reader should know, such as sound that could not be carried over. */
  notes?: string[];
  /** Frees the stored archive once the reader has it, or has moved on. */
  dispose: () => Promise<void>;
}

export interface ExportJob {
  /** Asks the export to stop. `done` then rejects with a `cancelled` error. */
  cancel: () => void;
  done: Promise<ExportOutput>;
}

/** The part of `Worker` the client uses, so tests can stand in for it. */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface ExportClientDeps {
  createWorker?: () => WorkerLike;
  /**
   * AV-1023 (TD-092). The reader's MapTiler key, for a route inset whose map is MapTiler's: it stays on the page, where the
   * maps are, and is never in a request to the worker.
   */
  maptilerKey?: string;
  /** AV-1023. Why a route inset's map is waiting (tiles still coming, a hidden tab), for the panel to say. */
  onWaiting?: InsetMapsInput['onWaiting'];
  /** For tests: how the page's route-inset maps are made. */
  createInsets?: (input: InsetMapsInput) => InsetMapSession;
}

/** What a job holds of the page's maps while it runs: the session, and the way to stop a map waiting on a tile. */
interface InsetBridge {
  session: InsetMapSession;
  controller: AbortController;
}

interface InsetSource {
  template: OverlayTemplate;
  activity: Activity;
  width: number;
  height: number;
  videoDurationSeconds: number;
  videoStart?: Date;
  offsetSeconds: number;
}

/** The page's maps for a template that has a basemap behind a route inset; `undefined` (and no round trips) for one that has none. */
function openInsetBridge(request: InsetSource, deps: ExportClientDeps): InsetBridge | undefined {
  if (!hasMapInset(request.template)) return undefined;
  const controller = new AbortController();
  const timeline = buildOverlayTimeline(request.activity, {
    video: { durationSeconds: request.videoDurationSeconds, start: request.videoStart },
    offsetSeconds: request.offsetSeconds,
  });
  const session = (deps.createInsets ?? createInsetMaps)({
    template: request.template,
    activity: request.activity,
    timeline,
    width: request.width,
    height: request.height,
    maptilerKey: deps.maptilerKey ?? '',
    signal: controller.signal,
    onWaiting: deps.onWaiting,
  });
  return { session, controller };
}

/** AV-1023 (TD-079). A MapTiler map is not for pictures: the PNG sequence refuses it, whoever asks. */
export const MAPTILER_PNG_REFUSAL =
  'A MapTiler map cannot go into the PNG sequence: MapTiler’s terms allow videos, not pictures of its map. Export a video, or change the route inset’s map to OpenFreeMap or none.';
export const hasMaptilerInset = (template: OverlayTemplate): boolean =>
  template.components.some((component) => component.visible && component.type === 'routeInset' && component.routeInset?.map.provider === 'maptiler');

/** How long a stop may take before the worker is ended outright. */
export const CANCEL_GRACE_MS = 2000;

const defaultWorker = (): WorkerLike =>
  new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });

export function newArchiveName(): string {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Date.now());
  return `${ARCHIVE_NAME_PREFIX}${id}.zip`;
}

/** How long the worker has to answer a storage probe before it is judged unusable. */
export const PROBE_TIMEOUT_MS = 8000;

let probed: Promise<ArchiveStorage> | undefined;

/**
 * Asks a worker which storage an export would really get: a file, or memory.
 * Answered once per page load — it does not change — and a failure is not
 * remembered, so a retry can succeed. Rejects with `render_failed` if the
 * worker cannot be started or does not answer, which is the same thing the
 * export itself would hit.
 */
export function probeExportStorage(deps: ExportClientDeps = {}): Promise<ArchiveStorage> {
  if (probed) return probed;
  const attempt = new Promise<ArchiveStorage>((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = (deps.createWorker ?? defaultWorker)();
    } catch (error) {
      reject(startupError(error));
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new OverlayExportError('render_failed', 'The export engine did not start.'));
    }, PROBE_TIMEOUT_MS);
    worker.onmessage = (event) => {
      // The worker says when it could not look, rather than leaving the page to its timeout.
      if (event.data.type === 'error') {
        finish();
        reject(new OverlayExportError(event.data.code, event.data.message));
        return;
      }
      if (event.data.type !== 'probed') return;
      finish();
      resolve(event.data.storage);
    };
    worker.onerror = (event) => {
      finish();
      reject(new OverlayExportError('render_failed', event.message || 'The export engine did not start.'));
    };
    try {
      worker.postMessage({ type: 'probe', archiveName: newArchiveName() });
    } catch (error) {
      finish();
      reject(startupError(error));
    }
  });
  probed = attempt;
  attempt.catch(() => {
    if (probed === attempt) probed = undefined;
  });
  return attempt;
}

/** Forgets the probe's answer. For tests. */
export function resetStorageProbe(): void {
  probed = undefined;
}

function startupError(error: unknown): OverlayExportError {
  return new OverlayExportError(
    'render_failed',
    `The export engine could not be started${error instanceof Error && error.message ? `: ${error.message}` : '.'}`,
    { cause: error },
  );
}

/** A PNG-sequence export: frames done out of frames in all. */
export function startOverlayExport(
  request: Omit<ExportRequest, 'archiveName'>,
  onProgress: (done: number, total: number) => void,
  deps: ExportClientDeps = {},
): ExportJob {
  if (hasMaptilerInset(request.template)) {
    return { cancel: () => undefined, done: Promise.reject(new OverlayExportError('render_failed', MAPTILER_PNG_REFUSAL)) };
  }
  return startWorkerJob(
    (archiveName) => ({ type: 'start', request: { ...request, archiveName } }),
    (message) => {
      if (message.type === 'progress') onProgress(message.done, message.total);
    },
    deps,
    openInsetBridge(request, deps),
  );
}

/** AV-1007. A burned-in render: how much of it is done, 0 to 1, and how many seconds of video. */
export function startBurnedInExport(
  request: Omit<BurnRequest, 'archiveName'>,
  onProgress: (fraction: number, processedSeconds: number) => void,
  deps: ExportClientDeps = {},
): ExportJob {
  return startWorkerJob(
    (archiveName) => ({ type: 'burn', request: { ...request, archiveName } }),
    (message) => {
      if (message.type === 'burnProgress') onProgress(message.fraction, message.processedSeconds);
    },
    deps,
    openInsetBridge(request, deps),
  );
}

/** How long reading a video's index may take before the worker is judged stuck. */
export const INSPECT_TIMEOUT_MS = 60_000;

/**
 * AV-1007. Looks at a video in a worker — its tracks, whether this browser can
 * decode it, whether it reports it can encode H.264 at the target size —
 * before anything is rendered. Reads only the container's index, not the
 * picture, however large the file.
 */
export function inspectBurnSource(
  file: File,
  target: { width: number; height: number; bitrate: number; frameRate?: number },
  deps: ExportClientDeps = {},
): Promise<BurnSourceInfo> {
  return new Promise((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = (deps.createWorker ?? defaultWorker)();
    } catch (error) {
      reject(startupError(error));
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new OverlayExportError('render_failed', 'Reading the video took too long.'));
    }, INSPECT_TIMEOUT_MS);
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'inspected') {
        finish();
        resolve(message.info);
      } else if (message.type === 'error') {
        finish();
        reject(new OverlayExportError(message.code, message.message));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new OverlayExportError('render_failed', event.message || 'The video could not be read.'));
    };
    try {
      worker.postMessage({ type: 'inspect', file, ...target });
    } catch (error) {
      finish();
      reject(startupError(error));
    }
  });
}

/**
 * Runs one job in a worker: the start message, the stop, the clean-up of the
 * stored file however it ends. The page never sees the worker.
 */
function startWorkerJob(
  startMessage: (archiveName: string) => ToWorker,
  onWorkerMessage: (message: FromWorker) => void,
  deps: ExportClientDeps,
  insets?: InsetBridge,
): ExportJob {
  const archiveName = newArchiveName();
  // A worker that cannot even be constructed (a blocked script, a policy) is a
  // failure of the export, reported the same way as one that dies later — as a
  // rejected `done`, never as an exception the caller has to know to catch.
  let worker: WorkerLike;
  try {
    worker = (deps.createWorker ?? defaultWorker)();
  } catch (error) {
    return { cancel: () => undefined, done: Promise.reject(startupError(error)) };
  }
  /** The worker is ended, and with it the maps the page held for it. */
  const stopWorker = () => {
    worker.terminate();
    // A map still waiting on a tile stops at once rather than poll for two minutes for a job that is over.
    insets?.controller.abort();
    insets?.session.close();
  };
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let started = false;
  let cancelRequested = false;
  let rejectJob: (error: OverlayExportError) => void = () => undefined;
  let releaseOwnership = () => undefined as void;
  const discard = async () => {
    try {
      await removeArchive(archiveName);
    } finally {
      releaseOwnership();
    }
  };

  const done = new Promise<ExportOutput>((resolve, reject) => {
    rejectJob = reject;

    const finish = () => {
      settled = true;
      if (cancelTimer) clearTimeout(cancelTimer);
      stopWorker();
    };

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress' || message.type === 'burnProgress') {
        onWorkerMessage(message);
      } else if (message.type === 'insets' && insets) {
        // AV-1023. The worker is waiting for these pictures before it draws frame `frame`: asked of the maps, sent back transferred.
        const { frame } = message;
        void insets.session.bitmapsAt(message.seconds, message.ids).then(
          (bitmaps) => {
            const pictures = Object.values(bitmaps);
            if (settled) {
              for (const bitmap of pictures) bitmap.close();
              return;
            }
            try {
              worker.postMessage({ type: 'insetBitmaps', frame, bitmaps }, pictures);
            } catch (error) {
              for (const bitmap of pictures) bitmap.close();
              settled = true;
              stopWorker();
              void discard();
              reject(startupError(error));
            }
          },
          (error: unknown) => {
            if (settled) return;
            // A stop the reader asked for while the worker waits on a picture ends as the worker ends it: it hears the stop,
            // aborts its archive and says so (the grace timer ends it if it does not).
            if (cancelRequested && error instanceof OverlayExportError && error.code === 'cancelled') return;
            finish();
            void discard();
            reject(
              error instanceof OverlayExportError
                ? error
                : new OverlayExportError('render_failed', error instanceof Error && error.message ? error.message : 'The route inset’s map could not be drawn.', { cause: error }),
            );
          },
        );
      } else if (message.type === 'done') {
        finish();
        if (cancelRequested) {
          // The stop lost the race with the last frame. The reader asked to stop,
          // so they get a stop: the finished archive is discarded, not offered.
          void discard();
          reject(new OverlayExportError('cancelled', 'The export was stopped.'));
          return;
        }
        resolve({
          file: message.file,
          bytes: message.bytes,
          frameCount: message.frameCount,
          notes: message.notes ?? [],
          dispose: discard,
        });
        if (message.storage !== 'opfs') releaseOwnership();
      } else if (message.type === 'error') {
        finish();
        void discard();
        reject(new OverlayExportError(message.code, message.message));
      }
    };
    worker.onerror = (event) => {
      finish();
      void discard();
      reject(
        new OverlayExportError('render_failed', event.message || 'The export stopped unexpectedly.'),
      );
    };
  });

  // Housekeeping first, then the work: leftovers from an interrupted export go.
  void ownArchive(archiveName).then(async (release) => {
    releaseOwnership = release;
    if (settled) { release(); return; }
    await removeStaleArchives(archiveName);
    if (settled) { release(); return; }
    if (cancelRequested) {
      // Stopped before it began: nothing was written, so there is nothing to undo.
      settled = true;
      stopWorker();
      releaseOwnership();
      rejectJob(new OverlayExportError('cancelled', 'The export was stopped.'));
      return;
    }
    started = true;
    try {
      worker.postMessage(startMessage(archiveName));
    } catch (error) {
      // A request that cannot be sent (it could not be cloned) would otherwise
      // leave the job waiting for a worker that never heard of it.
      settled = true;
      stopWorker();
      void discard();
      rejectJob(startupError(error));
    }
  }).catch((error: unknown) => {
    settled = true;
    stopWorker();
    void discard();
    rejectJob(startupError(error));
  });

  return {
    done,
    cancel() {
      if (settled) return;
      cancelRequested = true;
      // Before the start message has gone out, the start itself is what is dropped.
      if (!started) return;
      worker.postMessage({ type: 'cancel' });
      // A map waiting on a tile gives up at once rather than hold the stop for it.
      insets?.controller.abort();
      // A worker busy in one long frame still answers eventually; if it does not, end it.
      cancelTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stopWorker();
        void discard();
        rejectJob(new OverlayExportError('cancelled', 'The export was stopped.'));
      }, CANCEL_GRACE_MS);
    },
  };
}
