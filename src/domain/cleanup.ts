import {
  MAX_PLAUSIBLE_CYCLING_SPEED_MPS,
  computeStreams,
  toValidCoordinate,
  type Activity,
  type ActivityCleanup,
  type ActivityPoint,
  type ActivitySport,
  type ActivityWarning,
} from './activity';
import { DEFAULT_PAUSE_SETTINGS, isPauseGap, type PauseSettings } from './pause';
import { EARTH_RADIUS_METERS, computeDistance, computeStats, haversineMeters } from './stats';
import { deriveSpeed } from './series';
import { deriveGrade } from '../overlay/derivedSeries';

/**
 * AV-1024 (TD-093). The telemetry clean-up: a *view* of an activity, never a
 * change to it. `cleanActivity(raw, settings)` returns a new activity with the
 * impossible points dropped, the stats worked out with the chosen pause
 * setting and the speed, grade and route smoothed by the chosen method; the raw
 * activity is left exactly as it was, so turning the clean-up off restores it.
 *
 * Pure and memoised by the raw activity's identity and the settings, so the
 * result is referentially stable: a page that reads it every render does not
 * rebuild everything that depends on it.
 */

export type SmoothingMethod = 'none' | 'movingAverage' | 'kalman';

export const SMOOTHING_METHODS: readonly SmoothingMethod[] = ['none', 'movingAverage', 'kalman'];
/** The strength is a window of 0 to 30 s for the moving average, and the Kalman's time constant, in the same range. */
export const CLEANUP_STRENGTH_LIMITS = { min: 0, max: 30 } as const;
export const DEFAULT_SMOOTHING_STRENGTH = 5;

export interface CleanupSettings {
  enabled: boolean;
  /** Drop impossible points: an implausible speed, or an elevation spike. */
  outliers: boolean;
  pause: PauseSettings;
  smoothing: { method: SmoothingMethod; strength: number };
}

export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
  enabled: false,
  outliers: true,
  pause: DEFAULT_PAUSE_SETTINGS,
  smoothing: { method: 'none', strength: DEFAULT_SMOOTHING_STRENGTH },
};

/** The figures the before/after table compares. */
export interface CleanupSummary {
  distanceMeters?: number;
  movingDurationSeconds?: number;
  averageSpeedMetersPerSecond?: number;
  maxSpeedMetersPerSecond?: number;
  elevationGainMeters?: number;
}

export interface CleanupReport {
  applied: boolean;
  dropped: { speed: number; elevation: number; total: number };
  /** Absent for an activity that arrived already cleaned (a handoff): the raw one is not at hand. */
  before?: CleanupSummary;
  after?: CleanupSummary;
}

export interface CleanupResult {
  activity: Activity;
  report: CleanupReport;
}

/** Running ceiling in metres per second; cycling's is `MAX_PLAUSIBLE_CYCLING_SPEED_MPS`, which every other sport uses. */
export const MAX_PLAUSIBLE_RUNNING_SPEED_MPS = 12;

export function speedCeilingMps(sport: ActivitySport | undefined): number {
  return sport === 'running' ? MAX_PLAUSIBLE_RUNNING_SPEED_MPS : MAX_PLAUSIBLE_CYCLING_SPEED_MPS;
}

/** An elevation is a spike when it differs from both neighbours by more than this... */
export const ELEVATION_SPIKE_METERS = 50;
/** ...and the neighbours agree within this. */
export const ELEVATION_NEIGHBOUR_AGREEMENT_METERS = 10;
/**
 * After this many points in a row dropped for speed, the next is kept as the new anchor: the point
 * they were measured from was more likely the bad one, and nothing else would stop a bad first fix
 * from taking the whole recording with it.
 */
export const MAX_CONSECUTIVE_SPEED_DROPS = 10;
/** ...and only if the run also lasts this long: ten fixes at 18 Hz are half a second, which is a glitch, not a move. */
export const MIN_RELOCATION_SECONDS = 10;

