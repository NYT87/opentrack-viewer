import {
  hasValidLocation,
  type Activity,
  type ActivityDerivedStats,
  type ActivityPoint,
  type ActivityWarning,
} from './activity';

const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Elevation gain is summed only once the running climb clears this threshold
 * (open question §17 resolved). Consumer GPS altitude noise is roughly ±2–5 m,
 * so a raw delta sum inflates gain badly on flat routes. 3 m is the common
 * industry default and keeps flat-route gain near zero.
 */
export const ELEVATION_NOISE_THRESHOLD_METERS = 3;

/** A point is "moving" when its speed exceeds this (used for moving time). */
const MOVING_SPEED_THRESHOLD_MPS = 0.5;

/** Great-circle distance between two WGS84 coordinates, in meters. */
export function haversineMeters(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DistanceResult {
  /** Total distance in meters, or undefined when it cannot be determined. */
  totalMeters?: number;
  /** Cumulative distance aligned index-for-index with the input points. */
  cumulativeMeters: (number | undefined)[];
  /** 'source' when the file provided a distance stream, 'derived' from GPS. */
  origin: 'source' | 'derived' | 'none';
}

/**
 * AV-401. Prefers a monotonic file-provided distance stream when one exists,
 * because devices integrate wheel/footpod data more accurately than sparse GPS
 * fixes. Falls back to haversine over valid coordinates otherwise.
 */
export function computeDistance(points: ActivityPoint[]): DistanceResult {
  const sourced = readSourceDistance(points);
  if (sourced) return sourced;

  const cumulative: (number | undefined)[] = new Array(points.length).fill(undefined);
  let total = 0;
  let previous: { lat: number; lon: number; segment: number } | undefined;
  let sawLocation = false;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    if (!hasValidLocation(point)) continue;
    sawLocation = true;
    const segment = point.segmentIndex ?? 0;

    // The gap between two segments is time the recording was stopped, not
    // ground covered. Counting it would inflate the distance by however far
    // the athlete travelled while paused.
    if (previous && previous.segment === segment) {
      total += haversineMeters(previous.lat, previous.lon, point.lat, point.lon);
    }
    previous = { lat: point.lat, lon: point.lon, segment };
    cumulative[i] = total;
  }

  if (!sawLocation) return { cumulativeMeters: cumulative, origin: 'none' };
  return { totalMeters: total, cumulativeMeters: cumulative, origin: 'derived' };
}

/** Uses the file's distance stream only when it is present and non-decreasing. */
function readSourceDistance(points: ActivityPoint[]): DistanceResult | undefined {
  const cumulative: (number | undefined)[] = new Array(points.length).fill(undefined);
  let last: number | undefined;
  let count = 0;

  for (let i = 0; i < points.length; i += 1) {
    const value = points[i]!.distanceMeters;
    if (!Number.isFinite(value)) continue;
    // A decreasing stream means resets or corruption; fall back to GPS instead.
    if (last !== undefined && (value as number) < last) return undefined;
    cumulative[i] = value;
    last = value;
    count += 1;
  }

  if (count < 2 || last === undefined) return undefined;
  return { totalMeters: last, cumulativeMeters: cumulative, origin: 'source' };
}

export interface TimeBoundsResult {
  startTime?: Date;
  endTime?: Date;
  durationSeconds?: number;
  warnings: ActivityWarning[];
}

/**
 * AV-402. Timestamps are taken as min/max rather than first/last so an
 * out-of-order file still yields a sane elapsed duration; the disorder is
 * reported as a warning rather than dropped silently.
 */
export function computeTimeBounds(points: ActivityPoint[]): TimeBoundsResult {
  const warnings: ActivityWarning[] = [];
  let min: number | undefined;
  let max: number | undefined;
  let previous: number | undefined;
  let unordered = false;
  let duplicates = 0;

  for (const point of points) {
    const time = point.time;
    if (!(time instanceof Date)) continue;
    const ms = time.getTime();
    if (Number.isNaN(ms)) continue;

    if (previous !== undefined) {
      if (ms < previous) unordered = true;
      else if (ms === previous) duplicates += 1;
    }
    previous = ms;
    if (min === undefined || ms < min) min = ms;
    if (max === undefined || ms > max) max = ms;
  }

  if (min === undefined || max === undefined) {
    return { warnings };
  }

  if (unordered) {
    warnings.push({
      code: 'unordered_timestamps',
      message:
        'Timestamps are not in chronological order. Duration uses the earliest and latest times found.',
      severity: 'warning',
    });
  }
  if (duplicates > 0) {
    warnings.push({
      code: 'duplicate_timestamps',
      message: `${duplicates} point${duplicates === 1 ? '' : 's'} share a timestamp with the previous point.`,
      severity: 'info',
    });
  }

  return {
    startTime: new Date(min),
    endTime: new Date(max),
    durationSeconds: (max - min) / 1000,
    warnings,
  };
}

export interface ElevationResult {
  gainMeters?: number;
  lossMeters?: number;
  minMeters?: number;
  maxMeters?: number;
}

/**
 * AV-403. Accumulates a candidate climb/descent and only commits it once it
 * exceeds ELEVATION_NOISE_THRESHOLD_METERS, so barometric jitter on flat
 * ground does not register as gain.
 */
