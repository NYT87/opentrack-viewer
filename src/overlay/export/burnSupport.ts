import type { BurnSourceInfo } from './protocol';

/**
 * AV-1007. Whether burned-in export can run here, and — once a video has been
 * looked at — whether it can run on *that* video. Every refusal says what is
 * missing and what the reader can do instead; none is decided by browser name.
 */

export interface BurnSupport {
  supported: boolean;
  reason?: string;
}

const OVERLAY_ONLY = 'The overlay-only export still works.';

/**
 * Phones and tablets: declared desktop-only until measured (TD-039) — they have
 * far less memory than the machines the figures came from, and an encoder that
 * is shared with the camera. iPadOS announces itself as a Mac, hence the touch check.
 */
export function isLikelyMobile(env: typeof globalThis = globalThis): boolean {
  const nav = env.navigator as
    | (Navigator & { userAgentData?: { mobile?: boolean } })
    | undefined;
  if (!nav) return false;
  if (nav.userAgentData?.mobile === true) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '')) return true;
  return /Macintosh/.test(nav.userAgent ?? '') && (nav.maxTouchPoints ?? 0) > 1;
}

export function getBurnSupport(env: typeof globalThis = globalThis): BurnSupport {
  if (isLikelyMobile(env)) {
    return {
      supported: false,
      reason: `Burned-in video export is available on desktop browsers only. ${OVERLAY_ONLY}`,
    };
  }
  const has = (name: string) => typeof (env as unknown as Record<string, unknown>)[name] === 'function';
  if (!has('Worker') || !has('OffscreenCanvas')) {
    return {
      supported: false,
      reason: `This browser cannot render video in the background. ${OVERLAY_ONLY}`,
    };
  }
  if (!has('VideoEncoder') || !has('VideoDecoder')) {
    return {
      supported: false,
      reason: `This browser has no video encoder and decoder (WebCodecs). Try a current version of Chrome, Edge or Safari. ${OVERLAY_ONLY}`,
    };
  }
  return { supported: true };
}

const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
};
export const codecName = (codec: string | null | undefined) =>
  codec ? (CODEC_NAMES[codec] ?? codec.toUpperCase()) : 'an unknown format';

export interface BurnReadiness {
  /** Reasons the render cannot be started. */
  errors: string[];
  /** Things to know before starting, that do not stop it. */
  notes: string[];
}

export interface BurnReadinessInput {
  info: BurnSourceInfo;
  tooLarge: boolean;
  estimatedBytes: number;
  /** Free space for the output in bytes, where the browser reports it. */
  freeBytes?: number;
  /** Whether the worker can write the output to a file (a burned-in render needs one). */
  fileStorage: boolean;
}

/** Whether this video can be rendered here, and what to tell the reader if not. */
export function describeBurnReadiness(input: BurnReadinessInput): BurnReadiness {
  const { info } = input;
  const errors: string[] = [];
  // The times are for a hardware encoder. The page asks for one but cannot be
  // told whether it got one, so what it can honestly say is "if".
  const notes: string[] = [
    'The time above assumes this browser uses a hardware video encoder, which it is asked for but cannot confirm. Without one the render is slower, possibly much slower.',
  ];

  if (!info.video) {
    errors.push(`This file has no video picture to draw on. ${OVERLAY_ONLY}`);
  } else if (!info.video.canDecode) {
    errors.push(
      `This browser cannot decode this video (${codecName(info.video.codec)}, ${info.video.width} × ${info.video.height}), so it cannot be rendered here. ${OVERLAY_ONLY}`,
    );
  }
  if (input.tooLarge) {
    errors.push(
      `This picture is larger than this export can handle (over 4K). Choose a smaller picture size. ${OVERLAY_ONLY}`,
    );
  }
  if (!info.canEncode) {
    errors.push(
      `This browser cannot encode H.264 video at this size, so it cannot render here. ${OVERLAY_ONLY}`,
    );
  }
  if (!input.fileStorage) {
    errors.push(
      `A rendered video is too big to hold in memory, and this browser will not give the page a file to write it to. ${OVERLAY_ONLY}`,
    );
  } else if (input.freeBytes !== undefined && input.estimatedBytes * 1.1 > input.freeBytes) {
    errors.push(
      `There is not enough free space on this device for the render: it needs about ${formatGB(input.estimatedBytes)} and the browser reports ${formatGB(input.freeBytes)} free.`,
    );
  }

  // The audio decision (TD-039): packets are copied through unchanged, so there
  // is no decode, no re-encode and no drift. AAC — what a GoPro writes — is
  // certain to be copyable into an MP4. Anything else is up to the conversion:
  // copied if an MP4 can hold it as it is, otherwise converted to a codec this
  // browser can encode and an MP4 can hold, and left out if there is none.
  // Which of the three happens is known only once the render starts, so the
  // page says only that, and reports a dropped track afterwards.
  if (info.audio) {
    if (info.audio.codec === 'aac') {
      notes.push('The sound is copied from your video unchanged.');
    } else {
      notes.push(
        `The sound (${codecName(info.audio.codec)}) is copied unchanged if an MP4 can hold it as it is. If not, it is converted where this browser can, and left out where it cannot — you are told if that happens.`,
      );
    }
  } else {
    notes.push('This video has no sound.');
  }
  return { errors, notes };
}

function formatGB(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
