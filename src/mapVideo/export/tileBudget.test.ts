import { describe, expect, it } from 'vitest';
import { activityThrough, type TestPoint } from '../../test/helpers/mapVideoRoutes';
import { buildMapVideoModel } from '../model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from '../project';
import { estimateBasemapTiles } from './tileBudget';

/** A loop `km` long, like the probe's (TD-064), a point every 10 m. */
function loop(km: number): TestPoint[] {
  const radius = (km * 1000) / (2 * Math.PI);
  const count = Math.round((km * 1000) / 10);
  return Array.from({ length: count + 1 }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return { north: radius * Math.sin(angle), east: radius * (1 - Math.cos(angle)), second: i * 2 };
  });
}
const estimate = (km: number, patch: Partial<MapVideoSettings> = {}) => {
  const settings = { ...DEFAULT_MAP_VIDEO_SETTINGS, lengthSeconds: 10, ...patch };
  const built = buildMapVideoModel(activityThrough(loop(km)), settings);
  if (!built.ok) throw new Error(built.error);
  return estimateBasemapTiles(built.model, settings);
};

describe('the basemap tile budget (AV-1209)', () => {
  it('estimates at least what the probe counted, and of the same order', () => {
    // TD-064: OpenFreeMap 2D, 10 s at 1080p, zoom 14.6, tilt 45°, a 28 km loop: 106 vector tiles asked.
    const counted = estimate(28, { camera: { ...DEFAULT_MAP_VIDEO_SETTINGS.camera, zoom: 14.6, pitch: 45 } });
    expect(counted).toBeGreaterThanOrEqual(106);
    expect(counted).toBeLessThan(106 * 4);
  });

  it('grows with the route and with the zoom, not with the video\'s length', () => {
    expect(estimate(200)).toBeGreaterThan(estimate(28) * 3);
    expect(estimate(28, { lengthSeconds: 60 })).toBeLessThan(estimate(28) * 1.3);
    expect(estimate(28, { camera: { ...DEFAULT_MAP_VIDEO_SETTINGS.camera, zoom: 12 } })).toBeLessThan(estimate(28));
  });

  it('counts coarser tiles with terrain on alone, where MapLibre takes them, and none for an untilted view (TD-078)', () => {
    const at = (pitch: number, terrain: boolean) =>
      estimate(28, { camera: { ...DEFAULT_MAP_VIDEO_SETTINGS.camera, zoom: 14, pitch }, terrain: { ...DEFAULT_MAP_VIDEO_SETTINGS.terrain, enabled: terrain } });
    expect(at(0, true)).toBe(at(0, false));
    expect(at(45, true)).toBeGreaterThan(at(45, false));
    expect(at(60, true)).toBeGreaterThan(at(60, false));
  });

  it('counts more the steeper the tilt, as the camera sees further (#13)', () => {
    const at = (pitch: number) => estimate(28, { camera: { ...DEFAULT_MAP_VIDEO_SETTINGS.camera, zoom: 14, pitch } });
    const counts = [0, 30, 45, 60].map(at);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
    // Measured against real exports at 1080p (TD-076): 60° asked for about four times what 0° did on that ride.
    expect(counts[3]! / counts[0]!).toBeGreaterThan(2.5);
  });
});
