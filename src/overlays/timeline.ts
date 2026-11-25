import type { Activity } from '../domain/activity';
import { buildSeries } from '../domain/series';

/**
 * AV-1003. The clock that ties a video to an activity.
 *
 * An overlay shows what the telemetry said *at this moment of the video*. This
 * module answers that question and nothing else: given a time in the video and
 * an offset, what was every measurement, and is there an answer at all?
 *
 * It is pure — no canvas, no DOM, no video element — so the same function
 * serves the live preview, the frame-by-frame export and the tests, and a
 * frame rendered for export cannot disagree with the one the user previewed.
 */

/** The measurements an overlay can bind to. */
export const OVERLAY_METRICS = [
  'speed',
  'pace',
  'distance',
  'elapsed',
  'elevation',
  'heartRate',
  'cadence',
  'cyclingCadence',
  'power',
  'temperature',
  'grade',
] as const;

export type OverlayMetric = (typeof OVERLAY_METRICS)[number];

/** Channels the timeline interpolates: the metrics, plus position. */
type Channel = Exclude<OverlayMetric, 'elapsed'> | 'lat' | 'lon';

const CHANNELS: Channel[] = [
  'lat',
  'lon',
  'speed',
  'pace',
  'distance',
  'elevation',
  'heartRate',
  'cadence',
  'cyclingCadence',
  'power',
  'temperature',
  'grade',
];

/**
 * Samples further apart than this are not joined by a straight line between
 * values: a minute-long hole in the recording has no honest reading in its
 * middle, and an overlay that invents one is worse than one that goes blank.
 */
export const MAX_INTERPOLATION_GAP_SECONDS = 10;

export type SampleStatus =
  /** Values are valid. */
  | 'ok'
  /** The video time is earlier than the activity's first timed point. */
  | 'before'
  /** The video time is later than its last. */
  | 'after'
  /** It falls in a recording gap or a pause: nothing was measured. */
  | 'gap';

export interface OverlaySample {
  status: SampleStatus;
  /** Seconds since the activity's first timed point. Present unless before/after. */
  elapsedSeconds?: number;
  /** 0 at the first timed point, 1 at the last. */
  progress?: number;
  /** The nearest point in `activity.points`, for markers and lookups. */
  pointIndex?: number;
  /** Interpolated values; a channel with no reading here is absent. */
  values: Partial<Record<Channel, number>>;
  /** Interpolated sensor streams, by stream key. */
  sensors: Record<string, number>;
}

export interface OverlayTimeline {
  /** Milliseconds since epoch of each timed point, ascending. */
  times: number[];
  /** `activity.points` position of each entry in `times`. */
  positions: number[];
  segments: number[];
  startMs: number;
  endMs: number;
  channels: Record<Channel, (number | undefined)[]>;
  sensorValues: Record<string, (number | undefined)[]>;
  /** Which channels hold at least one reading, so a template can hide the rest. */
  available: ReadonlySet<Channel>;
  availableSensors: ReadonlySet<string>;
}

export type TimelineResult =
  | { ok: true; timeline: OverlayTimeline }
  | { ok: false; reason: string };

