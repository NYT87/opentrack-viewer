import {
  isPlausibleSpeed,
  type Activity,
  type ActivityPoint,
  type ActivityPointRange,
  type ChartXAxisMode,
} from './activity';
import { computeDistance, computeTimeBounds } from './stats';

/** The axis a series is actually plotted against; see ChartXAxisMode. */
export type SeriesXAxis = ChartXAxisMode | 'index';

export type ChartSeriesKey =
  | 'elevation'
  | 'pace'
  | 'speed'
  | 'cadence'
  | 'heartRate'
  | 'power'
  | 'temperature';

export interface SeriesSample {
  /** Meters, seconds since the activity start, or the point index. */
  x: number;
  y: number;
  /** Index into `activity.points`, for map/chart synchronization (AV-601). */
  pointIndex: number;
}

export interface ChartSeries {
  key: ChartSeriesKey;
  label: string;
  unit: string;
  /** The axis actually plotted, which may be the `index` fallback. */
  xAxis: SeriesXAxis;
  /** What the caller asked for, when it asked for anything. */
  requestedXAxis?: ChartXAxisMode;
  /** Set when the requested axis was unavailable and another was used. */
  xAxisFallbackReason?: string;
  samples: SeriesSample[];
  /** Pace reads better with faster values at the top (AV-505). */
  invertY?: boolean;
  yMin: number;
  yMax: number;
  xMin: number;
  xMax: number;
  isEmpty: boolean;
}

/** AV-501: typed availability, so the UI can explain a disabled axis. */
export interface XAxisAvailability {
  mode: ChartXAxisMode;
  available: boolean;
  /** Why the axis cannot be built. Present only when unavailable. */
  reason?: string;
}

export interface ResolvedXAxis {
  axis: SeriesXAxis;
  requested?: ChartXAxisMode;
  fallbackReason?: string;
}

interface SeriesDefinition {
  key: ChartSeriesKey;
  label: string;
  unit: string;
  invertY?: boolean;
  /**
   * Reads the value for a point. `derive` series compute their values across
   * points instead and provide `derived` below.
   */
  read?: (point: ActivityPoint) => number | undefined;
  derived?: (activity: Activity) => (number | undefined)[];
}

const DEFINITIONS: Record<ChartSeriesKey, SeriesDefinition> = {
  elevation: { key: 'elevation', label: 'Elevation', unit: 'm', read: (p) => p.elevationMeters },
  pace: { key: 'pace', label: 'Pace', unit: 's/km', invertY: true, derived: derivePace },
  speed: { key: 'speed', label: 'Speed', unit: 'm/s', derived: deriveSpeed },
  // AV-515: strides per minute, never rpm.
  cadence: {
    key: 'cadence',
    label: 'Cadence',
    unit: 'spm',
    read: (p) => p.runningCadenceSpm,
  },
  heartRate: { key: 'heartRate', label: 'Heart rate', unit: 'bpm', read: (p) => p.heartRateBpm },
  power: { key: 'power', label: 'Power', unit: 'W', read: (p) => p.powerWatts },
  temperature: {
    key: 'temperature',
    label: 'Temperature',
    unit: '°C',
    read: (p) => p.temperatureCelsius,
  },
};

/**
 * Rolling window for pace, in seconds. Point-to-point pace from consumer GPS is
 * dominated by fix jitter — a metre of noise between two 1 s samples swings the
 * value by minutes per km — so each sample is averaged over a window instead.
 * (§17 open question resolved.)
 */
export const PACE_WINDOW_SECONDS = 15;

/**
 * Speeds above this are not plausible for a human on foot, so the interval that
 * produced them is treated as a gap rather than plotted (AV-505).
 */
const MAX_PLAUSIBLE_SPEED_MPS = 10;

/**
 * AV-505. Pace in seconds per kilometre, derived from distance and time over a
 * rolling window rather than from instantaneous speed: `speedMetersPerSecond`
 * is often absent in GPX and is itself device-smoothed when present, so
 * deriving keeps GPX and FIT consistent (TD-002).
 */
function derivePace(activity: Activity): (number | undefined)[] {
  const points = activity.points;
  const cumulative = computeDistance(points).cumulativeMeters;
  const times = points.map((point) =>
    point.time instanceof Date && !Number.isNaN(point.time.getTime())
      ? point.time.getTime() / 1000
      : undefined,
  );

  const out: (number | undefined)[] = new Array(points.length).fill(undefined);
  // Indexes of points that carry both a distance and a timestamp.
  const usable: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (cumulative[i] !== undefined && times[i] !== undefined) usable.push(i);
  }

  let windowStart = 0;
  for (let k = 0; k < usable.length; k += 1) {
    const i = usable[k]!;
    const timeAt = times[i]!;

    // Advance the trailing edge until the window is no wider than it needs.
    while (
      windowStart < k &&
      timeAt - times[usable[windowStart + 1]!]! >= PACE_WINDOW_SECONDS
    ) {
      windowStart += 1;
    }

    const j = usable[windowStart]!;
    if (j === i) continue;

    const seconds = timeAt - times[j]!;
    const meters = cumulative[i]! - cumulative[j]!;
    // Zero-duration or stationary intervals have no meaningful pace: gap them.
    if (seconds <= 0 || meters <= 0) continue;
    if (meters / seconds > MAX_PLAUSIBLE_SPEED_MPS) continue;

    out[i] = (seconds / meters) * 1000;
  }

  return out;
}

