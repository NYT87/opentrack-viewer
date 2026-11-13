import { describe, expect, it } from 'vitest';
import { toValidCoordinate } from '../domain/activity';
import { MIN_TRIMMED_ROUTE_METERS } from '../mapVideo/route';
import { activityThrough, METERS_PER_DEGREE, straightNorth } from '../test/helpers/mapVideoRoutes';
import { makeActivity } from '../test/helpers/activity';
import { extractRoute } from './routeImage';
import { projectRoute } from './routeProjection';
import {
  hasPrivacyTrim,
  keptRoute,
  markerVisible,
  minimumKeptText,
  readPrivacyTrim,
  routeTotalMeters,
  sampleActivityMs,
  shareOfRouteText,
  type KeptRoute,
} from './privacyTrim';

const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
const kept = (...args: Parameters<typeof keptRoute>) => keptRoute(...args) as KeptRoute;
const northOf = (lat: number) => (lat - 46) * METERS_PER_DEGREE;

describe('the privacy trim cuts the route by shares of its distance (AV-1022, TD-091)', () => {
  const ride = activityThrough(straightNorth(1000, 10, 5));

  it('hides nothing at 0 %, and hands back the activity itself', () => {
    expect(kept(ride, undefined).activity).toBe(ride);
    expect(kept(ride, { start: 0, end: 0 }).activity).toBe(ride);
    expect(hasPrivacyTrim({ start: 0, end: 0 })).toBe(false);
    expect(kept(ride, undefined).startMs).toBeUndefined();
    expect(keptRoute(undefined, { start: 0.1, end: 0 })).toBeUndefined();
  });

  it('cuts the start and the end at their shares, interpolated exactly that far in', () => {
    const result = kept(ride, { start: 0.1, end: 0.2 });
    const total = routeTotalMeters(ride);
    expect(result.totalMeters).toBeCloseTo(total, 6);
    expect(result.hiddenMeters.start).toBeCloseTo(0.1 * total, 6);
    expect(result.hiddenMeters.end).toBeCloseTo(0.2 * total, 6);
    const points = result.activity.points;
    expect(northOf(points[0]!.lat!)).toBeCloseTo(100, 0);
    expect(northOf(points[points.length - 1]!.lat!)).toBeCloseTo(800, 0);
    // The route is a straight ride at 5 m/s: the cut ends carry the times of those places.
    expect(result.startMs).toBeCloseTo(T0 + 20_000, -1);
    expect(result.endMs).toBeCloseTo(T0 + 160_000, -1);
    expect(routeTotalMeters(result.activity)).toBeCloseTo(0.7 * total, 0);
  });

  it('cuts a cut vertex between two points: 7.5 % of a route of 10 m steps is 75 m in', () => {
    const result = kept(ride, { start: 0.075, end: 0 });
    expect(northOf(result.activity.points[0]!.lat!)).toBeCloseTo(75, 0);
    expect(result.startMs).toBeCloseTo(T0 + 15_000, -1);
    expect(result.endMs).toBeUndefined();
  });

  it('cuts one end alone', () => {
    const endOnly = kept(ride, { start: 0, end: 0.3 });
    expect(endOnly.startMs).toBeUndefined();
    expect(endOnly.endMs).toBeCloseTo(T0 + 140_000, -1);
    expect(northOf(endOnly.activity.points[0]!.lat!)).toBeCloseTo(0, 3);
  });

  it('cuts both ends at once at the most each may hide, leaving the tenth between them', () => {
    const long = activityThrough(straightNorth(2000, 10, 5));
    const result = kept(long, { start: 0.45, end: 0.45 });
    expect(routeTotalMeters(result.activity)).toBeCloseTo(200, 0);
    expect(northOf(result.activity.points[0]!.lat!)).toBeCloseTo(900, 0);
  });

  it('keeps the break between two recordings inside a kept part', () => {
    const broken = activityThrough([
      ...straightNorth(500, 50, 5).map((point) => ({ ...point, segment: 0 })),
      ...straightNorth(500, 50, 5).map((point) => ({ ...point, north: point.north + 5000, second: 200 + (point.second ?? 0), segment: 1 })),
    ]);
    // 1000 m of route (no distance counts across the gap): 10 % off each end leaves 800 m, across the break.
    expect(routeTotalMeters(broken)).toBeCloseTo(1000, 0);
    const result = kept(broken, { start: 0.1, end: 0.1 });
    expect(new Set(result.activity.points.map((point) => point.segmentIndex))).toEqual(new Set([0, 1]));
    expect(projectRoute(result.activity, 1)!.segments).toHaveLength(2);
    const extracted = extractRoute(result.activity);
    expect(extracted.ok && extracted.route.runs).toHaveLength(2);
  });

  it('is too short, and draws nothing, when less than 100 m would be left', () => {
    const short = activityThrough(straightNorth(150, 10, 5));
    const result = keptRoute(short, { start: 0.2, end: 0.2 });
    expect(result).toMatchObject({ tooShort: true });
    expect(MIN_TRIMMED_ROUTE_METERS).toBe(100);
    // Just enough left is drawn.
    expect(keptRoute(short, { start: 0.1, end: 0.1 })).not.toMatchObject({ tooShort: true });
  });

  it('is too short for a route of one place: there is no distance to share, and that place may be the one to hide', () => {
    expect(keptRoute(makeActivity([{ lat: 46, lon: 7 }]), { start: 0.1, end: 0 })).toMatchObject({ tooShort: true });
  });

  it('carries only the places: no laps, events or sensor streams', () => {
    const result = kept({ ...ride, laps: [{ index: 0 }], events: [{ type: 'lap' } as never] }, { start: 0.1, end: 0 });
    expect(result.activity.laps).toBeUndefined();
    expect(result.activity.events).toBeUndefined();
    expect(result.activity.sensorStreams).toBeUndefined();
  });

  it('joins across a point with no location inside a kept part, as the map video\u2019s route does', () => {
    const dropout = makeActivity([...straightNorth(500, 50, 5).slice(0, 5).map((p) => ({ lat: 46 + p.north / METERS_PER_DEGREE, lon: 7 })), {}, ...straightNorth(500, 50, 5).slice(6).map((p) => ({ lat: 46 + p.north / METERS_PER_DEGREE, lon: 7 }))]);
    const result = kept(dropout, { start: 0.1, end: 0.1 });
    expect(result.activity.points.every((p) => p.lat !== undefined)).toBe(true);
    expect(projectRoute(result.activity, 1)!.segments).toHaveLength(1);
  });

  it('is made once per activity and trim', () => {
    const a = keptRoute(ride, { start: 0.1, end: 0.1 });
    expect(keptRoute(ride, { start: 0.1, end: 0.1 })).toBe(a);
    expect(keptRoute(ride, { start: 0.1, end: 0.2 })).not.toBe(a);
  });

  it('gives the projection and the fit only the kept part', () => {
    // 200 m east, 600 m north, 200 m east: the hidden ends are the only part with any width.
    const bent = activityThrough([
      ...Array.from({ length: 5 }, (_, i) => ({ north: 0, east: i * 50, second: i * 10 })),
      ...Array.from({ length: 13 }, (_, i) => ({ north: (i + 1) * 50, east: 200, second: 50 + i * 10 })),
      ...Array.from({ length: 4 }, (_, i) => ({ north: 650, east: 200 + (i + 1) * 50, second: 180 + i * 10 })),
    ]);
    const whole = projectRoute(bent, 1)!;
    const wholeXs = whole.segments.flat().map(([x]) => x);
    expect(Math.max(...wholeXs) - Math.min(...wholeXs)).toBeGreaterThan(0.3);

    const total = routeTotalMeters(bent);
    const result = kept(bent, { start: 200 / total, end: 200 / total });
    const fitted = projectRoute(result.activity, 1)!;
    const xs = fitted.segments.flat().map(([x]) => x);
    const ys = fitted.segments.flat().map(([, y]) => y);
    // A straight line north, centred, filling the box's height: the hidden turns leave no margin to guess from.
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.01);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8);
    const image = extractRoute(result.activity);
    expect(image.ok && image.route.bounds.maxLon - image.route.bounds.minLon).toBeLessThan(1e-4);
  });

  it('keeps coordinates valid across the antimeridian', () => {
    const crossing = makeActivity(
      Array.from({ length: 21 }, (_, i) => ({
        lat: 1,
        lon: ((179.99 + i * 0.001 + 540) % 360) - 180,
        time: new Date(T0 + i * 10_000),
      })),
    );
    const result = kept(crossing, { start: 0.2, end: 0.2 });
    for (const point of result.activity.points) expect(toValidCoordinate(point.lat, point.lon)).toBeDefined();
    const fitted = projectRoute(result.activity, 1)!;
    const xs = fitted.segments.flat().map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
  });
});

