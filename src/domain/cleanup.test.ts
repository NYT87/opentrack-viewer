import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLEANUP_SETTINGS,
  MAX_CONSECUTIVE_SPEED_DROPS,
  MIN_RELOCATION_SECONDS,
  cleanActivity,
  speedCeilingMps,
  type CleanupSettings,
} from './cleanup';
import { haversineMeters } from './stats';
import { deriveSpeed } from './series';
import { buildOverlayTimeline } from '../overlay/timeline';
import { exportActivity } from '../exporters';
import { makeActivity } from '../test/helpers/activity';
import { useCleanupStore } from '../state/cleanupStore';
import { useInteractionStore } from '../state/interactionStore';
import type { Activity, ActivityPoint } from './activity';

const T0 = new Date('2024-01-01T10:00:00Z').getTime();
const at = (s: number) => new Date(T0 + s * 1000);
const M_PER_DEG = 111_194.9;
const LAT0 = 45;
const LON0 = 7;
const M_PER_DEG_LON = M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180);

/** A straight eastbound track, one point a second at `speed` m/s, `noise` is added by the caller. */
function track(count: number, speed = 5, extra: (i: number) => Partial<ActivityPoint> = () => ({})): Partial<ActivityPoint>[] {
  return Array.from({ length: count }, (_, i) => ({
    time: at(i),
    lat: LAT0,
    lon: LON0 + (i * speed) / M_PER_DEG_LON,
    ...extra(i),
  }));
}

const on = (patch: Partial<CleanupSettings> = {}): CleanupSettings => ({ ...DEFAULT_CLEANUP_SETTINGS, enabled: true, ...patch });

/** A small deterministic noise source (LCG), roughly uniform in [-1, 1]. */
function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 4294967296) * 2 - 1;
  };
}

