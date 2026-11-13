import { describe, expect, it } from 'vitest';
import { activityThrough, straightNorth, METERS_PER_DEGREE, type TestPoint } from '../test/helpers/mapVideoRoutes';
import {
  INSET_REFERENCE_PX,
  buildInsetRoute,
  createInsetModels,
  createInsetProjection,
  endBearing,
  fitCamera,
  fromMercator,
  headingFreeMs,
  insetFrame,
  insetScale,
  lowerIndex,
  mapInsetIds,
  cappedMapIds,
  mercator,
  splitIndex,
} from './insetCamera';
import { DEFAULT_ROUTE_INSET, parseRouteInsetSetting, type OverlayRouteInsetSetting } from './routeInset';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayComponent, type OverlayTemplate } from './template';
import { buildOverlayTimeline } from './timeline';

/**
 * AV-1023 (TD-092). The inset's camera and projection, pure: the Mercator projection against the
 * numbers MapLibre's own `map.project` gives (computed once, in Chromium, on a 400 x 300 map of an
 * empty style: `jumpTo({ center, zoom, bearing, pitch: 0 })`, then `project([lon, lat])`), the position
 * held in the centre while following, the heading, the trim.
 */

describe('the Web Mercator projection is MapLibre’s', () => {
  // [centre, zoom, bearing, [lon, lat, x, y]...] as `map.project` returned them, 400 x 300 pixels.
  const reference: [[number, number], number, number, [number, number, number, number][]][] = [
    [[7, 46], 15, 0, [[7.001, 46.002, 246.6033777777354, 15.821180390252007], [7.0123, 46.0045, 773.2215466658274, -151.90916528701783], [6.995, 45.997, -33.01688888867696, 351.25913572735254]]],
    [[7, 46], 15, 90, [[7.001, 46.002, 65.82118039025201, 103.39662222226461], [7.0123, 46.0045, -101.90916528701783, -423.2215466658274], [6.995, 45.997, 401.25913572735254, 383.016888888677]]],
    [[7.0123, 46.0045], 13.4, 237.5, [[7.001, 46.002, 246.67409470505186, -26.242286881075966], [7.0123, 46.0045, 199.9999999994702, 150], [6.995, 45.997, 202.91075355794695, -163.49090981059604]]],
    [[-122.4194, 37.7749], 17, 30, [[-122.42, 37.776, -26.576299862331815, -18.745449814266628]]],
    [[151.2093, -33.8688], 10, 359, [[151.21, -33.867, 201.07439307894973, 146.86114606002965]]],
  ];

  it.each(reference)('at %j, zoom %s, bearing %s', (center, zoom, bearing, points) => {
    const projection = createInsetProjection({ center, zoom, bearing }, 400, 300);
    for (const [lon, lat, x, y] of points) {
      const [px, py] = projection.project(lon, lat);
      expect(px).toBeCloseTo(x, 3);
      expect(py).toBeCloseTo(y, 3);
    }
  });

  it('puts the camera’s own centre in the middle of the box, at any scale', () => {
    for (const scale of [0.4, 1, 2]) {
      const [x, y] = createInsetProjection({ center: [7.5, 46.5], zoom: 12, bearing: 123 }, 300, 200, scale).project(7.5, 46.5);
      expect(x).toBeCloseTo(150, 6);
      expect(y).toBeCloseTo(100, 6);
    }
  });

  it('draws the same ground larger at a larger scale: a frame twice the size has twice the pixels between two places', () => {
    const camera = { center: [7, 46] as [number, number], zoom: 15, bearing: 40 };
    const a = createInsetProjection(camera, 300, 300, 1).project(7.001, 46.001);
    const b = createInsetProjection(camera, 600, 600, 2).project(7.001, 46.001);
    expect(b[0] - 300).toBeCloseTo((a[0] - 150) * 2, 6);
    expect(b[1] - 300).toBeCloseTo((a[1] - 150) * 2, 6);
  });

  it('turns so the bearing is up: heading east puts east above the centre', () => {
    const camera = { center: [7, 46] as [number, number], zoom: 15, bearing: 90 };
    const [x, y] = createInsetProjection(camera, 200, 200).project(7.001, 46);
    expect(x).toBeCloseTo(100, 3);
    expect(y).toBeLessThan(100);
  });

  it('takes the nearest copy of the world, so a route across the antimeridian is one piece', () => {
    const camera = { center: [179.999, 0.5] as [number, number], zoom: 14, bearing: 0 };
    const projection = createInsetProjection(camera, 400, 300);
    const [x] = projection.project(-179.999, 0.5);
    expect(x - 200).toBeGreaterThan(0);
    expect(x - 200).toBeLessThan(100);
  });

  it('inverts the Mercator square', () => {
    const [x, y] = mercator(12.34, -56.78);
    const [lon, lat] = fromMercator(x, y);
    expect(lon).toBeCloseTo(12.34, 9);
    expect(lat).toBeCloseTo(-56.78, 9);
  });

  it('scales a frame by its shorter side over the 1080 reference', () => {
    expect(insetScale({ width: 1920, height: 1080 })).toBe(1);
    expect(insetScale({ width: 3840, height: 2160 })).toBe(2);
    expect(insetScale({ width: 1080, height: 1920 })).toBe(1);
    expect(INSET_REFERENCE_PX).toBe(1080);
  });
});

