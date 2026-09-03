import { ActivityError } from './errors';
import type { Activity, ActivityWarning } from './activity';

export interface ValidationResult {
  /** False when the activity has nothing worth showing at all. */
  isUsable: boolean;
  /** True when a route can be drawn on the map. */
  canRenderRoute: boolean;
  warnings: ActivityWarning[];
}

/**
 * Plan step 5: an activity is usable when it has route points *or* useful
 * summary data. A FIT treadmill run with no GPS is valid — it just cannot be
 * mapped — so a missing location stream is a warning, never a hard failure.
 */
export function validateActivity(activity: Activity): ValidationResult {
  const warnings: ActivityWarning[] = [];

  if (activity.points.length === 0) {
    return { isUsable: false, canRenderRoute: false, warnings };
  }

  const { hasLocation, hasTime, hasElevation } = activity.streams;

  if (!hasLocation) {
    warnings.push({
      code: 'no_location_stream',
      message: 'This activity has no GPS coordinates, so no route is shown.',
      severity: 'warning',
    });
  }
  if (!hasTime) {
    warnings.push({
      code: 'no_time_stream',
      message: 'No timestamps found. Duration and pace are unavailable.',
      severity: 'info',
    });
  }
  if (!hasElevation) {
    warnings.push({
      code: 'no_elevation_stream',
      message: 'No elevation data found. The elevation chart is unavailable.',
      severity: 'info',
    });
  }

  const isUsable = hasLocation || hasTime || hasElevation;
  return { isUsable, canRenderRoute: hasLocation, warnings };
}

/** Throws when the activity is not worth rendering at all. */
export function assertUsableActivity(activity: Activity): ValidationResult {
  const result = validateActivity(activity);
  if (activity.points.length === 0) {
    throw new ActivityError(
      'no_route_points',
      'The file parsed successfully but contained no track points.',
    );
  }
  if (!result.isUsable) {
    throw new ActivityError(
      'no_route_points',
      'The file contained points, but none had coordinates, timestamps or elevation.',
    );
  }
  return result;
}
