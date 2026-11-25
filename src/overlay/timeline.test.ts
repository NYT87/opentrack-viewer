import { describe, expect, it } from 'vitest';
import { buildOverlayTimeline, canSmooth, paceFromSpeed, smoothedValueAt } from './timeline';
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

    it('holds the values through a stop, a long gap or a pause, rather than inventing a path across it (TD-080)', () => {
      const gap = makeActivity([
        { time: at(0), heartRateBpm: 100 },
        { time: at(60), heartRateBpm: 160 },
      ]);
      expect(buildOverlayTimeline(gap).sampleAt(30)!.values['metric:heartRate']).toBe(100);

      const split = makeActivity([
        { time: at(0), heartRateBpm: 100, segmentIndex: 0 },
        { time: at(2), heartRateBpm: 160, segmentIndex: 1 },
      ]);
      expect(buildOverlayTimeline(split).sampleAt(1)!.values['metric:heartRate']).toBe(100);
    });

    it('reads the figures of motion as zero through a stop, and holds the distance, the place and the rest (TD-080)', () => {
      // Riding 5 m/s, then paused for two minutes in a new segment, then riding on from the same place.
      const paused = makeActivity([
        { time: at(0), lat: 1, lon: 1, speedMetersPerSecond: 5, powerWatts: 200, heartRateBpm: 130, segmentIndex: 0 },
        { time: at(4), lat: 1 + 20 / 111_320, lon: 1, speedMetersPerSecond: 5, powerWatts: 220, heartRateBpm: 140, segmentIndex: 0 },
        { time: at(124), lat: 1 + 20 / 111_320, lon: 1, speedMetersPerSecond: 5, powerWatts: 210, heartRateBpm: 110, segmentIndex: 1 },
        { time: at(128), lat: 1 + 40 / 111_320, lon: 1, speedMetersPerSecond: 5, powerWatts: 200, heartRateBpm: 120, segmentIndex: 1 },
      ]);
      const timeline = buildOverlayTimeline(paused);
      const sample = timeline.sampleAt(60)!;
      expect(sample.values['metric:speed']).toBe(0);
      expect(sample.values['metric:pace']).toBe(0);
      expect(sample.values['metric:power']).toBe(0);
      expect(sample.values['metric:heartRate']).toBe(140);
      expect(sample.values['metric:distance']).toBeCloseTo(20, 0);
      expect(sample.values['metric:elapsed']).toBe(60);
      expect(sample.position).toEqual({ lat: 1 + 20 / 111_320, lon: 1 });
      expect(sample.progress).toBeCloseTo(0.5, 1);
    });

    it('gives a pace of zero standing still while recording, rather than none', () => {
      const activity = makeActivity([
        { time: at(0), speedMetersPerSecond: 4 },
        { time: at(2), speedMetersPerSecond: 0 },
        { time: at(4), speedMetersPerSecond: 0 },
      ]);
      expect(buildOverlayTimeline(activity).sampleAt(3)!.values['metric:pace']).toBe(0);
    });

    it('knows nothing across a dropout the activity moved across', () => {
      // 60 s without a point, 600 m further on: moving, so not a stop.
      const dropout = makeActivity([
        { time: at(0), distanceMeters: 0, heartRateBpm: 100 },
        { time: at(60), distanceMeters: 600, heartRateBpm: 160 },
      ]);
      const sample = buildOverlayTimeline(dropout).sampleAt(30)!;
      expect(sample.values['metric:heartRate']).toBeUndefined();
      expect(sample.values['metric:distance']).toBeUndefined();
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

  it('states the whole distance, on the basis the distance is read on (TD-080)', () => {
    expect(buildOverlayTimeline(ride()).distanceTotalMeters).toBeCloseTo(100);
    const odometer = makeActivity([
      { time: at(0), distanceMeters: 5000 },
      { time: at(10), distanceMeters: 5100 },
    ]);
    expect(buildOverlayTimeline(odometer).distanceTotalMeters).toBeCloseTo(100);
    expect(buildOverlayTimeline(makeActivity([{ time: at(0) }, { time: at(4) }])).distanceTotalMeters).toBeUndefined();
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

describe('how the video is laid against the activity (TD-059)', () => {
  const ride = makeActivity(
    Array.from({ length: 61 }, (_, i) => ({ lat: 0, lon: i * 0.0001, time: new Date(Date.UTC(2024, 0, 1, 10, 0, i)) })),
  );

  it('says it used the camera clock, and where the video falls in the activity', () => {
    const timeline = buildOverlayTimeline(ride, {
      video: { durationSeconds: 20, start: new Date(Date.UTC(2024, 0, 1, 10, 0, 30)) },
    });
    expect(timeline.alignment).toMatchObject({
      anchoredBy: 'videoClock',
      anchorSeconds: 30,
      activitySpanSeconds: 60,
      videoStartInActivity: 30,
      videoEndInActivity: 50,
      overlaps: true,
    });
  });

  it('says it fell back to the activity start for a video with no clock, and the offset moves it', () => {
    const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 20 }, offsetSeconds: -10 });
    expect(timeline.alignment).toMatchObject({ anchoredBy: 'activityStart', videoStartInActivity: 10, videoEndInActivity: 30 });
  });

  it('knows when the two do not overlap at all', () => {
    const timeline = buildOverlayTimeline(ride, {
      video: { durationSeconds: 20, start: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)) },
    });
    expect(timeline.alignment?.overlaps).toBe(false);
  });
});

