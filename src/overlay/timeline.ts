import type { Activity, ActivityPoint, Coordinate } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';
import { deriveSpeed } from '../domain/series';
import { computeDistance, elevationClimb } from '../domain/stats';
import { zoneIndex, type ZoneTimes } from './zones';
import { circularMeanDegrees, deriveGrade, deriveHeading, lerpDegrees } from './derivedSeries';

/**
 * AV-1003. The overlay timeline: video time in, normalized activity values out.
 *
 * Format-independent by construction — it reads an `Activity` (TD-002) and a
 * video's clock, never a GPX, FIT or GoPro type. The auxiliary camera streams
 * are already aligned to `activity.points` (TD-034), so they interpolate here
 * exactly as heart rate does.
 *
 * Pure functions only: the preview (AV-1004) and the exporters (AV-1006/7) call
 * `sampleAt` at arbitrary times and must get the same answer.
 */

/** A built-in quantity an overlay component can show. */
export type OverlayMetricKey =
  | 'speed'
  | 'pace'
  | 'distance'
  | 'elevation'
  | 'heartRate'
  | 'runningCadence'
  | 'cyclingCadence'
  | 'power'
  | 'temperature'
  | 'grade'
  | 'elapsed'
  /** AV-1011. Time spent moving so far, by the viewer's own rule (TD-058). */
  | 'moving'
  /** AV-1016. Elevation gained so far, by the summary's own rule (TD-084). */
  | 'climb'
  /** AV-1019. The direction of travel in degrees, 0 north, 90 east (TD-087). */
  | 'heading';

export const OVERLAY_METRIC_KEYS: readonly OverlayMetricKey[] = [
  'speed',
  'pace',
  'distance',
  'elevation',
  'heartRate',
  'runningCadence',
  'cyclingCadence',
  'power',
  'temperature',
  'grade',
  'elapsed',
  'moving',
  'climb',
  'heading',
];

/** Where a value comes from: a built-in metric, or a named camera stream. */
export type OverlayDataSource =
  | { kind: 'metric'; metric: OverlayMetricKey }
  | { kind: 'sensor'; key: string };

/** Stable string form of a data source, for maps and warnings. */
export function dataSourceId(source: OverlayDataSource): string {
  return source.kind === 'metric' ? `metric:${source.metric}` : `sensor:${source.key}`;
}

/**
 * The video's clock, as the container states it (the same shape the overlay
 * store holds). Video time `t` is wall-clock `start + t` when `start` is known.
 */
export interface OverlayVideoClock {
  durationSeconds: number;
  start?: Date;
}

export interface OverlayTimelineOptions {
  video?: OverlayVideoClock;
  /**
   * Seconds the activity is *late* against the video: video time `t` shows the
   * activity as it was at `t - offsetSeconds` after the anchor. Positive delays
   * the telemetry; negative brings it forward. The reader adjusts it when the
   * camera and the watch disagree (AV-1004).
   */
  offsetSeconds?: number;
  /**
   * Longest gap between two points across which a value is interpolated. A
   * longer gap is a pause or a dropout, and a value drawn across it would be
   * invented. Default 10 s.
   */
  maxInterpolationGapSeconds?: number;
}

export interface OverlaySensorInfo {
  label: string;
  unit?: string;
  min: number;
  max: number;
}

export const DEFAULT_MAX_INTERPOLATION_GAP_SECONDS = 10;

/** Why a timeline has nothing to sample. */
export type OverlayTimelineUnavailable = 'no_activity' | 'no_timestamps';

/** One moment of the activity, with every value that exists then. */
export interface OverlaySample {
  /** The video time asked for. */
  videoTimeSeconds: number;
  /** Seconds since the activity's first timed point, at this moment. */
  activityElapsedSeconds: number;
  /** A value per data source that has one here; absent keys are missing data. */
  values: Partial<Record<string, number>>;
  position?: Coordinate;
  /** 0..1 along the activity by distance, else by time. */
  progress?: number;
}

