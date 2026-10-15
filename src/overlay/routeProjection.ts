import type { Activity, Coordinate } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';

/**
 * AV-1004. Fits an activity's route into a unit box for the route inset.
 *
 * Equirectangular, with longitude scaled by the cosine of the mean latitude so
 * a route is not stretched; longitudes are unwrapped from the first point so a
 * route crossing the antimeridian stays in one piece. Aspect ratio is kept and
 * the route is centred, so nothing is clipped whatever shape the box is.
 */
export interface ProjectedRoute {
  /** Segments of normalized `[x, y]` points, y down, each within the padded box. */
  segments: [number, number][][];
  project: (position: Coordinate) => [number, number];
}

export function projectRoute(
  activity: Activity,
  boxAspect: number,
  padding = 0.08,
): ProjectedRoute | undefined {
  // A run is an unbroken stretch of valid fixes. A recorded segment boundary
  // or an invalid fix ends one: drawing across either would suggest a route
  // through a gap the recording does not contain.
  const raw: { lat: number; lon: number; segment: number }[] = [];
  let run = 0;
  let lastSegment: number | undefined;
  let lastValid = true;
  for (const point of activity.points) {
    const place = toValidCoordinate(point.lat, point.lon);
    const segment = point.segmentIndex ?? 0;
    if (!place) {
      lastValid = false;
      continue;
    }
    if (!lastValid || (lastSegment !== undefined && segment !== lastSegment)) run += 1;
    lastValid = true;
    lastSegment = segment;
    raw.push({ ...place, segment: run });
  }
  const first = raw[0];
  if (!first || !(boxAspect > 0)) return undefined;

  const unwrap = (lon: number) => {
    let delta = lon - first.lon;
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    return first.lon + delta;
  };

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let latSum = 0;
  for (const { lat, lon } of raw) {
    const u = unwrap(lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, u);
    maxLon = Math.max(maxLon, u);
    latSum += lat;
  }
  const lonScale = Math.cos(((latSum / raw.length) * Math.PI) / 180);
  const width = (maxLon - minLon) * lonScale;
  const height = maxLat - minLat;

  // Work in a box of `boxAspect` x 1, then normalize x by the aspect.
  const innerW = boxAspect * (1 - 2 * padding);
  const innerH = 1 - 2 * padding;
  const scale =
    width > 0 && height > 0
      ? Math.min(innerW / width, innerH / height)
      : width > 0
        ? innerW / width
        : height > 0
          ? innerH / height
          : 0; // a single place: centred
  const offsetX = (boxAspect - width * scale) / 2;
  const offsetY = (1 - height * scale) / 2;

  const project = ({ lat, lon }: Coordinate): [number, number] => [
    (offsetX + (unwrap(lon) - minLon) * lonScale * scale) / boxAspect,
    offsetY + (maxLat - lat) * scale,
  ];

  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let currentSegment = first.segment;
  for (const place of raw) {
    if (place.segment !== currentSegment) {
      if (current.length) segments.push(current);
      current = [];
      currentSegment = place.segment;
    }
    current.push(project(place));
  }
  if (current.length) segments.push(current);

  return { segments, project };
}
