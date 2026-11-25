/**
 * AV-1007. What a burned-in render will cost, worked out before it starts.
 *
 * The numbers come from AV-1001's measurements (TD-039), taken with a hardware
 * H.264 encoder — which a browser cannot be asked to confirm, so they are a best
 * case and the panel says so. Hardware H.264 decodes,
 * composites and encodes a 480p clip at 10.6× real time and is bounded by the
 * encoder at 1080p (about 4–6×) and 4K (1.2–1.7×). Between and beyond those
 * points the speed scales with the picture's area, and every figure is shown as
 * "roughly" — the first real 4K file is where to re-measure.
 */

/**
 * Largest picture the browser's encoders are trusted with: UHD, with a little
 * room for DCI 4K. Bounded three ways, because a pixel budget alone lets a
 * 5000 × 1000 strip through that no encoder is specified for. The
 * limits are on the long and short side, so a portrait 4K phone video
 * (2160 × 3840) is as welcome as a landscape one.
 */
export const BURN_MAX_PIXELS = 4096 * 2176;
export const BURN_MAX_LONG_SIDE = 4096;
export const BURN_MAX_SHORT_SIDE = 2304;
export const BURN_MIN_BITRATE = 2_000_000;
export const BURN_MAX_BITRATE = 60_000_000;
const AUDIO_BYTES_PER_SECOND = 24_000; // a 192 kbps AAC track, copied unchanged

const PIXELS_1080P = 1920 * 1080;
/** Real-time multiple at 1080p, from the encoder ceiling in TD-039 (4–6×, taken low). */
const REALTIME_MULTIPLE_1080P = 4.5;
const REALTIME_MULTIPLE_MIN = 1.2;
const REALTIME_MULTIPLE_MAX = 10;

/** H.264 bits per pixel per frame that keeps overlay text clean: ~7.5 Mbps at 1080p30. */
const BITS_PER_PIXEL = 0.12;

export function burnBitrate(width: number, height: number, frameRate = 30): number {
  const bits = width * height * Math.max(1, frameRate) * BITS_PER_PIXEL;
  return Math.round(Math.min(BURN_MAX_BITRATE, Math.max(BURN_MIN_BITRATE, bits)));
}

export interface BurnPlanInput {
  videoDurationSeconds: number;
  width: number;
  height: number;
  frameRate?: number;
  hasAudio: boolean;
}

export interface BurnPlan {
  width: number;
  height: number;
  bitrate: number;
  estimatedBytes: number;
  /** How long the render will take, roughly. */
  estimatedSeconds: number;
  /** Times faster than the video's own length. */
  realtimeMultiple: number;
  tooLarge: boolean;
}

export function planBurn(input: BurnPlanInput): BurnPlan {
  const { width, height } = input;
  const duration = Math.max(0, input.videoDurationSeconds);
  const bitrate = burnBitrate(width, height, input.frameRate);
  const pixels = width * height;
  const multiple = Math.min(
    REALTIME_MULTIPLE_MAX,
    Math.max(REALTIME_MULTIPLE_MIN, (REALTIME_MULTIPLE_1080P * PIXELS_1080P) / Math.max(1, pixels)),
  );
  return {
    width,
    height,
    bitrate,
    estimatedBytes: Math.round(
      (duration * bitrate) / 8 + (input.hasAudio ? duration * AUDIO_BYTES_PER_SECOND : 0),
    ),
    estimatedSeconds: duration / multiple,
    realtimeMultiple: multiple,
    tooLarge:
      pixels > BURN_MAX_PIXELS ||
      Math.max(width, height) > BURN_MAX_LONG_SIDE ||
      Math.min(width, height) > BURN_MAX_SHORT_SIDE,
  };
}
