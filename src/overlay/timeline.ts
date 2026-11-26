import type { Activity, ActivityPoint, Coordinate } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';
import { deriveSpeed } from '../domain/series';
import { computeDistance, elevationClimb } from '../domain/stats';
import { zoneIndex, type ZoneTimes } from './zones';
import type { SplitSources, SplitStreams } from './splits';
import { BRIDGE_GAP_SECONDS, DEFAULT_PAUSE_SETTINGS, isBelowPauseSpeed, isStopped, movingSteps, type PauseSettings, type PauseStep } from '../domain/pause';
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
  | 'heading'
  /** AV-1025 (TD-094). The highest speed, heart rate or power up to the moment, held through a stop. */
  | 'maxSpeed'
  | 'maxHeartRate'
  | 'maxPower'
  /** AV-1025. Distance so far over the time so far: elapsed, or moving by the shared pause rule. */
  | 'averageSpeed'
  | 'averageMovingSpeed'
  | 'averagePace'
  | 'averageMovingPace'
  /** AV-1025. The rate of ascent over the last 10 s, in m/s; zero through a stop. */
  | 'verticalSpeed'
  /** AV-1025. The lowest and highest elevation up to the moment. */
  | 'elevationLowest'
  | 'elevationHighest'
  /** AV-1025. Seconds from a moment (the cut's start, else the activity's), and the wall-clock time in seconds since 1970 (UTC). */
  | 'stopwatch'
  | 'clock';

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
  'maxSpeed',
  'maxHeartRate',
  'maxPower',
  'averageSpeed',
  'averageMovingSpeed',
  'averagePace',
  'averageMovingPace',
  'verticalSpeed',
  'elevationLowest',
  'elevationHighest',
  'stopwatch',
  'clock',
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
  /**
   * AV-1025 (TD-094). Where the exported cut starts, in video seconds (TD-081): a stopwatch with no
   * start of its own reads 0:00 there. Absent: the activity's own start.
   */
  cutStartSeconds?: number;
}

export interface OverlaySensorInfo {
  label: string;
  unit?: string;
  min: number;
  max: number;
}

export const DEFAULT_MAX_INTERPOLATION_GAP_SECONDS = BRIDGE_GAP_SECONDS;

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
  /**
   * The moment at a video time. AV-1025: `only` names one data source (`dataSourceId`): a smoothed figure
   * reads one value at up to 121 moments a frame, and the sample then holds that source's value alone (and
   * the elapsed time), found without the work of the rest; its position is the same and its `progress` is
   * absent. A source that is a total or a rate (the figures so far, pace) always gets the whole sample.
   */
  sampleAt: (videoTimeSeconds: number, only?: string) => OverlaySample | undefined;
  /**
   * AV-1025 (TD-094). The same timeline with the stopwatch counting from another cut start, in video
   * seconds, at the cost of a wrapper: only the stopwatch's zero depends on the cut, so a trim handle
   * dragged in the preview does not rebuild the timeline. Absent on a timeline that cannot sample.
   */
  withCutStart?: (cutStartSeconds: number | undefined) => OverlayTimeline;
  /**
   * AV-1024 (TD-093). The pause setting this timeline reads its stops, its moving time and its
   * "standing still" pace from: the activity's own (a cleaned one carries it), else the defaults.
   */
  pause?: PauseSettings;
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
   * AV-1021 (TD-090). Which ways the activity can be split: by its laps (two or more with a
   * start time) and by distance. Absent on a timeline that cannot sample.
   */
  splitSources?: SplitSources;
  /**
   * AV-1021. The streams a split is found from: the distance, the moving time and the laps, on
   * the activity's clock, made on first use and kept. Callers go through `splitTimesFor` (or a
   * renderer's `createSplitTimes`), which keep the splits. Absent on a timeline that cannot sample.
   */
  splitStreams?: () => SplitStreams;
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
  /** AV-1024. Whether the step that ends at a point (by point index) is moving by the shared pause rule, runs of slow steps included. */
  movingStep: Map<number, boolean>;
  /** AV-1019. The recorded grade where there is one, else the derived one; see `deriveGrade`. */
  grade: (number | undefined)[];
  /** AV-1019. The bearing of the last 20 m of the route; see `deriveHeading`. */
  heading: (number | undefined)[];
  /** AV-1025. The running maximum (minimum) of a reading up to each point, by point index, held where a point has none. */
  maxSpeed: (number | undefined)[];
  maxHeartRate: (number | undefined)[];
  maxPower: (number | undefined)[];
  elevationLowest: (number | undefined)[];
  elevationHighest: (number | undefined)[];
  /** AV-1025. Average speed up to each point, over elapsed and over moving time; absent before there is any of either. */
  averageSpeed: (number | undefined)[];
  averageMovingSpeed: (number | undefined)[];
  /** AV-1025. The rate of ascent over the last 10 s at each point, in m/s. */
  verticalSpeed: (number | undefined)[];
  /** AV-1025. When the first timed point was, in seconds since 1970: what the clock adds the elapsed seconds to. */
  startEpochSeconds: number;
}