export interface OverlayTimeline {
  /** `undefined` when the timeline can sample; otherwise why it cannot. */
  unavailable?: OverlayTimelineUnavailable;
  durationSeconds: number;
  offsetSeconds: number;
  /** Data sources that have a value somewhere in the activity. */
  available: ReadonlySet<string>;
  /** Whether any point carries a valid position, so a route can be drawn. */
  hasRoute: boolean;
  /** The whole activity's distance, on the same basis as `metric:distance`; absent without one. */
  distanceTotalMeters?: number;
  /**
   * The activity's charted camera streams, keyed by `sensor:` id, with the
   * range their values span (a gauge needs bounds the source does not state).
   */
  sensorLabels: ReadonlyMap<string, OverlaySensorInfo>;
  sampleAt: (videoTimeSeconds: number) => OverlaySample | undefined;
  /**
   * AV-1019 (TD-087). The lowest and highest value a source takes across the
   * whole activity, by its own readings (moving pace only, for pace): what a dial's
   * default range is rounded from. `undefined` for a source with no values; absent
   * on a timeline that cannot sample.
   */
  rangeOf?: (source: OverlayDataSource) => { min: number; max: number } | undefined;
  /**
   * AV-1019 (TD-087). When the activity's first timed point was, in milliseconds
   * since the epoch: `activityElapsedSeconds` counts from here, so a chart on a
   * time axis can place its cursor on the activity's own clock. Absent on a
   * timeline that cannot sample.
   */
  activityStartMs?: number;
  /**
   * AV-1018 (TD-086). The seconds spent moving in each zone, up to a moment:
   * one pass over the activity's points, counting each step the way moving time
   * is counted (TD-058), in the zone of the unsmoothed value at the step's
   * start. `bounds` are the zones' lower bounds in the source's own unit. Absent
   * on a timeline that cannot sample; `undefined` for a source with no values.
   * Callers go through `zoneTimesFor`, which keeps the answer.
   */
  zoneTimes?: (source: OverlayDataSource, bounds: readonly number[]) => ZoneTimes | undefined;
  /**
   * TD-059. How the video was laid against the activity, so the page can say
   * so: by the camera's own clock, or at the activity's first point because
   * the video states no clock. Absent when the timeline cannot sample.
   */
  alignment?: OverlayAlignment;
}

export interface OverlayAlignment {
  anchoredBy: 'videoClock' | 'activityStart';
  /** Seconds into the activity at video time 0, before the offset. */
  anchorSeconds: number;
  /** Seconds from the activity's first timed point to its last. */
  activitySpanSeconds: number;
  /** Where video 0 and video's end land in activity seconds, with the offset. */
  videoStartInActivity: number;
  videoEndInActivity: number;
  /** Whether any of the video's span falls within the activity's. */
  overlaps: boolean;
  /** When the activity starts, and the video when its container says: for a mismatch told in dates. */
  activityStart: Date;
  videoStart?: Date;
  /**
   * TD-059. The activity's speed (or, without one, its elevation) across its
   * whole span, evenly sampled: what a reader lines a sprint or a climb up by.
   * Absent when the activity has neither.
   */
  trace?: { label: 'Speed' | 'Elevation'; values: (number | undefined)[] };
}

/** How many samples the alignment trace takes across the activity. */
const TRACE_SAMPLES = 160;

interface TimedPoint {
  seconds: number;
  point: ActivityPoint;
  index: number;
}

type Reader = (timed: TimedPoint) => number | undefined;

const finite = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Distance and speed are read the way the viewer's charts read them: from the
 * file where it states them, and derived from positions and time where it does
 * not. Most GPX files state neither, so reading the raw fields alone would draw
 * no distance, speed or pace for them — while the viewer shows all three.
 */
