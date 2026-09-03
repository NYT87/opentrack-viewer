import { describe, expect, it } from 'vitest';
import {
  computeDistance,
  computeElevation,
  computeStats,
  computeTimeBounds,
  haversineMeters,
} from './stats';
import type { ActivityPoint } from './activity';

const point = (partial: Partial<ActivityPoint>, index = 0): ActivityPoint => ({
  index,
  ...partial,
});

const points = (list: Partial<ActivityPoint>[]): ActivityPoint[] =>
  list.map((item, index) => point(item, index));

describe('haversineMeters', () => {
  it('matches a known one-degree-of-latitude distance', () => {
    // One degree of latitude is ~111.19 km on a sphere of radius 6371008.8 m.
    expect(haversineMeters(0, 0, 1, 0)).toBeCloseTo(111_195, -2);
  });

  it('is zero for identical coordinates', () => {
    expect(haversineMeters(51.5, -0.12, 51.5, -0.12)).toBe(0);
  });
});

describe('computeDistance (AV-401)', () => {
  it('derives distance from GPS coordinates', () => {
    const result = computeDistance(
      points([
        { lat: 0, lon: 0.0001 },
        { lat: 1, lon: 0.0001 },
        { lat: 2, lon: 0.0001 },
      ]),
    );

    expect(result.origin).toBe('derived');
    expect(result.totalMeters).toBeCloseTo(222_390, -3);
    expect(result.cumulativeMeters[0]).toBe(0);
  });

  it('prefers a monotonic source distance stream', () => {
    const result = computeDistance(
      points([
        { lat: 51.5, lon: 0.1, distanceMeters: 0 },
        { lat: 51.6, lon: 0.1, distanceMeters: 500 },
        { lat: 51.7, lon: 0.1, distanceMeters: 1200 },
      ]),
    );

    expect(result.origin).toBe('source');
    expect(result.totalMeters).toBe(1200);
  });

  it('falls back to GPS when the source stream decreases', () => {
    const result = computeDistance(
      points([
        { lat: 51.5, lon: 0.1, distanceMeters: 0 },
        { lat: 51.6, lon: 0.1, distanceMeters: 900 },
        { lat: 51.7, lon: 0.1, distanceMeters: 400 },
      ]),
    );

    expect(result.origin).toBe('derived');
  });

  it('skips invalid coordinates without breaking the chain', () => {
    const result = computeDistance(
      points([{ lat: 0, lon: 0.0001 }, { lat: 999, lon: 0.0001 }, { lat: 1, lon: 0.0001 }]),
    );

    expect(result.origin).toBe('derived');
    expect(result.totalMeters).toBeCloseTo(111_195, -2);
    expect(result.cumulativeMeters[1]).toBeUndefined();
  });

  it('does not count the gap between segments (regression)', () => {
    // Two 111 m legs, a long way apart. Accumulating across the boundary would
    // add the distance travelled while the recording was stopped.
    const result = computeDistance(
      points([
        { lat: 51.5, lon: 0.0001, segmentIndex: 0 },
        { lat: 51.501, lon: 0.0001, segmentIndex: 0 },
        { lat: 51.55, lon: 0.0001, segmentIndex: 1 },
        { lat: 51.551, lon: 0.0001, segmentIndex: 1 },
      ]),
    );

    expect(result.totalMeters).toBeCloseTo(222, 0);
    // Cumulative distance still runs continuously across the boundary.
    expect(result.cumulativeMeters[2]).toBeCloseTo(111, 0);
    expect(result.cumulativeMeters[3]).toBeCloseTo(222, 0);
  });

  it('treats points without a segment index as one run', () => {
    const result = computeDistance(
      points([
        { lat: 51.5, lon: 0.0001 },
        { lat: 51.501, lon: 0.0001 },
      ]),
    );

    expect(result.totalMeters).toBeCloseTo(111, 0);
  });

  it('reports no distance when there is no location at all', () => {
    const result = computeDistance(points([{ elevationMeters: 10 }, { elevationMeters: 12 }]));

    expect(result.origin).toBe('none');
    expect(result.totalMeters).toBeUndefined();
  });
});

