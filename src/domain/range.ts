import type { Activity, ActivityPointRange } from './activity';
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