/**
 * AV-513. Speed in metres per second.
 *
 * A recorded `speedMetersPerSecond` is trusted when the device provides a
 * plausible one — a wheel sensor knows better than GPS positions do, but a
 * faulty reading is worse than none, so an implausible value falls through to
 * derivation like a missing one. Otherwise speed is derived
 * over the same rolling window as pace, for the same reason: point-to-point
 * speed from consumer GPS is mostly fix jitter.
 */
function deriveSpeed(activity: Activity): (number | undefined)[] {
  const points = activity.points;
  const cumulative = computeDistance(points).cumulativeMeters;
  const times = points.map((point) =>
    point.time instanceof Date && !Number.isNaN(point.time.getTime())
      ? point.time.getTime() / 1000
      : undefined,
  );

  const out: (number | undefined)[] = new Array(points.length).fill(undefined);
  const usable: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const recorded = points[i]!.speedMetersPerSecond;
    if (isPlausibleSpeed(recorded)) out[i] = recorded;
    if (cumulative[i] !== undefined && times[i] !== undefined) usable.push(i);
  }

  let windowStart = 0;
  for (let k = 0; k < usable.length; k += 1) {
    const i = usable[k]!;
    if (out[i] !== undefined) continue; // The device already told us.
    const timeAt = times[i]!;

    while (
      windowStart < k &&
      timeAt - times[usable[windowStart + 1]!]! >= PACE_WINDOW_SECONDS
    ) {
      windowStart += 1;
    }

    const j = usable[windowStart]!;
    if (j === i) continue;

    const seconds = timeAt - times[j]!;
    const meters = cumulative[i]! - cumulative[j]!;
    if (seconds <= 0 || meters < 0) continue;

    const speed = meters / seconds;
    // An interval that implies an impossible speed is a gap, not a data point.
    if (!isPlausibleSpeed(speed)) continue;
    out[i] = speed;
  }

  return out;
}

const NO_DISTANCE = 'This activity has no distance or GPS data.';
const NO_TIME = 'This activity has no usable timestamps.';

/**
 * AV-501 / AV-504. Which x-axis modes this activity can be plotted against,
 * with a reason for each one that it cannot.
 */
export function getXAxisAvailability(activity: Activity): XAxisAvailability[] {
  const hasDistance = computeDistance(activity.points).origin !== 'none';
  const time = computeTimeBounds(activity.points);
  // A single timestamp, or many identical ones, gives a zero-width axis.
  const hasTime = time.durationSeconds !== undefined && time.durationSeconds > 0;

  return [
    { mode: 'distance', available: hasDistance, ...(hasDistance ? {} : { reason: NO_DISTANCE }) },
    { mode: 'time', available: hasTime, ...(hasTime ? {} : { reason: NO_TIME }) },
  ];
}

/**
 * Picks the axis to plot: the caller's preference when it is available,
 * otherwise distance, then time, then the point-index fallback (AV-504).
 */
export function resolveXAxis(activity: Activity, preference?: ChartXAxisMode): ResolvedXAxis {
  const availability = getXAxisAvailability(activity);
  const entryFor = (mode: ChartXAxisMode) => availability.find((entry) => entry.mode === mode);

  if (preference && entryFor(preference)?.available) {
    return { axis: preference, requested: preference };
  }

  const fallbackReason = preference ? entryFor(preference)?.reason : undefined;
  const requested = preference ? { requested: preference } : {};

  for (const mode of ['distance', 'time'] as const) {
    if (entryFor(mode)?.available) {
      return {
        axis: mode,
        ...requested,
        ...(fallbackReason ? { fallbackReason } : {}),
      };
    }
  }

  return {
    axis: 'index',
    ...requested,
    fallbackReason: fallbackReason ?? `${NO_DISTANCE} ${NO_TIME}`,
  };
}

/** x values for each point on the given axis; undefined where unplottable. */
export function pointXValues(activity: Activity, axis: SeriesXAxis): (number | undefined)[] {
  if (axis === 'distance') return computeDistance(activity.points).cumulativeMeters;

  if (axis === 'time') {
    const start = computeTimeBounds(activity.points).startTime?.getTime();
    return activity.points.map((point) => {
      if (start === undefined) return undefined;
      const time = point.time;
      if (!(time instanceof Date) || Number.isNaN(time.getTime())) return undefined;
      // Seconds since the activity start, so the axis reads as elapsed time.
      return (time.getTime() - start) / 1000;
    });
  }

  return activity.points.map((point) => point.index);
}

