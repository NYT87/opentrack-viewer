import type { OverlayContext2D } from './drawOverlay';
import { drawRouteMarks, renderRouteImagePng, type RouteImageCanvasDeps } from './drawRouteImage';
import type { StillImagePlan } from '../staticImage';
import type { RouteImagePlan } from '../routeImage';

/**
 * AV-1010. Draws a still-image plan: the route, then each text in the order
 * the layout lists it, on a cleared, transparent canvas. Text is drawn with
 * the canvas in the system's own type (no font is fetched), and as text only:
 * `fillText` puts the characters on the canvas, so nothing in them is read as
 * markup.
 */
export function drawStillImage(ctx: OverlayContext2D, plan: StillImagePlan): void {
  ctx.clearRect(0, 0, plan.width, plan.height);
  for (const item of plan.items) {
    if (item.kind === 'route') {
      drawRouteMarks(ctx, item.plan);
      continue;
    }
    ctx.save();
    ctx.fillStyle = item.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = item.align;
    for (const line of item.lines) {
      ctx.font = line.font;
      // A caption is the same colour, quieter, as on the viewer's stat grid.
      ctx.globalAlpha = line.caption ? 0.8 : 1;
      ctx.fillText(line.text, line.x, line.y);
    }
    ctx.restore();
  }
}

/** The still image as a PNG with an alpha channel, made in this tab; refused with the reason rather than empty. */
export function renderStillImagePng(plan: StillImagePlan, deps: RouteImageCanvasDeps = {}): Promise<Blob> {
  // The route image's encoder: the same canvas, size checks and failure
  // messages, with this drawing in place of the route's alone.
  const asRoute = { width: plan.width, height: plan.height } as RouteImagePlan;
  return renderRouteImagePng(asRoute, { ...deps, draw: (ctx) => drawStillImage(ctx, plan) });
}

/** The still image's file name: what it is and its size, never the activity's name. */
export function stillImageFileName(plan: Pick<StillImagePlan, 'width' | 'height' | 'items'>): string {
  // A route alone is the route image AV-1009 made, and is named as it was.
  const routeOnly = plan.items.every((item) => item.kind === 'route');
  return `${routeOnly ? 'route-overlay' : 'overlay-image'}-${plan.width}x${plan.height}.png`;
}