describe('the outlier filter (AV-1024)', () => {
  it('drops a point whose position implies an impossible speed, and says how many', () => {
    // A GPS spike: point 10 is a kilometre off for one second.
    const raw = makeActivity(track(30, 5, (i) => (i === 10 ? { lat: LAT0 + 0.009 } : {})));
    const { activity, report } = cleanActivity(raw, on());
    expect(activity.points).toHaveLength(29);
    expect(report.dropped).toEqual({ speed: 1, elevation: 0, total: 1 });
    // The point after the spike is judged against the last kept point, so it stays.
    expect(activity.points.map((p) => p.time!.getTime())).not.toContain(at(10).getTime());
    expect(activity.points.map((p) => p.time!.getTime())).toContain(at(11).getTime());
    // Indexes are renumbered to the cleaned points.
    expect(activity.points.map((p) => p.index)).toEqual(activity.points.map((_, i) => i));
    expect(activity.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['cleanup_points_dropped', 'cleanup_applied']));
    expect(activity.warnings.find((w) => w.code === 'cleanup_points_dropped')).toMatchObject({
      severity: 'info',
      message: expect.stringContaining('1 for an implausible speed'),
    });
    expect(activity.warnings.find((w) => w.code === 'cleanup_applied')?.message).toBe('Cleaned: 1 point dropped, smoothing none.');
    expect(activity.cleanup?.dropped).toEqual({ speed: 1, elevation: 0, total: 1 });
  });

  it('uses the sport’s ceiling: running 12 m/s, cycling 35, anything else 35', () => {
    expect(speedCeilingMps('running')).toBe(12);
    expect(speedCeilingMps('cycling')).toBe(35);
    for (const sport of ['walking', 'hiking', 'unknown', undefined] as const) expect(speedCeilingMps(sport)).toBe(35);
    // A 20 m hop in a second is 20 m/s: impossible on foot, ordinary downhill on a bike.
    const hop = (i: number) => (i === 10 ? { lat: LAT0 + 20 / M_PER_DEG } : {});
    const run = makeActivity(track(30, 3, hop));
    run.metadata.sport = 'running';
    const ride = makeActivity(track(30, 3, hop));
    ride.metadata.sport = 'cycling';
    expect(cleanActivity(run, on()).report.dropped.speed).toBe(1);
    expect(cleanActivity(ride, on()).report.dropped.speed).toBe(0);
  });

  it('measures from the previous kept point, so two spikes in a row both go', () => {
    const raw = makeActivity(track(30, 5, (i) => (i === 10 || i === 11 ? { lat: LAT0 + 0.009 } : {})));
    expect(cleanActivity(raw, on()).report.dropped.speed).toBe(2);
  });

  it('does not test a point with no time or no position, and keeps it', () => {
    const raw = makeActivity([
      ...track(5),
      { time: at(5), heartRateBpm: 100 },
      { lat: LAT0 + 0.5, lon: LON0 },
      ...track(5).map((p, i) => ({ ...p, time: at(6 + i), lon: (p.lon as number) + 6 * 5 / M_PER_DEG_LON })),
    ]);
    const { report, activity } = cleanActivity(raw, on());
    expect(report.dropped.total).toBe(0);
    expect(activity.points).toHaveLength(raw.points.length);
  });

  it('drops an elevation spike, but not a climb or neighbours that disagree', () => {
    const spike = makeActivity(track(10, 5, (i) => ({ elevationMeters: i === 5 ? 250 : 100 })));
    const spiked = cleanActivity(spike, on());
    expect(spiked.report.dropped).toEqual({ speed: 0, elevation: 1, total: 1 });
    expect(spiked.activity.points).toHaveLength(9);

    const climb = makeActivity(track(10, 5, (i) => ({ elevationMeters: i * 60 })));
    expect(cleanActivity(climb, on()).report.dropped.total).toBe(0);

    // The neighbours are 30 m apart: a step, not a spike.
    const step = makeActivity(track(10, 5, (i) => ({ elevationMeters: i < 5 ? 100 : i === 5 ? 300 : 130 })));
    expect(cleanActivity(step, on()).report.dropped.total).toBe(0);
  });

  it('does not let a bad first fix take the recording with it', () => {
    const raw = makeActivity(track(40, 5, (i) => (i === 0 ? { lat: LAT0 + 0.5 } : {})));
    const { activity, report } = cleanActivity(raw, on());
    // Only the bad first fix goes; the good points that disagreed with it are restored.
    expect(report.dropped.speed).toBe(1);
    expect(activity.points).toHaveLength(39);
    expect(activity.points.every((p) => p.lat === LAT0)).toBe(true);
    expect(activity.derived!.distanceMeters!).toBeCloseTo(38 * 5, 0);
    expect(MAX_CONSECUTIVE_SPEED_DROPS).toBe(10);
    expect(MIN_RELOCATION_SECONDS).toBe(10);
  });

  it('drops a first fix that is only a little off too, and keeps the good points after it', () => {
    const raw = makeActivity(track(30, 5, (i) => (i === 0 ? { lat: LAT0 + 200 / M_PER_DEG } : {})));
    const { activity, report } = cleanActivity(raw, on());
    expect(report.dropped.speed).toBe(1);
    expect(activity.points).toHaveLength(29);
  });

  it('does not restore a glitch of scattered fixes, however long', () => {
    const raw = makeActivity(track(40, 5, (i) => (i >= 10 && i < 22 ? { lat: LAT0 + (i % 2 === 0 ? 0.05 : -0.05) * (i - 9) } : {})));
    expect(cleanActivity(raw, on()).report.dropped.speed).toBe(12);
  });

  it('lets a long relocation that agrees with itself stand', () => {
    const raw = makeActivity(track(60, 5, (i) => (i >= 20 ? { lat: LAT0 + 0.5 } : {})));
    const { report, activity } = cleanActivity(raw, on());
    expect(report.dropped.total).toBe(0);
    expect(activity.points).toHaveLength(60);
  });

  it('lets a relocation stand even when one of its fixes is a glitch', () => {
    // The third fix after the jump is 200 m off: it alone goes, and the run around it stands whole.
    const raw = makeActivity(track(60, 5, (i) => (i >= 20 ? { lat: LAT0 + 0.5 + (i === 22 ? 200 / M_PER_DEG : 0) } : {})));
    const { report, activity } = cleanActivity(raw, on());
    expect(report.dropped.speed).toBe(1);
    expect(activity.points).toHaveLength(59);
    expect(activity.points.some((point) => point.lat! > LAT0 + 0.5 + 100 / M_PER_DEG)).toBe(false);
  });

  it('keeps the run when two glitches in a row interrupt it', () => {
    const off = (i: number) => (i === 22 ? 200 : i === 23 ? -400 : 0) / M_PER_DEG;
    const raw = makeActivity(track(60, 5, (i) => (i >= 20 ? { lat: LAT0 + 0.5 + off(i) } : {})));
    const { report } = cleanActivity(raw, on());
    expect(report.dropped.speed).toBe(2);
  });

  it('keeps events, laps, segments and camera streams consistent with the points that stay', () => {
    const raw = makeActivity(track(20, 5, (i) => ({ ...(i === 5 ? { lat: LAT0 + 0.009 } : {}), segmentIndex: i < 12 ? 0 : 1 })));
    raw.events = [
      { type: 'marker', pointIndex: 3 },
      { type: 'marker', pointIndex: 5 },
      { type: 'marker', pointIndex: 15 },
      { type: 'lap', time: at(8) },
    ];
    raw.laps = [{ index: 0, startTime: at(0), durationSeconds: 10 }];
    raw.sensorStreams = [{ key: 'ACCL', label: 'Acceleration', display: 'chart', valuesByPoint: raw.points.map((_, i) => i) }];
    const { activity } = cleanActivity(raw, on());
    expect(activity.points).toHaveLength(19);
    // Point 5 is gone: an event on it moves to the next point kept, which is now at 5.
    expect(activity.events!.map((e) => e.pointIndex)).toEqual([3, 5, 14, undefined]);
    expect(activity.laps).toEqual(raw.laps);
    expect(activity.points.map((p) => p.segmentIndex)).toEqual([...Array(11).fill(0), ...Array(8).fill(1)]);
    // The stream lost the same point: its value at each kept index is the value of the point that stayed.
    expect(activity.sensorStreams![0]!.valuesByPoint).toHaveLength(19);
    expect(activity.sensorStreams![0]!.valuesByPoint![5]).toBe(6);
  });
});

