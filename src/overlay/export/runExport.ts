import { OverlayExportError } from './errors';
import { formatStartTimecode, sameFrameRate, type SourceTimecode } from '../timecode';
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
  /** TD-081. Where in the video the first frame belongs. */
  videoStartSeconds?: number;
  templateName: string;
  /**
   * AV-1026. The source video's timecode at this export's first frame, the
   * cut's start already added (TD-081); absent where the source has none.
   */
  startTimecode?: SourceTimecode;
  /** AV-1026. Name the frames by the source's own frame numbers, from `startTimecode`'s counter. */
  numberFramesBySource?: boolean;
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

/**
 * `frame_000001.png`. AV-1026: `firstNumber` is the number of the first frame,
 * 1 unless they are named by the source's frames; every name is as wide as the
 * last one's, so the files stay in order in a folder.
 */
export function frameFileName(frameIndex: number, frameCount: number, firstNumber = 1): string {
  const digits = Math.max(6, String(firstNumber + frameCount - 1).length);
  return `frame_${String(firstNumber + frameIndex).padStart(digits, '0')}.png`;
}

/**
 * The number the first frame carries in its name. Source numbering is refused,
 * here as in the panel, at a frame rate that is not the source's: the numbers
 * would name frames the source does not have.
 */
export function firstFrameNumber(
  options: Pick<RunExportOptions, 'fps' | 'startTimecode' | 'numberFramesBySource'>,
): number {
  const { startTimecode } = options;
  return options.numberFramesBySource && startTimecode && sameFrameRate(options.fps, startTimecode)
    ? startTimecode.startFrame
    : 1;
}

/** AV-1026. The timecode as the metadata file states it, or null with the reason beside it. */
function timecodeMetadata(timecode: SourceTimecode | undefined) {
  if (!timecode) {
    return { timecode: null, timecodeNote: 'The source video has no timecode, so none is written.' };
  }
  return {
    timecode: {
      start: formatStartTimecode(timecode),
      startFrame: timecode.startFrame,
      frameRate: { numerator: timecode.rate.numerator, denominator: timecode.rate.denominator },
      dropFrame: timecode.dropFrame,
      source: timecode.source,
      ...(timecode.note ? { note: timecode.note } : {}),
    },
  };
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
      videoStartSeconds: options.videoStartSeconds ?? 0,
      template: options.templateName,
      firstFrame: frameFileName(0, options.frameCount, firstFrameNumber(options)),
      ...timecodeMetadata(options.startTimecode),
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
  const firstNumber = firstFrameNumber(options);
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
    await zip.add(frameFileName(index, frameCount, firstNumber), png, modified);
    onProgress?.(index + 1, frameCount);
  }

  const { bytes } = await zip.finish();
  return { frameCount, bytes };
}