function templateOf(setting: OverlayRouteInsetSetting | undefined, privacyTrim?: OverlayTemplate['privacyTrim']): OverlayTemplate {
  const component: OverlayComponent = {
    id: 'route',
    type: 'routeInset',
    visible: true,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
    unitMode: 'auto',
    style: {},
    ...(setting ? { routeInset: setting } : {}),
  };
  return { version: OVERLAY_TEMPLATE_VERSION, name: 't', style: DEFAULT_OVERLAY_STYLE, components: [component], ...(privacyTrim ? { privacyTrim } : {}) };
}
const follow = (patch: Partial<OverlayRouteInsetSetting> = {}) => parseRouteInsetSetting({ ...DEFAULT_ROUTE_INSET, view: 'follow', ...patch });

/** A ride north at 5 m/s, then east: the heading is 0, then 90. */
const lShaped = (): TestPoint[] => [
  ...Array.from({ length: 21 }, (_, i) => ({ north: i * 5, east: 0, second: i })),
  ...Array.from({ length: 20 }, (_, i) => ({ north: 100, east: (i + 1) * 5, second: 21 + i })),
];

describe('the camera while following (AV-1023)', () => {
  const ride = activityThrough(straightNorth(1000, 10, 5));
  const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
  const make = (setting: OverlayRouteInsetSetting, trim?: OverlayTemplate['privacyTrim']) =>
    createInsetModels({ template: templateOf(setting, trim), timeline, activity: ride, width: 1920, height: 1080 }).get('route')!;

  it('holds the position in the centre at the zoom chosen, the route moving under it', () => {
    const model = make(follow({ zoom: 16 }));
    for (const t of [10, 50, 120]) {
      const moment = model.momentAt(t)!;
      const position = timeline.sampleAt(t)!.position!;
      expect(moment.camera.center[0]).toBeCloseTo(position.lon, 9);
      expect(moment.camera.center[1]).toBeCloseTo(position.lat, 9);
      expect(moment.camera.zoom).toBe(16);
      expect(moment.camera.bearing).toBe(0);
      expect(moment.marker).toEqual(position);
      const [x, y] = createInsetProjection(moment.camera, model.frame.w, model.frame.h, model.scale).project(position.lon, position.lat);
      expect(x).toBeCloseTo(model.frame.w / 2, 6);
      expect(y).toBeCloseTo(model.frame.h / 2, 6);
    }
  });

  it('clamps the zoom to 10 to 18 when read', () => {
    expect(parseRouteInsetSetting({ view: 'follow', zoom: 3 }).zoom).toBe(10);
    expect(parseRouteInsetSetting({ view: 'follow', zoom: 99 }).zoom).toBe(18);
    expect(parseRouteInsetSetting({ view: 'follow', zoom: 'x' }).zoom).toBe(15);
  });

  it('keeps north up unless heading up is chosen', () => {
    expect(make(follow({ orientation: 'north' })).momentAt(60)!.camera.bearing).toBe(0);
  });

  it('turns to the smoothed heading when heading up, and no bearing from nowhere before the heading is known', () => {
    const turning = activityThrough(lShaped());
    const turningTimeline = buildOverlayTimeline(turning, { video: { durationSeconds: 41 } });
    const model = createInsetModels({ template: templateOf(follow({ orientation: 'heading' })), timeline: turningTimeline, activity: turning, width: 1920, height: 1080 }).get('route')!;
    const north = model.momentAt(15)!.camera.bearing;
    expect(Math.min(north, 360 - north)).toBeLessThan(0.5);
    expect(model.momentAt(40)!.camera.bearing).toBeCloseTo(90, 0);
    // Through the corner the smoothed heading turns steadily, with no jump: no step is more than 40 degrees at a tenth of a second.
    let previous = model.momentAt(18)!.camera.bearing;
    for (let t = 18.1; t <= 30; t += 0.1) {
      const now = model.momentAt(t)!.camera.bearing;
      const step = Math.abs(((now - previous + 540) % 360) - 180);
      expect(step, `at ${t}`).toBeLessThan(40);
      previous = now;
    }
    // Before 20 m has been covered there is no heading: north up, not a swing.
    expect(model.momentAt(1)!.camera.bearing).toBe(0);
  });

  it('crosses 359 to 0 degrees without going the long way round', () => {
    // A ride at 350 degrees that bends to 10: the bearing passes through 0.
    const rad = (d: number) => (d * Math.PI) / 180;
    const points: TestPoint[] = [];
    let n = 0;
    let e = 0;
    for (let i = 0; i <= 24; i += 1) {
      points.push({ north: n, east: e, second: i });
      const h = i < 12 ? 350 : 10;
      n += 5 * Math.cos(rad(h));
      e += 5 * Math.sin(rad(h));
    }
    const bent = activityThrough(points);
    const bentTimeline = buildOverlayTimeline(bent, { video: { durationSeconds: 24 } });
    const model = createInsetModels({ template: templateOf(follow({ orientation: 'heading' })), timeline: bentTimeline, activity: bent, width: 1920, height: 1080 }).get('route')!;
    for (let t = 6; t <= 24; t += 0.25) {
      const bearing = model.momentAt(t)!.camera.bearing;
      expect(Math.min(bearing, 360 - bearing), `at ${t}`).toBeLessThan(25);
    }
  });

  it('holds the heading through a stop (TD-080): the bearing the stop began with', () => {
    const points: TestPoint[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ north: i * 5, east: 0, second: i })),
      ...Array.from({ length: 5 }, (_, i) => ({ north: 40, east: i * 5, second: 68 + i })),
    ];
    const stopped = activityThrough(points);
    const stopTimeline = buildOverlayTimeline(stopped, { video: { durationSeconds: 72 } });
    const model = createInsetModels({ template: templateOf(follow({ orientation: 'heading' })), timeline: stopTimeline, activity: stopped, width: 1920, height: 1080 }).get('route')!;
    const before = model.momentAt(8)!.camera.bearing;
    const during = model.momentAt(40)!.camera.bearing;
    expect(during).toBeCloseTo(before, 6);
  });

  it('frames the whole kept route when the view is the whole route, north up', () => {
    const model = make(parseRouteInsetSetting({ view: 'whole', orientation: 'heading', border: { width: 0.01 } }));
    const moment = model.momentAt(10)!;
    expect(moment.camera.bearing).toBe(0);
    expect(moment.camera).toEqual(model.fit);
    // Every vertex lies inside the frame.
    const projection = createInsetProjection(moment.camera, model.frame.w, model.frame.h, model.scale);
    for (let i = 0; i < model.route.count; i += 1) {
      const [x, y] = projection.toBox(model.route.x[i]!, model.route.y[i]!);
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(model.frame.w + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(model.frame.h + 1e-6);
    }
  });

  it('fits a round inset inside its circle', () => {
    const model = make(parseRouteInsetSetting({ shape: 'round' }));
    expect(model.frame.w).toBe(model.frame.h);
    const projection = createInsetProjection(model.fit, model.frame.w, model.frame.h, model.scale);
    const radius = model.frame.w / 2;
    for (let i = 0; i < model.route.count; i += 1) {
      const [x, y] = projection.toBox(model.route.x[i]!, model.route.y[i]!);
      expect(Math.hypot(x - radius, y - radius)).toBeLessThanOrEqual(radius + 1e-6);
    }
  });

  it('draws nothing where there is no position', () => {
    expect(make(follow()).momentAt(9999)).toBeUndefined();
  });
});

