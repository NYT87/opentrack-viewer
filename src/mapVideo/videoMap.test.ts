import { describe, expect, it } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { FakeMap } from '../test/helpers/maplibreMock';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { buildMapVideoModel } from './model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from './project';
import { buildMapVideoRoute, positionAt } from './route';
import { drawVideoMap, installVideoLayers, styleVideoMap, videoMapColors } from './videoMap';

/**
 * AV-1210. The privacy trim, in every frame, as the map is given it: not the
 * model's points (model.test.ts checks those) but every coordinate of every
 * source the map draws (the revealed line in its colour runs, the rest of the
 * route, the start and finish, the trail, the marker) and every camera centre.
 */

// 3 km north, climbing and falling, so the line is coloured by elevation in runs.
const ride = activityThrough(straightNorth(3000, 10, 5).map((point) => ({ ...point, elevation: 400 + 80 * Math.sin(point.north / 300) })));
const full = buildMapVideoRoute(ride)!;
const TRIM = { startMeters: 200, endMeters: 300 };
const lowest = positionAt(full, TRIM.startMeters).lat;
const highest = positionAt(full, full.totalMeters - TRIM.endMeters).lat;

/** Everything drawn that can show a place: the rest of the route, both ends, a trail, colour runs. */
const everythingDrawn = (privacyTrim: MapVideoSettings['privacyTrim']): MapVideoSettings => ({
  ...DEFAULT_MAP_VIDEO_SETTINGS,
  lengthSeconds: 10,
  privacyTrim,
  route: { ...DEFAULT_MAP_VIDEO_SETTINGS.route, unrevealed: 'dimmed', colorBy: 'elevation' },
  endpoints: { ...DEFAULT_MAP_VIDEO_SETTINGS.endpoints, shown: true },
  marker: { ...DEFAULT_MAP_VIDEO_SETTINGS.marker, trail: true },
});

/** Every coordinate pair in a GeoJSON value, however deep. */
function coordinatesIn(value: unknown, out: [number, number][] = []): [number, number][] {
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') out.push([value[0], value[1]]);
    else for (const item of value) coordinatesIn(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) coordinatesIn(item, out);
  }
  return out;
}

/** Each frame's latitudes, drawn on a fake map: the sources' coordinates and the camera's centre. */
function latitudesDrawn(settings: MapVideoSettings): { frames: number; lats: number[] } {
  const built = buildMapVideoModel(ride, settings);
  if (!built.ok) throw new Error(built.error);
  const { model } = built;
  const fake = new FakeMap({});
  const map = fake as unknown as MapLibreMap;
  const colors = videoMapColors(ride, model, settings);
  expect(colors, 'the line is drawn in colour runs').toBeDefined();
  installVideoLayers(map, settings);
  styleVideoMap(map, ride, model, settings, colors);
  const lats: number[] = [];
  for (let f = 0; f < model.frameCount; f += 1) {
    drawVideoMap(map, model, settings, colors, model.timeline.frameSeconds(f, model.frameCount), 0);
    for (const [, source] of fake.sources) for (const [, lat] of coordinatesIn(source.data)) lats.push(lat);
    lats.push((fake.jumps[fake.jumps.length - 1]!.center as [number, number])[1]);
  }
  return { frames: model.frameCount, lats };
}

describe('the privacy trim, in everything the map is given (AV-1210)', () => {
  it('puts no place from a trimmed stretch in any source, nor the camera, in any frame', () => {
    const { frames, lats } = latitudesDrawn(everythingDrawn(TRIM));
    expect(frames).toBe(300);
    expect(lats.length).toBeGreaterThan(frames * 4);
    const outside = lats.filter((lat) => lat < lowest - 1e-9 || lat > highest + 1e-9);
    expect(outside).toEqual([]);
  });

  it('would see a trimmed place if one were drawn: without the trim, both ends are on the map', () => {
    const { lats } = latitudesDrawn(everythingDrawn({ startMeters: 0, endMeters: 0 }));
    expect(lats.some((lat) => lat < lowest - 1e-6)).toBe(true);
    expect(lats.some((lat) => lat > highest + 1e-6)).toBe(true);
  });
});