/**
 * TD-080. What reads zero while the activity stands still: the figures of
 * motion. Everything else holds the value it had when the stop began.
 */
export const STILL_AT_ZERO: readonly string[] = ['metric:speed', 'metric:runningCadence', 'metric:cyclingCadence', 'metric:power', 'metric:verticalSpeed'];

/**
 * AV-1011. Moving time so far at each point, counted the way the stats count
 * the activity's moving time: a step between two points with a distance is
 * moving by the shared pause rule (TD-093; 0.5 m/s or more by default), and a
 * recording gap (a new segment) is never moving. Points with no distance have none.
 */
function movingSoFar(
  points: { index: number; seconds: number; point: ActivityPoint }[],
  distance: (number | undefined)[],
  size: number,
  pause: PauseSettings,
): { moving: (number | undefined)[]; movingStep: Map<number, boolean> } {
  const moving: (number | undefined)[] = new Array(size).fill(undefined);
  const movingStep = new Map<number, boolean>();
  const steps: PauseStep[] = [];
  const at: number[] = [];
  let previous: { seconds: number; meters: number; segment: number } | undefined;
  for (const { index, seconds, point } of points) {
    const meters = distance[index];
    if (typeof meters !== 'number' || !Number.isFinite(meters)) continue;
    const segment = point.segmentIndex ?? 0;
    const follows = previous !== undefined && previous.segment === segment;
    steps.push(follows ? { seconds: seconds - previous!.seconds, meters: meters - previous!.meters } : { seconds: 0, meters: 0, breakBefore: true });
    at.push(index);
    previous = { seconds, meters, segment };
  }
  const flags = movingSteps(steps, pause);
  let total = 0;
  steps.forEach((step, k) => {
    if (flags[k]) total += step.seconds;
    moving[at[k]!] = total;
    movingStep.set(at[k]!, flags[k]!);
  });
  return { moving, movingStep };
}

function metricReaders(streams: DerivedStreams): Record<OverlayMetricKey, Reader> {
  const { distance, speed, moving, climb, grade, heading } = streams;
  const averagePace = (average: (number | undefined)[]): Reader => ({ index }) => {
    const value = finite(average[index]);
    return value === undefined ? undefined : (paceFromSpeed(value) ?? 0);
  };
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
    // AV-1025 (TD-094). The totals so far, by point; `sampleAt` writes them again for a moment between two points.
    maxSpeed: ({ index }) => finite(streams.maxSpeed[index]),
    maxHeartRate: ({ index }) => finite(streams.maxHeartRate[index]),
    maxPower: ({ index }) => finite(streams.maxPower[index]),
    averageSpeed: ({ index }) => finite(streams.averageSpeed[index]),
    averageMovingSpeed: ({ index }) => finite(streams.averageMovingSpeed[index]),
    averagePace: averagePace(streams.averageSpeed),
    averageMovingPace: averagePace(streams.averageMovingSpeed),
    verticalSpeed: ({ index }) => finite(streams.verticalSpeed[index]),
    elevationLowest: ({ index }) => finite(streams.elevationLowest[index]),
    elevationHighest: ({ index }) => finite(streams.elevationHighest[index]),
    stopwatch: ({ seconds }) => seconds,
    clock: ({ seconds }) => streams.startEpochSeconds + seconds,
  };
}