export function computeElevation(
  points: ActivityPoint[],
  thresholdMeters: number = ELEVATION_NOISE_THRESHOLD_METERS,
): ElevationResult {
  let gain = 0;
  let loss = 0;
  let min: number | undefined;
  let max: number | undefined;
  let anchor: number | undefined;
  let seen = 0;

  for (const point of points) {
    const elevation = point.elevationMeters;
    if (!Number.isFinite(elevation)) continue;
    const value = elevation as number;
    seen += 1;
    if (min === undefined || value < min) min = value;
    if (max === undefined || value > max) max = value;

    if (anchor === undefined) {
      anchor = value;
      continue;
    }

    const delta = value - anchor;
    if (delta >= thresholdMeters) {
      gain += delta;
      anchor = value;
    } else if (delta <= -thresholdMeters) {
      loss += -delta;
      anchor = value;
    }
  }

  if (seen === 0) return {};
  return { gainMeters: gain, lossMeters: loss, minMeters: min, maxMeters: max };
}

interface SensorSummary {
  averageHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  averagePowerWatts?: number;
  maxPowerWatts?: number;
}

function computeSensorSummary(points: ActivityPoint[]): SensorSummary {
  let hrSum = 0;
  let hrCount = 0;
  let hrMax: number | undefined;
  let powerSum = 0;
  let powerCount = 0;
  let powerMax: number | undefined;

  for (const point of points) {
    if (Number.isFinite(point.heartRateBpm)) {
      const hr = point.heartRateBpm as number;
      hrSum += hr;
      hrCount += 1;
      if (hrMax === undefined || hr > hrMax) hrMax = hr;
    }
    if (Number.isFinite(point.powerWatts)) {
      const watts = point.powerWatts as number;
      powerSum += watts;
      powerCount += 1;
      if (powerMax === undefined || watts > powerMax) powerMax = watts;
    }
  }

  return {
    averageHeartRateBpm: hrCount > 0 ? hrSum / hrCount : undefined,
    maxHeartRateBpm: hrMax,
    averagePowerWatts: powerCount > 0 ? powerSum / powerCount : undefined,
    maxPowerWatts: powerMax,
  };
}

/** Elapsed time spent above the moving-speed threshold, when time+distance exist. */
function computeMovingDuration(
  points: ActivityPoint[],
  cumulative: (number | undefined)[],
): number | undefined {
  let moving = 0;
  let previousIndex: number | undefined;
  let counted = false;

  for (let i = 0; i < points.length; i += 1) {
    const time = points[i]!.time;
    const distance = cumulative[i];
    if (!(time instanceof Date) || Number.isNaN(time.getTime()) || distance === undefined) continue;
    if (previousIndex !== undefined) {
      const previousTime = points[previousIndex]!.time as Date;
      const seconds = (time.getTime() - previousTime.getTime()) / 1000;
      const meters = distance - (cumulative[previousIndex] as number);
      if (seconds > 0 && meters / seconds >= MOVING_SPEED_THRESHOLD_MPS) {
        moving += seconds;
        counted = true;
      }
    }
    previousIndex = i;
  }

  return counted ? moving : undefined;
}

export interface ComputeStatsResult {
  stats: ActivityDerivedStats;
  /** Cumulative distance per point — reused by the chart adapter (AV-501). */
  cumulativeDistanceMeters: (number | undefined)[];
  warnings: ActivityWarning[];
}

/** Runs the full stats engine over an activity's points. */
export function computeStats(points: ActivityPoint[]): ComputeStatsResult {
  const distance = computeDistance(points);
  const time = computeTimeBounds(points);
  const elevation = computeElevation(points);
  const sensors = computeSensorSummary(points);

  /*
   * Average speed over *elapsed* time, not moving time, so it agrees with the
   * `Duration` figure it sits beside. Moving time is reported separately, and a
   * moving average could be added alongside rather than replacing this one.
   */
  const averageSpeedMetersPerSecond =
    distance.totalMeters !== undefined &&
    time.durationSeconds !== undefined &&
    time.durationSeconds > 0
      ? distance.totalMeters / time.durationSeconds
      : undefined;

  /*
   * The same average, expressed the way runners read it. Derived from the speed
   * rather than computed separately so the two can never disagree. A zero
   * average has no pace — you cannot spend a finite time per kilometre without
   * covering one.
   */
  const averagePaceSecondsPerKm =
    averageSpeedMetersPerSecond !== undefined && averageSpeedMetersPerSecond > 0
      ? 1000 / averageSpeedMetersPerSecond
      : undefined;

  return {
    stats: {
      pointCount: points.length,
      startTime: time.startTime,
      endTime: time.endTime,
      durationSeconds: time.durationSeconds,
      movingDurationSeconds: computeMovingDuration(points, distance.cumulativeMeters),
      distanceMeters: distance.totalMeters,
      averageSpeedMetersPerSecond,
      averagePaceSecondsPerKm,
      elevationGainMeters: elevation.gainMeters,
      elevationLossMeters: elevation.lossMeters,
      minElevationMeters: elevation.minMeters,
      maxElevationMeters: elevation.maxMeters,
      ...sensors,
    },
    cumulativeDistanceMeters: distance.cumulativeMeters,
    warnings: time.warnings,
  };
}

/** Returns a copy of the activity with `derived` populated and warnings merged. */
export function withDerivedStats(activity: Activity): Activity {
  const { stats, warnings } = computeStats(activity.points);
  return {
    ...activity,
    derived: stats,
    warnings: [...activity.warnings, ...warnings],
  };
}
