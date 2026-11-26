import type { OverlaySpeed, OverlayVideoTiming } from '../state/overlayStore';
import type { VideoTimeWarp } from './timeline';

/** The largest "N× faster" the control takes (AV-1027). */
export const MAX_SPEED_FACTOR = 1000;

/**
 * AV-1027 (TD-099). The warp in effect for a video: the reader's choice, or the video's default (the
 * camera's timing where it was detected, else real time). The one place the preview and both export
 * panels read it from, so they cannot disagree.
 */
export function effectiveWarp(
  timing: Pick<OverlayVideoTiming, 'warp'> | undefined,
  speed: OverlaySpeed | undefined,
): VideoTimeWarp | undefined {
  if (!speed || speed.mode === 'camera') return timing?.warp;
  const { factor } = speed;
  return Number.isFinite(factor) && factor > 0 && factor !== 1 ? { kind: 'factor', factor } : undefined;
}

/** The warp's overall seconds of activity per second of video; 1 at real time. */
export function overallFactor(warp: VideoTimeWarp | undefined): number {
  if (!warp) return 1;
  if (warp.kind === 'factor') return warp.factor;
  const last = warp.video.length - 1;
  return last > 0 && warp.video[last]! > warp.video[0]! ? (warp.real[last]! - warp.real[0]!) / (warp.video[last]! - warp.video[0]!) : 1;
}
