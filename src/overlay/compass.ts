import type { OverlayCompassSetting } from './template';
import { normalizeDegrees } from './derivedSeries';

/**
 * AV-1019 (TD-087). The compass: the pure part. Its defaults, and where the
 * rose and the needle point for a heading. Headings are degrees clockwise from
 * north; nothing here draws.
 */

export const DEFAULT_COMPASS: OverlayCompassSetting = {
  style: 'rose',
  labels: true,
  roseColor: '#ffffff',
  needleColor: '#ff6a00',
};

/** The four cardinal points, with the bearing each is at. */
export const CARDINALS = [
  { letter: 'N', bearing: 0 },
  { letter: 'E', bearing: 90 },
  { letter: 'S', bearing: 180 },
  { letter: 'W', bearing: 270 },
] as const;

/**
 * Where a bearing is drawn on the compass, as an angle in radians from the top,
 * clockwise (so a canvas point is `(cx + r sin a, cy - r cos a)`). A rose turns
 * so the heading is up: a bearing is at its difference from the heading. A needle
 * style keeps north up, and a bearing is where it is. The difference is taken
 * modulo a turn, so 359 degrees to 1 is a step of two degrees and not a swing.
 */
export function compassAngle(style: OverlayCompassSetting['style'], bearing: number, heading: number): number {
  const degrees = style === 'rose' ? normalizeDegrees(bearing - heading) : normalizeDegrees(bearing);
  return (degrees * Math.PI) / 180;
}

/** The point of a bearing on a circle of radius `r`, centred at `(cx, cy)`. */
export function compassPoint(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
}
