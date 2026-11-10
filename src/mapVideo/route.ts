import { hasValidLocation, type Activity } from '../domain/activity';
import { haversineMeters } from '../domain/stats';

/**
 * AV-1203. The route a map video follows: the activity's located points, in
 * order, with the distance along the route at each. Built once per activity
 * and trim, and read by everything else: the timing, the camera, the drawn
 * line and the marker.
 */

/** One located point of the route. */
export interface RouteVertex {
  lon: number;
  lat: number;
  /** Metres along the route from its start. Never counted across a gap between recorded segments. */
  distance: number;
  /** Milliseconds since the epoch, where the point has a time. */
  time?: number;
  elevation?: number;
  /** The point's index in `activity.points`, for figures read at this place (AV-1207). */
  pointIndex: number;
  /** Recorded segment: no line is drawn between two segments, and no distance counted. */
  segment: number;
}

export interface MapVideoRoute {
  vertices: RouteVertex[];
  totalMeters: number;
}

/** A place on the route, between two vertices or on one. */
export interface RoutePosition {
  lon: number;
  lat: number;
  distance: number;
  elevation?: number;
  time?: number;
  /** The vertex at or before this place; the edge runs from it to the next. */
  index: number;
  /** How far along that edge, 0 to 1. */
  fraction: number;
}