const NO_DROPS = { speed: 0, elevation: 0, total: 0 };

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const timeMs = (point: ActivityPoint): number | undefined => {
  const ms = point.time instanceof Date ? point.time.getTime() : undefined;
  return finite(ms) ? ms : undefined;
};

interface Dropped {
  kept: number[];
  speed: number;
  elevation: number;
}

/**
 * The outlier rules. A point is dropped when the position implies a speed above the sport's ceiling
 * from the previous *kept* point (a point with no time or no position is not tested, and does not
 * become the previous one), or when its elevation is a spike. Returns the positions kept.
 */
function dropOutliers(points: ActivityPoint[], ceiling: number): Dropped {
  interface Fix {
    position: number;
    lat: number;
    lon: number;
    ms: number;
  }
  const dropped = new Set<number>();
  let speed = 0;
  let anchor: Fix | undefined;
  let firstLocated: number | undefined;
  // A run of fixes, each plausible from the one before it, all implausible from the anchor.
  let streak: Fix[] = [];
  // At least a second is allowed between two fixes: at 10 or 18 Hz the metres of ordinary fix noise are not a speed.
  const plausible = (a: Fix, b: Fix) =>
    haversineMeters(a.lat, a.lon, b.lat, b.lon) / Math.max(Math.abs(b.ms - a.ms) / 1000, 1) <= ceiling;
  const restore = (dropAnchor: boolean) => {
    for (const entry of streak) dropped.delete(entry.position);
    speed -= streak.length;
    if (dropAnchor && anchor) {
      dropped.add(anchor.position);
      speed += 1;
    }
  };
  /** A bad first fix: the run after it agrees with itself and with the point that ended it. */
  const firstFixWasBad = (next?: Fix) =>
    anchor !== undefined && anchor.position === firstLocated && streak.length >= 2 && (next === undefined || plausible(streak[streak.length - 1]!, next));
  points.forEach((point, position) => {
    const where = toValidCoordinate(point.lat, point.lon);
    const ms = timeMs(point);
    if (!where || ms === undefined) return;
    firstLocated ??= position;
    const here: Fix = { position, lat: where.lat, lon: where.lon, ms };
    if (anchor && !plausible(anchor, here)) {
      // A fix that disagrees with the run before it starts a new run, so one glitch cannot keep a relocation from standing.
      if (streak.length > 0 && !plausible(streak[streak.length - 1]!, here)) streak = [];
      dropped.add(position);
      speed += 1;
      streak.push(here);
      // A long run that keeps agreeing with itself is a relocation, not a spike: it stands. Only when the
      // anchor is the recording's first fix is the anchor itself the likelier bad one, and that goes.
      if (streak.length >= MAX_CONSECUTIVE_SPEED_DROPS && here.ms - streak[0]!.ms >= MIN_RELOCATION_SECONDS * 1000) {
        restore(anchor.position === firstLocated);
        anchor = here;
        streak = [];
      }
      return;
    }
    // The run has ended. If it was after a bad first fix, that fix goes and the run is restored.
    if (firstFixWasBad(here)) restore(true);
    streak = [];
    anchor = here;
  });
  if (firstFixWasBad()) restore(true);
  const afterSpeed = points.map((_, position) => position).filter((position) => !dropped.has(position));

  // Neighbours are the nearest points that still stand with an elevation, as the points are after the speed test.
  const withElevation = afterSpeed.filter((position) => finite(points[position]!.elevationMeters));
  const spikes = new Set<number>();
  for (let k = 1; k + 1 < withElevation.length; k += 1) {
    const here = points[withElevation[k]!]!.elevationMeters as number;
    const before = points[withElevation[k - 1]!]!.elevationMeters as number;
    const after = points[withElevation[k + 1]!]!.elevationMeters as number;
    if (
      Math.abs(here - before) > ELEVATION_SPIKE_METERS &&
      Math.abs(here - after) > ELEVATION_SPIKE_METERS &&
      Math.abs(before - after) <= ELEVATION_NEIGHBOUR_AGREEMENT_METERS
    ) {
      spikes.add(withElevation[k]!);
    }
  }
  return { kept: afterSpeed.filter((position) => !spikes.has(position)), speed, elevation: spikes.size };
}

