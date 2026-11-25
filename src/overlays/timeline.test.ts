import { describe, expect, it } from 'vitest';
import { computeStreams, type Activity, type ActivityPoint } from '../domain/activity';
import {
  MAX_INTERPOLATION_GAP_SECONDS,
  buildTimeline,
  metricValue,
  sampleTimeline,
  timelineDurationSeconds,
  type OverlayTimeline,
} from './timeline';

const T0 = Date.UTC(2024, 0, 1, 10, 0, 0);
const at = (seconds: number, extra: Partial<ActivityPoint> = {}, index = 0): ActivityPoint => ({
  index,
  time: new Date(T0 + seconds * 1000),
  lat: 42 + seconds * 1e-5,
  lon: -8,
  distanceMeters: seconds * 4,
  heartRateBpm: 100 + seconds,
  ...extra,
});

const activityOf = (points: ActivityPoint[], extra: Partial<Activity> = {}): Activity => ({
  id: 'a',
  source: { format: 'gpx', parserVersion: 't' },
  metadata: {},
  points: points.map((p, i) => ({ ...p, index: i })),
  streams: computeStreams(points),
  warnings: [],
  ...extra,
});

const steady = () => activityOf([0, 1, 2, 3, 4, 5].map((s) => at(s)));

const build = (activity: Activity): OverlayTimeline => {
  const result = buildTimeline(activity);
  if (!result.ok) throw new Error(result.reason);
  return result.timeline;
};