describe('off, identity and the raw activity (AV-1024)', () => {
  it('returns the very same activity when the clean-up is off, so every figure is what it was', () => {
    const raw = makeActivity(track(20, 5, (i) => (i === 10 ? { lat: LAT0 + 0.009 } : {})));
    expect(cleanActivity(raw, DEFAULT_CLEANUP_SETTINGS).activity).toBe(raw);
    expect(cleanActivity(raw, DEFAULT_CLEANUP_SETTINGS).report).toEqual({ applied: false, dropped: { speed: 0, elevation: 0, total: 0 } });
  });

  it('never changes the raw activity, and turning it off again restores it exactly', () => {
    const raw = makeActivity(track(30, 5, (i) => ({ ...(i === 10 ? { lat: LAT0 + 0.009 } : {}), elevationMeters: 100 + (i % 3) })));
    const before = structuredClone(raw);
    cleanActivity(raw, on({ smoothing: { method: 'kalman', strength: 8 } }));
    expect(raw).toEqual(before);
    expect(cleanActivity(raw, { ...DEFAULT_CLEANUP_SETTINGS, enabled: false }).activity).toBe(raw);
  });

  it('is referentially stable for the same activity and settings, and new when either changes', () => {
    const raw = makeActivity(track(20));
    const a = cleanActivity(raw, on());
    expect(cleanActivity(raw, on())).toBe(a);
    expect(cleanActivity(raw, on({ outliers: false })).activity).not.toBe(a.activity);
    expect(cleanActivity(makeActivity(track(20)), on()).activity).not.toBe(a.activity);
  });

  it('with nothing to drop and no smoothing, leaves the points and the stats as they were, and says it was applied', () => {
    const raw = makeActivity(track(30));
    const { activity } = cleanActivity(raw, on());
    expect(activity.points).toEqual(raw.points);
    expect(activity.derived).toEqual(raw.derived);
    expect(activity.warnings.map((w) => w.code)).toEqual(['cleanup_applied']);
  });

  it('is not cleaned twice: an activity handed over already cleaned keeps its clean-up', () => {
    const raw = makeActivity(track(30, 5, (i) => (i === 10 ? { lat: LAT0 + 0.009 } : {})));
    const cleaned = cleanActivity(raw, on()).activity;
    const again = cleanActivity(cleaned, on({ smoothing: { method: 'kalman', strength: 9 } }));
    expect(again.activity).toBe(cleaned);
    expect(again.report.dropped.total).toBe(1);
  });

  it('works out the stats from the cleaned points, so they agree with the cleaned series', () => {
    const raw = makeActivity(track(30, 5, (i) => (i === 10 ? { lat: LAT0 + 0.009 } : {})));
    const { activity, report } = cleanActivity(raw, on());
    // The raw distance carries the spike's out and back (~2 km); the cleaned one is the 145 m actually covered.
    expect(raw.derived!.distanceMeters!).toBeGreaterThan(1500);
    expect(activity.derived!.distanceMeters!).toBeCloseTo(29 * 5, 0);
    expect(activity.derived!.pointCount).toBe(29);
    expect(activity.derived!.distanceMeters).toBeCloseTo(
      haversineMeters(LAT0, LON0, LAT0, LON0 + (29 * 5) / M_PER_DEG_LON),
      0,
    );
    expect(report.before!.distanceMeters).toBe(raw.derived!.distanceMeters);
    expect(report.after!.distanceMeters).toBe(activity.derived!.distanceMeters);
    // The windowed speed already treats an impossible interval as a gap, so the maximum cannot grow.
    expect(report.after!.maxSpeedMetersPerSecond!).toBeLessThanOrEqual(report.before!.maxSpeedMetersPerSecond!);
    expect(activity.streams).toEqual(expect.objectContaining({ hasLocation: true, hasTime: true }));
  });
});

