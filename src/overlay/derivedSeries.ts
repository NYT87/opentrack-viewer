import type { ActivityPoint } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';

/**
 * AV-1019 (TD-087). The two readings the overlay derives from where the activity
 * went: the grade, from elevation over the last stretch of distance, and the
 * heading, the bearing of the last stretch of the route. Pure functions of the
 * points and their cumulative distance (`computeDistance`), so the timeline, the
 * charts and the tests read them the same way. Both stay inside one recorded
 * segment: a pause or a lost fix is not a stretch that was ridden.
 */

/** The grade is the climb over at least this much distance. */
export const GRADE_BACK_METERS = 50;
/** The heading is the bearing from the point at least this far back. */
export const HEADING_BACK_METERS = 20;

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * For each point, the nearest earlier point of the same segment that is at least
 * `meters` of distance back, or -1 where there is none (the start, a segment's
 * first stretch, a point with no distance). Distance never decreases along a
 * segment, so the back point only moves forward as the point does: one pass.
 */
function backPoints(points: ActivityPoint[], distance: (number | undefined)[], meters: number): Int32Array {
  const back = new Int32Array(points.length).fill(-1);
  // The points of the current segment that have a distance, in order, and how many of them are far enough behind.
  let seen: number[] = [];
  let far = -1;
  let segment: number | undefined;
  for (let i = 0; i < points.length; i += 1) {
    const seg = points[i]!.segmentIndex ?? 0;
    if (seg !== segment) {
      segment = seg;
      seen = [];
      far = -1;
    }
    const here = distance[i];
    if (!finite(here)) continue;
    while (far + 1 < seen.length && here - distance[seen[far + 1]!]! >= meters) far += 1;
    back[i] = far >= 0 ? seen[far]! : -1;
    seen.push(i);
  }
  return back;
}

/**
 * The slope in percent at each point: the file's own grade where it states one,
 * else the elevation gained since the point at least 50 m of distance back, over
 * that distance. Undefined within the first 50 m of a segment, and wherever the
 * point or the one it looks back to has no elevation or no distance.
 */
export function deriveGrade(points: ActivityPoint[], distance: (number | undefined)[]): (number | undefined)[] {
  const back = backPoints(points, distance, GRADE_BACK_METERS);
  return points.map((point, i) => {
    if (finite(point.gradePercent)) return point.gradePercent;
    const j = back[i]!;
    if (j < 0) return undefined;
    const now = point.elevationMeters;
    const then = points[j]!.elevationMeters;
    const here = distance[i];
    const there = distance[j];
    if (!finite(now) || !finite(then) || !finite(here) || !finite(there) || here <= there) return undefined;
    return ((now - then) / (here - there)) * 100;
  });
}

/** The great-circle initial bearing from one position to another, in degrees 0 (north) to just under 360. */
export function bearingDegrees(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const phi1 = from.lat * rad;
  const phi2 = to.lat * rad;
  const delta = (to.lon - from.lon) * rad;
  const y = Math.sin(delta) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(delta);
  return normalizeDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

/** An angle in degrees brought into [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  const positive = wrapped < 0 ? wrapped + 360 : wrapped;
  // -1e-15 % 360 + 360 is 360 once rounded.
  // `+ 0` turns -0 into 0.
  return positive >= 360 ? 0 : positive + 0;
}

/**
 * The heading at each point: the bearing from the point at least 20 m of
 * distance back along the route (within the segment) to this one. Undefined
 * before the activity has moved 20 m, and where either point has no position.
 */
export function deriveHeading(points: ActivityPoint[], distance: (number | undefined)[]): (number | undefined)[] {
  const back = backPoints(points, distance, HEADING_BACK_METERS);
  return points.map((point, i) => {
    const j = back[i]!;
    if (j < 0) return undefined;
    const to = toValidCoordinate(point.lat, point.lon);
    const from = toValidCoordinate(points[j]!.lat, points[j]!.lon);
    if (!to || !from || (to.lat === from.lat && to.lon === from.lon)) return undefined;
    return bearingDegrees(from, to);
  });
}

/**
 * The circular mean of angles in degrees: the direction of the sum of their unit
 * vectors, so 359 and 1 average to 0 and not to 180. `undefined` for none, and
 * for angles that cancel out (opposite headings have no mean direction).
 */
export function circularMeanDegrees(sumSin: number, sumCos: number, count: number): number | undefined {
  if (count === 0) return undefined;
  if (Math.hypot(sumSin, sumCos) < 1e-9 * count) return undefined;
  return normalizeDegrees((Math.atan2(sumSin, sumCos) * 180) / Math.PI);
}

/** Between two angles in degrees along the shorter arc, `fraction` of the way from `a` to `b`. */
export function lerpDegrees(a: number, b: number, fraction: number): number {
  let delta = normalizeDegrees(b) - normalizeDegrees(a);
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return normalizeDegrees(a + delta * fraction);
}

const POINTS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** The 8-point letters for a heading: N covers 337.5 to 22.5. */
export function cardinalLetters(degrees: number): (typeof POINTS_8)[number] {
  return POINTS_8[Math.round(normalizeDegrees(degrees) / 45) % 8]!;
}

/**
 * "123° SE". The degrees are rounded, and a heading that rounds up to 360 reads
 * 0° N, so the number and the letter always agree.
 */
export function formatHeading(degrees: number): string {
  const whole = Math.round(normalizeDegrees(degrees)) % 360;
  return `${whole}° ${cardinalLetters(whole)}`;
}
