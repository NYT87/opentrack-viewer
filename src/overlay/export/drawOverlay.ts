import type { Activity } from '../../domain/activity';
import type { UnitSystem } from '../../domain/units';
import { BASE_FONT_CQW } from '../presets';
import { projectProfile, type ProjectedProfile } from '../elevationProfile';
import type { ProjectedSeries } from '../series';
import { projectRoute, type ProjectedRoute } from '../routeProjection';
import { FIGURE_MIN_TOP_EMS, figureLayout, haloShadow } from '../figureLayout';
import { drawShape } from '../shapes';
import { extractRoute } from '../routeImage';
import { layoutStillText, stillValue, type PlannedStillItem } from '../staticImage';
import {
  DEFAULT_OVERLAY_STYLE,
  STILL_IMAGE_COMPONENT_TYPES,
  needsHalo,
  resolveOverlayComponent,
  type OverlayComponent,
  type OverlayTemplate,
  type PersonalFigures,
  type ResolvedOverlayComponent,
} from '../template';
import type { OverlayTimeline } from '../timeline';
import { DEFAULT_CHART } from '../template';
import { chartMoment, chartSeriesOf } from '../chart';
import { drawChart, drawSeries } from './drawChart';
import { drawCompass } from './drawCompass';
import { drawDial } from './drawDial';
import { drawGradient } from './drawGradient';
import { drawZones } from './drawZones';
import { createZoneTimes } from '../zones';
import { drawSplits } from './drawSplits';
import { createSplitTimes, splitEveryMeters, splitsRate, splitsView, unitMeters } from '../splits';

/**
 * AV-1006. Draws a template on a canvas, at any resolution, on a transparent
 * background — the picture an editor lays over the video.
 *
 * It is the preview's drawing (`OverlayLayer`) again, from the same resolved
 * components and the same type sizing: type is `2.2%` of the frame width at
 * scale 1, a tile's padding and gauge track are fractions of that, and a
 * component whose data is missing is not drawn. Works on a `<canvas>` context
 * and an `OffscreenCanvas` one alike, because the export runs in a worker.
 */

export type OverlayContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Type size in frame widths at scale 1: the preview's `2.2cqw`, from the same constant. */
export const BASE_FONT_FRACTION = BASE_FONT_CQW / 100;

export interface OverlayRendererInput {
  template: OverlayTemplate;
  timeline: OverlayTimeline;
  activity: Activity | undefined;
  units: UnitSystem;
  width: number;
  height: number;
  /**
   * AV-1011. The reader's time zone, for a date on the canvas; the browser's
   * own by default (a worker's is the same as its page's).
   */
  readerTimeZone?: string;
  /**
   * AV-1018 (TD-086). The reader's own maximum heart rate and FTP, which a zones
   * component measured in percent needs. Held in memory for the session and
   * given to the renderer by every caller; never stored, logged or sent.
   */
  personal?: PersonalFigures;
}

export interface OverlayRenderer {
  /**
   * Draws the overlay as it is at this video time. By default the context is
   * cleared first, so what is not overlay is transparent; a burned-in render
   * passes `clear: false` to draw over a video frame already on the canvas.
   */
  drawFrame(ctx: OverlayContext2D, videoTimeSeconds: number, options?: { clear?: boolean }): void;
}

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function roundedRect(ctx: OverlayContext2D, box: Box, radius: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(box.x, box.y, box.w, box.h, radius);
  else ctx.rect(box.x, box.y, box.w, box.h);
}

