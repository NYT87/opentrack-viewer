import { beforeEach, describe, expect, it } from 'vitest';
import { ease } from './camera';
import { maxFollowOffsetMeters, offsetBetween, type CameraKeyframe } from './keyframes';
import { buildMapVideoModel } from './model';
import { DEFAULT_MAP_VIDEO_SETTINGS, MAP_VIDEO_PROJECT_KIND, parseMapVideoProject, serializeMapVideoProject, type MapVideoSettings } from './project';
import { useMapVideoStore } from '../state/mapVideoStore';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';

// 5 km north; a 30 s video: a 2 s intro, the follow from 2 s to 27 s, a 3 s outro.
const ride = activityThrough(straightNorth(5000));
const keyframe = (patch: Partial<CameraKeyframe> = {}): CameraKeyframe => ({
  id: 'k1',
  seconds: 12,
  mode: 'follow',
  offset: { east: 0, north: 0 },
  zoom: 16,
  pitch: 20,
  bearing: null,
  ...patch,
});
const modelWith = (keyframes: CameraKeyframe[], patch: Partial<MapVideoSettings> = {}) => {
  const built = buildMapVideoModel(ride, { ...DEFAULT_MAP_VIDEO_SETTINGS, ...patch, keyframes });
  if (!built.ok) throw new Error(built.error);
  return built.model;
};
const viewport = { width: 1920, height: 1080 };
const markerAt = (model: ReturnType<typeof modelWith>, seconds: number) => model.at(seconds).reveal.marker;

describe('camera keyframes (AV-1206)', () => {
  it('leave the follow camera as it is when there are none', () => {
    const plain = modelWith([]);
    for (let s = 0; s <= 30; s += 0.7) expect(plain.at(s).camera).toEqual(plain.camera.at(plain.timeline.at(s)));
  });

  it('are reached exactly, and eased into from the follow camera with a smoothstep', () => {
    const model = modelWith([keyframe()]);
    expect(model.at(12).camera).toMatchObject({ zoom: 16, pitch: 20 });
    // From the follow camera at 2 s (zoom 14.5, pitch 45) to the keyframe at 12 s.
    for (const t of [0.25, 0.5, 0.75]) {
      const camera = model.at(2 + 10 * t).camera;
      expect(camera.zoom).toBeCloseTo(14.5 + (16 - 14.5) * ease(t), 9);
      expect(camera.pitch).toBeCloseTo(45 + (20 - 45) * ease(t), 9);
    }
    // And back to the follow camera's own values by the end of the follow.
    expect(model.at(27).camera).toMatchObject({ zoom: 14.5, pitch: 45 });
  });

  it('take effect in time order, whatever order they were added in', () => {
    const a = keyframe({ id: 'a', seconds: 8, zoom: 13 });
    const b = keyframe({ id: 'b', seconds: 20, zoom: 16.5 });
    const forwards = modelWith([a, b]);
    const backwards = modelWith([b, a]);
    for (let s = 2; s <= 27; s += 1.3) expect(backwards.at(s).camera).toEqual(forwards.at(s).camera);
    expect(forwards.at(8).camera.zoom).toBe(13);
    expect(forwards.at(20).camera.zoom).toBe(16.5);
  });

  it('are held to the follow, never the intro or the outro', () => {
    const model = modelWith([keyframe({ seconds: 0.5, zoom: 12 })]);
    expect(model.at(2).camera.zoom).toBe(12);
    expect(model.at(0).camera).toEqual(model.camera.overview);
  });

  it('turn with the route, or hold a heading, the short way round', () => {
    const model = modelWith([keyframe({ id: 'a', seconds: 10, bearing: 350 }), keyframe({ id: 'b', seconds: 20, bearing: 10 })]);
    expect(model.at(10).camera.bearing).toBe(350);
    expect(model.at(15).camera.bearing).toBeCloseTo(0, 6);
    for (let s = 10; s <= 20; s += 0.5) {
      const bearing = model.at(s).camera.bearing;
      expect(bearing >= 349.999 || bearing <= 10.001).toBe(true);
    }
    // null: as the follow camera turns, here due north.
    expect(modelWith([keyframe({ bearing: null })]).at(12).camera.bearing).toBeCloseTo(0, 3);
  });

  it('never let a following camera lose the marker, at a keyframe or between two', () => {
    // Asked for 9 km to the east at zoom 12, then the marker at zoom 17 tilted: far more than the frames hold.
    const model = modelWith([
      keyframe({ id: 'a', seconds: 8, zoom: 12, pitch: 0, offset: { east: 9000, north: 0 } }),
      keyframe({ id: 'b', seconds: 20, zoom: 17, pitch: 60 }),
    ]);
    for (let s = 2; s <= 27; s += 0.25) {
      const { camera } = model.at(s);
      const marker = markerAt(model, s);
      const away = offsetBetween(marker, camera.center);
      expect(Math.hypot(away.east, away.north)).toBeLessThanOrEqual(maxFollowOffsetMeters(camera.zoom, camera.pitch, marker[1], viewport) + 1e-6);
    }
    // The first is kept as far east as the frame allows, not dropped.
    const at8 = offsetBetween(markerAt(model, 8), model.at(8).camera.center);
    expect(at8.east).toBeCloseTo(maxFollowOffsetMeters(12, 0, markerAt(model, 8)[1], viewport), 3);
  });

  it('hold a fixed camera still, and let the marker leave the frame', () => {
    const fixed = { mode: 'fixed' as const, zoom: 15, pitch: 0, bearing: 0 };
    const model = modelWith([keyframe({ id: 'a', seconds: 8, ...fixed }), keyframe({ id: 'b', seconds: 20, ...fixed, offset: offsetBetween(markerAt(modelWith([]), 20), markerAt(modelWith([]), 8)) })]);
    const still = model.at(8).camera.center;
    for (let s = 8; s <= 20; s += 0.5) {
      expect(model.at(s).camera.center[0]).toBeCloseTo(still[0], 9);
      expect(model.at(s).camera.center[1]).toBeCloseTo(still[1], 9);
    }
    const away = offsetBetween(markerAt(model, 20), still);
    expect(Math.hypot(away.east, away.north)).toBeGreaterThan(maxFollowOffsetMeters(15, 0, still[1], viewport));
  });

  it('meet the intro and the outro where the follow starts and ends', () => {
    const model = modelWith([keyframe({ seconds: 2, zoom: 13 }), keyframe({ id: 'k2', seconds: 27, zoom: 16 })]);
    expect(model.at(1.999).camera.zoom).toBeCloseTo(13, 2);
    expect(model.at(27.001).camera.zoom).toBeCloseTo(16, 2);
  });
});

