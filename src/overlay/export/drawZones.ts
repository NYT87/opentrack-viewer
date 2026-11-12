import { formatDuration } from '../../domain/units';
import { FIGURE_FONT_FAMILY, haloShadow } from '../figureLayout';
import { needsHalo, type ResolvedOverlayComponent } from '../template';
import type { Box, OverlayContext2D } from './drawOverlay';

/**
 * AV-1018 (TD-086). Draws a zones component in its box: the zones as a
 * horizontal bar, a vertical bar, a segmented arc or a single coloured figure,
 * the current zone bright and the others dimmed, with a marker at the value's
 * place in its zone; and, where they are set to be shown, the zone's number
 * and name, the value, and the time spent in each zone so far.
 *
 * The one drawing: the preview, the PNG sequence, the WebM, the burned-in video,
 * the map video and the map image all call it through `createOverlayRenderer`.
 * The caller has clipped to the box and painted its background. Type uses the
 * figures' own fonts, sizes and halo (AV-1015); nothing is read from the canvas.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** The unselected zones, as a share of full colour. */
const DIMMED = 0.35;

/** Format a number of seconds as m:ss, or h:mm:ss from an hour. */
const clock = (seconds: number) => formatDuration(seconds);

/**
 * `times` is the seconds in each zone up to this moment, or `undefined` when
 * the activity cannot say (then no time is drawn).
 */
export function drawZones(
  ctx: OverlayContext2D,
  box: Box,
  ready: Ready,
  em: number,
  frameWidth: number,
  times: readonly number[] | undefined,
): void {
  const resolved = ready.zones;
  if (!resolved) return;
  const { setting, index, within } = resolved;
  const zones = setting.zones;
  const current = zones[index]!;
  const figure = ready.component.figure;
  const { show } = setting;

  const pad = 0.5 * em;
  const labelSize = 0.55 * em * (figure?.labelScale ?? 1);
  const valueSize = 1.1 * em * (figure?.valueScale ?? 1);
  const timeSize = 0.42 * em;
  const labelFont = `${labelSize}px ${FIGURE_FONT_FAMILY}`;
  const valueFont = `bold ${valueSize}px ${FIGURE_FONT_FAMILY}`;
  const timeFont = `${timeSize}px ${FIGURE_FONT_FAMILY}`;
  const align = figure?.align ?? 'left';
  const innerWidth = Math.max(1, box.w - 2 * pad);
  const textX = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w - pad : box.x + pad;
  const shadow = needsHalo(ready.style) ? haloShadow(figure) : undefined;

  // What the header says: the zone's number and name over the value.
  const number = show.number ? `Z${index + 1}` : '';
  const name = show.name ? current.name : '';
  const labelText = [number, name].filter(Boolean).join(' ');
  const valueText = show.value ? (ready.text ?? '') : '';
  // A coloured figure is its value (or, with no value, its zone) in the zone's colour.
  const figureShape = setting.shape === 'figure';
  const bigText = figureShape ? valueText || labelText : valueText;
  const smallText = figureShape ? (valueText ? labelText : '') : labelText;
  const showSmall = smallText !== '' && figure?.showLabel !== false;

  const text = (value: string, x: number, y: number, font: string, color: string, alpha: number, maxWidth: number) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.fillText(value, x, y, Math.max(1, maxWidth));
  };
  const withShadow = (draw: () => void) => {
    if (shadow) {
      ctx.shadowColor = shadow;
      ctx.shadowBlur = 0.2 * em;
    }
    draw();
    if (shadow) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  };

  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  let y = box.y + pad * 0.6;

  withShadow(() => {
    if (showSmall) {
      text(smallText, textX, y, labelFont, figure?.labelColor ?? (figureShape ? current.color : ready.style.textColor), 0.85, innerWidth);
      y += figure?.gap === undefined ? labelSize * 1.2 : labelSize + figure.gap * frameWidth;
    }
    if (bigText) {
      // A figure takes the room that is left under its label; any other shape writes the value in the text colour.
      const color = figureShape ? current.color : ready.style.textColor;
      text(bigText, textX, y, valueFont, color, 1, innerWidth);
      y += valueSize * 1.1;
    }
  });

  const timeRow = show.timeInZone && times !== undefined && setting.shape !== 'vertical';
  const timeHeight = timeRow ? timeSize * 1.5 : 0;
  const areaTop = y + (bigText || showSmall ? 0.25 * em : 0);
  const areaBottom = box.y + box.h - pad * 0.6 - timeHeight;
  const area: Box = { x: box.x + pad, y: areaTop, w: innerWidth, h: areaBottom - areaTop };

  if (!figureShape && area.w > 1 && area.h > 1) {
    if (setting.shape === 'horizontal') drawBar(ctx, area, zones, index, within, ready, em, 'horizontal', times, show.timeInZone, timeFont);
    else if (setting.shape === 'vertical') drawBar(ctx, area, zones, index, within, ready, em, 'vertical', times, show.timeInZone, timeFont);
    else drawArc(ctx, area, zones, index, within, ready, em);
  }

  if (timeRow && times) {
    // One small time under each zone's share of the width, in its colour; the current one bright.
    const cell = innerWidth / zones.length;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const rowY = box.y + box.h - pad * 0.6 - timeSize * 1.2;
    zones.forEach((zone, i) => {
      text(clock(times[i] ?? 0), box.x + pad + cell * (i + 0.5), rowY, timeFont, zone.color, i === index ? 1 : 0.75, cell);
    });
    ctx.globalAlpha = 1;
  }
}

