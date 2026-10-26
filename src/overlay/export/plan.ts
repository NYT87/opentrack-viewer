import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from './zip';

/**
 * AV-1006. What an export will be, worked out before it starts: how many
 * frames, how big the picture is, what it will cost, and whether the archive
 * format can hold it. Pure, so the panel can show it and the engine can check
 * it with the same numbers.
 */

/**
 * Frame rates offered. A HUD whose values change at telemetry rate rarely needs
 * 60, but an editor needs the overlay at its timeline's rate.
 *
 * TD-059. The NTSC rates are the exact fractions cameras record at, not their
 * rounded names: a GoPro records 29.97 fps as 30000/1001, and an overlay
 * exported at a flat 30 drifts against it by about 0.6 s every ten minutes once
 * an editor conforms it to the clip's timeline.
 */
export const EXPORT_FRAME_RATES = [10, 15, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60] as const;
export const DEFAULT_EXPORT_FRAME_RATE = 30;

/** A frame rate as an editor names it: 29.97, not 29.970029970029970. */
export function formatFrameRate(fps: number): string {
  if (Number.isInteger(fps)) return String(fps);
  const short = Math.round(fps * 100) / 100;
  // 23.976 is the one name with three decimals.
  return Math.abs(fps - 24000 / 1001) < 1e-6 ? '23.976' : String(short);
}

/** Pictures taller than this are not offered; 8K frames would not fit a 4 GB archive for long. */
export const EXPORT_HEIGHT_PRESETS = [720, 1080, 2160] as const;

/**
 * Measured in AV-1001 (TD-039): a 1080p overlay frame is about 125 KB as PNG and
 * takes 17 ms to draw and encode in Chromium. Frames of mostly transparent flat
 * colour scale with their area. A small frame does not go below a floor, the
 * PNG and ZIP headers and the type's edges: 180 frames at 256 × 144 came to
 * 781 KB, about 4.3 KB a frame, against 2.2 KB by area (TD-059). It is shown
 * as "about", not as a promise.
 */
const BYTES_PER_1080P_FRAME = 125_000;
const MIN_BYTES_PER_FRAME = 4_500;
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
  const estimatedBytes = Math.round(frameCount * Math.max(MIN_BYTES_PER_FRAME, BYTES_PER_1080P_FRAME * scale));
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

/**
 * AV-1012. The transparent WebM is recorded from a canvas held in memory, so it
 * is limited by what a tab can hold rather than by a file format.
 */
export const WEBM_MAX_BYTES = 2_000_000_000;

/**
 * The bitrate the recorder is asked for: 8 Mbit/s at 1080p, scaled with the
 * picture's area and held between 1 and 24 Mbit/s. It is a ceiling: an overlay
 * is mostly clear, and VP9 spends little on what does not change.
 */
export function webmBitsPerSecond(width: number, height: number): number {
  const scaled = Math.round((8_000_000 * width * height) / PIXELS_1080P);
  return Math.min(24_000_000, Math.max(1_000_000, scaled));
}

export interface WebmExportPlan extends ExportDimensions {
  fps: number;
  frameCount: number;
  durationSeconds: number;
  bitsPerSecond: number;
  /** At most this: the bitrate over the whole length. */
  estimatedBytes: number;
  /** Recorded in real time, so as long as the overlay itself. */
  estimatedSeconds: number;
  /** Whether the recording can be held in memory. */
  fits: boolean;
  limitBytes: number;
}

export function planWebmExport({
  videoDurationSeconds,
  fps,
  width,
  height,
  limitBytes = WEBM_MAX_BYTES,
}: ExportPlanInput): WebmExportPlan {
  const frames = planExport({ videoDurationSeconds, fps, width, height });
  const bitsPerSecond = webmBitsPerSecond(width, height);
  const estimatedBytes = Math.round((bitsPerSecond * frames.durationSeconds) / 8);
  return {
    width,
    height,
    fps: frames.fps,
    frameCount: frames.frameCount,
    durationSeconds: frames.durationSeconds,
    bitsPerSecond,
    estimatedBytes,
    estimatedSeconds: frames.durationSeconds,
    fits: estimatedBytes < limitBytes,
    limitBytes,
  };
}