/** The route of an activity, or undefined when fewer than two points have a location. */
export function buildMapVideoRoute(activity: Activity): MapVideoRoute | undefined {
  const vertices: RouteVertex[] = [];
  for (const point of activity.points) {
    if (!hasValidLocation(point)) continue;
    const previous = vertices[vertices.length - 1];
    const segment = point.segmentIndex ?? 0;
    const distance =
      previous === undefined
        ? 0
        : previous.distance + (previous.segment === segment ? haversineMeters(previous.lat, previous.lon, point.lat, point.lon) : 0);
    const time = point.time instanceof Date && !Number.isNaN(point.time.getTime()) ? point.time.getTime() : undefined;
    vertices.push({
      lon: point.lon,
      lat: point.lat,
      distance,
      ...(time !== undefined ? { time } : {}),
      ...(Number.isFinite(point.elevationMeters) ? { elevation: point.elevationMeters } : {}),
      pointIndex: point.index,
      segment,
    });
  }
  if (vertices.length < 2) return undefined;
  return { vertices, totalMeters: vertices[vertices.length - 1]!.distance };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpOptional = (a: number | undefined, b: number | undefined, t: number) =>
  a !== undefined && b !== undefined ? lerp(a, b, t) : t < 0.5 ? (a ?? b) : (b ?? a);

/** The last vertex whose distance is at most `distance`: at a gap, the first vertex after it. */
function vertexAtOrBefore(route: MapVideoRoute, distance: number): number {
  const { vertices } = route;
  let lo = 0;
  let hi = vertices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (vertices[mid]!.distance <= distance) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The place `distance` metres along the route, clamped to its ends. Between
 * two vertices it is interpolated, time and elevation with it, so the marker
 * moves smoothly however sparse the points are.
 */
export function positionAt(route: MapVideoRoute, distance: number): RoutePosition {
  const { vertices } = route;
  const d = Math.min(route.totalMeters, Math.max(0, distance));
  const index = vertexAtOrBefore(route, d);
  const a = vertices[index]!;
  const b = vertices[index + 1];
  if (!b || b.segment !== a.segment || b.distance <= a.distance) {
    return { lon: a.lon, lat: a.lat, distance: a.distance, elevation: a.elevation, time: a.time, index, fraction: 0 };
  }
  const fraction = (d - a.distance) / (b.distance - a.distance);
  return {
    lon: lerp(a.lon, b.lon, fraction),
    lat: lerp(a.lat, b.lat, fraction),
    distance: d,
    elevation: lerpOptional(a.elevation, b.elevation, fraction),
    time: lerpOptional(a.time, b.time, fraction),
    index,
    fraction,
  };
}

/** The smallest distance the privacy trim may leave: anything shorter is not a route to follow. */
export const MIN_TRIMMED_ROUTE_METERS = 100;

/**
 * The privacy trim: the route without its first `startMeters` and last
 * `endMeters`. The cut ends are interpolated, so the trimmed route starts and
 * ends exactly that far in. Everything downstream is built from the result,
 * so the trimmed stretches reach no line, marker, camera or figure.
 * Undefined when less than `MIN_TRIMMED_ROUTE_METERS` would remain.
 */
export function trimRoute(route: MapVideoRoute, startMeters: number, endMeters: number): MapVideoRoute | undefined {
  const start = Math.max(0, startMeters);
  const end = route.totalMeters - Math.max(0, endMeters);
  if (end - start < MIN_TRIMMED_ROUTE_METERS) return undefined;
  if (start === 0 && end === route.totalMeters) return route;

  const first = positionAt(route, start);
  const last = positionAt(route, end);
  const cut = (position: RoutePosition): RouteVertex => {
    const vertex = route.vertices[position.index]!;
    return {
      lon: position.lon,
      lat: position.lat,
      distance: position.distance,
      ...(position.time !== undefined ? { time: position.time } : {}),
      ...(position.elevation !== undefined ? { elevation: position.elevation } : {}),
      pointIndex: vertex.pointIndex,
      segment: vertex.segment,
    };
  };
  // Strictly between the cuts: a vertex exactly at a cut is the cut itself.
  const inner = route.vertices.filter((vertex, i) => i > first.index && vertex.distance > start && vertex.distance < end);
  const vertices = [cut(first), ...inner, cut(last)].map((vertex) => ({
    ...vertex,
    distance: vertex.distance - start,
  }));
  return { vertices, totalMeters: end - start };
}

/** The drawn part of the route at a place, and the marker, which meet exactly. */
export interface RouteReveal {
  /** One line per recorded segment reached so far, each as `[lon, lat]` pairs; the last ends at the marker. */
  lines: [number, number][][];
  marker: [number, number];
}

/**
 * The vertices worth drawing: Douglas–Peucker within each recorded segment,
 * keeping every vertex the line would otherwise stray more than
 * `toleranceMeters` from, and every segment's first and last. With a
 * tolerance under half a pixel the drawn line looks the same, and a long
 * route passes the map thousands of points a frame rather than every one.
 */
export function simplifiedIndices(route: MapVideoRoute, toleranceMeters: number): number[] {
  const { vertices } = route;
  if (!(toleranceMeters > 0)) return vertices.map((_, i) => i);
  // Local metres: plenty for the distances between neighbouring points.
  const lat0 = (vertices[0]!.lat * Math.PI) / 180;
  const x = vertices.map((vertex) => vertex.lon * 111_320 * Math.cos(lat0));
  const y = vertices.map((vertex) => vertex.lat * 110_574);
  const keep = new Uint8Array(vertices.length);
  const squared = toleranceMeters * toleranceMeters;
  let start = 0;
  for (let i = 1; i <= vertices.length; i += 1) {
    if (i < vertices.length && vertices[i]!.segment === vertices[start]!.segment) continue;
    const end = i - 1;
    keep[start] = 1;
    keep[end] = 1;
    const stack: [number, number][] = [[start, end]];
    while (stack.length > 0) {
      const [a, b] = stack.pop()!;
      const dx = x[b]! - x[a]!;
      const dy = y[b]! - y[a]!;
      const length = dx * dx + dy * dy;
      let worst = -1;
      let worstDistance = squared;
      for (let k = a + 1; k < b; k += 1) {
        const t = length > 0 ? Math.max(0, Math.min(1, ((x[k]! - x[a]!) * dx + (y[k]! - y[a]!) * dy) / length)) : 0;
        const ex = x[a]! + t * dx - x[k]!;
        const ey = y[a]! + t * dy - y[k]!;
        const distance = ex * ex + ey * ey;
        if (distance > worstDistance) {
          worstDistance = distance;
          worst = k;
        }
      }
      if (worst >= 0) {
        keep[worst] = 1;
        stack.push([a, worst], [worst, b]);
      }
    }
    start = i;
  }
  const kept: number[] = [];
  keep.forEach((flag, i) => {
    if (flag) kept.push(i);
  });
  return kept;
}

/**
 * The route drawn up to `distance`, ending exactly where the marker is. With
 * `kept` (from `simplifiedIndices`), only those vertices are drawn before the
 * marker; the marker itself is always the exact place.
 */
export function revealAt(route: MapVideoRoute, distance: number, kept?: number[]): RouteReveal {
  const position = positionAt(route, distance);
  const marker: [number, number] = [position.lon, position.lat];
  const lines: [number, number][][] = [];
  let line: [number, number][] = [];
  let segment: number | undefined;
  let upTo = position.index;
  if (kept) {
    // The kept vertices up to the marker's edge.
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kept[mid]! <= position.index) lo = mid + 1;
      else hi = mid;
    }
    upTo = lo - 1;
  }
  for (let j = 0; j <= upTo; j += 1) {
    const i = kept ? kept[j]! : j;
    const vertex = route.vertices[i]!;
    if (segment !== undefined && vertex.segment !== segment) {
      if (line.length > 0) lines.push(line);
      line = [];
    }
    segment = vertex.segment;
    line.push([vertex.lon, vertex.lat]);
  }
  // The marker closes the line, unless it stands on the last vertex drawn.
  const last = line[line.length - 1];
  if (!last || last[0] !== marker[0] || last[1] !== marker[1]) line.push(marker);
  lines.push(line);
  return { lines, marker };
}
