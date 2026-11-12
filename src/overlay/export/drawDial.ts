import { DEFAULT_DIAL, dialAngle, dialTicks } from '../dial';
import { figureLayout } from '../figureLayout';
import type { ResolvedOverlayComponent } from '../template';
import type { Box, OverlayContext2D } from './drawOverlay';
import { drawLabelValue } from './drawText';

/**
 * AV-1019 (TD-087). Draws a dial in its box: a track, the part of it up to the
 * value filled, ticks, a needle or a marker at the value's place, and the label
 * and value in the middle. The arc is centred at the top and opens `sweep`
 * degrees; a value beyond the range sits at its end (the fraction is pinned).
 *
 * The one drawing for the canvas preview, the PNG sequence, the WebM, the
 * burned-in video and the map video. The caller has clipped to the box and
 * painted its background. The needle is drawn from absolute points, never a
 * rotated context, so what is drawn can be read back and tested.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** Where a needle's tip and a marker are, as shares of the dial's radius. */
export const DIAL_GEOMETRY = {
  /** The arc's stroke width. */
  arcWidth: 0.13,
  /** Ticks start this far inside the arc, and are this long. */
  tickGap: 0.05,
  majorTick: 0.13,
  minorTick: 0.07,
  /** The needle's tip, from the centre. */
  needleTip: 0.74,
  hub: 0.07,
} as const;

export function drawDial(ctx: OverlayContext2D, box: Box, ready: Ready, em: number, frameWidth: number): void {
  const setting = ready.component.dial ?? DEFAULT_DIAL;
  const range = ready.range;
  if (!range) return;
  const fraction = ready.fraction ?? 0;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // A little room inside the box for the marker, which is wider than the arc.
  const R = Math.max(2, (Math.min(box.w, box.h) / 2 - 0.3 * em) / 1.03);
  const arcWidth = Math.max(1.5, DIAL_GEOMETRY.arcWidth * R);
  const arcRadius = R - arcWidth / 2;
  const start = dialAngle(setting.sweep, 0);
  const end = dialAngle(setting.sweep, 1);
  const angle = dialAngle(setting.sweep, fraction);
  const polar = (radius: number, a: number) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;

  // The track, and the part of it up to the value.
  ctx.lineCap = 'butt';
  ctx.lineWidth = arcWidth;
  ctx.strokeStyle = setting.trackColor;
  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, start, end);
  ctx.stroke();
  if (fraction > 0) {
    ctx.strokeStyle = setting.fillColor;
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, start, angle);
    ctx.stroke();
  }

  // The ticks, inside the arc: major ones longer.
  const outer = R - arcWidth - DIAL_GEOMETRY.tickGap * R;
  ctx.strokeStyle = setting.trackColor;
  ctx.lineCap = 'butt';
  const allTicks = dialTicks(range, setting);
  for (const major of [false, true]) {
    ctx.lineWidth = Math.max(1, (major ? 0.025 : 0.015) * R);
    ctx.beginPath();
    for (const tick of allTicks) {
      if (tick.major !== major) continue;
      const a = dialAngle(setting.sweep, tick.fraction);
      const [x1, y1] = polar(outer, a);
      const [x2, y2] = polar(outer - (major ? DIAL_GEOMETRY.majorTick : DIAL_GEOMETRY.minorTick) * R, a);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }

  // The label and the value, in the middle, under where the needle turns.
  const layout = figureLayout({ em, frameWidth, label: ready.label, value: ready.text ?? '', figure: ready.component.figure, track: false });
  drawLabelValue(ctx, ready, layout, em, { x: cx, top: cy + 0.2 * R, align: 'center', maxWidth: 1.5 * R });

  // The pointer, over the text.
  ctx.fillStyle = setting.needleColor;
  ctx.strokeStyle = setting.needleColor;
  if (setting.pointer === 'needle') {
    const [tx, ty] = polar(DIAL_GEOMETRY.needleTip * R, angle);
    ctx.lineWidth = Math.max(1.5, 0.045 * R);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, DIAL_GEOMETRY.hub * R), 0, Math.PI * 2);
    ctx.fill();
  } else {
    // A marker: a dot on the arc at the value, a little wider than the arc.
    const [mx, my] = polar(arcRadius, angle);
    ctx.beginPath();
    ctx.arc(mx, my, Math.max(2, 0.7 * arcWidth), 0, Math.PI * 2);
    ctx.fill();
  }
}
