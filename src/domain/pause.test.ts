import { describe, expect, it } from 'vitest';
import { DEFAULT_PAUSE_SETTINGS, isStopped, movingSteps } from './pause';
import { computeDistance, computeStats } from './stats';
import { parseActivityFile } from '../parsers';
import { fixtureFile } from '../test/helpers/fixtures';
import { buildOverlayTimeline } from '../overlay/timeline';
import { makeActivity } from '../test/helpers/activity';

/** The rule the stats counted moving time by before the pause setting existed (TD-058), kept here as the reference. */
function legacyMovingSeconds(points: ReturnType<typeof makeActivity>['points']): number | undefined {
  const cumulative = computeDistance(points).cumulativeMeters;
  let moving = 0;
  let previous: number | undefined;
  let counted = false;
  for (let i = 0; i < points.length; i += 1) {
    const time = points[i]!.time;
    const distance = cumulative[i];
    if (!(time instanceof Date) || Number.isNaN(time.getTime()) || distance === undefined) continue;
    if (previous !== undefined && (points[previous]!.segmentIndex ?? 0) === (points[i]!.segmentIndex ?? 0)) {
      const seconds = (time.getTime() - (points[previous]!.time as Date).getTime()) / 1000;
      const meters = distance - (cumulative[previous] as number);
      if (seconds > 0 && meters / seconds >= 0.5) {
        moving += seconds;
        counted = true;
      }
    }
    previous = i;
  }
  return counted ? moving : undefined;
}

describe('the shared pause setting (AV-1024, TD-093)', () => {
  it('has the defaults each reader used before: 0.5 m/s and a stop of any length', () => {
    expect(DEFAULT_PAUSE_SETTINGS).toEqual({ speedThresholdMps: 0.5, minStopSeconds: 0 });
  });

  it('reproduces today’s moving time exactly on the existing fixtures', async () => {
    for (const name of ['paused-run.gpx', 'flat-route.gpx', 'overlay-ride.gpx', 'multi-track.gpx']) {
      const { activity } = await parseActivityFile(fixtureFile(name));
      expect(computeStats(activity.points).stats.movingDurationSeconds, name).toBe(legacyMovingSeconds(activity.points));
      expect(computeStats(activity.points, DEFAULT_PAUSE_SETTINGS).stats.movingDurationSeconds, name).toBe(
        legacyMovingSeconds(activity.points),
      );
    }
  });

  it('counts a stop shorter than the minimum as moving, and a longer one as a stop', () => {
    const steps = [
      { seconds: 10, meters: 50, breakBefore: true },
      { seconds: 3, meters: 0 },
      { seconds: 3, meters: 0 },
      { seconds: 10, meters: 50 },
      { seconds: 20, meters: 0 },
      { seconds: 10, meters: 50 },
    ];
    expect(movingSteps(steps, DEFAULT_PAUSE_SETTINGS)).toEqual([true, false, false, true, false, true]);
    // The 6 s stop is under 10 s and is moving; the 20 s stop stays a stop.
    expect(movingSteps(steps, { speedThresholdMps: 0.5, minStopSeconds: 10 })).toEqual([true, true, true, true, false, true]);
  });

  it('judges a single gap by the same two numbers', () => {
    expect(isStopped(0, 30, DEFAULT_PAUSE_SETTINGS)).toBe(true);
    expect(isStopped(30, 30, DEFAULT_PAUSE_SETTINGS)).toBe(false);
    expect(isStopped(0, 30, { speedThresholdMps: 0.5, minStopSeconds: 60 })).toBe(false);
    expect(isStopped(10, 30, { speedThresholdMps: 0.2, minStopSeconds: 0 })).toBe(false);
  });

  it('treats a recording hole beside a sampled stop as part of that stop, as moving time does', () => {
    const t0 = new Date('2024-01-01T10:00:00Z').getTime();
    const at = (s: number) => new Date(t0 + s * 1000);
    const riding = (from: number, n: number, d0: number) => Array.from({ length: n }, (_, i) => ({ time: at(from + i), distanceMeters: d0 + i * 10, lat: 45, lon: 7 + (d0 + i * 10) / 1e5 }));
    const still = Array.from({ length: 60 }, (_, i) => ({ time: at(30 + i), distanceMeters: 290, lat: 45, lon: 7.0029 }));
    // 30 s riding, 60 s standing sampled, a 20 s hole while still standing, then riding again.
    const points = [...riding(0, 30, 0), ...still, ...riding(110, 30, 290)];
    const pause = { speedThresholdMps: 0.5, minStopSeconds: 30 };
    const activity = { ...makeActivity(points), cleanup: { pause, smoothing: { method: 'none' as const, strength: 0 }, dropped: { speed: 0, elevation: 0, total: 0 } } };
    const stats = computeStats(activity.points, pause).stats;
    // One 80 s stop: not moving.
    expect(stats.movingDurationSeconds).toBeLessThan(60);
    // So the timeline reads the hole as standing still too: speed 0, distance held, position known.
    const sample = buildOverlayTimeline(activity).sampleAt(100)!;
    expect(sample.values['metric:speed']).toBe(0);
    expect(sample.values['metric:distance']).toBeCloseTo(290);
    expect(sample.position).toBeDefined();
  });

  it('is what moving time, the overlay’s stops, its moving-so-far and its gaps all read', () => {
    const t0 = new Date('2024-01-01T10:00:00Z').getTime();
    const at = (s: number) => new Date(t0 + s * 1000);
    // 10 m/s for 10 s, a 30 s gap standing still, then on again.
    const points = [
      ...Array.from({ length: 11 }, (_, i) => ({ time: at(i), distanceMeters: i * 10, lat: 45, lon: 7 + i * 0.0001 })),
      ...Array.from({ length: 11 }, (_, i) => ({ time: at(40 + i), distanceMeters: 100 + i * 10, lat: 45, lon: 7.0011 + i * 0.0001 })),
    ];
    const base = makeActivity(points);
    const defaultTimeline = buildOverlayTimeline(base);
    // Inside the gap the activity stands still: speed reads 0 and the moving time holds.
    expect(defaultTimeline.sampleAt(20)!.values['metric:speed']).toBe(0);
    expect(defaultTimeline.sampleAt(20)!.values['metric:moving']).toBeCloseTo(10);
    expect(base.derived?.movingDurationSeconds).toBe(20);

    // With a minimum stop of 60 s that same gap is not a stop: the three readers agree again.
    const pause = { speedThresholdMps: 0.5, minStopSeconds: 60 };
    const cleaned = { ...base, cleanup: { pause, smoothing: { method: 'none' as const, strength: 0 }, dropped: { speed: 0, elevation: 0, total: 0 } } };
    const stats = computeStats(cleaned.points, pause).stats;
    expect(stats.movingDurationSeconds).toBe(50);
    const timeline = buildOverlayTimeline(cleaned);
    expect(timeline.pause).toEqual(pause);
    expect(timeline.sampleAt(20)!.values['metric:speed']).toBeUndefined();
    expect(timeline.sampleAt(40)!.values['metric:moving']).toBeCloseTo(stats.movingDurationSeconds! - 10);
  });
});
