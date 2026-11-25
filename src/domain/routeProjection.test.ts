import { describe, expect, it } from 'vitest';
import type { ActivityPoint } from './activity';
import { projectRoute } from './routeProjection';

const at = (lat: number, lon: number, extra: Partial<ActivityPoint> = {}, index = 0): ActivityPoint => ({
  index,
  lat,
  lon,
  ...extra,
});
const box = { width: 400, height: 300, padding: 20 };

const allPoints = (route: ReturnType<typeof projectRoute>) => route.segments.flat();

describe('route projection (AV-1009)', () => {
  it('fits the route inside the padding on every side', () => {
    const route = projectRoute(
      [at(42, -8), at(42.05, -8), at(42.05, -7.9), at(42.1, -7.95)],
      box,
    );
    const xs = allPoints(route).map((p) => p.x);
    const ys = allPoints(route).map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(380 + 1e-6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(20 - 1e-6);
    expect(Math.max(...ys)).toBeLessThanOrEqual(280 + 1e-6);
    // It uses the room it has: one axis touches its limit.
    const touches =
      Math.abs(Math.min(...xs) - 20) < 1e-6 ||
      Math.abs(Math.min(...ys) - 20) < 1e-6;
    expect(touches).toBe(true);
  });

  it('draws north up and east right', () => {
    const route = projectRoute([at(42, -8), at(42.1, -7.9)], box);
    const [south, north] = [route.segments[0]![0]!, route.segments[0]![1]!];
    expect(north.y).toBeLessThan(south.y);
    expect(north.x).toBeGreaterThan(south.x);
  });

  it('keeps the shape: equal spans in metres are not stretched', () => {
    // About 1 km north and 1 km east at 42°N: a square in the world.
    const dLon = 1 / (111.32 * Math.cos((42 * Math.PI) / 180));
    const route = projectRoute(
      [at(42, -8), at(42.009, -8), at(42.009, -8 + dLon), at(42, -8 + dLon)],
      { width: 500, height: 500, padding: 0 },
    );
    const xs = allPoints(route).map((p) => p.x);
    const ys = allPoints(route).map((p) => p.y);
    expect((Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys))).toBeCloseTo(1, 1);
  });

  it('centres a route that is narrower than the image', () => {
    const route = projectRoute([at(42, -8), at(42.1, -8)], box);
    const xs = allPoints(route).map((p) => p.x);
    expect(xs[0]).toBeCloseTo(200, 5);
  });

  it('draws a single point at the centre, and a route that never moves the same', () => {
    const one = projectRoute([at(42, -8)], box);
    expect(one.start).toEqual({ x: 200, y: 150 });
    expect(one.end).toEqual({ x: 200, y: 150 });
    const still = projectRoute([at(42, -8), at(42, -8, {}, 1)], box);
    expect(still.start).toEqual({ x: 200, y: 150 });
  });

  it('unwraps a route that crosses the antimeridian into one run', () => {
    const route = projectRoute([at(0.5, 179.9), at(0.5, -179.9, {}, 1)], box);
    const [a, b] = route.segments[0]!;
    // 0.2° apart, not 359.8°: they are neighbours, with the east end to the right.
    expect(b!.x).toBeGreaterThan(a!.x);
    expect(b!.x - a!.x).toBeGreaterThan(300);
    expect(Math.max(a!.x, b!.x)).toBeLessThanOrEqual(380 + 1e-6);
  });

  it('keeps recorded segments apart, and reports where it starts and ends', () => {
    const route = projectRoute(
      [at(42, -8, { segmentIndex: 0 }), at(42.01, -8, { segmentIndex: 0 }, 1), at(42.02, -8, { segmentIndex: 1 }, 2), at(42.03, -8, { segmentIndex: 1 }, 3)],
      box,
    );
    expect(route.segments.map((s) => s.length)).toEqual([2, 2]);
    expect(route.start).toBe(route.segments[0]![0]);
    expect(route.end).toBe(route.segments[1]![1]);
  });

  it('skips points with no usable position', () => {
    const route = projectRoute([{ index: 0 }, at(42, -8, {}, 1), at(95, 0, {}, 2), at(42.1, -8, {}, 3), at(0, 0, {}, 4)], box);
    expect(allPoints(route)).toHaveLength(2);
  });

  it('refuses an empty route and a padding that leaves no room', () => {
    expect(() => projectRoute([], box)).toThrow(/no GPS/);
    expect(() => projectRoute([{ index: 0 }], box)).toThrow(/no GPS/);
    expect(() => projectRoute([at(42, -8)], { width: 40, height: 300, padding: 20 })).toThrow(/padding/);
  });

  it('handles a route near the pole without producing non-finite numbers', () => {
    const route = projectRoute([at(89.9, 0), at(89.99, 10, {}, 1)], box);
    for (const p of allPoints(route)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});
