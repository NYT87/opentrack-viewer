import type { Activity, ActivityPoint, Coordinate } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';
import { deriveSpeed } from '../domain/series';
import { computeDistance } from '../domain/stats';

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
  | 'elapsed';

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
  /**
   * The activity's charted camera streams, keyed by `sensor:` id, with the
   * range their values span (a gauge needs bounds the source does not state).
   */
  sensorLabels: ReadonlyMap<string, OverlaySensorInfo>;
  sampleAt: (videoTimeSeconds: number) => OverlaySample | undefined;
}

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
}

function metricReaders({ distance, speed }: DerivedStreams): Record<OverlayMetricKey, Reader> {
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
    grade: ({ point }) => finite(point.gradePercent),
    elapsed: ({ seconds }) => seconds,
  };
}

/** Pace in seconds per km from a speed; undefined when standing still. */
export function paceFromSpeed(metersPerSecond: number | undefined): number | undefined {
  return typeof metersPerSecond === 'number' && metersPerSecond > 0
    ? 1000 / metersPerSecond
    : undefined;
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

  // Points without a usable time cannot be placed against a clock. Order is
  // trusted from the parsers but not assumed: sort by time, stably.
  const timed = activity.points
    .map((point, index) => ({ point, index, ms: point.time?.getTime() }))
    .filter((entry): entry is { point: ActivityPoint; index: number; ms: number } =>
      Number.isFinite(entry.ms),
    )
    .sort((a, b) => a.ms - b.ms || a.index - b.index);
  if (timed.length === 0) return empty('no_timestamps');

  const firstMs = (timed[0] as { ms: number }).ms;
  const lastMs = (timed[timed.length - 1] as { ms: number }).ms;
  const points: TimedPoint[] = timed.map(({ point, index, ms }) => ({
    point,
    index,
    seconds: (ms - firstMs) / 1000,
  }));
  const spanSeconds = (lastMs - firstMs) / 1000;

  // Video time `t` is `anchor + t` on the wall clock; the activity then shows
  // `anchor + t - offset`, expressed as seconds since its first point.
  const anchorMs = options.video?.start?.getTime();
  const anchorSeconds =
    typeof anchorMs === 'number' && Number.isFinite(anchorMs) ? (anchorMs - firstMs) / 1000 : 0;
  const toActivitySeconds = (videoTime: number) => anchorSeconds + videoTime - offsetSeconds;

  const derived: DerivedStreams = {
    distance: computeDistance(activity.points).cumulativeMeters,
    speed: deriveSpeed(activity),
  };
  const readers = metricReaders(derived);
  const sources: { id: string; read: Reader }[] = OVERLAY_METRIC_KEYS.map((metric) => ({
    id: dataSourceId({ kind: 'metric', metric }),
    read: readers[metric],
  }));
  const sensorLabels = new Map<string, OverlaySensorInfo>();
  for (const stream of activity.sensorStreams ?? []) {
    if (stream.display !== 'chart' || !stream.valuesByPoint) continue;
    const id = dataSourceId({ kind: 'sensor', key: stream.key });
    const values = stream.valuesByPoint;
    sources.push({ id, read: ({ index }) => finite(values[index]) });
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
    const bridges =
      !exact &&
      gap <= maxGap &&
      (a.point.segmentIndex ?? 0) === (b.point.segmentIndex ?? 0);

    const values: Partial<Record<string, number>> = {};
    for (const { id, read } of sources) {
      const va = read(a);
      const vb = read(b);
      let value: number | undefined;
      if (exact) value = va;
      else if (bridges && va !== undefined && vb !== undefined) value = va + (vb - va) * fraction;
      else value = undefined;
      if (value !== undefined) values[id] = value;
    }
    if (values['metric:pace'] !== undefined) {
      const pace = paceFromSpeed(values['metric:speed']);
      if (pace === undefined) delete values['metric:pace'];
      else values['metric:pace'] = pace;
    }
    // Elapsed is the clock, not a recorded value: it is defined everywhere.
    values['metric:elapsed'] = seconds;

    let position: Coordinate | undefined;
    const pa = toValidCoordinate(a.point.lat, a.point.lon);
    const pb = toValidCoordinate(b.point.lat, b.point.lon);
    if (exact) position = pa;
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

  return { durationSeconds, offsetSeconds, available, hasRoute, sensorLabels, sampleAt };
}