describe('computeTimeBounds (AV-402)', () => {
  const at = (iso: string) => new Date(iso);

  it('computes start, end and elapsed duration', () => {
    const result = computeTimeBounds(
      points([
        { time: at('2024-01-01T10:00:00Z') },
        { time: at('2024-01-01T10:00:30Z') },
        { time: at('2024-01-01T10:05:00Z') },
      ]),
    );

    expect(result.startTime?.toISOString()).toBe('2024-01-01T10:00:00.000Z');
    expect(result.endTime?.toISOString()).toBe('2024-01-01T10:05:00.000Z');
    expect(result.durationSeconds).toBe(300);
    expect(result.warnings).toHaveLength(0);
  });

  it('normalizes unordered timestamps and warns', () => {
    const result = computeTimeBounds(
      points([
        { time: at('2024-01-01T10:05:00Z') },
        { time: at('2024-01-01T10:00:00Z') },
        { time: at('2024-01-01T10:02:00Z') },
      ]),
    );

    expect(result.durationSeconds).toBe(300);
    expect(result.warnings.map((warning) => warning.code)).toContain('unordered_timestamps');
  });

  it('notes duplicate timestamps without failing', () => {
    const result = computeTimeBounds(
      points([
        { time: at('2024-01-01T10:00:00Z') },
        { time: at('2024-01-01T10:00:00Z') },
        { time: at('2024-01-01T10:01:00Z') },
      ]),
    );

    expect(result.durationSeconds).toBe(60);
    expect(result.warnings.map((warning) => warning.code)).toContain('duplicate_timestamps');
  });

  it('returns nothing when no point has a timestamp', () => {
    const result = computeTimeBounds(points([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]));

    expect(result.startTime).toBeUndefined();
    expect(result.durationSeconds).toBeUndefined();
  });
});

describe('computeElevation (AV-403)', () => {
  it('sums a sustained climb', () => {
    const result = computeElevation(
      points([{ elevationMeters: 100 }, { elevationMeters: 150 }, { elevationMeters: 200 }]),
    );

    expect(result.gainMeters).toBeCloseTo(100);
    expect(result.lossMeters).toBeCloseTo(0);
    expect(result.minMeters).toBe(100);
    expect(result.maxMeters).toBe(200);
  });

  it('sums a sustained descent', () => {
    const result = computeElevation(
      points([{ elevationMeters: 200 }, { elevationMeters: 120 }, { elevationMeters: 100 }]),
    );

    expect(result.gainMeters).toBeCloseTo(0);
    expect(result.lossMeters).toBeCloseTo(100);
  });

  it('ignores jitter below the noise threshold on a flat route', () => {
    const result = computeElevation(
      points([
        { elevationMeters: 50 },
        { elevationMeters: 51.2 },
        { elevationMeters: 49.4 },
        { elevationMeters: 50.8 },
        { elevationMeters: 50.1 },
      ]),
    );

    expect(result.gainMeters).toBe(0);
    expect(result.lossMeters).toBe(0);
  });

  it('ignores points without elevation', () => {
    const result = computeElevation(
      points([{ elevationMeters: 100 }, { lat: 1, lon: 1 }, { elevationMeters: 140 }]),
    );

    expect(result.gainMeters).toBeCloseTo(40);
  });

  it('returns an empty result when no point has elevation', () => {
    expect(computeElevation(points([{ lat: 1, lon: 1 }]))).toEqual({});
  });
});

describe('computeStats', () => {
  it('summarizes distance, time, elevation and sensors together', () => {
    const result = computeStats(
      points([
        { lat: 0, lon: 0.0001, elevationMeters: 10, heartRateBpm: 100, time: new Date('2024-01-01T10:00:00Z') },
        { lat: 1, lon: 0.0001, elevationMeters: 60, heartRateBpm: 140, time: new Date('2024-01-01T11:00:00Z') },
      ]),
    );

    expect(result.stats.pointCount).toBe(2);
    expect(result.stats.durationSeconds).toBe(3600);
    expect(result.stats.elevationGainMeters).toBeCloseTo(50);
    expect(result.stats.averageHeartRateBpm).toBe(120);
    expect(result.stats.maxHeartRateBpm).toBe(140);
    expect(result.cumulativeDistanceMeters).toHaveLength(2);
  });

  it('handles an activity with no usable streams', () => {
    const result = computeStats(points([{}, {}]));

    expect(result.stats.distanceMeters).toBeUndefined();
    expect(result.stats.durationSeconds).toBeUndefined();
    expect(result.stats.elevationGainMeters).toBeUndefined();
  });
});
