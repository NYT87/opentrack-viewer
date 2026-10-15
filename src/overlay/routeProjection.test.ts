import { describe, expect, it } from 'vitest';
import { projectRoute } from './routeProjection';
import { makeActivity } from '../test/helpers/activity';

const inBox = ([x, y]: [number, number]) => x >= 0 && x <= 1 && y >= 0 && y <= 1;

describe('projectRoute (AV-1004)', () => {
  it('fits a route inside the box without clipping, whatever the aspect', () => {
    const activity = makeActivity([
      { lat: 10, lon: 20 },
      { lat: 10.5, lon: 20.01 },
      { lat: 11, lon: 20 },
    ]);
    for (const aspect of [0.4, 1, 3]) {
      const route = projectRoute(activity, aspect)!;
      expect(route.segments.flat().every(inBox)).toBe(true);
    }
  });

  it('draws north up and keeps the aspect of the ground', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 0.5, lon: 0.5 },
        { lat: 0.6, lon: 0.5 },
      ]),
      1,
    )!;
    const [south, north] = route.segments[0]!;
    expect(north![1]).toBeLessThan(south![1]);
    expect(north![0]).toBeCloseTo(south![0]);
  });

  it('keeps a route across the antimeridian in one piece', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 1, lon: 179.9 },
        { lat: 1.1, lon: -179.9 },
      ]),
      1,
    )!;
    const xs = route.segments.flat().map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.9);
    expect(xs.every((x) => x >= 0 && x <= 1)).toBe(true);
  });

  it('centres a single place, and refuses an empty or invalid route', () => {
    const one = projectRoute(makeActivity([{ lat: 5, lon: 5 }]), 2)!;
    expect(one.segments[0]![0]).toEqual([0.5, 0.5]);
    expect(projectRoute(makeActivity([{ elevationMeters: 3 }]), 1)).toBeUndefined();
    expect(projectRoute(makeActivity([{ lat: 95, lon: 5 }, { lat: 0, lon: 0 }]), 1)).toBeUndefined();
    expect(projectRoute(makeActivity([{ lat: 5, lon: 5 }]), 0)).toBeUndefined();
  });

  it('splits at recorded segment boundaries', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 1, lon: 1, segmentIndex: 0 },
        { lat: 1.1, lon: 1.1, segmentIndex: 0 },
        { lat: 1.2, lon: 1.2, segmentIndex: 1 },
      ]),
      1,
    )!;
    expect(route.segments.map((s) => s.length)).toEqual([2, 1]);
  });

  it('splits the route at an invalid fix instead of joining across it', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 1, lon: 1 },
        { lat: 1.1, lon: 1.1 },
        { lat: 95, lon: 1.2 }, // invalid
        { elevationMeters: 5 }, // no fix
        { lat: 1.3, lon: 1.3 },
        { lat: 1.4, lon: 1.4 },
      ]),
      1,
    )!;
    expect(route.segments.map((segment) => segment.length)).toEqual([2, 2]);
  });
});