/** A bar of segments of equal size: left to right, or bottom to top, so the hotter zones are higher. */
function drawBar(
  ctx: OverlayContext2D,
  area: Box,
  zones: readonly { color: string }[],
  index: number,
  within: number,
  ready: Ready,
  em: number,
  direction: 'horizontal' | 'vertical',
  times: readonly number[] | undefined,
  withTimes: boolean,
  timeFont: string,
): void {
  const n = zones.length;
  const gap = Math.min(0.12 * em, (direction === 'horizontal' ? area.w : area.h) / (n * 4));
  const thickness = direction === 'horizontal' ? Math.min(area.h, 1.3 * em) : Math.min(area.w, 1.3 * em);
  const along = direction === 'horizontal' ? area.w : area.h;
  const segment = (along - gap * (n - 1)) / n;
  const markerWidth = Math.max(1.5, 0.14 * em);
  zones.forEach((zone, i) => {
    const offset = i * (segment + gap);
    ctx.globalAlpha = i === index ? 1 : DIMMED;
    ctx.fillStyle = zone.color;
    if (direction === 'horizontal') ctx.fillRect(area.x + offset, area.y, segment, thickness);
    else ctx.fillRect(area.x, area.y + area.h - offset - segment, thickness, segment);
  });
  ctx.globalAlpha = 1;
  const markerAt = index * (segment + gap) + within * segment;
  ctx.fillStyle = ready.style.textColor;
  if (direction === 'horizontal') {
    ctx.fillRect(area.x + markerAt - markerWidth / 2, area.y - 0.12 * em, markerWidth, thickness + 0.24 * em);
  } else {
    ctx.fillRect(area.x - 0.12 * em, area.y + area.h - markerAt - markerWidth / 2, thickness + 0.24 * em, markerWidth);
  }
  if (direction === 'vertical' && withTimes && times) {
    // The times beside the bar, one per zone, level with its segment.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = timeFont;
    zones.forEach((zone, i) => {
      ctx.fillStyle = zone.color;
      ctx.globalAlpha = i === index ? 1 : 0.75;
      ctx.fillText(formatDuration(times[i] ?? 0), area.x + thickness + 0.4 * em, area.y + area.h - i * (segment + gap) - segment / 2, Math.max(1, area.w - thickness - 0.4 * em));
    });
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'top';
  }
}

/** The arc is 240 degrees open at the bottom, the first zone at its left end. */
const ARC_START = (150 * Math.PI) / 180;
const ARC_SWEEP = (240 * Math.PI) / 180;

function drawArc(ctx: OverlayContext2D, area: Box, zones: readonly { color: string }[], index: number, within: number, ready: Ready, em: number): void {
  const n = zones.length;
  // The arc is as wide as its diameter and 1.5 radii high (its open mouth is the lower half of the last 60 degrees on each side).
  const outer = Math.max(1, Math.min(area.w / 2, area.h / 1.5));
  const thickness = Math.min(0.32 * outer, 1.2 * em);
  const radius = outer - thickness / 2;
  const cx = area.x + area.w / 2;
  const cy = area.y + (area.h - 1.5 * outer) / 2 + outer;
  const gap = Math.min(0.04, (ARC_SWEEP / n) * 0.2);
  const each = ARC_SWEEP / n;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'butt';
  zones.forEach((zone, i) => {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, ARC_START + i * each + gap / 2, ARC_START + (i + 1) * each - gap / 2);
    ctx.strokeStyle = zone.color;
    ctx.globalAlpha = i === index ? 1 : DIMMED;
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  // The needle, from the centre to the band, at the value's place in its zone.
  const angle = ARC_START + index * each + within * each;
  ctx.strokeStyle = ready.style.textColor;
  ctx.lineWidth = Math.max(1.5, 0.14 * em);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * (radius + thickness / 2), cy + Math.sin(angle) * (radius + thickness / 2));
  ctx.stroke();
  ctx.fillStyle = ready.style.textColor;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(2, 0.18 * em), 0, Math.PI * 2);
  ctx.fill();
}
