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
  // AV-1025 (TD-094).
  maxSpeed: 'This activity has no speed: it needs positions or a recorded speed, and times.',
  maxHeartRate: 'This activity has no heart rate.',
  maxPower: 'This activity has no power.',
  averageSpeed: 'This activity has no average speed: it needs a distance and times.',
  averageMovingSpeed: 'This activity has no average moving speed: it needs a distance and times, and some movement.',
  averagePace: 'This activity has no average pace: it needs a distance and times, and some movement.',
  averageMovingPace: 'This activity has no average moving pace: it needs a distance and times, and some movement.',
  verticalSpeed: ELEVATION_MISSING,
  elevationLowest: ELEVATION_MISSING,
  elevationHighest: ELEVATION_MISSING,
  stopwatch: 'This activity has no timestamps.',
  clock: 'This activity has no timestamps, so it has no time of day.',
};

/** AV-1021. Why an activity cannot be split, for a predefined entry that needs splits: the file's laps with start times, or a distance. */
export const SPLITS_MISSING = 'This activity has no distance, and no laps with start times, to split by.';