describe('moving time so far (AV-1011)', () => {
  it('counts the time spent moving up to each moment, not the stops, as the stats count it', () => {
    const T = Date.parse('2024-01-01T10:00:00Z');
    // Moving 5 m/s for 10 s, standing for 10 s, moving again for 10 s.
    let lat = 1;
    const points = Array.from({ length: 31 }, (_, i) => {
      if (i > 0 && (i <= 10 || i > 20)) lat += 5 / 111_320;
      return { time: new Date(T + i * 1000), lat, lon: 1 };
    });
    const timeline = buildOverlayTimeline(makeActivity(points), { video: { durationSeconds: 30 } });
    const moving = (t: number) => timeline.sampleAt(t)?.values['metric:moving'];
    expect(moving(5)).toBe(5);
    expect(moving(15)).toBe(10);
    expect(moving(25)).toBe(15);
    expect(moving(30)).toBe(20);
    expect(timeline.available.has('metric:moving')).toBe(true);
  });
});

describe('climb so far (AV-1016)', () => {
  const T = Date.parse('2024-01-01T10:00:00Z');
  const climbing = (elevations: number[], extra: (i: number) => object = () => ({})) =>
    makeActivity(elevations.map((elevationMeters, i) => ({ time: new Date(T + i * 1000), elevationMeters, ...extra(i) })));
  const climb = (timeline: ReturnType<typeof buildOverlayTimeline>, t: number) => timeline.sampleAt(t)?.values['metric:climb'];

  it('rises with the climb, holds through a descent, and ends at the summary’s elevation gain', () => {
    const activity = climbing([100, 105, 110, 120, 110, 100, 105, 115, 130, 128]);
    const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 9 } });
    expect(timeline.available.has('metric:climb')).toBe(true);
    expect(climb(timeline, 0)).toBe(0);
    expect(climb(timeline, 3)).toBe(20);
    // Going down adds nothing and takes nothing away.
    expect(climb(timeline, 5)).toBe(20);
    expect(climb(timeline, 8)).toBe(50);
    expect(climb(timeline, 9)).toBeCloseTo(activity.derived!.elevationGainMeters!, 6);
  });

  it('does not count barometric jitter, as the summary does not', () => {
    const activity = climbing([50, 51.2, 49.4, 50.8, 50.1, 51, 50.2]);
    const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 6 } });
    expect(climb(timeline, 6)).toBe(activity.derived?.elevationGainMeters ?? 0);
  });

  it('holds through a stop, and is absent for an activity with no elevation', () => {
    // Climbs for 5 s, then no point for a minute, then a point at the same height.
    const points = [0, 1, 2, 3, 4, 5, 65, 66].map((s, i) => ({
      time: new Date(T + s * 1000),
      elevationMeters: 100 + Math.min(i, 5) * 4,
      lat: 1,
      lon: 1,
    }));
    const timeline = buildOverlayTimeline(makeActivity(points), { video: { durationSeconds: 66 } });
    expect(climb(timeline, 5)).toBe(20);
    expect(climb(timeline, 40)).toBe(20);
    expect(buildOverlayTimeline(makeActivity([{ time: new Date(T) }, { time: new Date(T + 1000) }])).available.has('metric:climb')).toBe(false);
  });
});

