import type { Activity } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';
import { DEFAULT_OVERLAY_STYLE } from './template';

/**
 * AV-1009. The complete route of an activity as a still picture on a
 * transparent background: geometry only. No basemap, no attribution and no
 * backdrop is ever part of it, so there is nothing to bake in.
 *
 * Two steps, so a control can change without re-reading the activity. `extractRoute`
 * reads the fixes once — what is usable, where the line is broken — and
 * `planRouteImage` lays that out in pixels for a size, padding and stroke.
 * Neither draws; `export/drawRouteImage.ts` does, from the plan.
 */

export const ROUTE_IMAGE_LIMITS = {
  minSide: 16,
  maxSide: 8192,
  /** 2^25 pixels: about 7680 x 4320, within what browsers will allocate a canvas for. */
  maxPixels: 33_554_432,
  minLineWidth: 1,
  maxLineWidth: 256,
  maxPaddingFraction: 0.4,
} as const;

export interface RouteImageOptions {
  /** Whole pixels. */
  width: number;
  height: number;
  /** Of the shorter side, 0..0.4: the margin kept clear around what is drawn, stroke and markers included. */
  paddingFraction: number;
  /** `#rgb` or `#rrggbb`. */
  color: string;
  /** Pixels. */
  lineWidth: number;
  /** Mark where the route starts and ends. */
  markers: boolean;
}

export const DEFAULT_ROUTE_IMAGE_OPTIONS: RouteImageOptions = {
  width: 1920,
  height: 1080,
  paddingFraction: 0.08,
  // The same accent token the telemetry overlays use.
  color: DEFAULT_OVERLAY_STYLE.accentColor,
  lineWidth: 12,
  markers: true,
};

/** Preset aspect ratios, as a size. Anything else is a custom size. */
export const ROUTE_IMAGE_ASPECTS: readonly { id: string; label: string; width: number; height: number }[] = [
  { id: '16:9', label: 'Landscape 16:9', width: 1920, height: 1080 },
  { id: '9:16', label: 'Portrait 9:16', width: 1080, height: 1920 },
  { id: '1:1', label: 'Square 1:1', width: 1080, height: 1080 },
  { id: '4:5', label: 'Portrait 4:5', width: 1080, height: 1350 },
];

export type RouteImageErrorCode =
  | 'no_location'
  | 'no_valid_coordinates'
  | 'invalid_dimensions'
  | 'invalid_style'
  | 'no_room'
  | 'render_failed';

export class RouteImageError extends Error {
  readonly code: RouteImageErrorCode;

  constructor(code: RouteImageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RouteImageError';
    this.code = code;
  }
}

type Point = [number, number];

/** A route read from an activity: unbroken runs of usable fixes, longitude unwrapped. */
export interface RouteGeometry {
  /** Runs of `[lat, unwrapped lon]`. A recorded segment boundary or an unusable fix ends one. */
  runs: Point[][];
  /** Fixes that carried coordinates the route cannot use (out of range, not a number). */
  skippedFixes: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** Metres per degree of longitude, relative to latitude, at the route's middle. */
  lonScale: number;
}

export type ExtractRouteResult =
  | { ok: true; route: RouteGeometry }
  | { ok: false; error: RouteImageError };

/**
 * Reads the route. Longitude is unwrapped step by step, so a route that crosses
 * the antimeridian is one continuous line (179.9 → -179.9 is 0.2 degrees, not 359.8)
 * however far it then runs. A fix outside the valid range, or not a number, is
 * left out and counted, and the line is broken there rather than drawn across it.
 */