interface DerivedStreams {
  distance: (number | undefined)[];
  speed: (number | undefined)[];
  /** Seconds spent moving up to each point, by point index; see `movingSoFar`. */
  moving: (number | undefined)[];
  /** AV-1016. Elevation gained up to each point, by point index; see `elevationClimb`. */
  climb: (number | undefined)[];
  /** AV-1019. The recorded grade where there is one, else the derived one; see `deriveGrade`. */
  grade: (number | undefined)[];
  /** AV-1019. The bearing of the last 20 m of the route; see `deriveHeading`. */
  heading: (number | undefined)[];
}

/** A step is moving at or above this, as the stats count moving time (TD-058). */
const MOVING_SPEED_THRESHOLD_MPS = 0.5;

/**
 * TD-080. What reads zero while the activity stands still: the figures of
 * motion. Everything else holds the value it had when the stop began.
 */
const STILL_AT_ZERO: readonly string[] = ['metric:speed', 'metric:runningCadence', 'metric:cyclingCadence', 'metric:power'];

/**
 * AV-1011. Moving time so far at each point, counted the way the stats count
 * the activity's moving time: a step between two points with a distance is
 * moving when it covers at least 0.5 m a second, and a recording gap (a new
 * segment) is never moving. Points with no distance have none.
 */
function movingSoFar(
  points: { index: number; seconds: number; point: ActivityPoint }[],
  distance: (number | undefined)[],
  size: number,
): (number | undefined)[] {
  const moving: (number | undefined)[] = new Array(size).fill(undefined);
  let total = 0;
  let previous: { seconds: number; meters: number; segment: number } | undefined;
  for (const { index, seconds, point } of points) {
    const meters = distance[index];
    if (typeof meters !== 'number' || !Number.isFinite(meters)) continue;
    const segment = point.segmentIndex ?? 0;
    if (previous && previous.segment === segment) {
      const step = seconds - previous.seconds;
      if (step > 0 && (meters - previous.meters) / step >= MOVING_SPEED_THRESHOLD_MPS) total += step;
    }
    previous = { seconds, meters, segment };
    moving[index] = total;
  }
  return moving;
}

function metricReaders({ distance, speed, moving, climb, grade, heading }: DerivedStreams): Record<OverlayMetricKey, Reader> {
  return {
    speed: ({ index }) => finite(speed[index]),
    // Pace is derived from the interpolated speed, not stored per point.
    pace: ({ index }) => finite(speed[index]),
    distance: ({ index }) => finite(distance[index]),
    elevation: ({ point }) => finite(point.elevationMeters),
    heartRate: ({ point }) => finite(point.heartRateBpm),
    runningCadence: ({ point }) => finite(point.runningCadenceSpm),
    cyclingCadence: ({ point }) => finite(point.cyclingCadenceRpm),
    power: ({ point }) => finite(point.powerWatts),
    temperature: ({ point }) => finite(point.temperatureCelsius),
    // AV-1019. The file's own grade where it has one, else the elevation over the last 50 m (TD-087).
    grade: ({ index }) => finite(grade[index]),
    elapsed: ({ seconds }) => seconds,
    moving: ({ index }) => finite(moving[index]),
    climb: ({ index }) => finite(climb[index]),
    heading: ({ index }) => finite(heading[index]),
  };
}

/** Pace in seconds per km from a speed; undefined when standing still. */
export function paceFromSpeed(metersPerSecond: number | undefined): number | undefined {
  return typeof metersPerSecond === 'number' && metersPerSecond > 0
    ? 1000 / metersPerSecond
    : undefined;
}

/**
 * AV-1016 (TD-084). Smoothing: the trailing mean of a figure's value over the
 * `windowSeconds` up to a moment, taken from `sampleAt` at a fixed step so it
 * depends on (time, window) alone: the preview and every export draw the same
 * number, and a frame never depends on the frame before it.
 */