describe('the marker is hidden in a hidden stretch (AV-1022, TD-091)', () => {
  const ride = activityThrough(straightNorth(1000, 10, 5));
  const result = kept(ride, { start: 0.1, end: 0.2 });

  it('shows between the cuts, and not before the first or after the last', () => {
    expect(markerVisible(result, T0 + 20_000 + 1)).toBe(true);
    expect(markerVisible(result, T0 + 100_000)).toBe(true);
    expect(markerVisible(result, T0 + 5_000)).toBe(false);
    expect(markerVisible(result, T0 + 190_000)).toBe(false);
  });

  it('always shows with no trim, and checks only the end that is cut', () => {
    expect(markerVisible(kept(ride, undefined), T0 - 1e6)).toBe(true);
    const startOnly = kept(ride, { start: 0.1, end: 0 });
    expect(markerVisible(startOnly, T0 + 199_000)).toBe(true);
    expect(markerVisible(startOnly, T0 + 5_000)).toBe(false);
  });

  it('shows nothing when the moment cannot be told', () => {
    expect(markerVisible(result, undefined)).toBe(false);
    expect(markerVisible(result, Number.NaN)).toBe(false);
    const untimed = kept(activityThrough(straightNorth(1000, 10, 5).map(({ north, east }) => ({ north, east }))), { start: 0.1, end: 0 });
    expect(untimed.untimed).toBe(true);
    expect(markerVisible(untimed, T0 + 100_000)).toBe(false);
  });

  it('reads a sample on the activity clock', () => {
    expect(sampleActivityMs({ activityStartMs: 1000 }, { activityElapsedSeconds: 2.5 })).toBe(3500);
    expect(sampleActivityMs({}, { activityElapsedSeconds: 2.5 })).toBeUndefined();
  });
});

