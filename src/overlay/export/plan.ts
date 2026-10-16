import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from './zip';

/**
 * AV-1006. What an export will be, worked out before it starts: how many
 * frames, how big the picture is, what it will cost, and whether the archive
 * format can hold it. Pure, so the panel can show it and the engine can check
 * it with the same numbers.
 */

/** Frame rates offered. A HUD whose values change at telemetry rate rarely needs 60. */
export const EXPORT_FRAME_RATES = [10, 15, 24, 25, 30, 50, 60] as const;
export const DEFAULT_EXPORT_FRAME_RATE = 30;

/** Pictures taller than this are not offered; 8K frames would not fit a 4 GB archive for long. */
export const EXPORT_HEIGHT_PRESETS = [720, 1080, 2160] as const;

/**
 * Measured in AV-1001 (TD-039): a 1080p overlay frame is about 125 KB as PNG and
 * takes 17 ms to draw and encode in Chromium. Frames of mostly transparent flat
 * colour scale with their area, which is all this estimate assumes — it is an
 * upper figure shown as "about", not a promise.
 */
const BYTES_PER_1080P_FRAME = 125_000;
const MS_PER_1080P_FRAME = 20;
const PIXELS_1080P = 1920 * 1080;

export interface ExportDimensions {
  width: number;
  height: number;
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** A picture of this aspect at this height. Sizes are even: some editors refuse odd ones. */
export function exportDimensions(aspect: number, height: number): ExportDimensions {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return { width: even(height * safeAspect), height: even(height) };
}

export interface ExportPlanInput {
  videoDurationSeconds: number;
  fps: number;
  width: number;
  height: number;
  /**
   * The most the archive may be, by what this browser can store it in: 4 GB for
   * a file on disk, far less in memory. Defaults to the ZIP format's own limit.
   */
  limitBytes?: number;
}

export interface ExportPlan extends ExportDimensions {
  fps: number;
  frameCount: number;
  /** Frames over frame rate: the video's length rounded up to a whole frame. */
  durationSeconds: number;
  estimatedBytes: number;
  estimatedSeconds: number;
  /** Whether it can be stored and zipped: under the storage limit, 65,535 files. */
  fitsArchive: boolean;
  /** The limit it was checked against. */
  limitBytes: number;
}

export function planExport({
  videoDurationSeconds,
  fps,
  width,
  height,
  limitBytes = ZIP_MAX_BYTES,
}: ExportPlanInput): ExportPlan {
  const rate = fps > 0 ? fps : DEFAULT_EXPORT_FRAME_RATE;
  const frameCount = Math.max(1, Math.ceil(Math.max(0, videoDurationSeconds) * rate - 1e-6));
  const scale = (width * height) / PIXELS_1080P;
  const estimatedBytes = Math.round(frameCount * BYTES_PER_1080P_FRAME * scale);
  return {
    width,
    height,
    fps: rate,
    frameCount,
    durationSeconds: frameCount / rate,
    estimatedBytes,
    estimatedSeconds: (frameCount * MS_PER_1080P_FRAME * Math.max(scale, 0.05)) / 1000,
    // One more file than there are frames: the metadata.
    fitsArchive: estimatedBytes < limitBytes && frameCount + 1 <= ZIP_MAX_ENTRIES,
    limitBytes,
  };
}

/** The highest offered frame rate at which the export fits an archive, if any does. */
export function highestFittingFrameRate(
  input: Omit<ExportPlanInput, 'fps'>,
): number | undefined {
  return [...EXPORT_FRAME_RATES].reverse().find((fps) => planExport({ ...input, fps }).fitsArchive);
}

/** The video time of a frame: frames are evenly spaced from zero. */
export function frameVideoTime(frameIndex: number, fps: number): number {
  return frameIndex / fps;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