describe('smoothing (AV-1016)', () => {
  const T = Date.parse('2024-01-01T10:00:00Z');
  /** 40 s: power 100 + 10 s a second (a ramp), speed 2 m/s a second, heart rate alternating. */
  const ramp = () =>
    makeActivity(
      Array.from({ length: 41 }, (_, i) => ({
        time: new Date(T + i * 1000),
        lat: 1 + (i * i) / 2 / 111_320,
        lon: 1,
        powerWatts: 100 + 10 * i,
        speedMetersPerSecond: i,
        heartRateBpm: i % 2 === 0 ? 100 : 120,
      })),
    );
  const timeline = () => buildOverlayTimeline(ramp(), { video: { durationSeconds: 40 } });
  const power = { kind: 'metric', metric: 'power' } as const;

  it('is the trailing mean over the window: on a ramp, the value half a window ago', () => {
    const t = timeline();
    expect(smoothedValueAt(t, power, 20, 3)).toBeCloseTo(100 + 10 * 18.5, 6);
    expect(smoothedValueAt(t, power, 20, 10)).toBeCloseTo(100 + 10 * 15, 6);
  });

  it('is off at a window of 0 and takes at most 30 s', () => {
    const t = timeline();
    expect(smoothedValueAt(t, power, 20, 0)).toBeUndefined();
    expect(smoothedValueAt(t, power, 35, 100)).toBeCloseTo(smoothedValueAt(t, power, 35, 30)!, 9);
  });

  it('is deterministic from the time and window alone, whatever was asked before', () => {
    const t = timeline();
    const first = smoothedValueAt(t, power, 25, 4);
    smoothedValueAt(t, power, 3, 4);
    smoothedValueAt(t, power, 39, 30);
    expect(smoothedValueAt(t, power, 25, 4)).toBe(first);
  });

  it('averages only what the activity has at the start: the first moment is itself', () => {
    const t = timeline();
    expect(smoothedValueAt(t, power, 0, 5)).toBe(100);
    // Half a window in: the mean of the two seconds there are.
    expect(smoothedValueAt(t, power, 2, 5)).toBeCloseTo(110, 6);
  });

  it('takes the sampled values through a stop, so the mean decays to zero and holds', () => {
    // Moves at 5 m/s for 10 s, then no point for 40 s (a stop), then one more.
    const points = [...Array.from({ length: 11 }, (_, i) => i), 50, 51].map((s) => ({
      time: new Date(T + s * 1000),
      lat: 1 + (Math.min(s, 10) * 5) / 111_320,
      lon: 1,
      powerWatts: s <= 10 ? 200 : 0,
      speedMetersPerSecond: s <= 10 ? 5 : 0,
    }));
    const t = buildOverlayTimeline(makeActivity(points), { video: { durationSeconds: 51 } });
    // Five seconds into the stop the 5 s window is half moving, half stood still.
    const speed = { kind: 'metric', metric: 'speed' } as const;
    expect(smoothedValueAt(t, speed, 12.5, 5)).toBeGreaterThan(0);
    expect(smoothedValueAt(t, speed, 12.5, 5)).toBeLessThan(5);
    // Long into the stop: zero, and still defined (never vanishing).
    expect(smoothedValueAt(t, speed, 30, 5)).toBe(0);
    expect(smoothedValueAt(t, { kind: 'metric', metric: 'pace' }, 30, 5)).toBe(0);
  });

  it('reads a pace of 0 once the mean speed is below walking, not an ever slower pace, through a stop', () => {
    const points = [...Array.from({ length: 11 }, (_, i) => i), 50].map((s) => ({
      time: new Date(T + s * 1000),
      lat: 1 + (Math.min(s, 10) * 3) / 111_320,
      lon: 1,
      speedMetersPerSecond: s <= 10 ? 3 : 0,
    }));
    const t = buildOverlayTimeline(makeActivity(points), { video: { durationSeconds: 50 } });
    const pace = { kind: 'metric', metric: 'pace' } as const;
    for (let at = 10.25; at <= 16; at += 0.25) {
      const value = smoothedValueAt(t, pace, at, 5)!;
      // Either a running pace (under 40 minutes a km) or standing still, never an hour a kilometre.
      expect(value === 0 || value < 2400, `at ${at}`).toBe(true);
    }
    expect(smoothedValueAt(t, pace, 16, 5)).toBe(0);
  });

  it('smooths pace through speed, then turns the mean back into pace', () => {
    const t = timeline();
    const meanSpeed = smoothedValueAt(t, { kind: 'metric', metric: 'speed' }, 20, 4)!;
    expect(smoothedValueAt(t, { kind: 'metric', metric: 'pace' }, 20, 4)).toBeCloseTo(paceFromSpeed(meanSpeed)!, 9);
    // Not the mean of the paces, which is a different (and larger) number.
    const paces = Array.from({ length: 17 }, (_, k) => paceFromSpeed(t.sampleAt(20 - k * 0.25)!.values['metric:speed'])!);
    expect(smoothedValueAt(t, { kind: 'metric', metric: 'pace' }, 20, 4)).toBeLessThan(paces.reduce((a, b) => a + b, 0) / paces.length);
  });

  it('costs at most 121 samples, however long the window', () => {
    let calls = 0;
    const inner = timeline();
    const counting = { sampleAt: (time: number) => (calls += 1, inner.sampleAt(time)) };
    smoothedValueAt(counting, power, 35, 30);
    expect(calls).toBe(121);
  });

  it('never smooths a total so far: distance, time, moving time and climb', () => {
    for (const metric of ['distance', 'elapsed', 'moving', 'climb'] as const) {
      expect(canSmooth({ kind: 'metric', metric })).toBe(false);
      expect(smoothedValueAt(timeline(), { kind: 'metric', metric }, 20, 5)).toBeUndefined();
    }
    expect(canSmooth({ kind: 'sensor', key: 'ACCL' })).toBe(true);
  });
});
