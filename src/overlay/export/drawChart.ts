import type { UnitSystem } from '../../domain/units';
import { chartLabels, chartView, type ChartMoment } from '../chart';
import { FIGURE_FONT_FAMILY, haloShadow } from '../figureLayout';
import type { ProjectedSeries, SeriesPoint } from '../series';
import { DEFAULT_CHART, needsHalo, type OverlayChartSetting, type ResolvedOverlayComponent } from '../template';
import type { OverlayTimeline } from '../timeline';
import type { Box, OverlayContext2D } from './drawOverlay';

/**
 * AV-1019 (TD-087). Draws a chart in its box: a figure against time or
 * distance, whole or through a window around now, with a cursor at the moment
 * shown. A gap in the data is a gap in the line. The elevation profile is the
 * same drawing with its own look (`drawSeries`), so the two cannot drift apart.
 *
 * The caller has clipped to the box and painted its background.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** How a series' runs are painted: the fill under the line, and the line. */
export interface SeriesLook {
  fillColor: string;
  fillAlpha: number;
  lineColor: string;
  lineAlpha: number;
  /** In pixels. */
  lineWidth: number;
}

/**
 * The runs as a filled area under a line, in `area`. Per run: the fill first and
 * then the line, round-joined, as AV-1211's profile has always been drawn.
 */
export function drawSeries(ctx: OverlayContext2D, area: Box, runs: SeriesPoint[][], look: SeriesLook): void {
  const px = (x: number) => area.x + x * area.w;
  const py = (y: number) => area.y + y * area.h;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const run of runs) {
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.lineTo(px(run[run.length - 1]![0]), area.y + area.h);
    ctx.lineTo(px(run[0]![0]), area.y + area.h);
    ctx.closePath();
    ctx.globalAlpha = look.fillAlpha;
    ctx.fillStyle = look.fillColor;
    ctx.fill();
    ctx.beginPath();
    run.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(px(x), py(y)) : ctx.lineTo(px(x), py(y))));
    ctx.globalAlpha = look.lineAlpha;
    ctx.strokeStyle = look.lineColor;
    ctx.lineWidth = look.lineWidth;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawChart(
  ctx: OverlayContext2D,
  box: Box,
  ready: Ready,
  em: number,
  series: ProjectedSeries,
  moment: ChartMoment,
  units: UnitSystem,
  timeline: Pick<OverlayTimeline, 'sensorLabels'>,
): void {
  const setting: OverlayChartSetting = ready.component.chart ?? DEFAULT_CHART;
  const source = ready.component.source;
  const view = source ? chartView(series, setting, moment) : undefined;
  if (!source || !view) return;
  const figure = ready.component.figure;
  const labelSize = 0.45 * em * (figure?.labelScale ?? 1);
  const bandHeight = setting.labels ? labelSize * 1.5 : 0;
  const pad = 0.3 * em;
  const area: Box = { x: box.x + pad, y: box.y + pad, w: Math.max(1, box.w - 2 * pad), h: Math.max(1, box.h - 2 * pad - bandHeight) };

  drawSeries(ctx, area, view.runs, {
    fillColor: setting.fillColor,
    fillAlpha: setting.fillOpacity,
    lineColor: setting.lineColor,
    lineAlpha: 1,
    lineWidth: Math.max(1, 0.025 * area.h),
  });

  // The cursor: a bar at the moment, and a dot on the line where the figure has a value.
  const barWidth = Math.max(2, 0.02 * area.h);
  const x = area.x + view.cursorX * area.w;
  ctx.fillStyle = ready.style.accentColor;
  ctx.fillRect(x - barWidth / 2, area.y, barWidth, area.h);
  if (view.cursorY !== undefined) {
    ctx.beginPath();
    ctx.arc(x, area.y + view.cursorY * area.h, Math.max(2, 0.05 * area.h), 0, Math.PI * 2);
    ctx.fill();
  }

  if (!setting.labels) return;
  const unitSystem = ready.component.unitMode === 'auto' ? units : ready.component.unitMode;
  const labels = chartLabels(view, series, setting, source, unitSystem, timeline, ready.component.display?.decimals);
  const shadow = needsHalo(ready.style) ? haloShadow(figure) : undefined;
  ctx.font = `${labelSize}px ${FIGURE_FONT_FAMILY}`;
  ctx.fillStyle = figure?.labelColor ?? ready.style.textColor;
  ctx.textBaseline = 'middle';
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = 0.2 * em;
  }
  const write = (text: string, tx: number, ty: number, align: 'left' | 'right') => {
    ctx.textAlign = align;
    ctx.globalAlpha = 0.85;
    ctx.fillText(text, tx, ty, Math.max(1, 0.45 * box.w));
    ctx.globalAlpha = 1;
  };
  // The y range's ends, at the left edge, beside where the highest and the lowest values are.
  if (view.y && labels.high !== undefined && view.high !== undefined) write(labels.high, area.x, area.y + view.y(view.high) * area.h - labelSize * 0.6, 'left');
  if (view.y && labels.low !== undefined && view.low !== undefined) write(labels.low, area.x, area.y + view.y(view.low) * area.h + labelSize * 0.6, 'left');
  // The x window, under the plot: its two ends.
  const rowY = area.y + area.h + bandHeight / 2 + pad * 0.3;
  write(labels.start, area.x, rowY, 'left');
  write(labels.end, area.x + area.w, rowY, 'right');
  if (shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
}