export const SMOOTHING_LIMITS = { min: 0, max: 30 } as const;
/** The step between the samples of one average, and so at most 120 of them in a 30 s window. */
const SMOOTHING_STEP_SECONDS = 0.25;
/** Totals so far: a running mean of a total is not a number the activity ever had. */
const NEVER_SMOOTHED: readonly OverlayMetricKey[] = ['distance', 'elapsed', 'moving', 'climb'];
/** AV-1019. A heading is an angle: its mean is the direction of the sum of its unit vectors, never the mean of its degrees. */
const isHeading = (source: OverlayDataSource) => source.kind === 'metric' && source.metric === 'heading';

/** Whether a source's value is a reading that can be averaged over a window. */
export function canSmooth(source: OverlayDataSource | undefined): boolean {
  if (!source) return false;
  return source.kind === 'sensor' || !NEVER_SMOOTHED.includes(source.metric);
}

/**
 * The mean of `source` over [t - window, t], ignoring moments with no value;
 * `undefined` when there are none. Through a stop the samples are TD-080's
 * (zeros, or held), so the mean decays and holds. Pace is the mean of speed,
 * turned back into pace by the same rule as a single moment (0 when stopped).
 */
export function smoothedValueAt(
  timeline: Pick<OverlayTimeline, 'sampleAt'>,
  source: OverlayDataSource,
  videoTimeSeconds: number,
  windowSeconds: number,
): number | undefined {
  if (!(windowSeconds > 0) || !canSmooth(source)) return undefined;
  const window = Math.min(windowSeconds, SMOOTHING_LIMITS.max);
  const pace = source.kind === 'metric' && source.metric === 'pace';
  const heading = isHeading(source);
  const id = pace ? 'metric:speed' : dataSourceId(source);
  const steps = Math.ceil(window / SMOOTHING_STEP_SECONDS);
  const step = window / steps;
  let sum = 0;
  let count = 0;
  let sumSin = 0;
  let sumCos = 0;
  for (let k = 0; k <= steps; k += 1) {
    const value = timeline.sampleAt(videoTimeSeconds - k * step)?.values[id];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (heading) {
      const radians = (value * Math.PI) / 180;
      sumSin += Math.sin(radians);
      sumCos += Math.cos(radians);
    }
    sum += value;
    count += 1;
  }
  if (count === 0) return undefined;
  if (heading) return circularMeanDegrees(sumSin, sumCos, count);
  const mean = sum / count;
  // A mean speed under the moving threshold is standing still: through a stop the mean decays towards 0, and
  // its reciprocal would read an hour a kilometre before it read 0 (AV-1016).
  return pace ? (mean < MOVING_SPEED_THRESHOLD_MPS ? 0 : (paceFromSpeed(mean) ?? 0)) : mean;
}

/** Interpolates a longitude along the shorter arc, across the antimeridian. */
function lerpLongitude(a: number, b: number, fraction: number): number {
  let delta = b - a;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  const value = a + delta * fraction;
  return value > 180 ? value - 360 : value < -180 ? value + 360 : value;
}

/**
 * The activity's points that have a time, in time order (stably), each with its
 * seconds from the first, and the first and last times in milliseconds; absent
 * when none has one. Order is trusted from the parsers but not assumed.
 */
function timedPointsOf(activity: Activity): { points: TimedPoint[]; firstMs: number; lastMs: number } | undefined {
  const timed = activity.points
    .map((point, index) => ({ point, index, ms: point.time?.getTime() }))
    .filter((entry): entry is { point: ActivityPoint; index: number; ms: number } => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);
  if (timed.length === 0) return undefined;
  const firstMs = (timed[0] as { ms: number }).ms;
  const lastMs = (timed[timed.length - 1] as { ms: number }).ms;
  return { points: timed.map(({ point, index, ms }) => ({ point, index, seconds: (ms - firstMs) / 1000 })), firstMs, lastMs };
}

