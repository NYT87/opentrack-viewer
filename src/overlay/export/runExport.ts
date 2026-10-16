import { OverlayExportError } from './errors';
import { frameVideoTime } from './plan';
import { ZipWriter, type ZipSink } from './zip';

/**
 * AV-1006. The export loop, free of the browser: draw each frame, add it to
 * the archive, report progress, stop when asked. The worker supplies a real
 * canvas and a file to write to; tests supply a counter and an array — the
 * loop is the same.
 */

export interface RunExportOptions {
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  /** The video's length, for the metadata file. */
  videoDurationSeconds: number;
  telemetryOffsetSeconds: number;
  templateName: string;
  /** Draws the overlay at this video time and returns it as a PNG. */
  renderFrame: (frameIndex: number, videoTimeSeconds: number) => Promise<Uint8Array>;
  sink: ZipSink;
  signal?: AbortSignal;
  onProgress?: (framesDone: number, frameCount: number) => void;
  /** Stamp on every file in the archive; injectable so output is reproducible. */
  modified?: Date;
}

export interface RunExportResult {
  frameCount: number;
  /** Size of the finished archive. */
  bytes: number;
}

export const METADATA_FILE_NAME = 'overlay-export.json';

export function frameFileName(frameIndex: number, frameCount: number): string {
  const digits = Math.max(6, String(frameCount).length);
  return `frame_${String(frameIndex + 1).padStart(digits, '0')}.png`;
}

/**
 * What an editor needs to place the sequence: the numbers, and nothing about
 * where it came from — no file name, no coordinates, no telemetry.
 */
export function exportMetadata(options: RunExportOptions): string {
  return JSON.stringify(
    {
      format: 'png-sequence',
      transparent: true,
      width: options.width,
      height: options.height,
      frameRate: options.fps,
      frameCount: options.frameCount,
      durationSeconds: options.frameCount / options.fps,
      videoDurationSeconds: options.videoDurationSeconds,
      telemetryOffsetSeconds: options.telemetryOffsetSeconds,
      template: options.templateName,
      firstFrame: frameFileName(0, options.frameCount),
    },
    null,
    2,
  );
}

function throwIfStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OverlayExportError('cancelled', 'The export was stopped.');
}

export async function runExport(options: RunExportOptions): Promise<RunExportResult> {
  const { frameCount, fps, signal, onProgress } = options;
  const modified = options.modified ?? new Date();
  const zip = new ZipWriter(options.sink);

  throwIfStopped(signal);
  await zip.add(METADATA_FILE_NAME, new TextEncoder().encode(exportMetadata(options)), modified);
  onProgress?.(0, frameCount);

  for (let index = 0; index < frameCount; index += 1) {
    throwIfStopped(signal);
    let png: Uint8Array;
    try {
      png = await options.renderFrame(index, frameVideoTime(index, fps));
    } catch (error) {
      if (error instanceof OverlayExportError) throw error;
      throw new OverlayExportError(
        'render_failed',
        `Frame ${index + 1} of ${frameCount} could not be drawn.`,
        { cause: error },
      );
    }
    // A stop that arrived while the frame was drawing still lands before it is kept.
    throwIfStopped(signal);
    await zip.add(frameFileName(index, frameCount), png, modified);
    onProgress?.(index + 1, frameCount);
  }

  const { bytes } = await zip.finish();
  return { frameCount, bytes };
}
