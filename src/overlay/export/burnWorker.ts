import { createArchiveSink } from './archiveSink';
import { inspectSource, runBurn, type MediabunnyModule } from './burnRun';
import { OverlayExportError, isOverlayExportError } from './errors';
import type { BurnRequest, FromWorker, ToWorker } from './protocol';

/**
 * AV-1007. The worker's side of a burned-in render and of looking at a video.
 * Loaded on demand from `exportWorker.ts`, so an image-sequence export never
 * pays for Mediabunny.
 */
type Post = (message: FromWorker) => void;

/**
 * Mediabunny, by name. Handing the whole module namespace around would keep all
 * of it — every demuxer, every muxer, every codec — in the bundle; naming what
 * is used lets the build leave the rest out.
 */
const loadMediabunny = async (): Promise<MediabunnyModule> => {
  const {
    BlobSource,
    Conversion,
    ConversionCanceledError,
    Input,
    MP4,
    Mp4OutputFormat,
    Output,
    QTFF,
    Quality,
    StreamTarget,
    canEncodeVideo,
  } = await import('mediabunny');
  return {
    BlobSource,
    Conversion,
    ConversionCanceledError,
    Input,
    MP4,
    Mp4OutputFormat,
    Output,
    QTFF,
    Quality,
    StreamTarget,
    canEncodeVideo,
  } as unknown as MediabunnyModule;
};

function asMessage(error: unknown): Extract<FromWorker, { type: 'error' }> {
  if (isOverlayExportError(error)) return { type: 'error', code: error.code, message: error.message };
  return {
    type: 'error',
    code: 'render_failed',
    message: error instanceof Error ? error.message : 'The video could not be rendered.',
  };
}

export async function handleInspect(
  message: Extract<ToWorker, { type: 'inspect' }>,
  post: Post,
): Promise<void> {
  try {
    const mb = await loadMediabunny();
    post({ type: 'inspected', info: await inspectSource(mb, message.file, message) });
  } catch (error) {
    post(asMessage(error));
  }
}

const PROGRESS_INTERVAL_MS = 100;

export async function handleBurn(
  request: BurnRequest,
  controller: AbortController,
  post: Post,
): Promise<void> {
  const archive = await createArchiveSink(request.archiveName);
  try {
    // An MP4 goes back to patch its header, which only a file can do: a
    // render this size has no business in memory either.
    if (!archive.writeAt) {
      throw new OverlayExportError(
        'storage_failed',
        'A rendered video is too big to hold in memory, and this browser will not give the page a file to write it to.',
      );
    }
    const mb = await loadMediabunny();
    let lastPosted = 0;
    const result = await runBurn({
      mb,
      request,
      writeAt: archive.writeAt,
      signal: controller.signal,
      onProgress: (fraction, processedSeconds) => {
        const now = Date.now();
        if (fraction >= 1 || now - lastPosted >= PROGRESS_INTERVAL_MS) {
          lastPosted = now;
          post({ type: 'burnProgress', fraction, processedSeconds });
        }
      },
    });
    const file = await archive.finish();
    post({
      type: 'done',
      file,
      bytes: file.size,
      frameCount: result.frameCount,
      storage: archive.storage,
      notes: result.notes,
    });
  } catch (error) {
    await archive.abort();
    post(asMessage(error));
  }
}