export function extractRoute(activity: Activity): ExtractRouteResult {
  const runs: Point[][] = [];
  let skippedFixes = 0;
  let located = 0;
  let current: Point[] = [];
  let lastSegment: number | undefined;
  let previousLon: number | undefined;
  let unwrappedLon = 0;

  const endRun = () => {
    if (current.length) runs.push(current);
    current = [];
    previousLon = undefined;
  };

  for (const point of activity.points) {
    const hasFields = point.lat !== undefined || point.lon !== undefined;
    const place = toValidCoordinate(point.lat, point.lon);
    if (!place) {
      // A point with no usable location ends the run, whether it carried bad
      // coordinates or none: the recording says nothing about the ground
      // between the fixes either side, so no line is drawn across it (as
      // `projectRoute` does). Only bad coordinates are counted as skipped.
      if (hasFields) skippedFixes += 1;
      endRun();
      continue;
    }
    located += 1;
    const segment = point.segmentIndex ?? 0;
    if (lastSegment !== undefined && segment !== lastSegment) endRun();
    lastSegment = segment;

    if (previousLon === undefined) unwrappedLon = place.lon;
    else {
      let delta = place.lon - previousLon;
      if (delta > 180) delta -= 360;
      else if (delta < -180) delta += 360;
      unwrappedLon += delta;
    }
    previousLon = place.lon;
    current.push([place.lat, unwrappedLon]);
  }
  endRun();

  if (located === 0) {
    return {
      ok: false,
      error:
        skippedFixes > 0
          ? new RouteImageError(
              'no_valid_coordinates',
              'Every location in this activity is outside the valid range, so there is no route to draw.',
            )
          : new RouteImageError('no_location', 'This activity has no locations, so there is no route to draw.'),
    };
  }

  // Runs are separate lines, but they share one picture, and each was unwrapped
  // on its own: a run is shifted by whole turns to the copy of the world in
  // which it starts nearest where the run before it ended.
  let reference = runs[0]![0]![1];
  for (const run of runs) {
    const shift = Math.round((reference - run[0]![1]) / 360) * 360;
    if (shift !== 0) for (const point of run) point[1] += shift;
    reference = run[run.length - 1]![1];
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const run of runs) {
    for (const [lat, lon] of run) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
  }
  const lonScale = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  return {
    ok: true,
    route: { runs, skippedFixes, bounds: { minLat, maxLat, minLon, maxLon }, lonScale },
  };
}

export interface RouteImagePlan {
  width: number;
  height: number;
  color: string;
  lineWidth: number;
  /** Lines to stroke, in pixels, y down. */
  runs: Point[][];
  /** Places drawn as a dot: a one-fix run, or the whole route when it is one place. */
  dots: Point[];
  /** Radius of the start and end markers, and of a one-place dot. */
  markerRadius: number;
  start?: Point;
  end?: Point;
  /** Everything the reader should be told about what is, or is not, drawn. */
  notes: string[];
  /** The route is one place, not a line. */
  singlePlace: boolean;
}

export type PlanRouteImageResult =
  | { ok: true; plan: RouteImagePlan }
  | { ok: false; error: RouteImageError };

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Points closer than this, in pixels, to the one before are not drawn: no pixel tells them apart. */
const MIN_PIXEL_STEP = 0.5;
/** A marker is this many line widths across its radius, with a floor so a hairline still shows one. */
const MARKER_RADIUS_PER_LINE = 1.25;
const MARKER_MIN_RADIUS = 4;
/** The marker's outline, as a multiple of its radius. */
export const MARKER_RING = 1.2;
/** Room left beyond the stroke for anti-aliasing. */
const ANTI_ALIAS_PX = 1;

const fail = (code: RouteImageErrorCode, message: string): PlanRouteImageResult => ({
  ok: false,
  error: new RouteImageError(code, message),
});

/**
 * Lays the route out in pixels so that **the whole stroke is inside the image**:
 * the padding asked for is kept clear *outside* half a stroke and the markers,
 * and what is left is where the route is fitted, keeping its aspect ratio and
 * centred. A size, stroke or padding that leaves no room is refused rather than
 * silently clipped.
 */
