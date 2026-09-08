import { describe, expect, it } from 'vitest';
import {
  domainFromPointRange,
  hasDrawableRoute,
  lapPointRange,
  pointRangeFromDomain,
} from './range';
import { makeActivity } from '../test/helpers/activity';
import { sliceActivity } from './activitySlice';
import { activityToRouteGeoJSON } from './geojson';

/** Five points ~111 m apart, one minute apart. */
const activity = () =>
  makeActivity([
    { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
    { lat: 0.001, lon: 0.0001, time: new Date('2024-01-01T10:01:00Z') },
    { lat: 0.002, lon: 0.0001, time: new Date('2024-01-01T10:02:00Z') },
    { lat: 0.003, lon: 0.0001, time: new Date('2024-01-01T10:03:00Z') },
    { lat: 0.004, lon: 0.0001, time: new Date('2024-01-01T10:04:00Z') },
  ]);

describe('pointRangeFromDomain (AV-509)', () => {
  it('maps a distance span to the points inside it', () => {
    // Roughly 111 m to 333 m, which is points 1 through 3.
    expect(pointRangeFromDomain(activity(), 'distance', 111, 333)).toEqual({
      startIndex: 1,
      endIndex: 3,
    });
  });

  it('maps a time span to the points inside it', () => {
    // 60 s to 180 s after the start.
    expect(pointRangeFromDomain(activity(), 'time', 60, 180)).toEqual({
      startIndex: 1,
      endIndex: 3,
    });
  });

  it('normalises a reversed selection', () => {
    expect(pointRangeFromDomain(activity(), 'time', 180, 60)).toEqual({
      startIndex: 1,
      endIndex: 3,
    });
  });

  it('clamps a selection that runs past both ends', () => {
    expect(pointRangeFromDomain(activity(), 'distance', -5000, 999_999)).toEqual({
      startIndex: 0,
      endIndex: 4,
    });
  });

  it('snaps to the nearest point rather than requiring an exact hit', () => {
    // 130 m is between points 1 (111 m) and 2 (222 m); 1 is nearer.
    expect(pointRangeFromDomain(activity(), 'distance', 130, 130)).toEqual({
      startIndex: 1,
      endIndex: 1,
    });
  });

  it('resolves an edge that lands on a point with no value on this axis', () => {
    // The middle point has no timestamp, so the time axis cannot place it.
    const gappy = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.001, lon: 0.0001 },
      { lat: 0.002, lon: 0.0001, time: new Date('2024-01-01T10:02:00Z') },
    ]);

    // 60 s falls in the gap; the nearest timestamped points are 0 and 2.
    const range = pointRangeFromDomain(gappy, 'time', 60, 60);
    expect(range).toBeDefined();
    expect([0, 2]).toContain(range!.startIndex);
  });

  it('returns nothing when no point can be placed on the axis', () => {
    const noTime = makeActivity([{ lat: 0, lon: 0.0001 }, { lat: 0.001, lon: 0.0001 }]);

    expect(pointRangeFromDomain(noTime, 'time', 0, 60)).toBeUndefined();
  });

  it('rejects a non-finite selection', () => {
    expect(pointRangeFromDomain(activity(), 'distance', Number.NaN, 100)).toBeUndefined();
  });
});

describe('point.index semantics (AV-509, AV-510)', () => {
  it('returns point indexes, which survive slicing', () => {
    const source = activity();
    // A focused slice keeps original indexes, so a range taken against the full
    // activity still identifies the same points inside the slice.
    const focused = { ...source, points: source.points.slice(2) };

    const range = pointRangeFromDomain(source, 'time', 120, 180)!;
    expect(range).toEqual({ startIndex: 2, endIndex: 3 });

    // The same range resolves against the slice, where those points sit at
    // array positions 0 and 1. The slice's time axis is measured from its own
    // first timestamp, so the *values* differ — the identified points do not.
    const onSlice = domainFromPointRange(focused, 'time', range)!;
    expect(onSlice).toBeDefined();
    expect(pointRangeFromDomain(focused, 'time', onSlice.start, onSlice.end)).toEqual(range);
  });

  it('returns nothing when the range names points the activity lacks', () => {
    const source = activity();

    expect(
      domainFromPointRange(source, 'time', { startIndex: 40, endIndex: 41 }),
    ).toBeUndefined();
  });
});

describe('domainFromPointRange (AV-509)', () => {
  it('places a stored range back on the distance axis', () => {
    const span = domainFromPointRange(activity(), 'distance', { startIndex: 1, endIndex: 3 })!;

    expect(span.start).toBeCloseTo(111, 0);
    expect(span.end).toBeCloseTo(334, 0);
  });

  it('places the same range on the time axis', () => {
    // The point of storing indices: the selection survives an axis switch.
    expect(domainFromPointRange(activity(), 'time', { startIndex: 1, endIndex: 3 })).toEqual({
      start: 60,
      end: 180,
    });
  });

  it('round-trips a selection through both axes', () => {
    const source = activity();
    const range = pointRangeFromDomain(source, 'distance', 111, 333)!;
    const onTime = domainFromPointRange(source, 'time', range)!;

    expect(pointRangeFromDomain(source, 'time', onTime.start, onTime.end)).toEqual(range);
  });

  it('falls back outward when an edge has no value on this axis', () => {
    const gappy = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.001, lon: 0.0001 },
      { lat: 0.002, lon: 0.0001, time: new Date('2024-01-01T10:02:00Z') },
    ]);

    // Index 1 has no timestamp; the band still spans the whole selection.
    expect(domainFromPointRange(gappy, 'time', { startIndex: 1, endIndex: 2 })).toEqual({
      start: 0,
      end: 120,
    });
  });

  it('returns nothing when the axis cannot place any point', () => {
    const noTime = makeActivity([{ lat: 0, lon: 0.0001 }, { lat: 0.001, lon: 0.0001 }]);

    expect(domainFromPointRange(noTime, 'time', { startIndex: 0, endIndex: 1 })).toBeUndefined();
  });
});

