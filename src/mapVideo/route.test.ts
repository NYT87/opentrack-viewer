import { describe, expect, it } from 'vitest';
import { buildMapVideoRoute, positionAt, revealAt, simplifiedIndices, trimRoute, MIN_TRIMMED_ROUTE_METERS } from './route';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { makeActivity } from '../test/helpers/activity';

const routeOf = (...args: Parameters<typeof activityThrough>) => buildMapVideoRoute(activityThrough(...args))!;

describe('the route a map video follows (AV-1203)', () => {
  it('is the located points, with the distance along them', () => {
    const route = buildMapVideoRoute(makeActivity([{ lat: 46, lon: 7 }, {}, { lat: 46.001, lon: 7 }, { lat: 46.002, lon: 7 }]))!;
    expect(route.vertices.map((vertex) => vertex.pointIndex)).toEqual([0, 2, 3]);
    expect(route.totalMeters).toBeCloseTo(222.4, 0);
  });

  it('counts no distance across a gap between recorded segments', () => {
    const route = routeOf([
      { north: 0, east: 0, segment: 0 },
      { north: 100, east: 0, segment: 0 },
      { north: 5000, east: 0, segment: 1 },
      { north: 5100, east: 0, segment: 1 },
    ]);
    expect(route.vertices.map((vertex) => Math.round(vertex.distance))).toEqual([0, 100, 100, 200]);
  });

  it('is not a route with fewer than two located points', () => {
    expect(buildMapVideoRoute(makeActivity([{ lat: 46, lon: 7 }, {}]))).toBeUndefined();
  });

  it('interpolates a place between points, and holds at the ends', () => {
    const route = routeOf([{ north: 0, east: 0, second: 0, elevation: 100 }, { north: 100, east: 0, second: 20, elevation: 120 }]);
    const middle = positionAt(route, 25);
    expect(middle.fraction).toBeCloseTo(25 / route.totalMeters, 9);
    expect(middle.elevation).toBeCloseTo(100 + 20 * middle.fraction, 9);
    expect(middle.time! - route.vertices[0]!.time!).toBeCloseTo(20_000 * middle.fraction, 3);
    expect(positionAt(route, -10).distance).toBe(0);
    expect(positionAt(route, 1e9).distance).toBeCloseTo(route.totalMeters, 9);
  });

  it('jumps across a gap to the next segment\'s start', () => {
    const route = routeOf([
      { north: 0, east: 0, segment: 0 },
      { north: 100, east: 0, segment: 0 },
      { north: 5000, east: 0, segment: 1 },
      { north: 5100, east: 0, segment: 1 },
    ]);
    const gap = route.vertices[1]!.distance;
    expect(positionAt(route, gap).lat).toBeCloseTo(route.vertices[2]!.lat, 9);
    expect(positionAt(route, gap - 0.01).lat).toBeLessThan(route.vertices[1]!.lat);
  });
});

describe('the reveal and the marker (AV-1203)', () => {
  const route = routeOf(straightNorth(1000, 37));

  it('end where the marker is, exactly, wherever it is', () => {
    for (let d = 0; d <= route.totalMeters; d += 13.7) {
      const { lines, marker } = revealAt(route, d);
      const last = lines[lines.length - 1]!;
      expect(last[last.length - 1]).toEqual(marker);
      const place = positionAt(route, d);
      expect(marker).toEqual([place.lon, place.lat]);
    }
  });

  it('starts with the start alone, and ends with the whole route', () => {
    expect(revealAt(route, 0).lines).toEqual([[[route.vertices[0]!.lon, route.vertices[0]!.lat]]]);
    const all = revealAt(route, route.totalMeters).lines.flat();
    expect(all).toHaveLength(route.vertices.length);
  });

  it('draws no line across a gap between segments', () => {
    const gapped = routeOf([
      { north: 0, east: 0, segment: 0 },
      { north: 100, east: 0, segment: 0 },
      { north: 5000, east: 0, segment: 1 },
      { north: 5100, east: 0, segment: 1 },
    ]);
    const { lines } = revealAt(gapped, 150);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(2);
    expect(lines[1]).toHaveLength(2);
  });
});

describe('the privacy trim (AV-1203)', () => {
  const full = routeOf(straightNorth(2000, 30));

  it('starts and ends exactly that far in, and measures from the new start', () => {
    const trimmed = trimRoute(full, 200, 300)!;
    expect(trimmed.totalMeters).toBeCloseTo(full.totalMeters - 500, 6);
    expect(trimmed.vertices[0]!.distance).toBe(0);
    const start = positionAt(full, 200);
    expect([trimmed.vertices[0]!.lon, trimmed.vertices[0]!.lat]).toEqual([start.lon, start.lat]);
    const end = positionAt(full, full.totalMeters - 300);
    const last = trimmed.vertices[trimmed.vertices.length - 1]!;
    expect(last.lat).toBeCloseTo(end.lat, 12);
  });

  it('keeps no place from the trimmed stretches', () => {
    const trimmed = trimRoute(full, 200, 300)!;
    const lowest = positionAt(full, 200).lat;
    const highest = positionAt(full, full.totalMeters - 300).lat;
    for (const vertex of trimmed.vertices) {
      expect(vertex.lat).toBeGreaterThanOrEqual(lowest - 1e-12);
      expect(vertex.lat).toBeLessThanOrEqual(highest + 1e-12);
    }
  });

  it('is the route itself when nothing is trimmed, and nothing when too little would be left', () => {
    expect(trimRoute(full, 0, 0)).toBe(full);
    expect(trimRoute(full, 1000, full.totalMeters - 1000 - MIN_TRIMMED_ROUTE_METERS + 1)).toBeUndefined();
  });
});

describe('the simplified line (AV-1204)', () => {
  const random = (() => {
    let seed = 3;
    return () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
  })();
  // A wiggly 5 km ride, a point every 2 m.
  const wiggly = routeOf(
    Array.from({ length: 2501 }, (_, i) => ({ north: i * 2, east: Math.sin(i / 40) * 30 + (random() - 0.5) * 0.4 })),
  );

  it('keeps far fewer points, and none of the dropped ones strays past the tolerance', () => {
    const kept = simplifiedIndices(wiggly, 2);
    expect(kept.length).toBeLessThan(wiggly.vertices.length / 5);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(wiggly.vertices.length - 1);
  });

  it('still ends exactly at the marker, wherever it is', () => {
    const kept = simplifiedIndices(wiggly, 2);
    for (let d = 0; d <= wiggly.totalMeters; d += 77.7) {
      const { lines, marker } = revealAt(wiggly, d, kept);
      const last = lines[lines.length - 1]!;
      expect(last[last.length - 1]).toEqual(marker);
      expect(marker).toEqual(revealAt(wiggly, d).marker);
    }
  });

  it('keeps each segment\'s ends, so no line joins two recordings', () => {
    const gapped = routeOf([
      ...straightNorth(500, 5).map((point) => ({ ...point, segment: 0 })),
      ...straightNorth(500, 5).map((point) => ({ north: 3000 + point.north, east: 0, segment: 1 })),
    ]);
    const kept = simplifiedIndices(gapped, 5);
    expect(kept).toEqual([0, 100, 101, 201]);
    expect(revealAt(gapped, gapped.totalMeters, kept).lines).toHaveLength(2);
  });
});
