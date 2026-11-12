import { CARDINALS, DEFAULT_COMPASS, compassAngle, compassPoint } from '../compass';
import { FIGURE_FONT_FAMILY, figureLayout, haloShadow } from '../figureLayout';
import { needsHalo, type ResolvedOverlayComponent } from '../template';
import type { Box, OverlayContext2D } from './drawOverlay';
import { drawLabelValue } from './drawText';

/**
 * AV-1019 (TD-087). Draws a compass in its box, for the heading shown.
 *
 * - `rose`: a ring with its cardinal points that turns so the heading is up,
 *   under a fixed marker at the top.
 * - `needle`: the same ring fixed with north up, and a needle along the heading.
 *
 * The heading is written as a figure ("123° SE") in the middle. Every point is
 * computed (never a rotated context), so the picture can be read back. The
 * caller has clipped to the box and painted its background.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** Shares of the compass' radius. */
export const COMPASS_GEOMETRY = {
  ring: 0.86,
  cardinalTick: 0.12,
  minorTick: 0.06,
  labels: 0.6,
  needleTip: 0.8,
  needleTail: 0.3,
  needleHalf: 0.08,
} as const;

export function drawCompass(ctx: OverlayContext2D, box: Box, ready: Ready, em: number, frameWidth: number): void {
  const setting = ready.component.compass ?? DEFAULT_COMPASS;
  const heading = ready.value;
  if (heading === undefined) return;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const R = Math.max(2, Math.min(box.w, box.h) / 2 - 0.25 * em);
  const ringRadius = COMPASS_GEOMETRY.ring * R;
  const at = (radius: number, angle: number) => compassPoint(cx, cy, radius, angle);

  // The ring, and a tick every 30 degrees, longer at the cardinal points.
  ctx.strokeStyle = setting.roseColor;
  ctx.lineCap = 'butt';
  ctx.lineWidth = Math.max(1.5, 0.035 * R);
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, 0.02 * R);
  ctx.beginPath();
  for (let bearing = 0; bearing < 360; bearing += 30) {
    const angle = compassAngle(setting.style, bearing, heading);
    const length = bearing % 90 === 0 ? COMPASS_GEOMETRY.cardinalTick : COMPASS_GEOMETRY.minorTick;
    const outer = at(ringRadius, angle);
    const inner = at(ringRadius - length * R, angle);
    ctx.moveTo(outer.x, outer.y);
    ctx.lineTo(inner.x, inner.y);
  }
  ctx.stroke();

  // The cardinal points: N in the needle's colour, which is the one to find.
  if (setting.labels) {
    const size = Math.max(6, 0.2 * R);
    const shadow = needsHalo(ready.style) ? haloShadow(ready.component.figure) : undefined;
    ctx.font = `bold ${size}px ${FIGURE_FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (shadow) {
      ctx.shadowColor = shadow;
      ctx.shadowBlur = 0.2 * em;
    }
    for (const { letter, bearing } of CARDINALS) {
      const point = at(COMPASS_GEOMETRY.labels * R, compassAngle(setting.style, bearing, heading));
      ctx.fillStyle = letter === 'N' ? setting.needleColor : setting.roseColor;
      ctx.fillText(letter, point.x, point.y, Math.max(1, 0.5 * R));
    }
    if (shadow) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
  }

  // The heading, written as a figure, in the middle (under the needle's pivot when there is one).
  const layout = figureLayout({ em, frameWidth, label: ready.label, value: ready.text ?? '', figure: ready.component.figure, track: false });
  const top = setting.style === 'needle' ? cy + 0.14 * R : cy - layout.contentHeight / 2;
  drawLabelValue(ctx, ready, layout, em, { x: cx, top, align: 'center', maxWidth: 1.3 * R });

  ctx.fillStyle = setting.needleColor;
  if (setting.style === 'rose') {
    // The fixed marker: a triangle at the top of the ring, pointing in.
    ctx.beginPath();
    ctx.moveTo(cx, cy - COMPASS_GEOMETRY.needleTip * R);
    ctx.lineTo(cx - COMPASS_GEOMETRY.needleHalf * R, cy - R);
    ctx.lineTo(cx + COMPASS_GEOMETRY.needleHalf * R, cy - R);
    ctx.closePath();
    ctx.fill();
  } else {
    // The needle: a long point along the heading and a short tail, the pivot between.
    const angle = compassAngle('needle', heading, heading);
    const tip = at(COMPASS_GEOMETRY.needleTip * R, angle);
    const tail = at(-COMPASS_GEOMETRY.needleTail * R, angle);
    const side = at(COMPASS_GEOMETRY.needleHalf * R, angle + Math.PI / 2);
    const other = at(COMPASS_GEOMETRY.needleHalf * R, angle - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(side.x, side.y);
    ctx.lineTo(tail.x, tail.y);
    ctx.lineTo(other.x, other.y);
    ctx.closePath();
    ctx.fill();
  }
}
