import { hasValidLocation, type ActivityPoint } from './activity';
import { ActivityError } from './errors';

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ProjectionOptions {
  width: number;
  height: number;
  /** Space kept clear on every side, in pixels. */
  padding: number;
}

export interface ProjectedRoute {
  width: number;
  height: number;
  /** One polyline per recorded segment, so a gap stays a gap. */
  segments: ScreenPoint[][];
  start: ScreenPoint;
  end: ScreenPoint;
}

/** Web Mercator stops being finite at the poles. */
const MAX_LATITUDE = 85.0511;

const mercatorY = (lat: number): number => {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
};

/**
 * AV-1009. Fits a route into a rectangle, in pixels.
 *
 * Projected the way the map draws it (Web Mercator), so an exported route has
 * the shape the reader just looked at rather than a squashed or stretched one.
 *
 * - Points with no usable position are skipped, as everywhere else.
 * - A route that crosses the antimeridian is unwrapped (longitudes below zero
 *   gain 360°) so it is drawn as one run instead of being stretched across the
 *   whole world.
 * - A single point, or a route that never moves, has no extent to scale by: it
 *   is centred and drawn as a point.
 * - The route is fitted *inside* the padding, so a thick line and its markers
 *   are not clipped by the edge.
 */
export function projectRoute(
  points: readonly ActivityPoint[],
  options: ProjectionOptions,
): ProjectedRoute {
  const { width, height, padding } = options;
  const innerWidth = width - 2 * padding;
  const innerHeight = height - 2 * padding;
  if (!(innerWidth > 0) || !(innerHeight > 0)) {
    throw new ActivityError(
      'invalid_selected_range',
      'The padding leaves no room for the route. Use a smaller padding or a larger image.',
    );
  }

  const located = points.filter(hasValidLocation);
  if (located.length === 0) {
    throw new ActivityError(
      'no_location_stream',
      'This activity has no GPS coordinates, so there is no route to draw.',
    );
  }

  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const point of located) {
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }
  const crossesAntimeridian = maxLon - minLon > 180;
  const lonOf = (lon: number) => (crossesAntimeridian && lon < 0 ? lon + 360 : lon);

  const projected = located.map((point) => ({
    x: lonOf(point.lon),
    y: mercatorY(point.lat),
    segment: point.segmentIndex ?? 0,
  }));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { x, y } of projected) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  // Longitude is in degrees and mercator Y in radians; put both in radians.
  const toRadians = Math.PI / 180;
  const spanX = (maxX - minX) * toRadians;
  const spanY = maxY - minY;

  const scales: number[] = [];
  if (spanX > 0) scales.push(innerWidth / spanX);
  if (spanY > 0) scales.push(innerHeight / spanY);
  const scale = scales.length > 0 ? Math.min(...scales) : 0;

  // Centre what is left over on each axis.
  const offsetX = padding + (innerWidth - spanX * scale) / 2;
  const offsetY = padding + (innerHeight - spanY * scale) / 2;

  const toScreen = (x: number, y: number): ScreenPoint => ({
    x: offsetX + (x - minX) * toRadians * scale,
    y: offsetY + (maxY - y) * scale,
  });

  const segments: ScreenPoint[][] = [];
  let current: ScreenPoint[] = [];
  let segment: number | undefined;
  for (const point of projected) {
    if (segment !== undefined && point.segment !== segment) {
      segments.push(current);
      current = [];
    }
    segment = point.segment;
    current.push(toScreen(point.x, point.y));
  }
  segments.push(current);

  const first = segments[0]![0]!;
  const lastSegment = segments.at(-1)!;
  return { width, height, segments, start: first, end: lastSegment.at(-1)! };
}
