import { describe, expect, it } from 'vitest';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { FIT_MARGIN, cameraAtWidth, drawnAtZoom, fitCamera, imageRoute, normalizeBearing, toScreen } from './geometry';

/** 4 km north, then 1 km east. */
const ell = activityThrough([...straightNorth(4000, 20), ...Array.from({ length: 50 }, (_, i) => ({ north: 4000, east: (i + 1) * 20, second: 800 + i * 4 }))]);
const route = (() => {
  const result = imageRoute(ell, { startMeters: 0, endMeters: 0 });
  if (!result.ok) throw new Error(result.error);
  return result.route;
})();

/** Every vertex on screen, and the tightest box round them. */
function extent(camera: ReturnType<typeof fitCamera>, size: { width: number; height: number }) {
  const points = route.vertices.map((vertex) => toScreen(vertex.lon, vertex.lat, camera, size));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

describe('the map image’s route and fit (AV-1013)', () => {
  it('fits the whole route north up, with the margin clear on the side that binds and centred on both', () => {
    const size = { width: 1080, height: 900 };
    const camera = fitCamera(route, size);
    expect(camera.bearing).toBe(0);
    const box = extent(camera, size);
    // 4 km tall, 1 km wide: the height binds.
    expect(box.top).toBeCloseTo(size.height * FIT_MARGIN, 0);
    expect(box.bottom).toBeCloseTo(size.height * (1 - FIT_MARGIN), 0);
    expect((box.left + box.right) / 2).toBeCloseTo(size.width / 2, 0);
    expect(box.left).toBeGreaterThan(size.width * FIT_MARGIN);
  });

  it('fits a turned map across the turned picture: a north–south route turned a quarter is fitted to the width', () => {
    const size = { width: 1080, height: 900 };
    const north = fitCamera(route, size, 0);
    const turned = fitCamera(route, size, 90);
    expect(turned.bearing).toBe(90);
    const box = extent(turned, size);
    // The 4 km now runs across: the width binds, and it fits with the margin.
    expect(box.left).toBeCloseTo(size.width * FIT_MARGIN, 0);
    expect(box.right).toBeCloseTo(size.width * (1 - FIT_MARGIN), 0);
    expect((box.top + box.bottom) / 2).toBeCloseTo(size.height / 2, 0);
    // Wider than tall, so the turned fit comes nearer.
    expect(turned.zoom).toBeGreaterThan(north.zoom);
  });

  it('puts east up at a bearing of 90, as MapLibre turns its map', () => {
    const camera = { center: [7, 46] as [number, number], zoom: 12, bearing: 90 };
    const [x, y] = toScreen(7.01, 46, camera, { width: 1000, height: 1000 });
    expect(x).toBeCloseTo(500, 6);
    expect(y).toBeLessThan(500);
  });

  it('keeps the same stretch of the world across the picture at another width', () => {
    const camera = fitCamera(route, { width: 1080, height: 900 });
    const small = cameraAtWidth(camera, 1080, 270);
    expect(small.zoom).toBeCloseTo(camera.zoom - 2, 9);
    const big = extent(camera, { width: 1080, height: 900 });
    const little = extent(small, { width: 270, height: 225 });
    expect((little.bottom - little.top) * 4).toBeCloseTo(big.bottom - big.top, 6);
  });

  it('draws from the trimmed route alone: the trim moves the fit off the hidden ends', () => {
    const trimmed = imageRoute(ell, { startMeters: 1000, endMeters: 0 });
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    expect(trimmed.route.vertices[0]!.lat).toBeGreaterThan(route.vertices[0]!.lat + 0.008);
    expect(fitCamera(trimmed.route, { width: 1080, height: 900 }).center[1]).toBeGreaterThan(fitCamera(route, { width: 1080, height: 900 }).center[1]);
    expect(imageRoute(ell, { startMeters: 3000, endMeters: 2000 })).toEqual({ ok: false, error: expect.stringContaining('privacy trim') });
    expect(imageRoute(activityThrough([{ north: 0, east: 0 }]), { startMeters: 0, endMeters: 0 }).ok).toBe(false);
  });

  it('draws fewer vertices further out, and every corner at any zoom', () => {
    // 4 km north, wavering a metre or two either side, then the turn east.
    const wavering = imageRoute(activityThrough([...straightNorth(4000, 20).map((point, i) => ({ ...point, east: Math.sin(i) * 2 })), { north: 4000, east: 1000 }]), { startMeters: 0, endMeters: 0 });
    if (!wavering.ok) throw new Error(wavering.error);
    const near = drawnAtZoom(wavering.route, 19);
    const far = drawnAtZoom(wavering.route, 10);
    expect(far.length).toBeLessThan(near.length);
    // The corner, 4 km in, is kept.
    const corner = wavering.route.vertices.length - 2;
    expect(far).toContain(corner);
  });

  it('holds headings to 0–360 and a single place to a near zoom', () => {
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(720)).toBe(0);
    const dot = imageRoute(activityThrough([{ north: 0, east: 0 }, { north: 0, east: 0.001 }, { north: 200, east: 0 }]), { startMeters: 0, endMeters: 0 });
    if (!dot.ok) throw new Error(dot.error);
    expect(fitCamera(dot.route, { width: 1000, height: 1000 }).zoom).toBeLessThanOrEqual(17);
  });
});