describe('the pause setting on a cleaned activity (AV-1024)', () => {
  it('changes moving time with the threshold and the minimum stop, and records them on the activity', () => {
    // 5 m/s for 20 s, still for 8 s, 5 m/s for 20 s.
    const pts = [...track(21), ...track(21).map((p, i) => ({ ...p, time: at(28 + i), lon: (p.lon as number) + 100 / M_PER_DEG_LON - 0 }))];
    const lastLon = pts[20]!.lon as number;
    pts.forEach((p, i) => {
      if (i >= 21) p.lon = lastLon + ((i - 21) * 5) / M_PER_DEG_LON;
    });
    const raw = makeActivity(pts);
    const base = cleanActivity(raw, on()).activity;
    expect(base.derived!.movingDurationSeconds).toBe(raw.derived!.movingDurationSeconds);
    const lenient = cleanActivity(raw, on({ pause: { speedThresholdMps: 0.5, minStopSeconds: 30 } })).activity;
    expect(lenient.cleanup!.pause).toEqual({ speedThresholdMps: 0.5, minStopSeconds: 30 });
    // The 8 s stop is under 30 s: it counts as moving, so the moving time is the whole elapsed time.
    expect(lenient.derived!.movingDurationSeconds).toBe(lenient.derived!.durationSeconds);
    expect(base.derived!.movingDurationSeconds).toBeLessThan(base.derived!.durationSeconds!);
  });
});