// ---------------------------------------------------------------------------------------------
// Smoothing

const METERS_PER_DEGREE = (EARTH_RADIUS_METERS * Math.PI) / 180;
/** What a consumer GPS fix is trusted to within, for the Kalman filter's measurement noise. */
const KALMAN_MEASUREMENT_SIGMA_METERS = 5;
/** The Kalman filter's process noise (an acceleration, in m/s²) at strength 0; it falls as 1 / (1 + strength). */
const KALMAN_ACCELERATION_SIGMA = 6;
const KALMAN_INITIAL_VELOCITY_VARIANCE = 100;

/**
 * Centred mean over `windowSeconds`, by time, within one run of samples. The window shrinks
 * symmetrically near the ends of the run, so the first and last samples stay where they are and a
 * straight track at constant speed is left exactly as it was.
 */
function movingAverage(times: number[], values: number[], windowSeconds: number): number[] {
  // Whole milliseconds, so a window clamped at a segment's end lands exactly on a sample at any rate.
  times = times.map((t) => Math.round(t * 1000));
  const windowMs = windowSeconds * 1000;
  const prefix = new Float64Array(values.length + 1);
  values.forEach((value, i) => {
    prefix[i + 1] = prefix[i]! + value;
  });
  const last = values.length - 1;
  const firstAtOrAfter = (t: number, strict = false) => {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? times[mid]! <= t : times[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out: number[] = new Array(values.length);
  for (let i = 0; i <= last; i += 1) {
    const half = Math.max(0, Math.min(windowMs / 2, times[i]! - times[0]!, times[last]! - times[i]!));
    const lo = firstAtOrAfter(times[i]! - half);
    const hi = firstAtOrAfter(times[i]! + half, true) - 1;
    out[i] = hi < lo ? values[i]! : (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
  }
  return out;
}

/**
 * A constant-velocity Kalman filter over one coordinate (metres): state (position, velocity), the
 * process noise an acceleration of `accelerationSigma`, the measurement noise a fixed GPS error.
 * Forward only, so deterministic and causal. Returns the filtered position and velocity.
 */
function kalmanConstantVelocity(times: number[], z: number[], accelerationSigma: number): { position: number[]; velocity: number[] } {
  const r = KALMAN_MEASUREMENT_SIGMA_METERS ** 2;
  const q = accelerationSigma ** 2;
  const position: number[] = [];
  const velocity: number[] = [];
  let p = z[0]!;
  let v = 0;
  let p00 = r;
  let p01 = 0;
  let p11 = KALMAN_INITIAL_VELOCITY_VARIANCE;
  for (let i = 0; i < z.length; i += 1) {
    if (i > 0) {
      const dt = Math.max(0, times[i]! - times[i - 1]!);
      p += v * dt;
      const n00 = p00 + dt * (2 * p01 + dt * p11) + (q * dt ** 4) / 4;
      const n01 = p01 + dt * p11 + (q * dt ** 3) / 2;
      const n11 = p11 + q * dt ** 2;
      p00 = n00;
      p01 = n01;
      p11 = n11;
      const s = p00 + r;
      const k0 = p00 / s;
      const k1 = p01 / s;
      const innovation = z[i]! - p;
      p += k0 * innovation;
      v += k1 * innovation;
      const u00 = (1 - k0) * p00;
      const u01 = (1 - k0) * p01;
      const u11 = p11 - k1 * p01;
      p00 = u00;
      p01 = u01;
      p11 = u11;
    }
    position.push(p);
    velocity.push(v);
  }
  return { position, velocity };
}

/**
 * The Kalman filter's smoothing of a plain series (a speed, a grade): the steady-state form of a
 * random-walk model, which is an exponential average with a time constant of `strength` seconds.
 */
function localLevel(times: number[], values: number[], timeConstant: number): number[] {
  const out: number[] = [];
  let level = values[0]!;
  for (let i = 0; i < values.length; i += 1) {
    if (i > 0) level += (1 - Math.exp(-Math.max(0, times[i]! - times[i - 1]!) / timeConstant)) * (values[i]! - level);
    out.push(level);
  }
  return out;
}

function smoothScalar(method: SmoothingMethod, strength: number, times: number[], values: number[]): number[] {
  if (method === 'movingAverage') return movingAverage(times, values, strength);
  if (method === 'kalman') return localLevel(times, values, strength);
  return values;
}

/**
 * Runs of consecutive entries in one recorded segment: smoothing never reaches across a recording
 * gap, nor across an auto-pause (a time gap inside a segment that the overlay reads as a stop,
 * TD-093), so the window shrinks at both sides of it as at the ends of a segment, and the Kalman
 * filter starts again after it rather than carrying its velocity over a pause.
 */
function segmentRuns(points: ActivityPoint[], positions: number[], pause: PauseSettings): number[][] {
  const runs: number[][] = [];
  let segment: number | undefined;
  let before: ActivityPoint | undefined;
  for (const position of positions) {
    const point = points[position]!;
    const own = point.segmentIndex ?? 0;
    if (own !== segment || (before && crossesPause(before, point, pause))) runs.push([]);
    segment = own;
    before = point;
    runs[runs.length - 1]!.push(position);
  }
  return runs;
}

/** True when the step from one point to the next is an auto-pause by the shared pause rule. */
function crossesPause(a: ActivityPoint, b: ActivityPoint, pause: PauseSettings): boolean {
  const seconds = ((timeMs(b) as number) - (timeMs(a) as number)) / 1000;
  const from = toValidCoordinate(a.lat, a.lon);
  const to = toValidCoordinate(b.lat, b.lon);
  // The file's own distance where both points have it, as the stats and the timeline read it.
  const step = finite(a.distanceMeters) && finite(b.distanceMeters) ? b.distanceMeters - a.distanceMeters : undefined;
  const recorded = step !== undefined && step >= 0 ? step : undefined;
  const meters = recorded ?? (from && to ? haversineMeters(from.lat, from.lon, to.lat, to.lon) : 0);
  return isPauseGap(meters, seconds, pause);
}

/** The positions of the points that have a valid location and a time. */
function locatedPositions(points: ActivityPoint[]): number[] {
  const out: number[] = [];
  points.forEach((point, position) => {
    if (toValidCoordinate(point.lat, point.lon) && timeMs(point) !== undefined) out.push(position);
  });
  return out;
}

/** The route smoothed, in metres on a plane tangent at the first fix (equirectangular), and back. */
function smoothRoute(points: ActivityPoint[], method: SmoothingMethod, strength: number, pause: PauseSettings): ActivityPoint[] {
  const located = locatedPositions(points);
  if (located.length === 0) return points;
  const first = points[located[0]!]!;
  const lat0 = first.lat as number;
  const lon0 = first.lon as number;
  const kx = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  const out = points.slice();
  for (const run of segmentRuns(points, located, pause)) {
    const times = run.map((position) => (timeMs(points[position]!) as number) / 1000);
    // Longitude is unwrapped about the first fix, so a route over the antimeridian is one piece.
    const xs = run.map((position) => ((((points[position]!.lon as number) - lon0 + 540) % 360) - 180) * kx);
    const ys = run.map((position) => (((points[position]!.lat as number) - lat0) * METERS_PER_DEGREE));
    let sx: number[];
    let sy: number[];
    if (method === 'kalman') {
      const sigma = KALMAN_ACCELERATION_SIGMA / (1 + strength);
      sx = kalmanConstantVelocity(times, xs, sigma).position;
      sy = kalmanConstantVelocity(times, ys, sigma).position;
    } else {
      sx = movingAverage(times, xs, strength);
      sy = movingAverage(times, ys, strength);
    }
    run.forEach((position, k) => {
      out[position] = { ...points[position]!, lat: lat0 + sy[k]! / METERS_PER_DEGREE, lon: ((((lon0 + sx[k]! / kx) + 540) % 360) - 180) };
    });
  }
  return out;
}

/** Writes a smoothed series into the points' own field, for the points that have a time and a value. */
function smoothField(
  points: ActivityPoint[],
  values: (number | undefined)[],
  field: 'speedMetersPerSecond' | 'gradePercent',
  method: SmoothingMethod,
  strength: number,
  pause: PauseSettings,
  clamp: (value: number) => number,
): void {
  const timed: number[] = [];
  points.forEach((point, position) => {
    if (finite(values[position]) && timeMs(point) !== undefined) timed.push(position);
  });
  for (const run of segmentRuns(points, timed, pause)) {
    const times = run.map((position) => (timeMs(points[position]!) as number) / 1000);
    const smoothed = smoothScalar(method, strength, times, run.map((position) => values[position] as number));
    run.forEach((position, k) => {
      points[position] = { ...points[position]!, [field]: clamp(smoothed[k]!) };
    });
  }
}

/**
 * The chosen method on the route, then on the speed and the grade worked out from it, written into
 * the points' own fields so every reader of them (the charts, the overlay's timeline, the exports)
 * sees the same numbers. The heading, the pace and the distance are derived from the smoothed route.
 */
function smoothPoints(activity: Activity, points: ActivityPoint[], method: SmoothingMethod, strength: number, pause: PauseSettings): ActivityPoint[] {
  if (method === 'none' || !(strength > 0)) return points;
  const routed = smoothRoute(points, method, strength, pause);
  const speeds = deriveSpeed({ ...activity, points: routed });
  const distance = computeDistance(routed).cumulativeMeters;
  const grades = deriveGrade(routed, distance);
  const out = routed.slice();
  smoothField(out, speeds, 'speedMetersPerSecond', method, strength, pause, (value) => Math.min(MAX_PLAUSIBLE_CYCLING_SPEED_MPS, Math.max(0, value)));
  smoothField(out, grades, 'gradePercent', method, strength, pause, (value) => value);
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Maps a point index to the index it has once points are dropped; a dropped point's is that of the next one kept. */
function renumber(raw: ActivityPoint[], kept: number[]): Map<number, number> {
  const map = new Map<number, number>();
  const keptSet = new Set(kept);
  let next = kept.length - 1;
  const newIndexOf = new Map<number, number>();
  kept.forEach((position, k) => newIndexOf.set(position, k));
  // From the end: a dropped point takes the index of the next point kept, the last kept one past the end.
  for (let position = raw.length - 1; position >= 0; position -= 1) {
    if (keptSet.has(position)) next = newIndexOf.get(position)!;
    map.set(raw[position]!.index, Math.max(0, next));
  }
  return map;
}

function summaryOf(activity: Activity): CleanupSummary {
  let max: number | undefined;
  for (const speed of deriveSpeed(activity)) if (finite(speed) && (max === undefined || speed > max)) max = speed;
  const derived = activity.derived;
  return {
    distanceMeters: derived?.distanceMeters,
    movingDurationSeconds: derived?.movingDurationSeconds,
    averageSpeedMetersPerSecond: derived?.averageSpeedMetersPerSecond,
    maxSpeedMetersPerSecond: max,
    elevationGainMeters: derived?.elevationGainMeters,
  };
}

/** What the smoothing is called in a sentence. */
export function smoothingLabel(smoothing: ActivityCleanup['smoothing']): string {
  if (smoothing.method === 'none' || !(smoothing.strength > 0)) return 'none';
  return smoothing.method === 'movingAverage' ? `moving average over ${smoothing.strength} s` : `Kalman, strength ${smoothing.strength}`;
}

function warningsFor(info: ActivityCleanup): ActivityWarning[] {
  const { speed, elevation, total } = info.dropped;
  const warnings: ActivityWarning[] = [];
  if (total > 0) {
    warnings.push({
      code: 'cleanup_points_dropped',
      severity: 'info',
      message: `Clean-up dropped ${total} point${total === 1 ? '' : 's'}: ${speed} for an implausible speed, ${elevation} for an elevation spike.`,
    });
  }
  warnings.push({
    code: 'cleanup_applied',
    severity: 'info',
    message: `Cleaned: ${total} point${total === 1 ? '' : 's'} dropped, smoothing ${smoothingLabel(info.smoothing)}.`,
  });
  return warnings;
}

const cache = new WeakMap<Activity, { key: string; result: CleanupResult }>();

/**
 * The cleaned view of `raw` under `settings`. With the clean-up off, `raw` itself comes back; an
 * activity that already carries a clean-up (one handed over from the viewer) is left as it is, never
 * cleaned twice.
 */
export function cleanActivity(raw: Activity, settings: CleanupSettings): CleanupResult {
  if (raw.cleanup) return { activity: raw, report: { applied: true, dropped: raw.cleanup.dropped } };
  if (!settings.enabled) return { activity: raw, report: { applied: false, dropped: NO_DROPS } };

  const key = JSON.stringify(settings);
  const cached = cache.get(raw);
  if (cached?.key === key) return cached.result;

  const { smoothing, pause } = settings;
  const outcome = settings.outliers
    ? dropOutliers(raw.points, speedCeilingMps(raw.metadata.sport))
    : { kept: raw.points.map((_, position) => position), speed: 0, elevation: 0 };
  const survivors = outcome.kept.map((position) => raw.points[position]!);
  const smoothed = smoothPoints(raw, survivors, smoothing.method, Math.min(CLEANUP_STRENGTH_LIMITS.max, Math.max(0, smoothing.strength)), pause);
  const points = smoothed.map((point, index) => (point.index === index ? point : { ...point, index }));

  const info: ActivityCleanup = {
    pause,
    smoothing: { method: smoothing.method, strength: smoothing.strength },
    dropped: { speed: outcome.speed, elevation: outcome.elevation, total: outcome.speed + outcome.elevation },
  };
  const dropped = outcome.kept.length !== raw.points.length;
  const remap = dropped ? renumber(raw.points, outcome.kept) : undefined;

  const { stats } = computeStats(points, pause);
  const activity: Activity = {
    ...raw,
    points,
    streams: computeStreams(points),
    derived: stats,
    warnings: [...raw.warnings, ...warningsFor(info)],
    cleanup: info,
    // Start and end follow the points that stand, as a slice's do.
    metadata: { ...raw.metadata, ...(raw.metadata.startTime ? { startTime: stats.startTime } : {}), ...(raw.metadata.endTime ? { endTime: stats.endTime } : {}) },
    // Laps and the segments are by time and by `segmentIndex`, which dropping a point leaves true; an event names a point.
    ...(raw.events && remap
      ? { events: raw.events.map((event) => (event.pointIndex === undefined ? event : { ...event, pointIndex: remap.get(event.pointIndex) ?? event.pointIndex })) }
      : {}),
    // A camera stream is positional against the points, so it loses the same ones.
    ...(raw.sensorStreams && dropped
      ? {
          sensorStreams: raw.sensorStreams.map((stream) =>
            stream.valuesByPoint ? { ...stream, valuesByPoint: outcome.kept.map((position) => stream.valuesByPoint![position]) } : stream,
          ),
        }
      : {}),
  };
  const result: CleanupResult = {
    activity,
    report: { applied: true, dropped: info.dropped, before: summaryOf(raw), after: summaryOf(activity) },
  };
  cache.set(raw, { key, result });
  return result;
}