/**
 * AV-501 / AV-704. Builds a chart series from any point field against the
 * requested axis. Points missing either the measurement or an x value are
 * skipped rather than breaking the series.
 */
export function buildSeries(
  activity: Activity,
  key: ChartSeriesKey,
  axisOrResolved: SeriesXAxis | ResolvedXAxis = 'distance',
): ChartSeries {
  const definition = DEFINITIONS[key];
  const resolved: ResolvedXAxis =
    typeof axisOrResolved === 'string' ? { axis: axisOrResolved } : axisOrResolved;
  const xs = pointXValues(activity, resolved.axis);
  const derived = definition.derived?.(activity);

  const samples: SeriesSample[] = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;

  for (let i = 0; i < activity.points.length; i += 1) {
    const point = activity.points[i]!;
    const y = derived ? derived[i] : definition.read?.(point);
    const x = xs[i];
    if (!Number.isFinite(y) || x === undefined) continue;

    const value = y as number;
    samples.push({ x, y: value, pointIndex: point.index });
    if (value < yMin) yMin = value;
    if (value > yMax) yMax = value;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
  }

  const base = {
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    ...(definition.invertY ? { invertY: true } : {}),
    xAxis: resolved.axis,
    ...(resolved.requested ? { requestedXAxis: resolved.requested } : {}),
    ...(resolved.fallbackReason ? { xAxisFallbackReason: resolved.fallbackReason } : {}),
  };

  if (samples.length === 0) {
    return { ...base, samples: [], yMin: 0, yMax: 0, xMin: 0, xMax: 0, isEmpty: true };
  }

  return { ...base, samples, yMin, yMax, xMin, xMax, isEmpty: false };
}

/**
 * Downsamples for rendering only (plan §14). Keeps the first and last sample
 * and preserves each bucket's extreme so peaks and valleys survive; the full
 * series remains the source of truth for stats.
 */
export function downsampleSeries(series: ChartSeries, maxSamples: number): ChartSeries {
  if (series.samples.length <= maxSamples || maxSamples < 3) return series;

  const bucketSize = series.samples.length / maxSamples;
  const output: SeriesSample[] = [series.samples[0]!];

  for (let bucket = 0; bucket < maxSamples; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(series.samples.length, Math.floor((bucket + 1) * bucketSize));
    let extreme: SeriesSample | undefined;
    let bestDeviation = -Infinity;
    const mid = (series.yMin + series.yMax) / 2;

    for (let i = start; i < end; i += 1) {
      const sample = series.samples[i]!;
      const deviation = Math.abs(sample.y - mid);
      if (deviation > bestDeviation) {
        bestDeviation = deviation;
        extreme = sample;
      }
    }
    if (extreme && extreme !== output[output.length - 1]) output.push(extreme);
  }

  const last = series.samples[series.samples.length - 1]!;
  if (output[output.length - 1] !== last) output.push(last);

  return { ...series, samples: output };
}

/**
 * AV-511. Narrows a series to a focused point range, keeping the x values it
 * already has.
 *
 * The series is built against the *full* activity and then filtered, rather
 * than rebuilt from the slice. Two reasons: the axis keeps absolute values, so
 * a focused section reads "2.0 km – 4.0 km" instead of restarting at zero and
 * losing where the reader is; and a derived series like pace keeps the window
 * that ran into the selection, instead of starting cold at its first sample.
 */
export function restrictSeries(series: ChartSeries, range: ActivityPointRange): ChartSeries {
  const samples = series.samples.filter(
    (sample) => sample.pointIndex >= range.startIndex && sample.pointIndex <= range.endIndex,
  );

  if (samples.length === 0) {
    return { ...series, samples: [], yMin: 0, yMax: 0, xMin: 0, xMax: 0, isEmpty: true };
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const sample of samples) {
    if (sample.y < yMin) yMin = sample.y;
    if (sample.y > yMax) yMax = sample.y;
    if (sample.x < xMin) xMin = sample.x;
    if (sample.x > xMax) xMax = sample.x;
  }

  return { ...series, samples, yMin, yMax, xMin, xMax, isEmpty: false };
}

/** Nearest sample to an x value — drives chart hover (AV-602). */
export function findNearestSample(series: ChartSeries, x: number): SeriesSample | undefined {
  if (series.samples.length === 0) return undefined;
  let best = series.samples[0]!;
  let bestDelta = Math.abs(best.x - x);
  for (const sample of series.samples) {
    const delta = Math.abs(sample.x - x);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = sample;
    }
  }
  return best;
}