describe('the camera under the privacy trim (AV-1022, TD-091)', () => {
  const ride = activityThrough(straightNorth(1000, 10, 5));
  const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
  const trim = { start: 0.2, end: 0.2 };
  const model = createInsetModels({ template: templateOf(follow({ orientation: 'heading' }), trim), timeline, activity: ride, width: 1920, height: 1080 }).get('route')!;
  const northOf = (lat: number) => (lat - 46) * METERS_PER_DEGREE;

  it('holds at the first kept vertex before it, with no marker', () => {
    const moment = model.momentAt(10)!; // 50 m in: hidden (the first 200 m are)
    expect(moment.marker).toBeUndefined();
    expect(northOf(moment.camera.center[1])).toBeCloseTo(200, 0);
    expect(model.momentAt(0)!.camera.center).toEqual(moment.camera.center);
  });

  it('holds at the last kept vertex after it, with no marker', () => {
    const moment = model.momentAt(190)!; // 950 m in
    expect(moment.marker).toBeUndefined();
    expect(northOf(moment.camera.center[1])).toBeCloseTo(800, 0);
  });

  it('shows the position in the kept part', () => {
    const moment = model.momentAt(100)!;
    expect(moment.marker).toBeDefined();
    expect(northOf(moment.camera.center[1])).toBeCloseTo(500, 0);
  });

  it('turns a held camera by the kept route’s own direction, never the hidden stretch’s heading', () => {
    // The ride bends east inside the hidden first stretch; the kept route runs north.
    const bend = activityThrough([
      ...Array.from({ length: 21 }, (_, i) => ({ north: 0, east: i * 10, second: i * 2 })),
      ...Array.from({ length: 60 }, (_, i) => ({ north: (i + 1) * 10, east: 200, second: 42 + i * 2 })),
    ]);
    const bendTimeline = buildOverlayTimeline(bend, { video: { durationSeconds: 170 } });
    const bent = createInsetModels({ template: templateOf(follow({ orientation: 'heading' }), { start: 0.25, end: 0 }), timeline: bendTimeline, activity: bend, width: 1920, height: 1080 }).get('route')!;
    const held = bent.momentAt(5)!; // inside the hidden stretch, riding east
    expect(held.marker).toBeUndefined();
    const bearing = held.camera.bearing;
    expect(Math.min(bearing, 360 - bearing)).toBeLessThan(1);
  });

  it('has no model at all when too little is left, so nothing is framed or asked for', () => {
    const none = createInsetModels({ template: templateOf(follow(), { start: 0.45, end: 0.45 }), timeline: buildOverlayTimeline(activityThrough(straightNorth(150, 10, 5)), { video: { durationSeconds: 40 } }), activity: activityThrough(straightNorth(150, 10, 5)), width: 1920, height: 1080 });
    expect(none.size).toBe(0);
  });

  it('frames only the kept route in the whole view', () => {
    const whole = createInsetModels({ template: templateOf(parseRouteInsetSetting({ view: 'whole', shape: 'round' }), trim), timeline, activity: ride, width: 1920, height: 1080 }).get('route')!;
    expect(whole.route.count).toBeLessThan(buildInsetRoute(ride)!.count);
    const [, lat] = whole.fit.center;
    expect(northOf(lat)).toBeCloseTo(500, 0);
  });
});

