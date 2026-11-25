import { ActivityError } from '../domain/errors';
import type { OverlayContext2D, OverlayRenderer } from './renderOverlay';
import { createZipWriter } from './zip';

/**
 * AV-1006. Overlay-only export: the overlay as a numbered sequence of
 * transparent PNGs, in zip files.
 *
 * A sequence rather than a video because it is the one format every browser can
 * make and every editor can read with its alpha channel intact. Nothing about
 * the source video is touched or even needed beyond its length.
 *
 * Frames are produced one at a time and packed into archives as they go. An
 * archive is handed to the caller the moment it is full, and then forgotten, so
 * memory is bounded by the size of one archive however long the clip is.
 */

export interface FrameExportOptions {
  fps: number;
  width: number;
  height: number;
  /** Video time of the first frame, in seconds. */
  startSeconds: number;
  /** Video time the sequence ends at (exclusive), in seconds. */
  endSeconds: number;
  /** The same telemetry offset the preview uses. */
  offsetSeconds: number;
}

export const MIN_FPS = 1;
export const MAX_FPS = 120;
export const MIN_FRAME_SIZE = 16;
/** PNG encoding time and canvas memory climb steeply past this. */
export const MAX_FRAME_SIZE = 4096;
/** About 30 minutes at 30 fps. Beyond this the export takes hours, not minutes. */
export const MAX_FRAMES = 54_000;
/** An archive is closed when it reaches either limit, so memory stays bounded. */
export const FRAMES_PER_ARCHIVE = 1_500;
export const BYTES_PER_ARCHIVE = 200 * 1024 * 1024;

export interface FrameExportPlan {
  frameCount: number;
  durationSeconds: number;
  /** At least this many archives; more if frames turn out large. */
  minimumArchives: number;
}

/**
 * Checks the options and says how big the export is, before any work is done.
 * Throws a typed error that says which setting to change.
 */
export function planFrameExport(options: FrameExportOptions): FrameExportPlan {
  const fail = (code: 'invalid_selected_range' | 'overlay_export_too_large', message: string): never => {
    throw new ActivityError(code, message);
  };
  const { fps, width, height, startSeconds, endSeconds, offsetSeconds } = options;

  if (![fps, width, height, startSeconds, endSeconds, offsetSeconds].every(Number.isFinite)) {
    fail('invalid_selected_range', 'Every setting must be a number.');
  }
  if (!Number.isInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) {
    fail('invalid_selected_range', `The frame rate must be a whole number from ${MIN_FPS} to ${MAX_FPS}.`);
  }
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < MIN_FRAME_SIZE) {
      fail('invalid_selected_range', `The ${name} must be a whole number of at least ${MIN_FRAME_SIZE} pixels.`);
    }
    if (value > MAX_FRAME_SIZE) {
      fail('overlay_export_too_large', `The ${name} can be at most ${MAX_FRAME_SIZE} pixels.`);
    }
  }
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    fail('invalid_selected_range', 'The end of the range must be after its start, and neither can be negative.');
  }

  const durationSeconds = endSeconds - startSeconds;
  const frameCount = Math.ceil(durationSeconds * fps - 1e-9);
  if (frameCount < 1) fail('invalid_selected_range', 'That range is too short to hold a frame.');
  if (frameCount > MAX_FRAMES) {
    fail(
      'overlay_export_too_large',
      `That is ${frameCount.toLocaleString('en-US')} frames; the most one export makes is ${MAX_FRAMES.toLocaleString('en-US')}.`,
    );
  }
  return { frameCount, durationSeconds, minimumArchives: Math.ceil(frameCount / FRAMES_PER_ARCHIVE) };
}

/** Where frames are drawn and encoded. Injectable so the export can be tested without a canvas. */
export interface FrameSurface {
  context: OverlayContext2D;
  /** Encodes what has been drawn as a PNG. */
  toPng(): Promise<Uint8Array>;
}
export type CreateSurface = (width: number, height: number) => FrameSurface | undefined;

/** A canvas the browser provides, off-screen where it can, or undefined where it cannot draw. */
export const createBrowserSurface: CreateSurface = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (context && typeof canvas.convertToBlob === 'function') {
        return {
          context: context as unknown as OverlayContext2D,
          toPng: async () =>
            new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()),
        };
      }
    } catch {
      /* fall through to a DOM canvas */
    }
  }
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context || typeof canvas.toBlob !== 'function') return undefined;
  return {
    context: context as unknown as OverlayContext2D,
    toPng: () =>
      new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('The frame could not be encoded.'));
            return;
          }
          void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
        }, 'image/png');
      }),
  };
};

export interface FrameArchive {
  /** 1-based, in the order they are produced. */
  index: number;
  fileName: string;
  blob: Blob;
  /** 1-based, inclusive: the frames this archive holds. */
  firstFrame: number;
  lastFrame: number;
  bytes: number;
}

export interface FrameProgress {
  framesDone: number;
  frameCount: number;
  archivesDone: number;
  elapsedMs: number;
  /** Estimated time left, once enough has been done to estimate. */
  remainingMs?: number;
}