/** Every stream the timeline reads that is derived from the points, by point index. */
function deriveStreams(activity: Activity, points: TimedPoint[]): { derived: DerivedStreams; distance: (number | undefined)[] } {
  const distance = computeDistance(activity.points).cumulativeMeters;
  return {
    distance,
    derived: {
      distance,
      speed: deriveSpeed(activity),
      moving: movingSoFar(points, distance, activity.points.length),
      climb: elevationClimb(activity.points).gainSoFar,
      grade: deriveGrade(activity.points, distance),
      heading: deriveHeading(activity.points, distance),
    },
  };
}

/** Each built-in metric's reader, and then each charted camera stream's. */
function sourceReaders(activity: Activity, derived: DerivedStreams): { id: string; read: Reader }[] {
  const readers = metricReaders(derived);
  const sources: { id: string; read: Reader }[] = OVERLAY_METRIC_KEYS.map((metric) => ({
    id: dataSourceId({ kind: 'metric', metric }),
    read: readers[metric],
  }));
  for (const stream of activity.sensorStreams ?? []) {
    if (stream.display !== 'chart' || !stream.valuesByPoint) continue;
    const values = stream.valuesByPoint;
    sources.push({ id: dataSourceId({ kind: 'sensor', key: stream.key }), read: ({ index }) => finite(values[index]) });
  }
  return sources;
}

/**
 * AV-1019 (TD-087). A source's value at each of an activity's points, by point
 * index, read as the timeline reads it (the derived speed, grade and heading
 * included): what a chart draws its line from. Pace is read for the moving
 * points only. Absent for a source the activity has no values of.
 */
export function pointValuesOf(activity: Activity, source: OverlayDataSource): (number | undefined)[] | undefined {
  const placed = timedPointsOf(activity);
  if (!placed) return undefined;
  const pace = source.kind === 'metric' && source.metric === 'pace';
  const wanted = pace ? 'metric:speed' : dataSourceId(source);
  const read = sourceReaders(activity, deriveStreams(activity, placed.points).derived).find((entry) => entry.id === wanted)?.read;
  if (!read) return undefined;
  const values: (number | undefined)[] = new Array(activity.points.length).fill(undefined);
  let any = false;
  for (const timedPoint of placed.points) {
    let value = read(timedPoint);
    if (pace && value !== undefined) value = value >= MOVING_SPEED_THRESHOLD_MPS ? 1000 / value : undefined;
    if (value === undefined) continue;
    values[timedPoint.index] = value;
    any = true;
  }
  return any ? values : undefined;
}

/**
 * Builds the timeline for an activity against a video's clock.
 *
 * The anchor is the video's wall-clock start when the container states one,
 * and the activity's first timed point otherwise — so a video with no clock
 * begins where the activity does, and `offsetSeconds` moves it from there.
 */