describe('the smoothing methods (AV-1024)', () => {
  it.each(['movingAverage', 'kalman'] as const)('%s leaves a straight constant-speed track with its endpoints and distance', (method) => {
    const raw = makeActivity(track(300, 10));
    const { activity } = cleanActivity(raw, on({ smoothing: { method, strength: 30 } }));
    expect(activity.points[0]!.lon).toBeCloseTo(raw.points[0]!.lon!, 7);
    expect(activity.points[299]!.lon!).toBeCloseTo(raw.points[299]!.lon!, method === 'kalman' ? 4 : 7);
    expect(activity.derived!.distanceMeters!).toBeCloseTo(raw.derived!.distanceMeters!, -1);
  });

  it('moving average leaves a 10 Hz constant-speed track exactly as it was', () => {
    const raw = makeActivity(
      Array.from({ length: 400 }, (_, i) => ({ time: new Date(T0 + i * 100), lat: LAT0, lon: LON0 + (i * 1) / M_PER_DEG_LON })),
    );
    const { activity } = cleanActivity(raw, on({ smoothing: { method: 'movingAverage', strength: 5 } }));
    activity.points.forEach((p, i) => expect(p.lon).toBeCloseTo(raw.points[i]!.lon!, 8));
  });

  it('keeps metadata start and end with the points that stand', () => {
    const raw = makeActivity(track(10, 5, (i) => (i === 9 ? { lat: LAT0 + 0.009 } : {})));
    raw.metadata.endTime = raw.derived!.endTime;
    const { activity } = cleanActivity(raw, on());
    expect(activity.metadata.endTime).toEqual(activity.derived!.endTime);
    expect(activity.metadata.endTime!.getTime()).toBe(at(8).getTime());
  });

  /** A 5 m/s eastbound track with ±jitter metres of position noise, and the true easting of each point. */
  function noisy(count: number, jitter: number) {
    const rand = noise(42);
    const truth = (i: number) => (i * 5) / M_PER_DEG_LON;
    const raw = makeActivity(
      Array.from({ length: count }, (_, i) => ({
        time: at(i),
        lat: LAT0 + (jitter * rand()) / M_PER_DEG,
        lon: LON0 + truth(i) + (jitter * rand()) / M_PER_DEG_LON,
      })),
    );
    const error = (activity: Activity) => {
      let sum = 0;
      activity.points.forEach((p, i) => {
        const dx = ((p.lon as number) - (LON0 + truth(i))) * M_PER_DEG_LON;
        const dy = ((p.lat as number) - LAT0) * M_PER_DEG;
        sum += dx * dx + dy * dy;
      });
      return Math.sqrt(sum / activity.points.length);
    };
    return { raw, error };
  }

  it.each(['movingAverage', 'kalman'] as const)('%s reduces the position error against noise', (method) => {
    const { raw, error } = noisy(200, 6);
    const { activity } = cleanActivity(raw, on({ smoothing: { method, strength: 8 } }));
    expect(activity.points).toHaveLength(200);
    expect(error(activity)).toBeLessThan(error(raw) * 0.7);
  });

  it.each(['movingAverage', 'kalman'] as const)('%s smooths the speed the charts and the overlay read', (method) => {
    const { raw } = noisy(200, 6);
    const spread = (a: Activity) => {
      const speeds = deriveSpeed(a).filter((v): v is number => v !== undefined);
      const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
      return Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length);
    };
    const { activity, report } = cleanActivity(raw, on({ smoothing: { method, strength: 8 } }));
    expect(spread(activity)).toBeLessThan(spread(raw) * 0.5);
    expect(activity.streams.hasSpeed).toBe(true);
    // The mean stays near the true 5 m/s: smoothing is not a bias.
    expect(activity.points[100]!.speedMetersPerSecond!).toBeGreaterThan(3.5);
    expect(activity.points[100]!.speedMetersPerSecond!).toBeLessThan(6.5);
    expect(report.after!.maxSpeedMetersPerSecond!).toBeLessThan(report.before!.maxSpeedMetersPerSecond!);
    expect(activity.warnings.find((w) => w.code === 'cleanup_applied')?.message).toContain(
      method === 'kalman' ? 'Kalman, strength 8' : 'moving average over 8 s',
    );
  });

  it.each(['movingAverage', 'kalman'] as const)('%s follows a step in speed within a bounded lag', (method) => {
    const strength = 6;
    const raw = makeActivity(track(120, 0, (i) => ({ speedMetersPerSecond: i < 60 ? 2 : 12 })));
    const { activity } = cleanActivity(raw, on({ smoothing: { method, strength } }));
    const speed = (i: number) => activity.points[i]!.speedMetersPerSecond!;
    // Before the step it is still low; a few time constants after it, it has arrived.
    expect(speed(40)).toBeCloseTo(2, 0);
    expect(speed(60 + strength * 3)).toBeGreaterThan(2 + 0.9 * 10);
    expect(speed(60 + strength * 3)).toBeLessThanOrEqual(12.0001);
  });

  it('smooths the grade it derives, and leaves the heading to the smoothed route', () => {
    const rand = noise(7);
    const raw = makeActivity(track(200, 5, (i) => ({ elevationMeters: i * 0.25 + 1.5 * rand() })));
    const { activity } = cleanActivity(raw, on({ smoothing: { method: 'movingAverage', strength: 10 } }));
    const grades = activity.points.map((p) => p.gradePercent).filter((g): g is number => g !== undefined);
    expect(grades.length).toBeGreaterThan(100);
    // 0.25 m up per 5 m along is 5 %; the noise alone moves the raw derivation by ~±3 points.
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    const rawGrades = raw.points.map((_, i) => i).slice(60).map((i) => {
      const back = raw.points[i - 10]!;
      return ((raw.points[i]!.elevationMeters! - back.elevationMeters!) / 50) * 100;
    });
    expect(spread(grades.slice(30))).toBeLessThan(spread(rawGrades));
    // Elevation itself is the file's reading, left as it was.
    expect(activity.points.map((p) => p.elevationMeters)).toEqual(raw.points.map((p) => p.elevationMeters));
  });

  it('smooths nothing at strength 0, nothing across a recording gap, and is deterministic', () => {
    const { raw } = noisy(60, 6);
    expect(cleanActivity(raw, on({ smoothing: { method: 'kalman', strength: 0 } })).activity.points.map((p) => [p.lat, p.lon])).toEqual(
      raw.points.map((p) => [p.lat, p.lon]),
    );
    const a = cleanActivity(raw, on({ smoothing: { method: 'kalman', strength: 5 } })).activity.points.map((p) => [p.lat, p.lon]);
    const b = cleanActivity(structuredClone(raw), on({ smoothing: { method: 'kalman', strength: 5 } })).activity.points.map((p) => [p.lat, p.lon]);
    expect(a).toEqual(b);

    // Two segments far apart: the first point of the second is not pulled towards the first.
    const gap = makeActivity(
      Array.from({ length: 20 }, (_, i) => ({ time: at(i), lat: LAT0 + (i < 10 ? 0 : 0.01), lon: LON0, segmentIndex: i < 10 ? 0 : 1 })),
    );
    const out = cleanActivity(gap, on({ outliers: false, smoothing: { method: 'movingAverage', strength: 30 } })).activity;
    expect(out.points[10]!.lat).toBeCloseTo(LAT0 + 0.01, 6);
    expect(out.points[9]!.lat).toBeCloseTo(LAT0, 6);
  });
});

