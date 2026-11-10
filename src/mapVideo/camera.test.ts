import { describe, expect, it } from 'vitest';
import { buildCameraPath, lerpBearing, MAX_TURN_DEGREES_PER_METER, type MapVideoCameraSettings } from './camera';
import { buildMapVideoRoute } from './route';
import { activityThrough, straightNorth, type TestPoint } from '../test/helpers/mapVideoRoutes';

const settings = (patch: Partial<MapVideoCameraSettings> = {}): MapVideoCameraSettings => ({
  zoom: 14.5,
  pitch: 45,
  bearing: 'follow',
  smoothingMeters: 300,
  ...patch,
});
const viewport = { width: 1920, height: 1080 };
const pathOf = (points: TestPoint[], patch?: Partial<MapVideoCameraSettings>, elevationScale?: number) => {
  const route = buildMapVideoRoute(activityThrough(points))!;
  return { route, path: buildCameraPath(route, settings(patch), viewport, elevationScale) };
};
/** The signed shortest turn from `a` to `b`, in degrees. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;
const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('the follow camera (AV-1203)', () => {
  it('looks along the route: north going north, east going east', () => {
    expect(pathOf(straightNorth(1000)).path.follow(500).bearing).toBeCloseTo(0, 3);
    const east = Array.from({ length: 101 }, (_, i) => ({ north: 0, east: i * 10 }));
    expect(pathOf(east).path.follow(500).bearing).toBeCloseTo(90, 1);
  });

  it('centres on the marker, at the set zoom and pitch', () => {
    const { route, path } = pathOf(straightNorth(1000));
    const camera = path.follow(321);
    const place = route.vertices[0]!;
    expect(camera.center[0]).toBeCloseTo(place.lon, 9);
    expect(camera).toMatchObject({ zoom: 14.5, pitch: 45 });
  });

  it('holds pitch to 0–60 degrees', () => {
    expect(pathOf(straightNorth(1000), { pitch: 80 }).path.follow(10).pitch).toBe(60);
    expect(pathOf(straightNorth(1000), { pitch: -5 }).path.follow(10).pitch).toBe(0);
  });

  it('keeps north up when asked', () => {
    const east = Array.from({ length: 101 }, (_, i) => ({ north: 0, east: i * 10 }));
    expect(pathOf(east, { bearing: 'north' }).path.follow(500).bearing).toBe(0);
  });

  it('does not twitch on a noisy straight', () => {
    const random = mulberry(7);
    // GPS noise of ±4 m across a point every 5 m: raw headings swing by up to ~80°.
    const noisy = Array.from({ length: 401 }, (_, i) => ({ north: i * 5, east: (random() - 0.5) * 8 }));
    const { path } = pathOf(noisy);
    for (let d = 400; d <= 1600; d += 10) expect(Math.abs(turn(0, path.follow(d).bearing))).toBeLessThan(1);
  });

  it('turns through a hairpin no faster than the limit, and comes out facing back', () => {
    // North 1 km, a 20 m-wide U-turn, south 1 km.
    const up = Array.from({ length: 101 }, (_, i) => ({ north: i * 10, east: 0 }));
    const bend = Array.from({ length: 9 }, (_, k) => {
      const a = (Math.PI * (k + 1)) / 10;
      return { north: 1000 + 10 * Math.sin(a), east: 10 - 10 * Math.cos(a) };
    });
    const down = Array.from({ length: 101 }, (_, i) => ({ north: 1000 - i * 10, east: 20 }));
    const { route, path } = pathOf([...up, ...bend, ...down]);
    let previous = path.follow(0).bearing;
    for (let d = 1; d <= route.totalMeters; d += 1) {
      const bearing = path.follow(d).bearing;
      expect(Math.abs(turn(previous, bearing))).toBeLessThanOrEqual(MAX_TURN_DEGREES_PER_METER + 1e-9);
      previous = bearing;
    }
    expect(Math.abs(turn(180, path.follow(route.totalMeters).bearing))).toBeLessThan(2);
  });

  it('turns through north the short way, never round by the south', () => {
    // Heading 340° for 1 km, then 20° for 1 km: a 40° turn across north.
    const rad = Math.PI / 180;
    const points: TestPoint[] = [];
    for (let i = 0; i <= 100; i += 1) points.push({ north: i * 10 * Math.cos(340 * rad), east: i * 10 * Math.sin(340 * rad) });
    const corner = points[points.length - 1]!;
    for (let i = 1; i <= 100; i += 1) points.push({ north: corner.north + i * 10 * Math.cos(20 * rad), east: corner.east + i * 10 * Math.sin(20 * rad) });
    const { route, path } = pathOf(points);
    for (let d = 0; d <= route.totalMeters; d += 5) {
      const bearing = path.follow(d).bearing;
      expect(bearing >= 0 && bearing < 360).toBe(true);
      expect(Math.abs(turn(0, bearing))).toBeLessThanOrEqual(20.5);
    }
  });

  it('interpolates bearings the short way round', () => {
    expect(lerpBearing(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpBearing(10, 350, 0.25)).toBeCloseTo(5, 9);
  });
});

describe('the camera height (AV-1203, TD-064)', () => {
  const climbing = straightNorth(2000).map((point) => ({ ...point, elevation: 100 + point.north / 10 }));

  it('comes from the route\'s elevation, smoothed and exaggerated', () => {
    const { path } = pathOf(climbing, {}, 1.5);
    expect(path.follow(1000).elevation).toBeCloseTo(200 * 1.5, 0);
  });

  it('is left to the map on a flat map, or a route without elevation', () => {
    expect(pathOf(climbing).path.follow(1000).elevation).toBeUndefined();
    expect(pathOf(straightNorth(2000), {}, 1.5).path.follow(1000).elevation).toBeUndefined();
  });
});

describe('the overview, the intro and the outro (AV-1203)', () => {
  const { route, path } = pathOf(straightNorth(5000));

  it('fits the whole route in the frame, looking straight down with north up', () => {
    const { overview } = path;
    expect(overview).toMatchObject({ pitch: 0, bearing: 0 });
    const middle = (route.vertices[0]!.lat + route.vertices[route.vertices.length - 1]!.lat) / 2;
    expect(overview.center[1]).toBeCloseTo(middle, 4);
    // 5 km tall in 1080 px less 8% padding top and bottom: about 5.6 m a pixel at 46° N.
    const metersPerPixel = (40_075_016.7 * Math.cos((46 * Math.PI) / 180)) / (512 * 2 ** overview.zoom);
    expect(5000 / metersPerPixel).toBeCloseTo(1080 - 2 * Math.round(1080 * 0.08), -1);
  });

  it('flies from the overview to the start, and from the end back to it', () => {
    expect(path.at({ phase: 'intro', phaseProgress: 0, distance: 0, paused: false })).toEqual(path.overview);
    const arrived = path.at({ phase: 'intro', phaseProgress: 1, distance: 0, paused: false });
    expect(arrived.zoom).toBeCloseTo(path.follow(0).zoom, 9);
    expect(arrived.center[1]).toBeCloseTo(path.follow(0).center[1], 9);
    const gone = path.at({ phase: 'outro', phaseProgress: 1, distance: route.totalMeters, paused: false });
    expect(gone.zoom).toBeCloseTo(path.overview.zoom, 9);
    expect(gone.center[1]).toBeCloseTo(path.overview.center[1], 9);
  });
});