export function buildOverlayTimeline(
  activity: Activity | undefined,
  options: OverlayTimelineOptions = {},
): OverlayTimeline {
  const offsetSeconds = finite(options.offsetSeconds) ?? 0;
  const maxGap = options.maxInterpolationGapSeconds ?? DEFAULT_MAX_INTERPOLATION_GAP_SECONDS;
  const durationSeconds = finite(options.video?.durationSeconds) ?? 0;
  const hasVideo = options.video !== undefined;

  const empty = (unavailable: OverlayTimelineUnavailable): OverlayTimeline => ({
    unavailable,
    durationSeconds,
    offsetSeconds,
    available: new Set(),
    hasRoute: false,
    sensorLabels: new Map(),
    sampleAt: () => undefined,
  });

  if (!activity) return empty('no_activity');

  const placed = timedPointsOf(activity);
  if (!placed) return empty('no_timestamps');
  const { points, firstMs, lastMs } = placed;
  const spanSeconds = (lastMs - firstMs) / 1000;

  // Video time `t` is `anchor + t` on the wall clock; the activity then shows
  // `anchor + t - offset`, expressed as seconds since its first point.
  const anchorMs = options.video?.start?.getTime();
  const anchorSeconds =
    typeof anchorMs === 'number' && Number.isFinite(anchorMs) ? (anchorMs - firstMs) / 1000 : 0;
  const toActivitySeconds = (videoTime: number) => anchorSeconds + videoTime - offsetSeconds;

  const { derived, distance } = deriveStreams(activity, points);
  const sources = sourceReaders(activity, derived);
  const sensorLabels = new Map<string, OverlaySensorInfo>();
  for (const stream of activity.sensorStreams ?? []) {
    if (stream.display !== 'chart' || !stream.valuesByPoint) continue;
    const id = dataSourceId({ kind: 'sensor', key: stream.key });
    const values = stream.valuesByPoint;
    // By iteration: spreading a long recording into Math.min would overflow.
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (min <= max) sensorLabels.set(id, { label: stream.label, unit: stream.unit, min, max });
  }

  const available = new Set<string>();
  for (const { id, read } of sources) {
    if (points.some((timedPoint) => read(timedPoint) !== undefined)) available.add(id);
  }
  // Pace needs speed *and* movement; elapsed needs nothing but time.
  if (!points.some(({ index }) => paceFromSpeed(finite(derived.speed[index])) !== undefined)) {
    available.delete('metric:pace');
  }

  // Progress runs from the first recorded distance to the last (in time
  // order), so an activity that starts at a nonzero odometer reading still
  // begins at zero. Found by iteration: spreading a long recording into
  // `Math.min` would overflow the call stack.
  let startDistance: number | undefined;
  let endDistance: number | undefined;
  for (const { index } of points) {
    const distance = finite(derived.distance[index]);
    if (distance === undefined) continue;
    startDistance ??= distance;
    endDistance = distance;
  }
  const distanceSpan = (endDistance ?? 0) - (startDistance ?? 0);

  const pointAt = (index: number): TimedPoint => points[index] as TimedPoint;

  /** Index of the last point at or before `seconds`; -1 if before the first. */
  const lowerIndex = (seconds: number): number => {
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pointAt(mid).seconds <= seconds) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };

  const sampleAt = (videoTimeSeconds: number): OverlaySample | undefined => {
    if (!Number.isFinite(videoTimeSeconds)) return undefined;
    // There is no picture outside the video, whatever the activity holds.
    if (hasVideo && (videoTimeSeconds < 0 || videoTimeSeconds > durationSeconds)) return undefined;
    const seconds = toActivitySeconds(videoTimeSeconds);
    // Outside the recording there is nothing to show — not the nearest value.
    if (seconds < 0 || seconds > spanSeconds) return undefined;

    const lower = lowerIndex(seconds);
    const a = pointAt(lower);
    const b = pointAt(Math.min(lower + 1, points.length - 1));
    const gap = b.seconds - a.seconds;
    const exact = gap === 0 || seconds === a.seconds;
    const fraction = exact ? 0 : (seconds - a.seconds) / gap;
    // Interpolate only inside a single recorded segment and a short gap.
    const sameSegment = (a.point.segmentIndex ?? 0) === (b.point.segmentIndex ?? 0);
    const bridges = !exact && gap <= maxGap && sameSegment;
    // TD-080. A gap that is not bridged is a stop. A new segment always is:
    // the recorder was paused, and moving time and distance count nothing
    // across it either. A long gap inside a segment is a stop unless the
    // distance says the activity moved across it, by the moving-time rule:
    // then it is a dropout, and nothing is known there.
    const da = finite(derived.distance[a.index]);
    const db = finite(derived.distance[b.index]);
    const movedAcross = sameSegment && da !== undefined && db !== undefined && (db - da) / gap >= MOVING_SPEED_THRESHOLD_MPS;
    const stopped = !exact && !bridges && !movedAcross;

    const values: Partial<Record<string, number>> = {};
    for (const { id, read } of sources) {
      const va = read(a);
      const vb = read(b);
      let value: number | undefined;
      if (exact) value = va;
      // A heading turns the short way round: 350 to 10 passes through north, not through south (AV-1019).
      else if (bridges && va !== undefined && vb !== undefined) value = id === 'metric:heading' ? lerpDegrees(va, vb, fraction) : va + (vb - va) * fraction;
      else if (stopped) value = va;
      else value = undefined;
      if (value !== undefined) values[id] = value;
    }
    if (stopped) for (const id of STILL_AT_ZERO) if (available.has(id)) values[id] = 0;
    // Standing still is a pace of zero, as it is a speed of zero (TD-080).
    if (values['metric:pace'] !== undefined) {
      if (available.has('metric:pace')) values['metric:pace'] = paceFromSpeed(values['metric:speed']) ?? 0;
      else delete values['metric:pace'];
    }
    // Elapsed is the clock, not a recorded value: it is defined everywhere.
    values['metric:elapsed'] = seconds;

    let position: Coordinate | undefined;
    const pa = toValidCoordinate(a.point.lat, a.point.lon);
    const pb = toValidCoordinate(b.point.lat, b.point.lon);
    if (exact || stopped) position = pa;
    else if (bridges && pa && pb) {
      position = { lat: pa.lat + (pb.lat - pa.lat) * fraction, lon: lerpLongitude(pa.lon, pb.lon, fraction) };
    }

    // One basis for the whole timeline, so the marker never reverses: by
    // distance when the activity has any, absent where that reading is missing,
    // and by time only when it has none at all.
    let progress: number | undefined;
    if (distanceSpan > 0) {
      const distance = values['metric:distance'];
      if (distance !== undefined) progress = (distance - (startDistance ?? 0)) / distanceSpan;
    } else if (spanSeconds > 0) {
      progress = seconds / spanSeconds;
    }

    return {
      videoTimeSeconds,
      activityElapsedSeconds: seconds,
      values,
      position,
      progress: progress === undefined ? undefined : Math.min(1, Math.max(0, progress)),
    };
  };

  const hasRoute = points.some(({ point }) => toValidCoordinate(point.lat, point.lon) !== undefined);

  /*
   * AV-1018. Moving seconds per zone. The steps are the ones `movingSoFar`
   * counts (between a point with a distance and the last one before it, in the
   * same segment, at 0.5 m/s or more), so the zones' times add up to the moving
   * time. A step's seconds go to the zone of the value at its start; a step
   * whose start has no value counts in no zone. `totals` holds the running
   * totals after each step, so a moment costs a search and the part of the step
   * it falls in.
   */
  const zoneTimes = (source: OverlayDataSource, bounds: readonly number[]): ZoneTimes | undefined => {
    const read = sources.find((entry) => entry.id === dataSourceId(source))?.read;
    if (!read || bounds.length === 0) return undefined;
    const zones = bounds.length;
    interface Step {
      from: number;
      to: number;
      zone: number;
    }
    const steps: Step[] = [];
    let previous: { position: number; meters: number; segment: number } | undefined;
    points.forEach((timedPoint, position) => {
      const meters = finite(distance[timedPoint.index]);
      if (meters === undefined) return;
      const segment = timedPoint.point.segmentIndex ?? 0;
      if (previous && previous.segment === segment) {
        const seconds = timedPoint.seconds - pointAt(previous.position).seconds;
        const value = read(pointAt(previous.position));
        if (seconds > 0 && (meters - previous.meters) / seconds >= MOVING_SPEED_THRESHOLD_MPS && value !== undefined) {
          steps.push({ from: previous.position, to: position, zone: zoneIndex(value, bounds) });
        }
      }
      previous = { position, meters, segment };
    });
    // Nothing moving with a value: the activity cannot say, so there is no time to show.
    if (steps.length === 0) return undefined;
    const totals = new Float64Array((steps.length + 1) * zones);
    steps.forEach((step, k) => {
      for (let z = 0; z < zones; z += 1) totals[(k + 1) * zones + z] = totals[k * zones + z]!;
      totals[(k + 1) * zones + step.zone]! += pointAt(step.to).seconds - pointAt(step.from).seconds;
    });
    return {
      at: (activitySeconds) => {
        const result = new Array<number>(zones).fill(0);
        if (!Number.isFinite(activitySeconds) || steps.length === 0) return result;
        // The steps that have ended by now: the last whose end is at or before the moment.
        let lo = 0;
        let hi = steps.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (pointAt(steps[mid]!.to).seconds <= activitySeconds) lo = mid + 1;
          else hi = mid;
        }
        for (let z = 0; z < zones; z += 1) result[z] = totals[lo * zones + z]!;
        const open = steps[lo];
        if (open) {
          const started = pointAt(open.from).seconds;
          if (activitySeconds > started) result[open.zone]! += activitySeconds - started;
        }
        return result;
      },
    };
  };

  /*
   * AV-1019 (TD-087). The range of a source across the whole activity, found once and kept: a dial's default range
   * is rounded from it. Pace is taken over the moving points only, so a stop's slow speed does not make the
   * slowest pace an hour a kilometre. Found by iteration, never by spreading a long recording into Math.min.
   */
  const ranges = new Map<string, { min: number; max: number } | undefined>();
  const rangeOf = (source: OverlayDataSource) => {
    const id = dataSourceId(source);
    if (ranges.has(id)) return ranges.get(id);
    const pace = id === 'metric:pace';
    const read = sources.find((entry) => entry.id === (pace ? 'metric:speed' : id))?.read;
    let min = Infinity;
    let max = -Infinity;
    if (read) {
      for (const timedPoint of points) {
        let value = read(timedPoint);
        if (value === undefined) continue;
        if (pace) {
          if (value < MOVING_SPEED_THRESHOLD_MPS) continue;
          value = 1000 / value;
        }
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    const range = min <= max ? { min, max } : undefined;
    ranges.set(id, range);
    return range;
  };

  const traceId = available.has('metric:speed')
    ? 'metric:speed'
    : available.has('metric:elevation')
      ? 'metric:elevation'
      : undefined;
  const traceRead = sources.find((entry) => entry.id === traceId)?.read;
  const trace =
    traceRead && spanSeconds > 0
      ? {
          label: traceId === 'metric:speed' ? ('Speed' as const) : ('Elevation' as const),
          values: Array.from({ length: TRACE_SAMPLES }, (_, i) => {
            const index = lowerIndex((spanSeconds * i) / (TRACE_SAMPLES - 1));
            return index < 0 ? undefined : traceRead(pointAt(index));
          }),
        }
      : undefined;

  const videoStartInActivity = toActivitySeconds(0);
  const videoEndInActivity = toActivitySeconds(durationSeconds);
  const alignment: OverlayAlignment | undefined = hasVideo
    ? {
        anchoredBy: typeof anchorMs === 'number' && Number.isFinite(anchorMs) ? 'videoClock' : 'activityStart',
        anchorSeconds,
        activitySpanSeconds: spanSeconds,
        videoStartInActivity,
        videoEndInActivity,
        overlaps: videoEndInActivity >= 0 && videoStartInActivity <= spanSeconds,
        activityStart: new Date(firstMs),
        ...(trace ? { trace } : {}),
        ...(typeof anchorMs === 'number' && Number.isFinite(anchorMs) ? { videoStart: new Date(anchorMs) } : {}),
      }
    : undefined;

  return {
    durationSeconds,
    offsetSeconds,
    available,
    hasRoute,
    ...(distanceSpan > 0 && endDistance !== undefined ? { distanceTotalMeters: endDistance } : {}),
    sensorLabels,
    sampleAt,
    rangeOf,
    activityStartMs: firstMs,
    zoneTimes,
    alignment,
  };
}