describe('overlay timeline (AV-1003)', () => {
  describe('building', () => {
    it('measures the telemetry and knows which channels have readings', () => {
      const timeline = build(steady());
      expect(timelineDurationSeconds(timeline)).toBe(5);
      expect(timeline.available.has('heartRate')).toBe(true);
      expect(timeline.available.has('distance')).toBe(true);
      expect(timeline.available.has('power')).toBe(false);
      expect(timeline.available.has('cadence')).toBe(false);
    });

    it('refuses an activity with no clock, saying why', () => {
      const result = buildTimeline(activityOf([{ index: 0, lat: 1, lon: 1 }, { index: 1, lat: 2, lon: 2 }]));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/no timestamps/);
      expect(buildTimeline(activityOf([at(0)])).ok).toBe(false);
    });

    it('copes with points out of order', () => {
      const timeline = build(activityOf([at(2), at(0), at(1)]));
      expect(timeline.times).toEqual([T0, T0 + 1000, T0 + 2000]);
    });

    it('ignores points whose time is not a real date', () => {
      const bad = { ...at(1), time: new Date('nope') };
      const timeline = build(activityOf([at(0), bad, at(2)]));
      expect(timeline.times).toHaveLength(2);
    });
  });

  describe('sampling', () => {
    it('reads a point exactly, and blends between two', () => {
      const timeline = build(steady());
      const exact = sampleTimeline(timeline, 2);
      expect(exact.status).toBe('ok');
      expect(exact.values.heartRate).toBe(102);

      const between = sampleTimeline(timeline, 2.5);
      expect(between.values.heartRate).toBeCloseTo(102.5, 6);
      expect(between.values.distance).toBeCloseTo(10, 6);
      expect(between.values.lat).toBeCloseTo(42 + 2.5e-5, 9);
      expect(between.elapsedSeconds).toBeCloseTo(2.5, 6);
      expect(between.progress).toBeCloseTo(0.5, 6);
    });

    it('reports the nearest point for markers', () => {
      const timeline = build(steady());
      expect(sampleTimeline(timeline, 2.4).pointIndex).toBe(2);
      expect(sampleTimeline(timeline, 2.6).pointIndex).toBe(3);
    });

    it('reads the last point, and says before and after rather than extrapolating', () => {
      const timeline = build(steady());
      expect(sampleTimeline(timeline, 5).status).toBe('ok');
      expect(sampleTimeline(timeline, 5).values.heartRate).toBe(105);
      const after = sampleTimeline(timeline, 5.001);
      expect(after.status).toBe('after');
      expect(after.values).toEqual({});
      const before = sampleTimeline(timeline, -0.001);
      expect(before.status).toBe('before');
      expect(before.values).toEqual({});
      expect(before.elapsedSeconds).toBeUndefined();
    });

    it('treats a non-finite time as before, not as a crash', () => {
      const timeline = build(steady());
      expect(sampleTimeline(timeline, NaN).status).toBe('before');
      expect(sampleTimeline(timeline, 1, Infinity).status).toBe('before');
    });
  });

  describe('offset', () => {
    it('shifts the activity against the video', () => {
      const timeline = build(steady());
      // Video second 1 with +3 shows the activity's fourth second.
      expect(sampleTimeline(timeline, 1, 3).values.heartRate).toBe(104);
      // A negative offset holds the start off until the video catches up.
      expect(sampleTimeline(timeline, 1, -2).status).toBe('before');
      expect(sampleTimeline(timeline, 2, -2).values.heartRate).toBe(100);
    });

    it('can push the whole video past the end of the telemetry', () => {
      expect(sampleTimeline(build(steady()), 1, 10).status).toBe('after');
    });
  });

  describe('missing data', () => {
    it('leaves out a channel that has no reading, rather than reporting zero', () => {
      const sample = sampleTimeline(build(steady()), 2.5);
      expect('power' in sample.values).toBe(false);
      expect(metricValue(sample, 'power')).toBeUndefined();
    });

    it('does not blend across a point that lacks a reading', () => {
      const timeline = build(
        activityOf([at(0), at(1, { heartRateBpm: undefined }), at(2)]),
      );
      expect(sampleTimeline(timeline, 0.5).values.heartRate).toBeUndefined();
      expect(sampleTimeline(timeline, 0).values.heartRate).toBe(100);
      // Position is still there.
      expect(sampleTimeline(timeline, 0.5).values.lat).toBeDefined();
    });

    it('goes blank across a gap in the recording instead of drawing a line through it', () => {
      const gap = MAX_INTERPOLATION_GAP_SECONDS + 5;
      const timeline = build(activityOf([at(0), at(1), at(1 + gap), at(2 + gap)]));
      const sample = sampleTimeline(timeline, 1 + gap / 2);
      expect(sample.status).toBe('gap');
      expect(sample.values).toEqual({});
      // Either side of it is fine.
      expect(sampleTimeline(timeline, 0.5).status).toBe('ok');
      expect(sampleTimeline(timeline, 1 + gap + 0.5).status).toBe('ok');
    });

    it('goes blank across a pause between recorded segments, however short', () => {
      const timeline = build(
        activityOf([at(0, { segmentIndex: 0 }), at(1, { segmentIndex: 0 }), at(2, { segmentIndex: 1 }), at(3, { segmentIndex: 1 })]),
      );
      expect(sampleTimeline(timeline, 1.5).status).toBe('gap');
      expect(sampleTimeline(timeline, 0.5).status).toBe('ok');
    });
  });

  describe('derived and auxiliary data', () => {
    it('derives distance from positions when points carry none, as the viewer does', () => {
      // Parsers leave `distanceMeters` unset; the figure must still be there.
      const bare = activityOf(
        Array.from({ length: 10 }, (_, s) => at(s, { lat: 42 + s * 3.6e-5, distanceMeters: undefined })),
      );
      const timeline = build(bare);
      expect(timeline.available.has('distance')).toBe(true);
      const sample = sampleTimeline(timeline, 5);
      // 5 s at about 4 m/s.
      expect(sample.values.distance).toBeGreaterThan(15);
      expect(sample.values.distance).toBeLessThan(25);
      expect(sampleTimeline(timeline, 0).values.distance).toBe(0);
    });

    it('derives speed and pace from position when the file has none', () => {
      // About 4 m/s: 0.00001° of latitude is ~1.11 m per second here, so move faster.
      const fast = activityOf(
        Array.from({ length: 40 }, (_, s) => at(s, { lat: 42 + s * 3.6e-5, distanceMeters: undefined })),
      );
      const sample = sampleTimeline(build(fast), 30);
      expect(sample.values.speed).toBeGreaterThan(3);
      expect(sample.values.speed).toBeLessThan(5);
      expect(sample.values.pace).toBeGreaterThan(200);
    });

    it('samples a charted sensor stream, and ignores a hidden one', () => {
      const activity = steady();
      activity.sensorStreams = [
        { key: 'ACCL', label: 'Shake', display: 'chart', valuesByPoint: [0, 10, 20, 30, 40, 50] },
        { key: 'GRAV', label: 'Gravity', display: 'hidden' },
      ];
      const timeline = build(activity);
      expect(sampleTimeline(timeline, 1.5).sensors).toEqual({ ACCL: 15 });
      expect(timeline.availableSensors.has('GRAV')).toBe(false);
    });
  });

  describe('metrics', () => {
    it('reads elapsed time as a metric of its own', () => {
      const sample = sampleTimeline(build(steady()), 3);
      expect(metricValue(sample, 'elapsed')).toBe(3);
      expect(metricValue(sample, 'heartRate')).toBe(103);
    });
  });

  describe('long timelines', () => {
    it('samples a six-hour activity quickly', () => {
      const points = Array.from({ length: 21_600 }, (_, s) => at(s));
      const timeline = build(activityOf(points));
      const started = performance.now();
      for (let video = 0; video < 20_000; video += 1) sampleTimeline(timeline, video * 1.07);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });
});
