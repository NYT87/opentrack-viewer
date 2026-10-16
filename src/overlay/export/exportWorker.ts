import { buildOverlayTimeline } from '../timeline';
import { createArchiveSink, probeArchiveStorage } from './archiveSink';
import { createOverlayRenderer } from './drawOverlay';
import { OverlayExportError, isOverlayExportError } from './errors';
import type { ExportRequest, FromWorker, ToWorker } from './protocol';
import { runExport } from './runExport';

/**
 * AV-1006. The export, off the main thread: the page stays responsive while
 * hundreds of frames are drawn on an `OffscreenCanvas`, encoded to PNG and
 * written to the archive. Nothing is posted back but progress and the finished
 * file; nothing is sent anywhere else.
 */

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
}
const scope = self as unknown as WorkerScope;

const PROGRESS_INTERVAL_MS = 50;

let current: AbortController | undefined;

const post = (message: FromWorker) => scope.postMessage(message);

/** Tells the page a job could not even begin, so it is not left waiting. */
function reportFailure(error: unknown, fallback = 'The export engine could not be started.'): void {
  post({
    type: 'error',
    code: 'render_failed',
    message: error instanceof Error && error.message ? `${fallback} (${error.message})` : fallback,
  });
}

async function run(request: ExportRequest, controller: AbortController): Promise<void> {
  const archive = await createArchiveSink(request.archiveName);
  try {
    const canvas = new OffscreenCanvas(request.width, request.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new OverlayExportError('unsupported_browser', 'This browser cannot draw on an offscreen canvas.');
    }

    const timeline = buildOverlayTimeline(request.activity, {
      video: { durationSeconds: request.videoDurationSeconds, start: request.videoStart },
      offsetSeconds: request.offsetSeconds,
    });
    const renderer = createOverlayRenderer({
      template: request.template,
      timeline,
      activity: request.activity,
      units: request.units,
      width: request.width,
      height: request.height,
    });

    let lastPosted = 0;
    const result = await runExport({
      frameCount: request.frameCount,
      fps: request.fps,
      width: request.width,
      height: request.height,
      videoDurationSeconds: request.videoDurationSeconds,
      telemetryOffsetSeconds: request.offsetSeconds,
      templateName: request.template.name,
      signal: controller.signal,
      sink: archive.sink,
      renderFrame: async (_index, videoTime) => {
        renderer.drawFrame(ctx, videoTime);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return new Uint8Array(await blob.arrayBuffer());
      },
      onProgress: (done, total) => {
        const now = Date.now();
        if (done === total || now - lastPosted >= PROGRESS_INTERVAL_MS) {
          lastPosted = now;
          scope.postMessage({ type: 'progress', done, total });
        }
      },
    });

    const file = await archive.finish();
    scope.postMessage({
      type: 'done',
      file,
      bytes: result.bytes,
      frameCount: result.frameCount,
      storage: archive.storage,
    });
  } catch (error) {
    await archive.abort();
    if (isOverlayExportError(error)) {
      scope.postMessage({ type: 'error', code: error.code, message: error.message });
    } else {
      scope.postMessage({
        type: 'error',
        code: 'storage_failed',
        message: error instanceof Error ? error.message : 'The export could not be written.',
      });
    }
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    current?.abort();
    return;
  }
  if (message.type === 'probe') {
    void probeArchiveStorage(message.archiveName).then(
      (storage) => scope.postMessage({ type: 'probed', storage }),
      reportFailure,
    );
    return;
  }
  // Loaded on demand. A chunk that will not load (offline after an update, a
  // blocked script) must be *said*: the page is waiting on an answer, and
  // without one an inspection waits out its timeout and a render waits forever.
  if (message.type === 'inspect') {
    void import('./burnWorker').then(
      ({ handleInspect }) => handleInspect(message, post),
      (error: unknown) => reportFailure(error, 'The video renderer could not be loaded.'),
    );
    return;
  }
  if (message.type === 'burn') {
    const controller = new AbortController();
    current = controller;
    void import('./burnWorker').then(
      ({ handleBurn }) => handleBurn(message.request, controller, post),
      (error: unknown) => reportFailure(error, 'The video renderer could not be loaded.'),
    );
    return;
  }
  current = new AbortController();
  void run(message.request, current);
};