describe('smoothing and an auto-pause inside one segment (TD-093)', () => {
  // A straight 6 m/s ride at 1 Hz that stops for a minute: the clock jumps 60 s with the position held.
  const PAUSE_AT = 60;
  const PAUSE_SECONDS = 60;
  const paused = () =>
    makeActivity(
      Array.from({ length: 120 }, (_, i) => {
        const moved = i < PAUSE_AT ? i : PAUSE_AT - 1 + (i - PAUSE_AT);
        return { time: at(i < PAUSE_AT ? i : i + PAUSE_SECONDS - 1), lat: LAT0, lon: LON0 + (moved * 6) / M_PER_DEG_LON };
      }),
    );
  const GAP_MID = PAUSE_AT - 1 + PAUSE_SECONDS / 2;
  const settings = [
    ['movingAverage 5 s', { method: 'movingAverage', strength: 5 }],
    ['movingAverage 30 s', { method: 'movingAverage', strength: 30 }],
    ['kalman', { method: 'kalman', strength: 5 }],
  ] as const;

  it.each(settings)('%s keeps the moving time and invents no distance across the pause', (_name, smoothing) => {
    const raw = paused();
    const { activity } = cleanActivity(raw, on({ outliers: false, smoothing }));
    expect(activity.derived!.movingDurationSeconds!).toBeCloseTo(raw.derived!.movingDurationSeconds!, 0);
    expect(activity.derived!.distanceMeters!).toBeCloseTo(raw.derived!.distanceMeters!, -1);
    // The two points either side of the pause stay where they were, a minute apart in time.
    const before = activity.points[PAUSE_AT - 1]!;
    const after = activity.points[PAUSE_AT]!;
    expect(haversineMeters(before.lat!, before.lon!, after.lat!, after.lon!)).toBeLessThan(0.5);
  });

  it.each([['none', { method: 'none', strength: 0 }], ...settings] as const)('%s leaves the pause a stop on the overlay timeline', (_name, smoothing) => {
    const { activity } = cleanActivity(paused(), on({ outliers: false, smoothing }));
    const timeline = buildOverlayTimeline(activity);
    const held = timeline.sampleAt(GAP_MID)!;
    expect(held.values['metric:speed']).toBe(0);
    const stillAt = timeline.sampleAt(PAUSE_AT - 1)!.position!;
    expect(held.position!.lat).toBeCloseTo(stillAt.lat, 8);
    expect(held.position!.lon).toBeCloseTo(stillAt.lon, 8);
    // Riding on either side is still riding.
    expect(timeline.sampleAt(30)!.values['metric:speed']).toBeGreaterThan(5);
    expect(timeline.sampleAt(GAP_MID + PAUSE_SECONDS)!.values['metric:speed']).toBeGreaterThan(5);
  });

  it('splits at a pause by the file’s distance, and whatever the minimum stop', () => {
    const withDistance = makeActivity(
      Array.from({ length: 120 }, (_, i) => {
        const moved = i < PAUSE_AT ? i : PAUSE_AT - 1 + (i - PAUSE_AT);
        // The GPS drifts 60 m across the pause while the file's distance stands still.
        const drift = i >= PAUSE_AT ? 60 : 0;
        return {
          time: at(i < PAUSE_AT ? i : i + PAUSE_SECONDS - 1),
          lat: LAT0,
          lon: LON0 + (moved * 6 + drift) / M_PER_DEG_LON,
          distanceMeters: moved * 6,
        };
      }),
    );
    const smoothing = { method: 'movingAverage', strength: 30 } as const;
    const a = cleanActivity(withDistance, on({ outliers: false, smoothing })).activity;
    expect(a.points[PAUSE_AT]!.lon).toBeCloseTo(withDistance.points[PAUSE_AT]!.lon!, 7);
    // A minimum stop longer than the gap does not make smoothing reach across it.
    const long = cleanActivity(paused(), on({ outliers: false, smoothing, pause: { speedThresholdMps: 0.5, minStopSeconds: 120 } })).activity;
    const before = long.points[PAUSE_AT - 1]!;
    const after = long.points[PAUSE_AT]!;
    expect(haversineMeters(before.lat!, before.lon!, after.lat!, after.lon!)).toBeLessThan(0.5);
  });
});