const validTime = (date: Date | undefined): number | undefined => {
  const ms = date instanceof Date ? date.getTime() : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * Prepares an activity for sampling. Fails, with a reason a person can read,
 * when there is no clock to align a video against: a planned route, or a file
 * recorded without timestamps, has no "at this moment".
 */
export function buildTimeline(activity: Activity): TimelineResult {
  const timed: { position: number; ms: number }[] = [];
  activity.points.forEach((point, position) => {
    const ms = validTime(point.time);
    if (ms !== undefined) timed.push({ position, ms });
  });

  if (timed.length < 2) {
    return {
      ok: false,
      reason:
        'This activity has no timestamps to line up with a video, so only a still overlay can be made from it.',
    };
  }
  // Files are normally in order; a stable sort makes the rest safe.
  timed.sort((a, b) => a.ms - b.ms);

  // The same windowed speed and pace the charts show, so an overlay and the
  // viewer never disagree about how fast a moment was.
  const perPoint = (key: 'speed' | 'pace'): (number | undefined)[] => {
    const values: (number | undefined)[] = new Array(activity.points.length).fill(undefined);
    const byIndex = new Map(activity.points.map((point, position) => [point.index, position]));
    for (const sample of buildSeries(activity, key, 'index').samples) {
      const position = byIndex.get(sample.pointIndex);
      if (position !== undefined) values[position] = sample.y;
    }
    return values;
  };
  const speed = perPoint('speed');
  const pace = perPoint('pace');
  const cumulative = activity.points.map((point) => point.distanceMeters);

  const read: Record<Channel, (position: number) => number | undefined> = {
    lat: (i) => activity.points[i]!.lat,
    lon: (i) => activity.points[i]!.lon,
    speed: (i) => speed[i],
    pace: (i) => pace[i],
    distance: (i) => cumulative[i],
    elevation: (i) => activity.points[i]!.elevationMeters,
    heartRate: (i) => activity.points[i]!.heartRateBpm,
    cadence: (i) => activity.points[i]!.runningCadenceSpm,
    cyclingCadence: (i) => activity.points[i]!.cyclingCadenceRpm,
    power: (i) => activity.points[i]!.powerWatts,
    temperature: (i) => activity.points[i]!.temperatureCelsius,
    grade: (i) => activity.points[i]!.gradePercent,
  };

  const finite = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const channels = {} as Record<Channel, (number | undefined)[]>;
  const available = new Set<Channel>();
  for (const channel of CHANNELS) {
    channels[channel] = timed.map(({ position }) => finite(read[channel](position)));
    if (channels[channel].some((value) => value !== undefined)) available.add(channel);
  }

  const sensorValues: Record<string, (number | undefined)[]> = {};
  const availableSensors = new Set<string>();
  for (const stream of activity.sensorStreams ?? []) {
    if (stream.display !== 'chart' || !stream.valuesByPoint) continue;
    const values = timed.map(({ position }) => finite(stream.valuesByPoint![position]));
    if (values.some((value) => value !== undefined)) {
      sensorValues[stream.key] = values;
      availableSensors.add(stream.key);
    }
  }

  return {
    ok: true,
    timeline: {
      times: timed.map((entry) => entry.ms),
      positions: timed.map((entry) => entry.position),
      segments: timed.map((entry) => activity.points[entry.position]!.segmentIndex ?? 0),
      startMs: timed[0]!.ms,
      endMs: timed[timed.length - 1]!.ms,
      channels,
      sensorValues,
      available,
      availableSensors,
    },
  };
}

/** Length of the telemetry, in seconds. */
export function timelineDurationSeconds(timeline: OverlayTimeline): number {
  return (timeline.endMs - timeline.startMs) / 1000;
}

/** Index of the last entry at or before `ms`, or -1 when `ms` precedes them all. */
function lastAtOrBefore(times: readonly number[], ms: number): number {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (times[middle]! <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

const lerp = (a: number | undefined, b: number | undefined, fraction: number) =>
  a === undefined || b === undefined ? undefined : a + (b - a) * fraction;

/**
 * What the telemetry says at `videoSeconds`.
 *
 * `offsetSeconds` shifts the activity against the video: with `+3`, the video's
 * second 0 shows the telemetry from the activity's third second. That is how a
 * user lines a recording up when the camera clock and the watch clock differ.
 *
 * Nothing is extrapolated. Before the first point, after the last, and across a
 * gap, the answer is a status with no values — a template then hides what it
 * cannot show, rather than freezing a stale number or inventing one.
 */
export function sampleTimeline(
  timeline: OverlayTimeline,
  videoSeconds: number,
  offsetSeconds = 0,
): OverlaySample {
  const empty = (status: SampleStatus, extra: Partial<OverlaySample> = {}): OverlaySample => ({
    status,
    values: {},
    sensors: {},
    ...extra,
  });

  if (!Number.isFinite(videoSeconds) || !Number.isFinite(offsetSeconds)) return empty('before');

  const ms = timeline.startMs + (videoSeconds + offsetSeconds) * 1000;
  if (ms < timeline.startMs) return empty('before');
  if (ms > timeline.endMs) return empty('after');

  const lower = lastAtOrBefore(timeline.times, ms);
  const upper = Math.min(lower + 1, timeline.times.length - 1);
  const t0 = timeline.times[lower]!;
  const t1 = timeline.times[upper]!;
  const elapsedSeconds = (ms - timeline.startMs) / 1000;
  const span = timeline.endMs - timeline.startMs;
  const progress = span > 0 ? (ms - timeline.startMs) / span : 0;
  const nearest = ms - t0 <= t1 - ms ? lower : upper;
  const meta = {
    elapsedSeconds,
    progress,
    pointIndex: timeline.positions[nearest],
  };

  // Exactly on a point (or the final one): its own readings, no blending.
  if (upper === lower || t0 === ms) {
    return fill(timeline, lower, lower, 0, 'ok', meta);
  }

  const crossesSegment = timeline.segments[lower] !== timeline.segments[upper];
  const tooFar = (t1 - t0) / 1000 > MAX_INTERPOLATION_GAP_SECONDS;
  if (crossesSegment || tooFar) return empty('gap', meta);

  return fill(timeline, lower, upper, (ms - t0) / (t1 - t0), 'ok', meta);
}

function fill(
  timeline: OverlayTimeline,
  lower: number,
  upper: number,
  fraction: number,
  status: SampleStatus,
  meta: Pick<OverlaySample, 'elapsedSeconds' | 'progress' | 'pointIndex'>,
): OverlaySample {
  const values: Partial<Record<Channel, number>> = {};
  for (const channel of timeline.available) {
    const series = timeline.channels[channel];
    const value = lerp(series[lower], series[upper], fraction);
    if (value !== undefined) values[channel] = value;
  }
  const sensors: Record<string, number> = {};
  for (const key of timeline.availableSensors) {
    const series = timeline.sensorValues[key]!;
    const value = lerp(series[lower], series[upper], fraction);
    if (value !== undefined) sensors[key] = value;
  }
  return { status, values, sensors, ...meta };
}

/** A metric's value in a sample, including the one that is not a channel. */
export function metricValue(sample: OverlaySample, metric: OverlayMetric): number | undefined {
  return metric === 'elapsed' ? sample.elapsedSeconds : sample.values[metric];
}
