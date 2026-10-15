import { describe, expect, it } from 'vitest';
import { buildOverlayTimeline, paceFromSpeed } from './timeline';
import { makeActivity } from '../test/helpers/activity';
import type { ActivitySensorStream } from '../domain/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const ride = () =>
  makeActivity([
    { time: at(0), lat: 10, lon: 20, distanceMeters: 0, speedMetersPerSecond: 2, heartRateBpm: 100 },
    { time: at(4), lat: 10.4, lon: 20.4, distanceMeters: 40, speedMetersPerSecond: 6, heartRateBpm: 140 },
    { time: at(8), lat: 10.8, lon: 20.8, distanceMeters: 100, speedMetersPerSecond: 4, heartRateBpm: 120 },
  ]);

describe('buildOverlayTimeline (AV-1003)', () => {
  it('interpolates values linearly between bracketing points', () => {
    const sample = buildOverlayTimeline(ride()).sampleAt(2)!;
    expect(sample.values['metric:heartRate']).toBeCloseTo(120);
    expect(sample.values['metric:speed']).toBeCloseTo(4);
    expect(sample.values['metric:distance']).toBeCloseTo(20);
    expect(sample.position).toEqual({ lat: 10.2, lon: 20.2 });
    expect(sample.progress).toBeCloseTo(0.2);
  });

  it('measures progress from the first recorded distance', () => {
    const activity = makeActivity([
      { time: at(0), distanceMeters: 1000 },
      { time: at(4), distanceMeters: 2000 },
    ]);
    const timeline = buildOverlayTimeline(activity);
    expect(timeline.sampleAt(0)!.progress).toBe(0);
    expect(timeline.sampleAt(2)!.progress).toBeCloseTo(0.5);
    expect(timeline.sampleAt(4)!.progress).toBe(1);
  });

  it('measures progress between the first and last readings, clamped, on a long recording', () => {
    const count = 200_000;
    const long = makeActivity(
      Array.from({ length: count }, (_, i) => ({ time: at(i), distanceMeters: 1000 + i })),
    );
    const timeline = buildOverlayTimeline(long);
    expect(timeline.sampleAt(0)!.progress).toBe(0);
    expect(timeline.sampleAt((count - 1) / 2)!.progress).toBeCloseTo(0.5);

    // A decreasing odometer is corrupt, as the viewer's charts decide too: it
    // is ignored, and with no positions either, progress runs by time.
    const dip = makeActivity([
      { time: at(0), distanceMeters: 1000 },
      { time: at(1), distanceMeters: 900 },
      { time: at(2), distanceMeters: 2000 },
    ]);
    expect(buildOverlayTimeline(dip).available.has('metric:distance')).toBe(false);
    expect(buildOverlayTimeline(dip).sampleAt(1)!.progress).toBeCloseTo(0.5);
  });

  it('keeps one progress basis: absent where distance is missing, never a time fallback', () => {
    const activity = makeActivity([
      { time: at(0) },
      { time: at(1), distanceMeters: 1000 },
      { time: at(2), distanceMeters: 2000 },
    ]);
    const timeline = buildOverlayTimeline(activity);
    expect(timeline.sampleAt(0.5)!.progress).toBeUndefined();
    expect(timeline.sampleAt(1)!.progress).toBe(0);
    expect(timeline.sampleAt(1.5)!.progress).toBeCloseTo(0.5);

    const dropout = makeActivity([
      { time: at(0), distanceMeters: 0 },
      { time: at(1) },
      { time: at(2), distanceMeters: 100 },
    ]);
    expect(buildOverlayTimeline(dropout).sampleAt(1)!.progress).toBeUndefined();
  });

  it('derives distance, speed and pace from positions when the file states none', () => {
    // A GPX typically carries only positions and times. About 11 m a second north.
    const activity = makeActivity(
      Array.from({ length: 31 }, (_, i) => ({ time: at(i), lat: 51.5 + i * 0.0001, lon: 0 })),
    );
    const timeline = buildOverlayTimeline(activity);
    for (const key of ['metric:distance', 'metric:speed', 'metric:pace']) {
      expect(timeline.available.has(key), key).toBe(true);
    }
    const sample = timeline.sampleAt(20)!;
    expect(sample.values['metric:distance']).toBeCloseTo(222.4, 0);
    expect(sample.values['metric:speed']).toBeCloseTo(11.12, 1);
    expect(sample.values['metric:pace']).toBeCloseTo(1000 / 11.12, 0);
    expect(sample.progress).toBeCloseTo(20 / 30, 2);
  });

  it('counts distance from the first reading of a recorded odometer', () => {
    const activity = makeActivity([
      { time: at(0), distanceMeters: 5000 },
      { time: at(10), distanceMeters: 5100 },
    ]);
    expect(buildOverlayTimeline(activity).sampleAt(5)!.values['metric:distance']).toBeCloseTo(50);
  });

  it('falls back to time for progress when there is no distance', () => {
    const activity = makeActivity([{ time: at(0) }, { time: at(4) }]);
    expect(buildOverlayTimeline(activity).sampleAt(1)!.progress).toBeCloseTo(0.25);
  });

  it('returns exact point values on a point and derives pace from speed', () => {
    const sample = buildOverlayTimeline(ride()).sampleAt(4)!;
    expect(sample.values['metric:heartRate']).toBe(140);
    expect(sample.values['metric:pace']).toBeCloseTo(1000 / 6);
    expect(paceFromSpeed(0)).toBeUndefined();
  });

  it('has nothing to show outside the recording', () => {
    const timeline = buildOverlayTimeline(ride());
    expect(timeline.sampleAt(-1)).toBeUndefined();
    expect(timeline.sampleAt(9)).toBeUndefined();
    expect(timeline.sampleAt(Number.NaN)).toBeUndefined();
  });

  it('interpolates longitude across the antimeridian by the short arc', () => {
    const activity = makeActivity([
      { time: at(0), lat: 0.5, lon: 179 },
      { time: at(2), lat: 0.5, lon: -179 },
    ]);
    expect(buildOverlayTimeline(activity).sampleAt(1)!.position!.lon).toBeCloseTo(180, 5);
  });

  describe('missing telemetry', () => {
    it('omits a value when either bracketing point lacks it', () => {
      const activity = makeActivity([
        { time: at(0), heartRateBpm: 100, speedMetersPerSecond: 3 },
        { time: at(2), speedMetersPerSecond: 5 },
        { time: at(4), heartRateBpm: 120, speedMetersPerSecond: 3 },
      ]);
      const timeline = buildOverlayTimeline(activity);
      const sample = timeline.sampleAt(1)!;
      expect(sample.values['metric:heartRate']).toBeUndefined();
      expect(sample.values['metric:speed']).toBeCloseTo(4);
      expect(timeline.available.has('metric:heartRate')).toBe(true);
      expect(timeline.available.has('metric:power')).toBe(false);
    });

    it('does not interpolate across a long gap or a segment boundary', () => {
      const gap = makeActivity([
        { time: at(0), heartRateBpm: 100 },
        { time: at(60), heartRateBpm: 160 },
      ]);
      expect(buildOverlayTimeline(gap).sampleAt(30)!.values['metric:heartRate']).toBeUndefined();

      const split = makeActivity([
        { time: at(0), heartRateBpm: 100, segmentIndex: 0 },
        { time: at(2), heartRateBpm: 160, segmentIndex: 1 },
      ]);
      expect(buildOverlayTimeline(split).sampleAt(1)!.values['metric:heartRate']).toBeUndefined();
    });

    it('reports a pace that is unavailable when the activity never moves', () => {
      const still = makeActivity([
        { time: at(0), speedMetersPerSecond: 0 },
        { time: at(2), speedMetersPerSecond: 0 },
      ]);
      const timeline = buildOverlayTimeline(still);
      expect(timeline.available.has('metric:pace')).toBe(false);
      expect(timeline.sampleAt(1)!.values['metric:pace']).toBeUndefined();
    });

    it('is unavailable without an activity or without timestamps', () => {
      expect(buildOverlayTimeline(undefined).unavailable).toBe('no_activity');
      const untimed = buildOverlayTimeline(makeActivity([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]));
      expect(untimed.unavailable).toBe('no_timestamps');
      expect(untimed.sampleAt(0)).toBeUndefined();
    });

    it('skips untimed points but still samples the timed ones', () => {
      const activity = makeActivity([
        { heartRateBpm: 90 },
        { time: at(0), heartRateBpm: 100 },
        { time: at(2), heartRateBpm: 120 },
      ]);
      expect(buildOverlayTimeline(activity).sampleAt(1)!.values['metric:heartRate']).toBeCloseTo(110);
    });
  });

  describe('activity/video offset', () => {
    it('begins at the first point when the video states no clock', () => {
      const sample = buildOverlayTimeline(ride(), { video: { durationSeconds: 8 } }).sampleAt(0)!;
      expect(sample.activityElapsedSeconds).toBe(0);
    });

    it('aligns against the video wall-clock start', () => {
      const video = { durationSeconds: 20, start: at(-3) };
      const timeline = buildOverlayTimeline(ride(), { video });
      expect(timeline.sampleAt(2)).toBeUndefined(); // 1 s before the recording
      expect(timeline.sampleAt(3)!.activityElapsedSeconds).toBe(0);
      expect(timeline.sampleAt(7)!.values['metric:heartRate']).toBeCloseTo(140);
    });

    it('delays the telemetry for a positive offset and advances it for a negative one', () => {
      const video = { durationSeconds: 8 };
      const late = buildOverlayTimeline(ride(), { video, offsetSeconds: 2 });
      expect(late.sampleAt(1)).toBeUndefined();
      expect(late.sampleAt(6)!.activityElapsedSeconds).toBe(4);
      const early = buildOverlayTimeline(ride(), { video, offsetSeconds: -2 });
      expect(early.sampleAt(2)!.activityElapsedSeconds).toBe(4);
      expect(early.offsetSeconds).toBe(-2);
    });

    it('has no sample outside the video, even where the activity continues', () => {
      const timeline = buildOverlayTimeline(ride(), { video: { durationSeconds: 5 } });
      expect(timeline.sampleAt(5)).toBeDefined();
      expect(timeline.sampleAt(6)).toBeUndefined();
      expect(timeline.sampleAt(-1)).toBeUndefined();
      // A video that starts 4 s into the activity: t < 0 never reaches back.
      const late = buildOverlayTimeline(ride(), { video: { durationSeconds: 4, start: at(4) } });
      expect(late.sampleAt(-1)).toBeUndefined();
      expect(late.sampleAt(0)!.activityElapsedSeconds).toBe(4);
    });

    it('treats a non-finite offset as none', () => {
      expect(buildOverlayTimeline(ride(), { offsetSeconds: Number.NaN }).offsetSeconds).toBe(0);
    });
  });

  it('samples charted camera streams and ignores hidden ones', () => {
    const streams: ActivitySensorStream[] = [
      { key: 'ACCL', label: 'Acceleration', unit: 'm/s²', display: 'chart', valuesByPoint: [1, 3, undefined] },
      { key: 'GRAV', label: 'Gravity', display: 'hidden' },
    ];
    const activity = { ...ride(), sensorStreams: streams };
    const timeline = buildOverlayTimeline(activity);
    expect(timeline.available.has('sensor:ACCL')).toBe(true);
    expect(timeline.available.has('sensor:GRAV')).toBe(false);
    expect(timeline.sampleAt(2)!.values['sensor:ACCL']).toBeCloseTo(2);
    expect(timeline.sampleAt(6)!.values['sensor:ACCL']).toBeUndefined();
  });

  it('reports whether there is a route, and the range of each charted stream', () => {
    const streams: ActivitySensorStream[] = [
      { key: 'ACCL', label: 'Acceleration', unit: 'm/s²', display: 'chart', valuesByPoint: [4, undefined, -2] },
    ];
    const timeline = buildOverlayTimeline({ ...ride(), sensorStreams: streams });
    expect(timeline.hasRoute).toBe(true);
    expect(timeline.sensorLabels.get('sensor:ACCL')).toMatchObject({ min: -2, max: 4 });
    expect(buildOverlayTimeline(makeActivity([{ time: at(0) }, { time: at(1) }])).hasRoute).toBe(false);
    expect(buildOverlayTimeline(undefined).hasRoute).toBe(false);
  });
});