describe('the route model', () => {
  it('finds the vertex at a time, and the first not before it', () => {
    const route = buildInsetRoute(activityThrough(straightNorth(100, 10, 5)))!;
    const t0 = route.ms[0]!;
    expect(splitIndex(route, t0 - 1)).toBe(-1);
    expect(splitIndex(route, t0)).toBe(0);
    expect(splitIndex(route, t0 + 4000)).toBe(2);
    expect(splitIndex(route, t0 + 5999)).toBe(2);
    expect(splitIndex(route, t0 + 1e9)).toBe(route.count - 1);
    expect(lowerIndex(route, t0 - 1)).toBe(0);
    expect(lowerIndex(route, t0 + 4000)).toBe(2);
    expect(lowerIndex(route, t0 + 4001)).toBe(3);
    expect(lowerIndex(route, t0 + 1e9)).toBe(route.count);
  });

  it('turns a held end by the way the route runs there', () => {
    const route = buildInsetRoute(activityThrough(straightNorth(200, 10, 5)))!;
    expect(endBearing(route, false)).toBeCloseTo(0, 3);
    expect(endBearing(route, true)).toBeCloseTo(0, 3);
  });

  it('fits a route of one place without a size, centred', () => {
    const route = buildInsetRoute(activityThrough([{ north: 0, east: 0, second: 0 }]))!;
    const camera = fitCamera(route, 300, 300);
    expect(camera.zoom).toBe(17);
    expect(camera.center[1]).toBeCloseTo(46, 6);
  });

  it('keeps a round inset in its centred square', () => {
    const box = { x: 10, y: 20, w: 300, h: 200 };
    expect(insetFrame(box, DEFAULT_ROUTE_INSET)).toBe(box);
    expect(insetFrame(box, { ...DEFAULT_ROUTE_INSET, shape: 'round' })).toEqual({ x: 60, y: 20, w: 200, h: 200 });
  });

  it('names the insets that carry a map', () => {
    const withMap = parseRouteInsetSetting({ map: { provider: 'openfreemap', style: 'liberty' } });
    expect(mapInsetIds(templateOf(withMap))).toEqual(['route']);
    expect(mapInsetIds(templateOf(undefined))).toEqual([]);
    expect(mapInsetIds(templateOf(DEFAULT_ROUTE_INSET))).toEqual([]);
  });
});

