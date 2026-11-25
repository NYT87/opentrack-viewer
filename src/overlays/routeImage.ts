import type { Activity } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { projectRoute, type ProjectedRoute } from '../domain/routeProjection';

/**
 * AV-1009. The standalone route overlay: the route alone, on nothing.
 *
 * "On nothing" is the point. The image has no basemap, no attribution and —
 * above all — no background fill, so every pixel the route does not touch is
 * fully transparent and the file can be laid over a video in any editor.
 */
export interface RouteImageOptions {
  width: number;
  height: number;
  padding: number;
  /** Any CSS colour. */
  color: string;
  lineWidth: number;
  showMarkers: boolean;
}

export const DEFAULT_ROUTE_IMAGE: RouteImageOptions = {
  width: 1920,
  height: 1080,
  padding: 96,
  color: '#ffffff',
  lineWidth: 10,
  showMarkers: true,
};

/** Aspect-ratio presets, at a size that suits a video frame of that shape. */
export const ROUTE_IMAGE_PRESETS = [
  { id: 'landscape', label: '16:9 (1920 × 1080)', width: 1920, height: 1080 },
  { id: 'square', label: '1:1 (1080 × 1080)', width: 1080, height: 1080 },
  { id: 'portrait', label: '9:16 (1080 × 1920)', width: 1080, height: 1920 },
] as const;

export const MIN_IMAGE_SIZE = 64;
/** Browsers refuse canvases much larger than this; say so instead of failing. */
export const MAX_IMAGE_SIZE = 8192;

export const START_MARKER_COLOR = '#2ecc71';
export const END_MARKER_COLOR = '#e74c3c';

/** The slice of the 2D context the drawing uses, so it can be tested without a canvas. */
export interface DrawingContext {
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/** Checks the options, throwing a typed error that says which one is wrong. */
export function validateRouteImageOptions(options: RouteImageOptions): void {
  const bad = (message: string) => {
    throw new ActivityError('invalid_selected_range', message);
  };
  for (const [name, value] of [
    ['width', options.width],
    ['height', options.height],
  ] as const) {
    if (!Number.isInteger(value) || value < MIN_IMAGE_SIZE || value > MAX_IMAGE_SIZE) {
      bad(`The image ${name} must be a whole number from ${MIN_IMAGE_SIZE} to ${MAX_IMAGE_SIZE} pixels.`);
    }
  }
  if (!Number.isFinite(options.padding) || options.padding < 0) bad('The padding cannot be negative.');
  if (!Number.isFinite(options.lineWidth) || options.lineWidth <= 0) {
    bad('The route width must be greater than zero.');
  }
  if (!options.color.trim()) bad('Choose a route colour.');
}

/**
 * Draws a projected route. The only thing ever painted is the route and its
 * markers; the canvas is cleared to transparent first and never filled.
 */
export function drawRoute(
  context: DrawingContext,
  route: ProjectedRoute,
  options: Pick<RouteImageOptions, 'color' | 'lineWidth' | 'showMarkers'>,
): void {
  context.clearRect(0, 0, route.width, route.height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = options.lineWidth;
  context.strokeStyle = options.color;

  for (const segment of route.segments) {
    // One point makes no line; the marker, if any, shows where it is.
    if (segment.length < 2) continue;
    context.beginPath();
    segment.forEach((point, index) =>
      index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y),
    );
    context.stroke();
  }

  if (!options.showMarkers) return;
  const radius = Math.max(options.lineWidth * 1.6, 5);
  const dot = (point: { x: number; y: number }, color: string) => {
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  };
  dot(route.start, START_MARKER_COLOR);
  dot(route.end, END_MARKER_COLOR);
}

/**
 * Projects `activity` and draws it onto `canvas`, resizing the canvas to the
 * requested dimensions. Throws a typed error for an unusable activity or
 * options, or when the browser gives no 2D context.
 */
export function renderRouteToCanvas(
  canvas: HTMLCanvasElement,
  activity: Activity,
  options: RouteImageOptions,
): void {
  validateRouteImageOptions(options);
  const route = projectRoute(activity.points, options);

  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new ActivityError('file_read_failed', 'This browser cannot draw images.');
  }
  drawRoute(context, route, options);
}

/** Encodes the canvas as a PNG, which keeps the alpha channel. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ActivityError('file_read_failed', 'The image could not be created.'));
    }, 'image/png');
  });
}

/** File name for the exported image, without extension. */
export function routeImageBaseName(activity: Activity): string {
  const name = activity.metadata.name ?? activity.source.fileName?.replace(/\.[^.]+$/, '') ?? 'route';
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'route'}-route-overlay`;
}
