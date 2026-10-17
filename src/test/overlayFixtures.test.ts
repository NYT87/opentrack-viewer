import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MP4Box from 'mp4box';
import { describe, expect, it } from 'vitest';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { buildOverlayTimeline } from '../overlay/timeline';
import { readFixture } from './helpers/fixtures';
import { syntheticRide } from './helpers/syntheticTelemetry';

/**
 * AV-1008. The overlay fixtures say what they claim: `overlay-ride.gpx` states
 * the formulae in `make-overlay-fixtures.mjs` at every second, and
 * `overlay-test-clip.mp4` is a real, small, playable video. The browser tests
 * state their expected numbers from those formulae, so these are what keep the
 * two from drifting apart.
 */
const speedAt = (t: number) => 4 + 0.2 * t;
const distanceAt = (t: number) => 4 * t + 0.1 * t * (t - 1);

describe('overlay-ride.gpx', () => {
  const activity = parseGpx(readFixture('overlay-ride.gpx'), { fileName: 'overlay-ride.gpx' });
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 6 } });

  it('is a minute of cycling at one point a second, from a fixed instant', () => {
    expect(activity.points).toHaveLength(61);
    expect(activity.points[0]?.time?.toISOString()).toBe('2024-01-01T10:00:00.000Z');
    expect(activity.points[60]?.time?.toISOString()).toBe('2024-01-01T10:01:00.000Z');
    expect(activity.metadata.sport).toBe('cycling');
  });

  it('carries every channel the overlay can show', () => {
    for (const key of ['speed', 'pace', 'distance', 'elevation', 'heartRate', 'cyclingCadence', 'power', 'elapsed']) {
      expect(timeline.available.has(`metric:${key}`), key).toBe(true);
    }
    expect(timeline.hasRoute).toBe(true);
    // It is a cycling ride: running cadence is the one thing it does not have.
    expect(timeline.available.has('metric:runningCadence')).toBe(false);
  });

  it('states the documented formula at every second', () => {
    const wholeRide = buildOverlayTimeline(activity);
    for (const t of [0, 1, 7, 30, 59, 60]) {
      const values = wholeRide.sampleAt(t)!.values;
      expect(values['metric:speed'], `speed @${t}`).toBeCloseTo(speedAt(t), 6);
      expect(values['metric:heartRate'], `hr @${t}`).toBeCloseTo(100 + t, 6);
      expect(values['metric:elevation'], `elevation @${t}`).toBeCloseTo(100 + t, 6);
      expect(values['metric:power'], `power @${t}`).toBeCloseTo(150 + 2 * t, 6);
      expect(values['metric:cyclingCadence'], `cadence @${t}`).toBeCloseTo(80 + (t % 5), 6);
      // Distance is derived from the positions, which move at the stated speed: it agrees with the formula.
      expect(values['metric:distance'], `distance @${t}`).toBeCloseTo(distanceAt(t), 0);
    }
  });

  it('interpolates linearly between its seconds', () => {
    const values = buildOverlayTimeline(activity).sampleAt(2.5)!.values;
    expect(values['metric:speed']).toBeCloseTo((speedAt(2) + speedAt(3)) / 2, 6);
    expect(values['metric:heartRate']).toBeCloseTo(102.5, 6);
  });

  it('is synthetic: nothing in it was recorded', () => {
    const text = readFixture('overlay-ride.gpx');
    expect(text).toMatch(/Synthetic \(AV-1008\)/);
    expect(text).toMatch(/creator="OpenTrackViewerTestFixture"/);
  });
});

describe('overlay-test-clip.mp4', () => {
  const bytes = readFileSync(join(process.cwd(), 'src/test/fixtures/overlay-test-clip.mp4'));

  it('is small enough to commit', () => {
    expect(bytes.length).toBeLessThan(100_000);
  });

  it('is a real MP4 with one 256×144 VP9 track of six seconds', async () => {
    const info = await new Promise<{ tracks: { codec: string; video?: { width: number; height: number }; nb_samples: number }[]; duration: number; timescale: number }>(
      (resolve, reject) => {
        const file = MP4Box.createFile();
        file.onError = (error: unknown) => reject(error);
        file.onReady = (ready) => resolve(ready as never);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer & { fileStart: number };
        buffer.fileStart = 0;
        file.appendBuffer(buffer);
        file.flush();
      },
    );
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]?.codec).toMatch(/^vp09/);
    expect(info.tracks[0]?.video).toMatchObject({ width: 256, height: 144 });
    expect(info.tracks[0]?.nb_samples).toBe(90); // 15 fps × 6 s
    expect(info.duration / info.timescale).toBeCloseTo(6, 1);
  });

  it('carries no GoPro telemetry and no clock: a video that needs an activity from elsewhere', () => {
    expect(bytes.includes(Buffer.from('gpmd'))).toBe(false);
  });
});

describe('synthetic telemetry (AV-1008)', () => {
  it('makes a recording of any length on demand, deterministically', () => {
    const a = syntheticRide({ seconds: 3600, hz: 1 });
    const b = syntheticRide({ seconds: 3600, hz: 1 });
    expect(a.points).toHaveLength(3601);
    expect(a.points.at(-1)?.time?.toISOString()).toBe('2024-06-01T09:00:00.000Z');
    expect(a.points[1234]).toEqual(b.points[1234]);
  });

  it('has every channel, valid positions, and an optional camera stream point for point', () => {
    const ride = syntheticRide({ seconds: 600, hz: 10, sensorStream: true });
    expect(ride.points).toHaveLength(6001);
    expect(ride.streams).toMatchObject({ hasLocation: true, hasHeartRate: true, hasPower: true, hasCyclingCadence: true, hasTime: true });
    expect(ride.sensorStreams?.[0]?.valuesByPoint).toHaveLength(6001);
    const timeline = buildOverlayTimeline(ride);
    expect(timeline.available.has('sensor:ACCL')).toBe(true);
    expect(timeline.sampleAt(300)?.position).toBeDefined();
  });
});