/** AV-1025. The figures `sampleAt` finds for the moment itself rather than by interpolating between two points. */
const SAMPLE_LEVEL: readonly string[] = [
  'maxSpeed',
  'maxHeartRate',
  'maxPower',
  'averageSpeed',
  'averageMovingSpeed',
  'averagePace',
  'averageMovingPace',
  'verticalSpeed',
  'elevationLowest',
  'elevationHighest',
  'stopwatch',
  'clock',
].map((metric) => `metric:${metric}`);

const ELEVATION_ID = 'metric:elevation';
const ID_MAX_SPEED = 'metric:maxSpeed';
const ID_MAX_HEART_RATE = 'metric:maxHeartRate';
const ID_MAX_POWER = 'metric:maxPower';
const ID_AVERAGE_SPEED = 'metric:averageSpeed';
const ID_AVERAGE_MOVING_SPEED = 'metric:averageMovingSpeed';
const ID_AVERAGE_PACE = 'metric:averagePace';
const ID_AVERAGE_MOVING_PACE = 'metric:averageMovingPace';
const ID_VERTICAL_SPEED = 'metric:verticalSpeed';
const ID_ELEVATION_LOWEST = 'metric:elevationLowest';
const ID_ELEVATION_HIGHEST = 'metric:elevationHighest';
const ID_STOPWATCH = 'metric:stopwatch';
const ID_CLOCK = 'metric:clock';

/** How far back the rate of ascent looks. */
const VERTICAL_SPEED_SECONDS = 10;

/**
 * AV-1025. The running extreme of a reading in time order, by point index: each point holds the best value
 * seen up to it, so a point with no reading of its own carries the last one and a stop holds the maximum.
 */
function runningExtreme(points: TimedPoint[], read: (timed: TimedPoint) => number | undefined, size: number, pick: (a: number, b: number) => number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(size).fill(undefined);
  let best: number | undefined;
  for (const timed of points) {
    const value = read(timed);
    if (value !== undefined) best = best === undefined ? value : pick(best, value);
    out[timed.index] = best;
  }
  return out;
}

/** AV-1025. Average speed up to each point: the distance since the first one over `over(point)` seconds, where that is above zero. */
function averageSince(points: TimedPoint[], distance: (number | undefined)[], size: number, over: (timed: TimedPoint) => number | undefined): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(size).fill(undefined);
  let start: number | undefined;
  for (const timed of points) {
    const meters = finite(distance[timed.index]);
    if (meters === undefined) continue;
    start ??= meters;
    const seconds = over(timed);
    if (seconds !== undefined && seconds > 0) out[timed.index] = Math.max(0, meters - start) / seconds;
  }
  return out;
}

/**
 * AV-1025. The rate of ascent at each point: the elevation now less the elevation `VERTICAL_SPEED_SECONDS` earlier
 * (the first seconds use the span there is) over that span, from the elevation as it is given. Zero at the first point.
 */
