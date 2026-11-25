import { DEFAULT_DIAL, dialAngle, dialMajorStep, dialTickLabel, dialTicks } from '../dial';
import { FIGURE_FONT_FAMILY, figureLayout, haloShadow, type FigureLayout } from '../figureLayout';
import { needsHalo, type ResolvedOverlayComponent } from '../template';
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
  /**
   * AV-1020. The numbers beside the major ticks: their size, and the gap between
   * them and the ticks' inner ends. They are left out (all of them) when this
   * size is under `MIN_TICK_LABEL_PX` or two of them would touch.
   */
  tickLabel: 0.13,
  tickLabelGap: 0.04,
} as const;

/**
 * AV-1020. The smallest a tick number is drawn: 9 px on a frame 1920 wide, and the same
 * share of the frame's width on any other, so the preview (drawn smaller than the frame)
 * and the export agree on whether the numbers are there.
 */
export const MIN_TICK_LABEL_PX = 9;
const MIN_TICK_LABEL_FRAME_WIDTH = 1920;

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
  const metric = ready.component.source?.kind === 'metric' ? ready.component.source.metric : undefined;
  const display = { metric, units: ready.unitSystem ?? 'metric' } as const;
  const allTicks = dialTicks(range, setting, display);
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
  const textTop = cy + 0.2 * R;
  drawTickNumbers(ctx, ready, {
    ticks: allTicks,
    frameWidth,
    text: { layout, top: textTop, maxWidth: 1.5 * R },
    step: dialMajorStep(range, setting, display),
    metric,
    radius: outer - DIAL_GEOMETRY.majorTick * R - DIAL_GEOMETRY.tickLabelGap * R,
    size: DIAL_GEOMETRY.tickLabel * R,
    em,
    centre: [cx, cy],
    sweep: setting.sweep,
  });

  drawLabelValue(ctx, ready, layout, em, { x: cx, top: textTop, align: 'center', maxWidth: 1.5 * R });

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

/**
 * AV-1020 (TD-089). The numbers of the major ticks, in the units the dial is
 * shown in, inside the ticks and centred on them, in the figure's text colour and
 * halo. All or none: none when the size is under `MIN_TICK_LABEL_PX` or the widest
 * would be wider than the arc between two ticks, so they never overlap.
 */
function drawTickNumbers(
  ctx: OverlayContext2D,
  ready: Ready,
  at: { ticks: ReturnType<typeof dialTicks>; frameWidth: number; text: { layout: FigureLayout; top: number; maxWidth: number }; step: number; metric: Parameters<typeof dialTickLabel>[0]; radius: number; size: number; em: number; centre: readonly [number, number]; sweep: number },
): void {
  const majors = at.ticks.filter((tick) => tick.major && tick.value !== undefined);
  if (majors.length === 0 || at.size < (MIN_TICK_LABEL_PX * at.frameWidth) / MIN_TICK_LABEL_FRAME_WIDTH || at.radius <= 0) return;
  const font = `${at.size}px ${FIGURE_FONT_FAMILY}`;
  ctx.font = font;
  const labels = majors.map((tick) => dialTickLabel(at.metric, tick.value!, at.step));
  const widest = Math.max(...labels.map((text) => (typeof ctx.measureText === 'function' ? ctx.measureText(text)?.width : undefined) ?? text.length * at.size * 0.55));
  // Nor over the label and the value in the middle: if any number would touch a line, there are none.
  // Each line has its own band and its own width, estimated from its size alone (not measured), so the
  // preview, drawn smaller, and the export decide alike.
  const { layout } = at.text;
  const wide = (text: string, size: number, factor: number) => text.length * size * factor;
  const showLabel = layout.showLabel && Boolean(ready.label);
  const bands = [
    ...(showLabel ? [{ top: at.text.top, bottom: at.text.top + layout.labelAdvance, half: Math.min(at.text.maxWidth, wide(ready.label!, layout.labelSize, 0.6)) / 2 }] : []),
    { top: at.text.top + (showLabel ? layout.labelAdvance : 0), bottom: at.text.top + layout.contentHeight, half: Math.min(at.text.maxWidth, wide(ready.text ?? '', layout.valueSize, 0.5)) / 2 },
  ];
  const touches = majors.some((tick, i) => {
    const a = dialAngle(at.sweep, tick.fraction);
    const x = at.radius * Math.cos(a);
    const y = at.centre[1] + at.radius * Math.sin(a);
    const w = wide(labels[i]!, at.size, 0.55) / 2;
    return bands.some((band) => Math.abs(x) < band.half + w && y + at.size / 2 > band.top && y - at.size / 2 < band.bottom);
  });
  if (touches) return;
  const gaps = majors.slice(1).map((tick, i) => tick.fraction - majors[i]!.fraction);
  const arc = at.radius * ((at.sweep * Math.PI) / 180) * (gaps.length > 0 ? Math.min(...gaps) : 1);
  if (widest * 1.05 > arc) return;
  const shadow = needsHalo(ready.style) ? haloShadow(ready.component.figure) : undefined;
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = 0.2 * at.em;
  }
  ctx.fillStyle = ready.style.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  majors.forEach((tick, i) => {
    const a = dialAngle(at.sweep, tick.fraction);
    ctx.fillText(labels[i]!, at.centre[0] + at.radius * Math.cos(a), at.centre[1] + at.radius * Math.sin(a));
  });
  if (shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
}
