import { describe, expect, it } from 'vitest';
import { domainFromPointRange, pointRangeFromDomain } from './range';
import { makeActivity } from '../test/helpers/activity';

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
