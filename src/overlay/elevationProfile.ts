import type { Activity } from '../domain/activity';
import { MAX_SERIES_COLUMNS, projectSeries, type ProjectedSeries } from './series';

/**
 * AV-1211. An activity's elevation, fitted into a unit box for the elevation
 * profile: along the activity on x, the height on y (down), with a cursor at
 * the moment shown.
 *
 * AV-1019 (TD-087). It is the series of elevation along distance (`projectSeries`):
 * the same projection a chart of any figure is made with, so a profile is a case
 * of a chart and draws the same pixels it always did. Along is measured as the
 * timeline's `progress` is (TD-041): by the recorded or derived distance where
 * the activity has one, else by time. A stretch with no elevation is a gap in the
 * line, not a line drawn across it.
 */
export type ProjectedProfile = ProjectedSeries;

/** The most points a profile is drawn with: two per column of a 1000 px box, the lowest and the highest. */
export const MAX_PROFILE_COLUMNS = MAX_SERIES_COLUMNS;

/** The profile of `activity`, or `undefined` when it has no two places with an elevation along it. */
export function projectProfile(activity: Activity): ProjectedProfile | undefined {
  return projectSeries(activity, (index) => activity.points[index]!.elevationMeters, 'distance', { fallbackToTime: true });
}