function ascentRates(points: TimedPoint[], size: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(size).fill(undefined);
  const known = points.filter((timed) => finite(timed.point.elevationMeters) !== undefined);
  let from = 0;
  for (const timed of known) {
    const seconds = timed.seconds;
    const earlier = Math.max(known[0]!.seconds, seconds - VERTICAL_SPEED_SECONDS);
    while (from + 1 < known.length && known[from + 1]!.seconds <= earlier) from += 1;
    const low = known[from]!;
    const high = known[Math.min(from + 1, known.length - 1)]!;
    const gap = high.seconds - low.seconds;
    const fraction = gap > 0 ? Math.min(1, Math.max(0, (earlier - low.seconds) / gap)) : 0;
    const then = (low.point.elevationMeters as number) + ((high.point.elevationMeters as number) - (low.point.elevationMeters as number)) * fraction;
    const span = seconds - earlier;
    out[timed.index] = span > 0 ? ((timed.point.elevationMeters as number) - then) / span : 0;
  }
  return out;
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
const NEVER_SMOOTHED: readonly OverlayMetricKey[] = [
  'distance',
  'elapsed',
  'moving',
  'climb',
  // AV-1025. A maximum, an extreme, an average so far, a stopwatch and a clock are totals or times: a mean of them is not a number the activity ever had.
  'maxSpeed',
  'maxHeartRate',
  'maxPower',
  'averageSpeed',
  'averageMovingSpeed',
  'averagePace',
  'averageMovingPace',
  'elevationLowest',
  'elevationHighest',
  'stopwatch',
  'clock',
];
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
  timeline: Pick<OverlayTimeline, 'sampleAt' | 'pause'>,
  source: OverlayDataSource,
  videoTimeSeconds: number,
  windowSeconds: number,
): number | undefined {
  if (!(windowSeconds > 0) || !canSmooth(source)) return undefined;
  const window = Math.min(windowSeconds, SMOOTHING_LIMITS.max);
  const pace = source.kind === 'metric' && source.metric === 'pace';
  const heading = isHeading(source);
  const pause = timeline.pause ?? DEFAULT_PAUSE_SETTINGS;
  const id = pace ? 'metric:speed' : dataSourceId(source);
  const steps = Math.ceil(window / SMOOTHING_STEP_SECONDS);
  const step = window / steps;
  let sum = 0;
  let count = 0;
  let sumSin = 0;
  let sumCos = 0;
  for (let k = 0; k <= steps; k += 1) {
    const value = timeline.sampleAt(videoTimeSeconds - k * step, id)?.values[id];
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
  return pace ? (isBelowPauseSpeed(mean, pause) ? 0 : (paceFromSpeed(mean) ?? 0)) : mean;
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
function deriveStreams(activity: Activity, points: TimedPoint[], pause: PauseSettings, startMs: number): { derived: DerivedStreams; distance: (number | undefined)[] } {
  const distance = computeDistance(activity.points).cumulativeMeters;
  const size = activity.points.length;
  const { moving, movingStep } = movingSoFar(points, distance, size, pause);
  const speed = deriveSpeed(activity);
  return {
    distance,
    derived: {
      distance,
      speed,
      moving,
      movingStep,
      climb: elevationClimb(activity.points).gainSoFar,
      grade: deriveGrade(activity.points, distance),
      heading: deriveHeading(activity.points, distance),
      maxSpeed: runningExtreme(points, ({ index }) => finite(speed[index]), size, Math.max),
      maxHeartRate: runningExtreme(points, ({ point }) => finite(point.heartRateBpm), size, Math.max),
      maxPower: runningExtreme(points, ({ point }) => finite(point.powerWatts), size, Math.max),
      elevationLowest: runningExtreme(points, ({ point }) => finite(point.elevationMeters), size, Math.min),
      elevationHighest: runningExtreme(points, ({ point }) => finite(point.elevationMeters), size, Math.max),
      averageSpeed: averageSince(points, distance, size, ({ seconds }) => seconds),
      averageMovingSpeed: averageSince(points, distance, size, ({ index }) => finite(moving[index])),
      verticalSpeed: ascentRates(points, size),
      startEpochSeconds: startMs / 1000,
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
  const pause = activity.cleanup?.pause ?? DEFAULT_PAUSE_SETTINGS;
  const pace = source.kind === 'metric' && source.metric === 'pace';
  const wanted = pace ? 'metric:speed' : dataSourceId(source);
  const read = sourceReaders(activity, deriveStreams(activity, placed.points, pause, placed.firstMs).derived).find((entry) => entry.id === wanted)?.read;
  if (!read) return undefined;
  const values: (number | undefined)[] = new Array(activity.points.length).fill(undefined);
  let any = false;
  for (const timedPoint of placed.points) {
    let value = read(timedPoint);
    if (pace && value !== undefined) value = !isBelowPauseSpeed(value, pause) ? 1000 / value : undefined;
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

  const pause = activity.cleanup?.pause ?? DEFAULT_PAUSE_SETTINGS;
  const { derived, distance } = deriveStreams(activity, points, pause, firstMs);
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

  // AV-1025. An average pace needs some movement, as a pace does: an activity that never moved has an average speed of zero and no pace.
  for (const [pace, speed] of [['metric:averagePace', derived.averageSpeed], ['metric:averageMovingPace', derived.averageMovingSpeed]] as const) {
    if (!points.some(({ index }) => (finite(speed[index]) ?? 0) > 0)) available.delete(pace);
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

  /**
   * AV-1025. The sources a moment interpolates between two points: every one but the figures so far, which `sampleAt`
   * writes for the moment itself (so interpolating them would be work thrown away, at every sample of a smoothing window).
   */
  const interpolated = sources.filter(({ id }) => !SAMPLE_LEVEL.includes(id));
  const narrowed = new Map(interpolated.filter(({ id }) => id !== 'metric:pace').map((entry) => [entry.id, [entry]]));

  /**
   * Where `seconds` on the activity's clock falls among the points, and how the gap there is read: a moment on a
   * point, between two points of one short gap (bridged), or in a stop. `undefined` outside the recording.
   */
  const place = (seconds: number) => {
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
    // TD-093: a gap is a stop by the shared pause rule, so one shorter than the minimum stop is not.
    const movedAcross = sameSegment && da !== undefined && db !== undefined && (derived.movingStep.get(b.index) ?? !isStopped(db - da, gap, pause));
    const stopped = !exact && !bridges && !movedAcross;
    return { a, b, fraction, exact, bridges, stopped };
  };
  type Placed = NonNullable<ReturnType<typeof place>>;

  /** One reading at a placed moment: on a point, interpolated in a bridged gap (a heading the short way round), held in a stop, absent in a dropout. */
  const readAt = (id: string, read: Reader, { a, b, fraction, exact, bridges, stopped }: Placed): number | undefined => {
    const va = read(a);
    if (exact) return va;
    if (bridges) {
      const vb = read(b);
      if (va === undefined || vb === undefined) return undefined;
      // A heading turns the short way round: 350 to 10 passes through north, not through south (AV-1019).
      return id === 'metric:heading' ? lerpDegrees(va, vb, fraction) : va + (vb - va) * fraction;
    }
    return stopped ? va : undefined;
  };

  /** AV-1025. The elevation a moment of the activity's clock gives, as a moment is read: held through a stop, absent in a dropout. */
  const elevationRead = sources.find(({ id }) => id === ELEVATION_ID)?.read;
  const elevationAt = (seconds: number): number | undefined => {
    const placed = place(seconds);
    return placed && elevationRead ? readAt(ELEVATION_ID, elevationRead, placed) : undefined;
  };

  /** The seconds of the activity's clock where the exported cut starts: a stopwatch with no start of its own counts from there. */
  const cutStartActivityOf = (cutStartSeconds: number | undefined) => (finite(cutStartSeconds) !== undefined ? toActivitySeconds(cutStartSeconds as number) : 0);
  const startEpochSeconds = firstMs / 1000;
  /** The maxima and the extremes that the activity has, found once: each with the stream it holds and the reading it is compared with. */
  const extremes = (
    [
      [ID_MAX_SPEED, 'metric:speed', derived.maxSpeed, Math.max],
      [ID_MAX_HEART_RATE, 'metric:heartRate', derived.maxHeartRate, Math.max],
      [ID_MAX_POWER, 'metric:power', derived.maxPower, Math.max],
      [ID_ELEVATION_LOWEST, ELEVATION_ID, derived.elevationLowest, Math.min],
      [ID_ELEVATION_HIGHEST, ELEVATION_ID, derived.elevationHighest, Math.max],
    ] as const
  ).filter(([id]) => available.has(id));
  const hasVerticalSpeed = available.has(ID_VERTICAL_SPEED);
  // The readings of elevation in time order: where a look back lands on a point with none, it is read between its neighbours that have one.
  const elevations = points.filter((timed) => finite(timed.point.elevationMeters) !== undefined);
  const firstElevationSeconds = elevations[0]?.seconds ?? 0;
  const elevationBetween = (seconds: number): number | undefined => {
    let lo = 0;
    let hi = elevations.length - 1;
    let below = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (elevations[mid]!.seconds <= seconds) {
        below = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const low = elevations[below];
    const high = elevations[Math.min(below + 1, elevations.length - 1)];
    if (!low || !high) return undefined;
    const gap = high.seconds - low.seconds;
    const fraction = gap > 0 ? (seconds - low.seconds) / gap : 0;
    return (low.point.elevationMeters as number) + ((high.point.elevationMeters as number) - (low.point.elevationMeters as number)) * fraction;
  };

  const sampleWithCut = (videoTimeSeconds: number, only: string | undefined, cutStartActivitySeconds: number): OverlaySample | undefined => {
    if (!Number.isFinite(videoTimeSeconds)) return undefined;
    // There is no picture outside the video, whatever the activity holds.
    if (hasVideo && (videoTimeSeconds < 0 || videoTimeSeconds > durationSeconds)) return undefined;
    const seconds = toActivitySeconds(videoTimeSeconds);
    const placed = place(seconds);
    if (!placed) return undefined;
    const { a, b, fraction, exact, bridges, stopped } = placed;

    const values: Partial<Record<string, number>> = {};
    const narrow = only === undefined ? undefined : narrowed.get(only);
    for (const { id, read } of narrow ?? interpolated) {
      const value = readAt(id, read, placed);
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

    /*
     * AV-1025 (TD-094). The figures so far, found for this very moment rather than interpolated between the
     * two points' totals: a maximum includes the value the moment has, an average is the distance and the time
     * the moment has, the rate of ascent looks back from the moment. At a stop every total holds the stop's
     * own (a maximum, a lowest, a highest, the distance and the moving time), the average over elapsed time
     * keeps counting the stop's seconds, and the rate of ascent is zero (TD-080). A dropout has no total.
     */
    if (!narrow && (exact || bridges || stopped)) {
      for (const [id, base, held, pick] of extremes) {
        const before = finite(held[a.index]);
        const now = bridges ? values[base] : undefined;
        const value = now === undefined ? before : before === undefined ? now : pick(before, now);
        if (value !== undefined) values[id] = value;
      }
    }
    const meters = values['metric:distance'];
    const done = !narrow && meters !== undefined && startDistance !== undefined ? Math.max(0, meters - startDistance) : undefined;
    if (done !== undefined) {
      const movingSeconds = values['metric:moving'];
      if (seconds > 0) {
        const average = done / seconds;
        values[ID_AVERAGE_SPEED] = average;
        // No movement is a pace of 0, as standing still is (TD-080).
        if (available.has(ID_AVERAGE_PACE)) values[ID_AVERAGE_PACE] = paceFromSpeed(average) ?? 0;
      }
      if (movingSeconds !== undefined && movingSeconds > 0) {
        const average = done / movingSeconds;
        values[ID_AVERAGE_MOVING_SPEED] = average;
        if (available.has(ID_AVERAGE_MOVING_PACE)) values[ID_AVERAGE_MOVING_PACE] = paceFromSpeed(average) ?? 0;
      }
    }
    if (!narrow && hasVerticalSpeed && !stopped) {
      const now = values[ELEVATION_ID];
      if (now !== undefined) {
        // Looks back over the unbroken stretch only: a stop or a break in the recording is not climbing, whatever the height across it.
        let earlier = Math.max(firstElevationSeconds, seconds - VERTICAL_SPEED_SECONDS);
        const back = earlier < seconds ? place(earlier) : undefined;
        let then: number | undefined;
        if (earlier >= seconds) then = now;
        else if (back?.stopped) {
          earlier = back.b.seconds;
          then = earlier >= seconds ? now : (finite(back.b.point.elevationMeters) ?? elevationBetween(earlier));
        } else then = elevationAt(earlier) ?? elevationBetween(earlier);
        if (then !== undefined) values[ID_VERTICAL_SPEED] = seconds > earlier ? (now - then) / (seconds - earlier) : 0;
      }
    }
    if (!narrow) {
      values[ID_STOPWATCH] = Math.max(0, seconds - cutStartActivitySeconds);
      values[ID_CLOCK] = startEpochSeconds + seconds;
    }

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

  const sampleAt = (videoTimeSeconds: number, only?: string) => sampleWithCut(videoTimeSeconds, only, cutStartActivityOf(options.cutStartSeconds));

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
    // Every step first, then the shared pause rule says which are moving (TD-093).
    const all: { from: number; to: number; step: PauseStep }[] = [];
    let previous: { position: number; meters: number; segment: number } | undefined;
    points.forEach((timedPoint, position) => {
      const meters = finite(distance[timedPoint.index]);
      if (meters === undefined) return;
      const segment = timedPoint.point.segmentIndex ?? 0;
      if (previous && previous.segment === segment) {
        const seconds = timedPoint.seconds - pointAt(previous.position).seconds;
        all.push({ from: previous.position, to: position, step: { seconds, meters: meters - previous.meters } });
      } else all.push({ from: position, to: position, step: { seconds: 0, meters: 0, breakBefore: true } });
      previous = { position, meters, segment };
    });
    const flags = movingSteps(all.map((entry) => entry.step), pause);
    all.forEach((entry, k) => {
      if (!flags[k]) return;
      const value = read(pointAt(entry.from));
      if (value !== undefined) steps.push({ from: entry.from, to: entry.to, zone: zoneIndex(value, bounds) });
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
          if (isBelowPauseSpeed(value, pause)) continue;
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

  /*
   * AV-1021 (TD-090). What splits are found from. The laps are placed on the activity's clock by their
   * start times; a lap before the first point starts there, one after the last point is dropped, and two
   * that start together are one. A file whose laps do not all have a start has none that can be placed.
   */
  const laps: { startSeconds: number; meters?: number }[] = [];
  let lapsIssue: SplitSources['lapsIssue'];
  const fileLaps = activity.laps ?? [];
  if (fileLaps.length >= 2) {
    if (fileLaps.every((lap) => lap.startTime instanceof Date && Number.isFinite(lap.startTime.getTime()))) {
      const placed = fileLaps
        .map((lap) => ({ startSeconds: Math.max(0, ((lap.startTime as Date).getTime() - firstMs) / 1000), meters: finite(lap.distanceMeters) }))
        .filter((lap) => lap.startSeconds <= spanSeconds)
        .sort((a, b) => a.startSeconds - b.startSeconds);
      for (const lap of placed) {
        if (laps.length > 0 && laps[laps.length - 1]!.startSeconds === lap.startSeconds) continue;
        laps.push({ startSeconds: lap.startSeconds, ...(lap.meters !== undefined ? { meters: lap.meters } : {}) });
      }
    } else lapsIssue = 'no_start_times';
  }
  const splitSources: SplitSources = {
    laps: laps.length >= 2,
    ...(lapsIssue ? { lapsIssue } : {}),
    distance: available.has('metric:distance') && distanceSpan > 0,
  };
  let splitStreamsMade: SplitStreams | undefined;
  const splitStreams = (): SplitStreams => {
    if (splitStreamsMade) return splitStreamsMade;
    const seconds: number[] = [];
    const meters: number[] = [];
    const movingSeconds: number[] = [];
    let first: number | undefined;
    let top = 0;
    for (const timedPoint of points) {
      const metres = finite(distance[timedPoint.index]);
      if (metres === undefined) continue;
      first ??= metres;
      top = Math.max(top, metres - first);
      seconds.push(timedPoint.seconds);
      meters.push(top);
      movingSeconds.push(finite(derived.moving[timedPoint.index]) ?? movingSeconds[movingSeconds.length - 1] ?? 0);
    }
    splitStreamsMade = { seconds, meters, moving: movingSeconds, spanSeconds, laps: splitSources.laps ? laps : [] };
    return splitStreamsMade;
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

  const timeline: OverlayTimeline = {
    durationSeconds,
    offsetSeconds,
    available,
    hasRoute,
    ...(distanceSpan > 0 && endDistance !== undefined ? { distanceTotalMeters: endDistance } : {}),
    sensorLabels,
    sampleAt,
    pause,
    rangeOf,
    activityStartMs: firstMs,
    zoneTimes,
    splitSources,
    splitStreams,
    alignment,
  };
  timeline.withCutStart = (cutStartSeconds) => {
    const cut = cutStartActivityOf(cutStartSeconds);
    return { ...timeline, sampleAt: (videoTimeSeconds, only) => sampleWithCut(videoTimeSeconds, only, cut) };
  };
  return timeline;
}