describe('the heading at a cut start and the cap on maps (AV-1023)', () => {
  it('turns by the kept route’s direction, not the hidden stretch’s, for the first seconds after the kept start', () => {
    // East in the hidden first stretch, then north: the smoothed heading would still read east for a few seconds after the cut.
    const bend = activityThrough([
      ...Array.from({ length: 21 }, (_, i) => ({ north: 0, east: i * 10, second: i * 2 })),
      ...Array.from({ length: 60 }, (_, i) => ({ north: (i + 1) * 10, east: 200, second: 42 + i * 2 })),
    ]);
    const tl = buildOverlayTimeline(bend, { video: { durationSeconds: 170 } });
    const model = createInsetModels({ template: templateOf(follow({ orientation: 'heading' }), { start: 0.25, end: 0 }), timeline: tl, activity: bend, width: 1920, height: 1080 }).get('route')!;
    const startMs = model.kept.startMs!;
    const seconds = (startMs - tl.activityStartMs!) / 1000;
    for (const t of [seconds + 0.5, seconds + 2]) {
      const bearing = model.momentAt(t)!.camera.bearing;
      expect(Math.min(bearing, 360 - bearing), `at ${t}`).toBeLessThan(1);
    }
  });

  it('turns by the kept route until it is 20 m along and the smoothing window after, at walking pace: about 14 s, and a stop holds it', () => {
    // 1.4 m/s: east for 120 m in the hidden stretch, then north.
    const walk = activityThrough([
      ...Array.from({ length: 41 }, (_, i) => ({ north: 0, east: i * 3, second: Math.round(i * 3 / 1.4) })),
      ...Array.from({ length: 100 }, (_, i) => ({ north: (i + 1) * 3, east: 120, second: Math.round((120 + (i + 1) * 3) / 1.4) })),
    ]);
    const tl = buildOverlayTimeline(walk, { video: { durationSeconds: 400 } });
    const model = createInsetModels({ template: templateOf(follow({ orientation: 'heading' }), { start: 0.3, end: 0 }), timeline: tl, activity: walk, width: 1920, height: 1080 }).get('route')!;
    const from = (model.kept.startMs! - tl.activityStartMs!) / 1000;
    const off = (b: number) => Math.min(b, 360 - b);
    for (const t of [from + 1, from + 8, from + 13]) expect(off(model.momentAt(t)!.camera.bearing), `at +${(t - from).toFixed(0)}`).toBeLessThan(1);
    expect(headingFreeMs(model.route)).toBeGreaterThan(model.kept.startMs! + 14_000);
  });

  it('gives a map to the first two insets that have one, hidden ones counted, so a duplicate or a toggle cannot make a third', () => {
    const map = parseRouteInsetSetting({ map: { provider: 'openfreemap', style: 'liberty' } });
    const inset = (id: string, visible = true) => ({ id, type: 'routeInset' as const, visible, rect: { x: 0, y: 0, width: 0.2, height: 0.2 }, unitMode: 'auto' as const, style: {}, routeInset: map });
    expect([...cappedMapIds([inset('a'), inset('b'), inset('c')])]).toEqual(['a', 'b']);
    expect([...cappedMapIds([inset('a', false), inset('b'), inset('c')])]).toEqual(['a', 'b']);
    const template = { ...templateOf(undefined), components: [inset('a'), inset('b'), inset('c')] };
    expect(mapInsetIds(template)).toEqual(['a', 'b']);
  });
});