describe('lapPointRange', () => {
  const activity = makeActivity(
    Array.from({ length: 6 }, (_, index) => ({
      lat: 51.5 + index * 0.001,
      lon: -0.1,
      time: new Date(Date.UTC(2024, 0, 1, 10, 0, index * 10)),
    })),
  );

  it('finds the points a lap covers, by time', () => {
    expect(
      lapPointRange(activity, {
        index: 0,
        startTime: new Date('2024-01-01T10:00:10Z'),
        endTime: new Date('2024-01-01T10:00:30Z'),
      }),
    ).toEqual({ startIndex: 1, endIndex: 3 });
  });

  it('runs to the end when a lap states no end', () => {
    expect(
      lapPointRange(activity, { index: 0, startTime: new Date('2024-01-01T10:00:40Z') }),
    ).toEqual({ startIndex: 4, endIndex: 5 });
  });

  it('has no range for a lap that states no start', () => {
    expect(lapPointRange(activity, { index: 0 })).toBeUndefined();
  });

  it('has no range when no point falls inside the lap', () => {
    expect(
      lapPointRange(activity, {
        index: 0,
        startTime: new Date('2024-01-01T11:00:00Z'),
        endTime: new Date('2024-01-01T11:30:00Z'),
      }),
    ).toBeUndefined();
  });

  it('ignores points with no timestamp rather than guessing', () => {
    const patchy = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 51.501, lon: -0.1 },
      { lat: 51.502, lon: -0.1, time: new Date('2024-01-01T10:00:20Z') },
    ]);

    expect(
      lapPointRange(patchy, {
        index: 0,
        startTime: new Date('2024-01-01T10:00:00Z'),
        endTime: new Date('2024-01-01T10:00:20Z'),
      }),
    ).toEqual({ startIndex: 0, endIndex: 2 });
  });
});

describe('hasDrawableRoute', () => {
  it('is true for two located points in the same segment', () => {
    const activity = makeActivity([
      { lat: 51.5, lon: -0.1, segmentIndex: 0 },
      { lat: 51.501, lon: -0.1, segmentIndex: 0 },
    ]);

    expect(hasDrawableRoute(activity, { startIndex: 0, endIndex: 1 })).toBe(true);
  });

  it('is false across a pause with one point on each side', () => {
    // The case found by running the app: a lap boundary inside a recording gap.
    const activity = makeActivity([
      { lat: 51.5, lon: -0.1, segmentIndex: 0 },
      { lat: 51.501, lon: -0.1, segmentIndex: 1 },
    ]);

    expect(hasDrawableRoute(activity, { startIndex: 0, endIndex: 1 })).toBe(false);
  });

  it('is true when either side of a pause has a pair', () => {
    const activity = makeActivity([
      { lat: 51.5, lon: -0.1, segmentIndex: 0 },
      { lat: 51.501, lon: -0.1, segmentIndex: 1 },
      { lat: 51.502, lon: -0.1, segmentIndex: 1 },
    ]);

    expect(hasDrawableRoute(activity, { startIndex: 0, endIndex: 2 })).toBe(true);
  });

  it('is false for a single point, and for none', () => {
    const activity = makeActivity([
      { lat: 51.5, lon: -0.1 },
      { lat: 51.501, lon: -0.1 },
    ]);

    expect(hasDrawableRoute(activity, { startIndex: 0, endIndex: 0 })).toBe(false);
  });

  it('joins across an unlocated point, exactly as the renderer does', () => {
    const activity = makeActivity([
      { lat: 51.5, lon: -0.1 },
      { heartRateBpm: 120 },
      { lat: 51.502, lon: -0.1 },
    ]);
    const range = { startIndex: 0, endIndex: 2 };

    // Only a segment change breaks a line; a point with no position is simply
    // skipped. Checked against the geometry rather than assumed.
    expect(hasDrawableRoute(activity, range)).toBe(true);

    const sliced = sliceActivity(activity, range);
    expect(sliced.ok && !activityToRouteGeoJSON(sliced.activity).isEmpty).toBe(true);
  });

  it('agrees with the geometry for every case it is asked about', () => {
    // The guard against the two drifting apart: one answers cheaply, the other
    // by building the route, and they must never disagree.
    const cases = [
      [{ lat: 51.5, lon: -0.1, segmentIndex: 0 }, { lat: 51.501, lon: -0.1, segmentIndex: 0 }],
      [{ lat: 51.5, lon: -0.1, segmentIndex: 0 }, { lat: 51.501, lon: -0.1, segmentIndex: 1 }],
      [{ lat: 51.5, lon: -0.1 }, { heartRateBpm: 120 }, { lat: 51.502, lon: -0.1 }],
      [{ heartRateBpm: 120 }, { heartRateBpm: 130 }],
      [{ lat: 51.5, lon: -0.1 }],
    ];

    for (const [index, points] of cases.entries()) {
      const activity = makeActivity(points);
      const range = { startIndex: 0, endIndex: points.length - 1 };
      const sliced = sliceActivity(activity, range);
      const drawn = sliced.ok && !activityToRouteGeoJSON(sliced.activity).isEmpty;

      expect(hasDrawableRoute(activity, range), `case ${index}`).toBe(drawn);
    }
  });
});
