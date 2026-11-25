import { describe, expect, it } from 'vitest';
import { buildMapVideoModel } from './model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from './project';
import { buildMapVideoRoute, positionAt } from './route';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';

const settings = (patch: Partial<MapVideoSettings> = {}): MapVideoSettings => ({
  ...DEFAULT_MAP_VIDEO_SETTINGS,
  lengthSeconds: 10,
  ...patch,
});
const ride = activityThrough(straightNorth(3000, 10, 5));
const modelOf = (patch?: Partial<MapVideoSettings>) => {
  const built = buildMapVideoModel(ride, settings(patch));
  if (!built.ok) throw new Error(built.error);
  return built.model;
};

describe('a map video\'s frames (AV-1203)', () => {
  it('has a frame for every 1/fps second, from the overview to the overview', () => {
    const model = modelOf();
    expect(model.frameCount).toBe(300);
    expect(model.frame(0).camera).toEqual(model.camera.overview);
    expect(model.frame(0).sample.phase).toBe('intro');
    const last = model.frame(299);
    expect(last.sample.phase).toBe('outro');
    expect(last.camera.zoom).toBeCloseTo(model.camera.overview.zoom, 9);
    expect(last.position.distance).toBe(model.route.totalMeters);
  });

  it('runs the marker from the first point to the last', () => {
    const model = modelOf({ intro: { enabled: false, seconds: 2 }, outro: { enabled: false, seconds: 3 } });
    expect(model.frame(0).position.distance).toBe(0);
    expect(model.frame(model.frameCount - 1).position.distance).toBe(model.route.totalMeters);
    let previous = -1;
    for (let f = 0; f < model.frameCount; f += 1) {
      const { position, reveal, camera } = model.frame(f);
      expect(position.distance).toBeGreaterThanOrEqual(previous);
      previous = position.distance;
      expect(reveal.marker).toEqual([position.lon, position.lat]);
      expect(camera.center).toEqual(reveal.marker);
    }
  });

  it('is the same, frame for frame, however often it is asked', () => {
    const a = modelOf({ terrain: { enabled: true, exaggeration: 1.5 } });
    const b = modelOf({ terrain: { enabled: true, exaggeration: 1.5 } });
    for (const f of [0, 37, 150, 271, 299]) expect(JSON.stringify(a.frame(f))).toBe(JSON.stringify(b.frame(f)));
  });
});

describe('the privacy trim, in every frame (AV-1203)', () => {
  const full = buildMapVideoRoute(ride)!;
  const lowest = positionAt(full, 200).lat;
  const highest = positionAt(full, full.totalMeters - 300).lat;
  const model = modelOf({ privacyTrim: { startMeters: 200, endMeters: 300 } });
  const firstHidden = full.vertices.findIndex((vertex) => vertex.distance >= 200);
  const lastShown = full.vertices.findLastIndex((vertex) => vertex.distance <= full.totalMeters - 300);

  it('leaves the trimmed stretches out of the line, the marker, the camera and the figures\' points', () => {
    for (let f = 0; f < model.frameCount; f += 1) {
      const { reveal, camera, position } = model.frame(f);
      for (const [, lat] of [...reveal.lines.flat(), reveal.marker]) {
        expect(lat).toBeGreaterThanOrEqual(lowest - 1e-12);
        expect(lat).toBeLessThanOrEqual(highest + 1e-12);
      }
      expect(camera.center[1]).toBeGreaterThanOrEqual(lowest - 1e-9);
      expect(camera.center[1]).toBeLessThanOrEqual(highest + 1e-9);
      // The point a figure is read from: inside the shown stretch, or the one just before its cut start.
      const pointIndex = model.route.vertices[position.index]!.pointIndex;
      expect(pointIndex).toBeGreaterThanOrEqual(firstHidden - 1);
      expect(pointIndex).toBeLessThanOrEqual(lastShown);
    }
  });

  it('fits the overview to what is shown, not to the whole ride', () => {
    // The middle in the map's projection, a millionth of a degree from the middle in latitude.
    expect(model.camera.overview.center[1]).toBeCloseTo((lowest + highest) / 2, 5);
  });

  it('is refused when it would leave too little to follow', () => {
    expect(buildMapVideoModel(ride, settings({ privacyTrim: { startMeters: 1500, endMeters: 1450 } }))).toEqual({
      ok: false,
      error: expect.stringContaining('less than 100 m'),
    });
  });
});
