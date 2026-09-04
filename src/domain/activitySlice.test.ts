import { describe, expect, it } from 'vitest';
import { sliceActivity } from './activitySlice';
import { makeActivity } from '../test/helpers/activity';
import type { Activity } from './activity';

/** Six points, 111 m and one minute apart, climbing steadily. */
const source = (): Activity =>
  makeActivity(
    Array.from({ length: 6 }, (_, index) => ({
      lat: index * 0.001,
      lon: 0.0001,
      elevationMeters: 100 + index * 10,
      time: new Date(Date.UTC(2024, 0, 1, 10, index)),
    })),
  );

const unwrap = (activity: Activity, startIndex: number, endIndex: number) => {
  const result = sliceActivity(activity, { startIndex, endIndex });
  if (!result.ok) throw new Error(`expected a slice, got ${result.error.code}`);
  return result.activity;
};

describe('sliceActivity (AV-510)', () => {
  it('keeps only the points inside the range', () => {
    const focused = unwrap(source(), 1, 3);

    expect(focused.points).toHaveLength(3);
    expect(focused.points.map((point) => point.elevationMeters)).toEqual([110, 120, 130]);
  });

  it('keeps the original point indexes rather than renumbering', () => {
    // The documented decision: an index identifies a point across the focused
    // and full views, so hover and map lookups never need translating.
    const focused = unwrap(source(), 2, 4);

    expect(focused.points.map((point) => point.index)).toEqual([2, 3, 4]);
  });

  it('does not mutate or share mutable state with the original', () => {
    const original = source();
    const before = JSON.stringify(original);

    const focused = unwrap(original, 1, 3);

    expect(JSON.stringify(original)).toBe(before);
    expect(original.points).toHaveLength(6);
    expect(focused.points).not.toBe(original.points);
    // The point objects themselves are shared, which is the point: focusing a
    // large activity must not copy every sample.
    expect(focused.points[0]).toBe(original.points[1]);
  });

  it('recalculates stats for the slice without touching the full ones', () => {
    const original = source();
    const fullDistance = original.derived!.distanceMeters!;
    const fullGain = original.derived!.elevationGainMeters!;

    const focused = unwrap(original, 1, 3);

    // Two 111 m legs and 20 m of climb, not the whole activity's five and 50.
    expect(focused.derived!.distanceMeters).toBeCloseTo(222, 0);
    expect(focused.derived!.elevationGainMeters).toBeCloseTo(20);
    expect(focused.derived!.pointCount).toBe(3);
    expect(original.derived!.distanceMeters).toBe(fullDistance);
    expect(original.derived!.elevationGainMeters).toBe(fullGain);
  });

  it('reports the slice’s own time bounds in metadata', () => {
    const focused = unwrap(source(), 1, 3);

    expect(focused.metadata.startTime?.toISOString()).toBe('2024-01-01T10:01:00.000Z');
    expect(focused.metadata.endTime?.toISOString()).toBe('2024-01-01T10:03:00.000Z');
  });

  it('recomputes streams, which a slice may not share with the whole', () => {
    const partial = makeActivity([
      { lat: 0, lon: 0.0001, elevationMeters: 10 },
      { lat: 0.001, lon: 0.0001, elevationMeters: 20 },
      // The tail has no elevation at all.
      { lat: 0.002, lon: 0.0001 },
      { lat: 0.003, lon: 0.0001 },
    ]);
    expect(partial.streams.hasElevation).toBe(true);

    expect(unwrap(partial, 2, 3).streams.hasElevation).toBe(false);
  });

  it('leaves laps to the full view', () => {
    const withLaps = source();
    withLaps.laps = [{ index: 0, distanceMeters: 1000, durationSeconds: 300 }];

    // A lap running past the focused section would misrepresent it.
    expect(unwrap(withLaps, 1, 3).laps).toBeUndefined();
    expect(withLaps.laps).toHaveLength(1);
  });

  it('rejects a range that covers too little to show', () => {
    const result = sliceActivity(source(), { startIndex: 2, endIndex: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_selected_range');
    expect(result.error.message).toMatch(/1 point/);
  });

  it('rejects a range that selects nothing', () => {
    const result = sliceActivity(source(), { startIndex: 50, endIndex: 60 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_selected_range');
  });

  it('rejects a reversed or non-integer range', () => {
    for (const range of [
      { startIndex: 4, endIndex: 1 },
      { startIndex: 1.5, endIndex: 3 },
      { startIndex: Number.NaN, endIndex: 3 },
    ]) {
      const result = sliceActivity(source(), range);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_selected_range');
    }
  });

  it('clamps to the points that exist when the range overshoots one end', () => {
    const focused = unwrap(source(), 4, 99);

    expect(focused.points.map((point) => point.index)).toEqual([4, 5]);
  });
});
