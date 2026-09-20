import type { Activity } from './activity';
import { computeDistance, computeTimeBounds } from './stats';

/**
 * How an activity's movement is read: distance over time, or time over
 * distance. The same measurement either way — runners read one, riders the
 * other, and it is a convention rather than a fact about the data (AV-908).
 */
export type PerformanceMetric = 'speed' | 'pace';

/**
 * The sports whose convention is settled. Note what is *not* here: walking,
 * hiking, skiing and the rest keep whatever the viewer already showed them,
 * because this task is about files that never said what they were, and
 * quietly changing a hike's charts is not that.
 */
const PACE_SPORTS = new Set(['running']);

/**
 * AV-908. Whether this app can tell which reading convention applies.
 *
 * Two different situations, with the same consequence:
 *
 * - `unknown` — the file stated no sport at all. A GoPro video is this, and
 *   honestly so: a bike, a pair of skis and a car all produce a moving GPS
 *   track, and a camera cannot tell them apart.
 * - `other` — the file *did* state a sport, and it is one this app does not
 *   model. A GPX `<type>kayaking</type>`, a FIT sport code with no name here,
 *   or any TCX activity that is neither Running nor Biking lands on it.
 *
 * In neither case does anything here know whether the reader wants speed or
 * pace, so in both the reader is asked. Note this is not "no sport": a file
 * that named kayaking told us something, just not something this app can act
 * on.
 */
export function isAmbiguousSport(activity: Activity): boolean {
  const sport = activity.metadata.sport;
  return sport === undefined || sport === 'unknown' || sport === 'other';
}

/** The metric the activity would show if the reader expressed no preference. */
export function defaultPerformanceMetric(activity: Activity): PerformanceMetric {
  const sport = activity.metadata.sport;
  // Speed for everything the file does not pin down: it means something for
  // any movement, while pace read off a chairlift is nonsense.
  return sport !== undefined && PACE_SPORTS.has(sport) ? 'pace' : 'speed';
}

/**
 * Whether pace can be worked out at all. Distance over a duration is arithmetic
 * either way round, so the requirement is the same one speed has — but a
 * stationary activity has a speed of zero and no pace, which the summary says
 * for itself.
 */
function paceIsPossible(activity: Activity): boolean {
  const distance = computeDistance(activity.points);
  // Ground actually covered, not merely a distance that could be computed: a
  // recording made standing still has coordinates and timestamps and a total
  // of zero, and no pace — you cannot spend a finite time per kilometre
  // without covering one. Offering the switch there hands the reader a mode
  // whose only possible answer is "no distance covered".
  const movedSomewhere = (distance.totalMeters ?? 0) > 0;
  const duration = computeTimeBounds(activity.points).durationSeconds;
  return movedSomewhere && duration !== undefined && duration > 0;
}

/**
 * AV-908. Whether to offer the reader the choice.
 *
 * Offered only where the file left the question open, and only when pace can
 * be worked out at all. A run is shown in pace and a ride in speed as they
 * always were: those files said what they were, and a control that re-asks a
 * settled question is noise on every activity that is not a video.
 */
export function isPerformanceMetricSelectable(activity: Activity): boolean {
  return isAmbiguousSport(activity) && paceIsPossible(activity);
}

/**
 * AV-908. The metric to display: the reader's preference where the activity
 * allows one, and the sport's own answer otherwise.
 *
 * The preference lives outside the activity and is resolved on every read, so
 * switching never touches the `Activity` — and, for a video, never goes near
 * the file it came from (TD-006). Nothing is re-parsed; the points and their
 * timestamps are already in memory.
 */
export function resolvePerformanceMetric(
  activity: Activity,
  preference?: PerformanceMetric,
): PerformanceMetric {
  if (preference && isPerformanceMetricSelectable(activity)) return preference;
  return defaultPerformanceMetric(activity);
}
