import type { Activity } from '../../domain/activity';
import type { UnitSystem } from '../../domain/units';
import { BASE_FONT_CQW } from '../presets';
import { projectRoute, type ProjectedRoute } from '../routeProjection';
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
  type ResolvedOverlayComponent,
} from '../template';
import type { OverlayTimeline } from '../timeline';

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

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

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

interface Box {
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
    const labelSize = 0.55 * em;
    const valueSize = 1.1 * em;
    const track = ready.fraction !== undefined ? 0.25 * em : 0;
    const trackGap = ready.fraction !== undefined ? 0.2 * em : 0;
    const contentHeight = labelSize * 1.2 + valueSize * 1.1 + trackGap + track;
    const padX = 0.6 * em;
    let y = box.y + Math.max(0.3 * em, (box.h - contentHeight) / 2);
    const x = box.x + padX;

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    // The preview's text-shadow, drawn: a dark halo under the type on a clear background.
    const halo = needsHalo(ready.style);
    if (halo) {
      ctx.shadowColor = 'rgb(0 0 0 / 0.8)';
      ctx.shadowBlur = 0.2 * em;
    }

    ctx.globalAlpha = 0.75;
    ctx.fillStyle = ready.style.textColor;
    ctx.font = `${labelSize}px ${FONT_FAMILY}`;
    ctx.fillText((ready.label ?? '').toUpperCase(), x, y);
    ctx.globalAlpha = 1;
    y += labelSize * 1.2;

    ctx.font = `bold ${valueSize}px ${FONT_FAMILY}`;
    ctx.fillText(ready.text ?? '', x, y);
    y += valueSize * 1.1 + trackGap;
    if (halo) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    if (ready.fraction !== undefined) {
      const trackWidth = box.w - 2 * padX;
      ctx.fillStyle = 'rgb(255 255 255 / 0.25)';
      ctx.fillRect(x, y, trackWidth, track);
      ctx.fillStyle = ready.style.accentColor;
      ctx.fillRect(x, y, trackWidth * ready.fraction, track);
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
        const ready = resolveOverlayComponent(template, component, sample, timeline, units);
        if (ready.status !== 'ready') continue;

        const box = boxOf(component);
        const em = BASE_FONT_FRACTION * width * ready.style.fontScale;

        ctx.save();
        // Each component stays inside its own box, as the preview's tile does.
        roundedRect(ctx, box, 0.4 * em);
        ctx.clip();
        drawBackground(ctx, box, ready, em);

        if (component.type === 'routeInset') {
          drawRoute(ctx, box, ready, sample);
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
