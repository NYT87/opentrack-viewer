import { hasValidLocation, type Activity, type ActivityLap, type ActivityPointRange } from './activity';
import { pointXValues, type SeriesXAxis } from './series';

/**
 * AV-509. Translates a span of the chart's x-axis into a range of activity
 * points.
 *
 * Points with no value on the requested axis — a GPS dropout on the distance
 * axis, a missing timestamp on the time axis — cannot be compared, so each edge
 * of the selection resolves to the *nearest point that does have a value*
 * rather than being dropped. That keeps a selection over a gap meaningful
 * instead of collapsing it.
 *
 * Out-of-bounds edges clamp to the first and last plottable points, and a
 * reversed drag is normalised.
 *
 * The result is expressed in `point.index` values, not positions in the points
 * array, so it keeps meaning against a focused slice (AV-510).
 */
export function pointRangeFromDomain(
  activity: Activity,
  axis: SeriesXAxis,
  start: number,
  end: number,
): ActivityPointRange | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;

  const xs = pointXValues(activity, axis);
  const nearest = (target: number): number | undefined => {
    let bestIndex: number | undefined;
    let bestDelta = Infinity;
    for (let i = 0; i < xs.length; i += 1) {
      const value = xs[i];
      if (value === undefined) continue;
      const delta = Math.abs(value - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  const from = nearest(Math.min(start, end));
  const to = nearest(Math.max(start, end));
  if (from === undefined || to === undefined) return undefined;

  const first = activity.points[from]!.index;
  const last = activity.points[to]!.index;
  return { startIndex: Math.min(first, last), endIndex: Math.max(first, last) };
}

/**
 * The inverse: where a stored point range sits on the current axis, so the
 * selection can be drawn after the reader switches between distance and time.
 *
 * An endpoint with no value on this axis falls back to the nearest point that
 * has one, in the direction of the range, so the band still spans the selection.
 */
export function domainFromPointRange(
  activity: Activity,
  axis: SeriesXAxis,
  range: ActivityPointRange,
): { start: number; end: number } | undefined {
  const xs = pointXValues(activity, axis);

  // The range speaks in point.index; find where those points sit in the array.
  const positionOf = (pointIndex: number) =>
    activity.points.findIndex((point) => point.index === pointIndex);
  const startPosition = positionOf(range.startIndex);
  const endPosition = positionOf(range.endIndex);
  if (startPosition === -1 || endPosition === -1) return undefined;

  const valueSearchingFrom = (index: number, step: number): number | undefined => {
    for (let i = index; i >= 0 && i < xs.length; i += step) {
      const value = xs[i];
      if (value !== undefined) return value;
    }
    return undefined;
  };

  // Search outward from each edge so the band never shrinks past the selection.
  const start = valueSearchingFrom(startPosition, -1) ?? valueSearchingFrom(startPosition, 1);
  const end = valueSearchingFrom(endPosition, 1) ?? valueSearchingFrom(endPosition, -1);
  if (start === undefined || end === undefined) return undefined;

  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * The span of points a lap covers, found by time.
 *
 * A lap states when it began and ended; a point states when it was recorded.
 * Nothing in any format links the two directly, so the times are what join
 * them. A lap whose bounds are unknown — or that no point falls inside — has
 * no range, and the caller shows nothing rather than guessing at one.
 */
export function lapPointRange(
  activity: Activity,
  lap: ActivityLap,
): ActivityPointRange | undefined {
  const start = lap.startTime?.getTime();
  const end = lap.endTime?.getTime();
  if (start === undefined) return undefined;

  let first: number | undefined;
  let last: number | undefined;

  for (const point of activity.points) {
    const time = point.time instanceof Date ? point.time.getTime() : undefined;
    if (time === undefined || time < start) continue;
    if (end !== undefined && time > end) break;

    first ??= point.index;
    last = point.index;
  }

  return first === undefined || last === undefined ? undefined : { startIndex: first, endIndex: last };
}

/**
 * Whether a span of points can be drawn as a route line.
 *
 * A line needs two located points from the *same* recorded segment: a pause
 * splits the route, and one point on either side of it draws nothing. That is
 * not hypothetical — a lap boundary can fall inside a pause, leaving a lap with
 * a point on each side and no line to show for it.
 *
 * Answered by counting rather than by building the geometry, so a panel can ask
 * it of every lap without serializing the whole route each time.
 */
export function hasDrawableRoute(activity: Activity, range: ActivityPointRange): boolean {
  let segment: number | undefined;
  let run = 0;

  for (const point of activity.points) {
    if (point.index < range.startIndex) continue;
    if (point.index > range.endIndex) break;

    // Skipped, not treated as a break: `activityToRouteGeoJSON` joins across an
    // unlocated point too, and this must answer for the same geometry it draws.
    if (!hasValidLocation(point)) continue;

    const current = point.segmentIndex ?? 0;
    run = current === segment ? run + 1 : 1;
    segment = current;

    if (run >= 2) return true;
  }

  return false;
}