describe('keyframes in the project file (AV-1206)', () => {
  const keyframes = [keyframe({ id: 'a', offset: { east: 120, north: -40 } }), keyframe({ id: 'b', seconds: 20, mode: 'fixed', bearing: 270 })];

  it('reopen as they were saved, holding offsets and never a place', () => {
    const settings = { ...DEFAULT_MAP_VIDEO_SETTINGS, keyframes };
    const json = serializeMapVideoProject({ activity: { fileName: null, points: 2 }, settings });
    const reopened = parseMapVideoProject(json);
    expect(reopened.ok && reopened.project.settings.keyframes).toEqual(keyframes);
    for (const point of ride.points) expect(json).not.toContain(String(point.lat).slice(0, 7));
  });

  it('are refused by name when a value is out of range', () => {
    const file = (k: unknown) => JSON.stringify({ kind: MAP_VIDEO_PROJECT_KIND, version: 1, activity: { fileName: null, points: 2 }, settings: { keyframes: [k] } });
    expect(parseMapVideoProject(file({ ...keyframe(), bearing: 400 }))).toEqual({ ok: false, error: expect.stringContaining('settings.keyframes[0].bearing') });
    expect(parseMapVideoProject(file({ ...keyframe(), zoom: 30 }))).toEqual({ ok: false, error: expect.stringContaining('settings.keyframes[0].zoom') });
    expect(parseMapVideoProject(file({ ...keyframe(), mode: 'orbit' }))).toEqual({ ok: false, error: expect.stringContaining('settings.keyframes[0].mode') });
  });
});

describe('undoing keyframe edits (AV-1206)', () => {
  beforeEach(() => useMapVideoStore.setState(useMapVideoStore.getInitialState(), true));

  it('steps back through every edit, fifty deep', () => {
    const { editKeyframes, undoKeyframes } = useMapVideoStore.getState();
    for (let n = 1; n <= 60; n += 1) editKeyframes(Array.from({ length: n }, (_, i) => keyframe({ id: `k${i}`, seconds: 2 + i * 0.1 })));
    expect(useMapVideoStore.getState().settings.keyframes).toHaveLength(60);
    undoKeyframes();
    expect(useMapVideoStore.getState().settings.keyframes).toHaveLength(59);
    for (let n = 0; n < 60; n += 1) undoKeyframes();
    expect(useMapVideoStore.getState().settings.keyframes).toHaveLength(10);
  });
});
