import { MARKER_RING, RouteImageError, type RouteImagePlan } from '../routeImage';
import type { OverlayContext2D } from './drawOverlay';

/**
 * AV-1009. Draws a route-image plan, and encodes it as a PNG.
 *
 * Nothing is painted but the route: the canvas is cleared to transparent and the
 * line, its dots and its markers are the only marks, so every other pixel keeps
 * alpha zero. There is no basemap, attribution or backdrop to leave out because
 * none is ever drawn.
 */

export const START_MARKER_COLOR = '#22c55e';
export const END_MARKER_COLOR = '#ef4444';
const MARKER_RING_COLOR = '#ffffff';

export function drawRouteImage(ctx: OverlayContext2D, plan: RouteImagePlan): void {
  ctx.clearRect(0, 0, plan.width, plan.height);

  ctx.strokeStyle = plan.color;
  ctx.lineWidth = plan.lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const run of plan.runs) {
    ctx.beginPath();
    run.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // A one-fix run is a dot as wide as the line; a route that is one place is a
  // dot of marker size, so it is as easy to see as a start marker would be.
  const dotRadius = plan.singlePlace ? plan.markerRadius : plan.lineWidth / 2;
  ctx.fillStyle = plan.color;
  for (const [x, y] of plan.dots) {
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  const marker = (at: [number, number], color: string) => {
    ctx.fillStyle = MARKER_RING_COLOR;
    ctx.beginPath();
    ctx.arc(at[0], at[1], plan.markerRadius * MARKER_RING, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(at[0], at[1], plan.markerRadius, 0, Math.PI * 2);
    ctx.fill();
  };
  // The end is drawn first, so a loop that ends where it began still shows its start.
  if (plan.end) marker(plan.end, END_MARKER_COLOR);
  if (plan.start) marker(plan.start, START_MARKER_COLOR);
}

export interface RouteImageCanvasDeps {
  /** For tests: a stand-in for the canvas the browser would make. */
  createCanvas?: (width: number, height: number) => RouteImageCanvas;
}

/** The part of a canvas the encoder uses. */
export interface RouteImageCanvas {
  getContext(kind: '2d'): OverlayContext2D | null;
  toPng(): Promise<Blob | null>;
}

function defaultCanvas(width: number, height: number): RouteImageCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    return {
      getContext: () => canvas.getContext('2d'),
      toPng: () => canvas.convertToBlob({ type: 'image/png' }),
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return {
    getContext: () => canvas.getContext('2d'),
    toPng: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
  };
}

/**
 * The plan as a PNG with an alpha channel, made in this tab. A browser that
 * cannot make a canvas this large, or cannot encode it, is a `render_failed`
 * with the reason — never an empty file offered as a success.
 */
export async function renderRouteImagePng(
  plan: RouteImagePlan,
  deps: RouteImageCanvasDeps = {},
): Promise<Blob> {
  try {
    const canvas = (deps.createCanvas ?? defaultCanvas)(plan.width, plan.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new RouteImageError('render_failed', 'This browser cannot draw the image.');
    drawRouteImage(ctx, plan);
    const blob = await canvas.toPng();
    if (!blob || blob.size === 0 || blob.type !== 'image/png') {
      throw new RouteImageError(
        'render_failed',
        'This browser could not encode an image of this size. Try a smaller size.',
      );
    }
    return blob;
  } catch (error) {
    if (error instanceof RouteImageError) throw error;
    throw new RouteImageError(
      'render_failed',
      `The image could not be made${error instanceof Error && error.message ? ` (${error.message})` : ''}. Try a smaller size.`,
      { cause: error },
    );
  }
}