describe('exports say whether they hold cleaned data (AV-1024)', () => {
  const raw = makeActivity(track(30, 5, (i) => (i === 10 ? { lat: LAT0 + 0.009 } : {})));

  it('adds the clean-up’s notes to the warnings when the clean-up is on', async () => {
    const { activity } = cleanActivity(raw, on());
    const result = await exportActivity(activity, { format: 'gpx' });
    expect(result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['cleanup_points_dropped', 'cleanup_applied']));
    const text = await result.blob.text();
    expect(text.match(/<trkpt/g)).toHaveLength(29);
  });

  it('adds nothing when it is off', async () => {
    const result = await exportActivity(cleanActivity(raw, DEFAULT_CLEANUP_SETTINGS).activity, { format: 'gpx' });
    expect(result.warnings.map((w) => w.code).filter((code) => code.startsWith('cleanup_'))).toEqual([]);
  });
});

describe('the clean-up settings (AV-1024)', () => {
  beforeEach(() => {
    useCleanupStore.getState().reset();
    localStorage.clear();
  });

  it('start off, with today’s pause thresholds', () => {
    expect(useCleanupStore.getState().settings).toEqual({
      enabled: false,
      outliers: true,
      pause: { speedThresholdMps: 0.5, minStopSeconds: 0 },
      smoothing: { method: 'none', strength: 5 },
    });
  });

  it('merge a patch, and are kept in memory only', () => {
    const setItem = localStorage.setItem.bind(localStorage);
    const written: string[] = [];
    localStorage.setItem = (key: string, value: string) => {
      written.push(key);
      setItem(key, value);
    };
    try {
      useCleanupStore.getState().update({ enabled: true, pause: { minStopSeconds: 20 }, smoothing: { method: 'kalman' } });
      expect(useCleanupStore.getState().settings).toMatchObject({
        enabled: true,
        pause: { speedThresholdMps: 0.5, minStopSeconds: 20 },
        smoothing: { method: 'kalman', strength: 5 },
      });
      expect(written).toEqual([]);
      expect(sessionStorage.length).toBe(0);
    } finally {
      localStorage.setItem = setItem;
    }
  });

  it('reset the selected range and lap, which are indexes into points that may have moved', () => {
    useInteractionStore.getState().setSelectedRange({ startIndex: 2, endIndex: 9 });
    useInteractionStore.getState().setSelectedLapIndex(1);
    useCleanupStore.getState().update({ enabled: true });
    expect(useInteractionStore.getState().selectedRange).toBeUndefined();
    expect(useInteractionStore.getState().selectedLapIndex).toBeUndefined();
  });
});