export function createOverlayRenderer(input: OverlayRendererInput): OverlayRenderer {
  const { template, timeline, activity, units, width, height } = input;

  // The route is projected once per component: it does not change as time does.
  const routes = new Map<string, ProjectedRoute | undefined>();
  const routeFor = (component: OverlayComponent, box: Box): ProjectedRoute | undefined => {
    if (!routes.has(component.id)) {
      routes.set(component.id, activity ? projectRoute(activity, box.w / box.h) : undefined);
    }
    return routes.get(component.id);
  };

  // So is the elevation profile, which is in the same units whatever the box.
  let profile: ProjectedProfile | undefined | null = null;
  const profileOf = (): ProjectedProfile | undefined => {
    if (profile === null) profile = activity ? projectProfile(activity) : undefined;
    return profile;
  };

  // TD-088 (TD-086). The time in each zone, one accumulator for each zones component drawn, kept for this renderer's life.
  const zoneTimesOf = createZoneTimes(timeline);

  // AV-1021 (TD-090). The splits for each source, distance, clock and unit drawn, found once for this renderer and then looked up.
  const splitTimesOf = createSplitTimes(timeline.splitStreams);

  // AV-1019. A chart's series is made once per component, from the points the renderer was given (the map video's are the trimmed ones).
  const seriesOf = (component: OverlayComponent): ProjectedSeries | undefined =>
    activity && component.source ? chartSeriesOf(activity, component.source, (component.chart ?? DEFAULT_CHART).axis) : undefined;

  const boxOf = (component: OverlayComponent): Box => ({
    x: component.rect.x * width,
    y: component.rect.y * height,
    w: component.rect.width * width,
    h: component.rect.height * height,
  });

  function drawBackground(ctx: OverlayContext2D, box: Box, ready: Ready, em: number): void {
    if (ready.style.backgroundOpacity <= 0) return;
    roundedRect(ctx, box, 0.4 * em);
    ctx.fillStyle = `rgb(0 0 0 / ${ready.style.backgroundOpacity})`;
    ctx.fill();
  }

  function drawFigure(ctx: OverlayContext2D, box: Box, ready: Ready, em: number): void {
    const figure = ready.component.figure;
    const layout = figureLayout({
      em,
      frameWidth: width,
      label: ready.label,
      value: ready.text ?? '',
      figure,
      track: ready.fraction !== undefined,
    });
    const { padX, track, trackGap } = layout;
    let y = box.y + Math.max(FIGURE_MIN_TOP_EMS * em, (box.h - layout.contentHeight) / 2);
    const x = layout.align === 'center' ? box.x + box.w / 2 : layout.align === 'right' ? box.x + box.w - padX : box.x + padX;
    const trackX = box.x + padX;

    ctx.textBaseline = 'top';
    ctx.textAlign = layout.align;
    // The preview's text-shadow, drawn: a dark halo under the type on a clear background.
    const shadow = needsHalo(ready.style) ? haloShadow(figure) : undefined;
    if (shadow) {
      ctx.shadowColor = shadow;
      ctx.shadowBlur = 0.2 * em;
    }

    if (layout.showLabel) {
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = figure?.labelColor ?? ready.style.textColor;
      ctx.font = layout.labelFont;
      ctx.fillText((ready.label ?? '').toUpperCase(), x, y);
      ctx.globalAlpha = 1;
      y += layout.labelAdvance;
    }

    ctx.fillStyle = ready.style.textColor;
    ctx.font = layout.valueFont;
    ctx.fillText(ready.text ?? '', x, y);
    y += layout.valueSize * 1.1 + trackGap;
    if (shadow) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    if (ready.fraction !== undefined) {
      const trackWidth = box.w - 2 * padX;
      ctx.fillStyle = 'rgb(255 255 255 / 0.25)';
      ctx.fillRect(trackX, y, trackWidth, track);
      ctx.fillStyle = ready.style.accentColor;
      ctx.fillRect(trackX, y, trackWidth * ready.fraction, track);
    }
  }

  function drawRoute(
    ctx: OverlayContext2D,
    box: Box,
    ready: Ready,
    sample: NonNullable<ReturnType<OverlayTimeline['sampleAt']>>,
  ): void {
    const route = routeFor(ready.component, box);
    if (!route) return;
    ctx.strokeStyle = ready.style.textColor;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 0.03 * box.h;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const segment of route.segments) {
      ctx.beginPath();
      segment.forEach(([x, y], index) => {
        const px = box.x + x * box.w;
        const py = box.y + y * box.h;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (sample.position) {
      const [x, y] = route.project(sample.position);
      ctx.fillStyle = ready.style.accentColor;
      ctx.beginPath();
      ctx.arc(box.x + x * box.w, box.y + y * box.h, 0.05 * box.h, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** AV-1211. The profile as the preview's `ElevationProfile` draws it: a soft fill, the line, and the cursor. */
  function drawProfile(ctx: OverlayContext2D, box: Box, ready: Ready): void {
    const projected = profileOf();
    if (!projected) return;
    const px = (x: number) => box.x + x * box.w;
    const py = (y: number) => box.y + y * box.h;
    // AV-1019. The same drawing of a series that a chart uses, with the profile's own look.
    drawSeries(ctx, box, projected.runs, {
      fillColor: ready.style.textColor,
      fillAlpha: 0.25,
      lineColor: ready.style.textColor,
      lineAlpha: 0.9,
      lineWidth: Math.max(1, 0.025 * box.h),
    });
    const progress = ready.fraction ?? 0;
    ctx.fillStyle = ready.style.accentColor;
    ctx.fillRect(px(progress) - Math.max(1, 0.01 * box.h), box.y, Math.max(2, 0.02 * box.h), box.h);
    const point = projected.at(progress);
    if (point) {
      ctx.beginPath();
      ctx.arc(px(point[0]), py(point[1]), 0.06 * box.h, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /*
   * AV-1011. A text, a figure from the summary or the date describes the whole
   * activity, so it is the same in every frame: set once, by the still image's
   * own layout (AV-1010), measured by the canvas it is drawn on, and kept.
   */
  let stillTexts: Map<string, Extract<PlannedStillItem, { kind: 'text' }>> | undefined;
  const setStillTexts = (ctx: OverlayContext2D) => {
    const texts = new Map<string, Extract<PlannedStillItem, { kind: 'text' }>>();
    const anyStill = template.components.some((component) => STILL_IMAGE_COMPONENT_TYPES.includes(component.type));
    if (activity && anyStill) {
      const context = { activity, route: extractRoute(activity), units, readerTimeZone: input.readerTimeZone };
      const measure = (text: string, font: string) => {
        ctx.font = font;
        return ctx.measureText(text).width;
      };
      for (const component of template.components) {
        if (!component.visible || !STILL_IMAGE_COMPONENT_TYPES.includes(component.type)) continue;
        const value = stillValue(component, context);
        if (!value.ok) continue;
        const color = component.style.textColor ?? DEFAULT_OVERLAY_STYLE.textColor;
        texts.set(component.id, layoutStillText(component, value, color, { width, height }, measure));
      }
    }
    return texts;
  };

  return {
    drawFrame(ctx, videoTimeSeconds, options) {
      // Transparent by construction: nothing but the components is ever painted.
      if (options?.clear !== false) ctx.clearRect(0, 0, width, height);
      // Where the activity does not reach, only what describes the whole of it is drawn.
      const sample = timeline.sampleAt(videoTimeSeconds);
      stillTexts ??= setStillTexts(ctx);

      for (const component of template.components) {
        if (!component.visible) continue;
        if (component.type === 'shape') {
          if (component.shape) drawShape(ctx, boxOf(component), component.shape, Math.min(width, height));
          continue;
        }
        const still = stillTexts.get(component.id);
        if (still) {
          ctx.save();
          ctx.fillStyle = still.color;
          ctx.textBaseline = 'top';
          ctx.textAlign = still.align;
          for (const line of still.lines) {
            ctx.font = line.font;
            ctx.globalAlpha = line.caption ? 0.8 : 1;
            ctx.fillText(line.text, line.x, line.y);
          }
          ctx.restore();
          continue;
        }
        if (!sample) continue;
        const ready = resolveOverlayComponent(template, component, sample, timeline, units, input.personal);
        if (ready.status !== 'ready') continue;

        const box = boxOf(component);
        const em = BASE_FONT_FRACTION * width * ready.style.fontScale;

        // A chart with no place on its axis at this moment (a dropout) draws nothing, background included, as the contract has no props for it.
        if (component.type === 'chart') {
          const chartSeries = seriesOf(component);
          if (!chartSeries || !component.source || chartMoment(chartSeries, component.source, sample, timeline).centre === undefined) continue;
        }
        ctx.save();
        // Each component stays inside its own box, as the preview's tile does.
        roundedRect(ctx, box, 0.4 * em);
        ctx.clip();
        drawBackground(ctx, box, ready, em);

        if (component.type === 'routeInset') {
          drawRoute(ctx, box, ready, sample);
        } else if (component.type === 'elevationProfile') {
          drawProfile(ctx, box, ready);
        } else if (component.type === 'zones') {
          // The time in each zone is a pass over the activity, made once for these bounds and then looked up (`createZoneTimes`, kept with this renderer: TD-088).
          const resolved = ready.zones;
          const times =
            resolved?.setting.show.timeInZone && component.source
              ? zoneTimesOf(component.source, resolved.bounds)?.at(sample.activityElapsedSeconds)
              : undefined;
          drawZones(ctx, box, ready, em, width, times);
        } else if (component.type === 'splits') {
          const resolved = ready.splits;
          const times = resolved
            ? splitTimesOf({ source: resolved.source, everyMeters: splitEveryMeters(resolved.setting, resolved.unitSystem), time: resolved.setting.time, unitMeters: unitMeters(resolved.unitSystem) })
            : undefined;
          const view =
            resolved && times
              ? splitsView(times, times.at(sample.activityElapsedSeconds), resolved.setting, splitsRate(resolved.setting, activity?.metadata.sport), resolved.unitSystem)
              : undefined;
          drawSplits(ctx, box, ready, em, width, view);
        } else if (component.type === 'dial') {
          drawDial(ctx, box, ready, em, width);
        } else if (component.type === 'gradient') {
          drawGradient(ctx, box, ready, em, width);
        } else if (component.type === 'compass') {
          drawCompass(ctx, box, ready, em, width);
        } else if (component.type === 'chart') {
          const series = seriesOf(component);
          if (series && component.source) drawChart(ctx, box, ready, em, series, chartMoment(series, component.source, sample, timeline), units, timeline);
        } else if (component.type === 'progress') {
          ctx.fillStyle = 'rgb(255 255 255 / 0.25)';
          ctx.fillRect(box.x, box.y, box.w, box.h);
          ctx.fillStyle = ready.style.accentColor;
          ctx.fillRect(box.x, box.y, box.w * (ready.fraction ?? 0), box.h);
        } else {
          drawFigure(ctx, box, ready, em);
        }
        ctx.restore();
      }
    },
  };
}
