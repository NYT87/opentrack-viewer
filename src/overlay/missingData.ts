import type { OverlayMetricKey } from './timeline';

/**
 * Why an activity cannot show a live figure, in the words the canvas's Add
 * list gives for it. Kept apart from `customCanvas` so the registry of
 * predefined components (AV-1016) can give the same reasons without the two
 * modules needing each other at load.
 */

/** Why an activity cannot show its elevation, as a figure or a profile. */
export const ELEVATION_MISSING = 'This activity has no elevation.';

export const NO_ROUTE = 'This activity has no positions, so there is no route.';

export const METRIC_MISSING: Record<OverlayMetricKey, string> = {
  speed: 'This activity has no speed: it needs positions or a recorded speed, and times.',
  pace: 'This activity has no pace: it needs a speed, and some movement.',
  distance: 'This activity has no distance: it has no positions or recorded distance.',
  elapsed: 'This activity has no timestamps.',
  moving: 'This activity has no moving time: it needs a distance and times.',
  elevation: ELEVATION_MISSING,
  heartRate: 'This activity has no heart rate.',
  power: 'This activity has no power.',
  cyclingCadence: 'This activity has no cycling cadence.',
  runningCadence: 'This activity has no running cadence.',
  temperature: 'This activity has no temperature.',
  grade: 'This activity has no gradient: it needs a recorded grade, or elevation and 50 m of distance.',
  climb: ELEVATION_MISSING,
  heading: 'This activity has no heading: it needs positions, and 20 m of movement.',
};