describe('reading a trim (AV-1022, TD-091)', () => {
  it('clamps each share to 0..45 % and a tenth of a percent, and drops a trim that hides nothing', () => {
    expect(readPrivacyTrim({ start: 0.9, end: -1 })).toEqual({ start: 0.45, end: 0 });
    expect(readPrivacyTrim({ start: 0.12345, end: 0.2 })).toEqual({ start: 0.123, end: 0.2 });
    expect(readPrivacyTrim({ start: 0, end: 0 })).toBeUndefined();
    expect(readPrivacyTrim({ start: 'x', end: Number.NaN })).toBeUndefined();
    expect(readPrivacyTrim(undefined)).toBeUndefined();
    expect(readPrivacyTrim([0.1, 0.1])).toBeUndefined();
  });

  it('words the shortest route kept in the reader’s units, and a length as a share of the route', () => {
    expect(minimumKeptText('metric')).toBe('100 m');
    expect(minimumKeptText('imperial')).toBe('330 ft');
    expect(shareOfRouteText(40, 1000)).toBe('4 % of the route');
    expect(shareOfRouteText(12.5, 1000)).toBe('1.3 % of the route');
    expect(shareOfRouteText(5000, 1000)).toBe('100 % of the route');
    expect(shareOfRouteText(10, 0)).toBe('');
  });
});