export function planRouteImage(route: RouteGeometry, options: RouteImageOptions): PlanRouteImageResult {
  const { width, height, paddingFraction, color, lineWidth, markers } = options;
  const { minSide, maxSide, maxPixels, minLineWidth, maxLineWidth, maxPaddingFraction } = ROUTE_IMAGE_LIMITS;

  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return fail('invalid_dimensions', 'Width and height must be whole numbers of pixels.');
  }
  if (width < minSide || height < minSide || width > maxSide || height > maxSide) {
    return fail('invalid_dimensions', `Width and height must each be between ${minSide} and ${maxSide} pixels.`);
  }
  if (width * height > maxPixels) {
    return fail(
      'invalid_dimensions',
      `That is ${((width * height) / 1e6).toFixed(1)} million pixels; this browser-side export stops at ${(maxPixels / 1e6).toFixed(1)} million.`,
    );
  }
  if (!HEX_COLOR.test(color)) {
    return fail('invalid_style', 'The route colour must be a hex colour such as #ff6a00.');
  }
  if (!Number.isFinite(lineWidth) || lineWidth < minLineWidth || lineWidth > maxLineWidth) {
    return fail('invalid_style', `The route width must be between ${minLineWidth} and ${maxLineWidth} pixels.`);
  }
  if (!Number.isFinite(paddingFraction) || paddingFraction < 0 || paddingFraction > maxPaddingFraction) {
    return fail('invalid_style', `The padding must be between 0% and ${maxPaddingFraction * 100}% of the shorter side.`);
  }

  const { minLat, maxLat, minLon, maxLon } = route.bounds;
  const spanX = (maxLon - minLon) * route.lonScale;
  const spanY = maxLat - minLat;
  const singlePlace = !(spanX > 0) && !(spanY > 0);

  const markerRadius = Math.max(MARKER_MIN_RADIUS, lineWidth * MARKER_RADIUS_PER_LINE);
  // How far what is drawn reaches beyond the point it is centred on: half the
  // stroke, the marker and its outline, or — for a route that is one place —
  // the dot, which is marker-sized.
  let reach = lineWidth / 2;
  if (markers && !singlePlace) reach = Math.max(reach, markerRadius * MARKER_RING);
  if (singlePlace) reach = Math.max(reach, markerRadius);
  // The padding is the margin around what is *drawn*, so it is measured from the
  // outside of the stroke and of the markers, not from the line they are centred on.
  const inset = paddingFraction * Math.min(width, height) + reach + ANTI_ALIAS_PX;
  const innerW = width - 2 * inset;
  const innerH = height - 2 * inset;
  if (innerW < 1 || innerH < 1) {
    return fail('no_room', 'The padding and route width leave no room for the route. Reduce them or make the image larger.');
  }

  const scale = singlePlace
    ? 0
    : Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const place = ([lat, lon]: Point): Point => [
    clamp(offsetX + (lon - minLon) * route.lonScale * scale, inset, width - inset),
    clamp(offsetY + (maxLat - lat) * scale, inset, height - inset),
  ];

  const runs: Point[][] = [];
  const dots: Point[] = [];
  for (const source of route.runs) {
    const thinned: Point[] = [];
    for (const fix of source) {
      const point = place(fix);
      const last = thinned[thinned.length - 1];
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= MIN_PIXEL_STEP) thinned.push(point);
    }
    const end = place(source[source.length - 1]!);
    const kept = thinned[thinned.length - 1];
    if (kept && kept !== end && (kept[0] !== end[0] || kept[1] !== end[1])) thinned.push(end);
    if (thinned.length >= 2) runs.push(thinned);
    else if (thinned[0]) dots.push(thinned[0]);
  }

  const firstRun = route.runs[0]!;
  const lastRun = route.runs[route.runs.length - 1]!;
  const notes: string[] = [];
  if (route.skippedFixes > 0) {
    notes.push(
      `${route.skippedFixes} location${route.skippedFixes === 1 ? ' was' : 's were'} outside the valid range and left out; the line is broken there, not drawn across.`,
    );
  }
  if (route.runs.length > 1) {
    notes.push('The recording has gaps; the line is not drawn across them.');
  }
  if (singlePlace) {
    notes.push('The route is a single place, so it is drawn as a dot.');
  }

  return {
    ok: true,
    plan: {
      width,
      height,
      color,
      lineWidth,
      runs,
      dots: singlePlace ? [place(firstRun[0]!)] : dots,
      markerRadius,
      ...(markers && !singlePlace ? { start: place(firstRun[0]!), end: place(lastRun[lastRun.length - 1]!) } : {}),
      notes,
      singlePlace,
    },
  };
}

/** The file name for a route image: the size, never the activity's name. */
export function routeImageFileName(options: Pick<RouteImageOptions, 'width' | 'height'>): string {
  return `route-overlay-${options.width}x${options.height}.png`;
}

/**
 * The same plan at another size, for a preview: every coordinate and the stroke
 * scaled together, so what is shown is what the export draws, only smaller.
 */
export function scaleRouteImagePlan(plan: RouteImagePlan, factor: number): RouteImagePlan {
  const width = Math.max(1, Math.round(plan.width * factor));
  const height = Math.max(1, Math.round(plan.height * factor));
  const kx = width / plan.width;
  const ky = height / plan.height;
  const k = Math.min(kx, ky);
  const move = ([x, y]: Point): Point => [x * kx, y * ky];
  return {
    ...plan,
    width,
    height,
    lineWidth: Math.max(1, plan.lineWidth * k),
    markerRadius: plan.markerRadius * k,
    runs: plan.runs.map((run) => run.map(move)),
    dots: plan.dots.map(move),
    ...(plan.start ? { start: move(plan.start) } : {}),
    ...(plan.end ? { end: move(plan.end) } : {}),
  };
}
