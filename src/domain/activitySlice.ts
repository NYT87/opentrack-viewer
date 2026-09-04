import {
  computeStreams,
  type Activity,
  type ActivityPointRange,
} from './activity';
import { ActivityError } from './errors';
import { withDerivedStats } from './stats';

export type ActivitySliceResult =
  | { ok: true; activity: Activity }
  | { ok: false; error: ActivityError };

/** A focus needs at least two points; one point draws no line and spans nothing. */
const MIN_FOCUSED_POINTS = 2;

/**
 * AV-510. Derives a focused view of an activity from a selected point range.
 *
 * The original is never touched (TD-006): this returns a new `Activity` that
 * shares the very same `ActivityPoint` objects, so focusing a 50,000-point ride
 * copies references rather than data.
 *
 * **Points keep their original `index`.** They are not renumbered from zero,
 * because an index is the app's identifier for a point: hover and selection
 * state, chart samples, and the map's coordinate lookup all speak in these
 * numbers. Renumbering would mean translating at every boundary between the
 * focused and full views, and any missed translation would silently point at
 * the wrong place on the map. `ActivityPointRange` therefore refers to
 * `point.index` values, not to positions in the `points` array.
 *
 * Derived stats are recalculated for the slice, and streams are recomputed too:
 * a focused section may lack elevation or cadence the whole activity has.
 */
export function sliceActivity(
  activity: Activity,
  range: ActivityPointRange,
): ActivitySliceResult {
  const { startIndex, endIndex } = range;

  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    endIndex < startIndex
  ) {
    return {
      ok: false,
      error: new ActivityError(
        'invalid_selected_range',
        'The selected range is not a valid span of this activity.',
      ),
    };
  }

  const points = activity.points.filter(
    (point) => point.index >= startIndex && point.index <= endIndex,
  );

  if (points.length < MIN_FOCUSED_POINTS) {
    return {
      ok: false,
      error: new ActivityError(
        'invalid_selected_range',
        `The selected range covers ${points.length} point${points.length === 1 ? '' : 's'}, which is too short to show.`,
      ),
    };
  }

  const focused = withDerivedStats({
    ...activity,
    points,
    streams: computeStreams(points),
    // Laps describe the whole recording. A lap that runs past the focused
    // section would misrepresent it, so they are left to the full view.
    laps: undefined,
    // Stats are recomputed below; drop the full-activity ones so they cannot be
    // mistaken for the slice's.
    derived: undefined,
  });

  focused.metadata = {
    ...activity.metadata,
    startTime: focused.derived?.startTime,
    endTime: focused.derived?.endTime,
  };

  return { ok: true, activity: focused };
}