export interface FrameExportRun {
  options: FrameExportOptions;
  renderer: OverlayRenderer;
  /** Base name for files; never the video's name. */
  baseName: string;
  signal?: AbortSignal;
  onProgress?: (progress: FrameProgress) => void;
  /** Called with each finished archive; the export waits for it, so a slow save slows the export, not memory. */
  onArchive: (archive: FrameArchive) => void | Promise<void>;
  createSurface?: CreateSurface;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface FrameExportResult {
  frameCount: number;
  archives: Omit<FrameArchive, 'blob'>[];
}

const pad = (n: number, digits: number) => String(n).padStart(digits, '0');
const frameFileName = (baseName: string, frame: number) => `${baseName}_${pad(frame, 6)}.png`;
const archiveFileName = (baseName: string, index: number) => `${baseName}-frames-part-${pad(index, 2)}.zip`;

/** Lets the page paint and respond between batches of frames. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const YIELD_EVERY = 16;

/** The note put in the first archive: what an editor needs to know to use the frames. */
export function readmeText(options: FrameExportOptions, frameCount: number): string {
  return [
    'Overlay frames (transparent PNG sequence)',
    '',
    `Frame rate:  ${options.fps} fps`,
    `Frame size:  ${options.width} x ${options.height} pixels`,
    `Frames:      ${frameCount}`,
    `Duration:    ${(frameCount / options.fps).toFixed(3)} seconds`,
    `Starts at:   ${options.startSeconds} s into the video`,
    '',
    'Frames are numbered from 000001 in video order.',
    'A long sequence is split across several zip files (part-01, part-02, ...).',
    'Unzip every part into the same folder, then import the folder as an image',
    `sequence at ${options.fps} fps. The PNGs have a transparent background; place`,
    'the sequence on a track above the video.',
    '',
  ].join('\n');
}

/**
 * Renders the sequence. Resolves with a summary when every frame is written, and
 * rejects with a typed error if the options are unusable, the browser cannot
 * draw, the signal aborts, or a frame cannot be encoded.
 *
 * Frame `i` shows video time `startSeconds + i / fps`, drawn by the same
 * renderer and the same `offsetSeconds` the preview uses, so a frame in the file
 * is the frame that was on screen.
 */
export async function exportFrameSequence(run: FrameExportRun): Promise<FrameExportResult> {
  const { options, renderer, baseName, signal, onProgress, onArchive } = run;
  const plan = planFrameExport(options);
  const clock = run.now ?? (() => performance.now());
  const cancelled = () => new ActivityError('overlay_export_cancelled', 'The export was stopped.');

  if (signal?.aborted) throw cancelled();
  const surface = (run.createSurface ?? createBrowserSurface)(options.width, options.height);
  if (!surface) {
    throw new ActivityError(
      'overlay_export_unsupported',
      'This browser cannot draw images for the overlay.',
    );
  }

  const startedAt = clock();
  const archives: FrameExportResult['archives'] = [];
  let zip = createZipWriter();
  let firstFrameInArchive = 1;
  let framesInArchive = 0;

  const closeArchive = async (lastFrame: number) => {
    if (framesInArchive === 0) return;
    const blob = zip.finish();
    const archive: FrameArchive = {
      index: archives.length + 1,
      fileName: archiveFileName(baseName, archives.length + 1),
      blob,
      firstFrame: firstFrameInArchive,
      lastFrame,
      bytes: blob.size,
    };
    const { blob: _handedOver, ...summary } = archive;
    void _handedOver;
    archives.push(summary);
    await onArchive(archive);
    zip = createZipWriter();
    framesInArchive = 0;
    firstFrameInArchive = lastFrame + 1;
  };

  try {
    for (let i = 0; i < plan.frameCount; i += 1) {
      if (signal?.aborted) throw cancelled();

      const frame = i + 1;
      renderer.render(
        surface.context,
        options.width,
        options.height,
        options.startSeconds + i / options.fps,
        options.offsetSeconds,
      );
      zip.add(frameFileName(baseName, frame), await surface.toPng());
      framesInArchive += 1;
      // The readme goes in with the first frame so the first archive carries it.
      if (frame === 1) zip.add('README.txt', new TextEncoder().encode(readmeText(options, plan.frameCount)));

      const archiveFull =
        framesInArchive >= FRAMES_PER_ARCHIVE || zip.size >= BYTES_PER_ARCHIVE || frame === plan.frameCount;
      if (archiveFull) await closeArchive(frame);

      const elapsedMs = clock() - startedAt;
      onProgress?.({
        framesDone: frame,
        frameCount: plan.frameCount,
        archivesDone: archives.length,
        elapsedMs,
        ...(frame >= 5 ? { remainingMs: (elapsedMs / frame) * (plan.frameCount - frame) } : {}),
      });

      if (frame % YIELD_EVERY === 0) await yieldToEventLoop();
    }
  } catch (error) {
    if (error instanceof ActivityError) throw error;
    throw new ActivityError('overlay_export_failed', 'A frame could not be written.', { cause: error });
  }

  return { frameCount: plan.frameCount, archives };
}
