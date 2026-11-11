import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_VIDEO_SETTINGS, outputProblem, parseMapVideoProject, serializeMapVideoProject, type MapVideoSettings } from './project';
import { buildMapVideoRoute, positionAt, simplifiedIndices } from './route';
import {
  COLOR_BY_PALETTE,
  colorByChoices,
  coloredRuns,
  drawnWithColorSteps,
  headingAt,
  mapVideoAttribution,
  routeColors,
  terrainActive,
  trailAt,
} from './style';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';

const settings = (patch: Partial<MapVideoSettings> = {}): MapVideoSettings => ({ ...DEFAULT_MAP_VIDEO_SETTINGS, ...patch });

/** 3 km north, climbing 100 m to 400 m, speeding up from 3 to 12 m/s, with a heart rate. */
function climbingRide() {
  let second = 0;
  const points = Array.from({ length: 301 }, (_, i) => {
    const speed = 3 + (9 * i) / 300;
    if (i > 0) second += 10 / speed;
    return { north: i * 10, east: 0, second, elevation: 100 + i };
  });
  const activity = activityThrough(points);
  activity.points.forEach((point, i) => {
    point.heartRateBpm = 100 + Math.round(i / 5);
  });
  return activity;
}

describe('what the route\'s colour can show (AV-1205)', () => {
  it('offers speed, elevation and heart rate where the activity records them', () => {
    const activity = climbingRide();
    const choices = colorByChoices(activity, buildMapVideoRoute(activity)!);
    expect(choices.map((choice) => [choice.value, choice.available])).toEqual([
      ['none', true],
      ['speed', true],
      ['elevation', true],
      ['heartRate', true],
    ]);
  });

  it('disables what is not recorded, with the reason', () => {
    const bare = activityThrough(straightNorth(1000).map(({ north, east }) => ({ north, east })));
    const choices = colorByChoices(bare, buildMapVideoRoute(bare)!);
    expect(choices.filter((choice) => !choice.available).map((choice) => [choice.value, choice.reason])).toEqual([
      ['speed', 'Not every point has a time, so there is no speed to show.'],
      ['elevation', 'This activity records no elevation for most of its points.'],
      ['heartRate', 'This activity records no heart rate for most of its points.'],
    ]);
  });
});

describe('the route\'s colours (AV-1205)', () => {
  const activity = climbingRide();
  const route = buildMapVideoRoute(activity)!;

  it('runs from the coolest step to the hottest along a steady climb', () => {
    const colors = routeColors(activity, route, 'elevation')!;
    expect(colors.bins[0]).toBe(0);
    expect(colors.bins[route.vertices.length - 1]).toBe(COLOR_BY_PALETTE.length - 1);
    for (let i = 1; i < route.vertices.length; i += 1) expect(colors.bins[i]!).toBeGreaterThanOrEqual(colors.bins[i - 1]!);
    expect(colors.low).toBeCloseTo(115, 0);
    expect(colors.high).toBeCloseTo(385, 0);
  });

  it('scales speed between the 5th and 95th percentile, so a spike does not flatten the rest', () => {
    const spiked = climbingRide();
    spiked.points[150]!.time = new Date(spiked.points[149]!.time!.getTime() + 10);
    const colors = routeColors(spiked, buildMapVideoRoute(spiked)!, 'speed')!;
    expect(new Set(colors.bins).size).toBe(COLOR_BY_PALETTE.length);
    expect(colors.high).toBeLessThan(13);
  });

  it('is one colour when asked for none', () => {
    expect(routeColors(activity, route, 'none')).toBeUndefined();
  });

  it('cuts the drawn line into runs of one step that join up and end at the marker', () => {
    const colors = routeColors(activity, route, 'heartRate')!;
    const kept = drawnWithColorSteps(simplifiedIndices(route, 0.5), colors);
    for (const d of [0, 777, 1500, route.totalMeters]) {
      const runs = coloredRuns(route, d, kept, colors);
      for (let k = 1; k < runs.length; k += 1) expect(runs[k]!.line[0]).toEqual(runs[k - 1]!.line[runs[k - 1]!.line.length - 1]);
      const place = positionAt(route, d);
      expect(runs[runs.length - 1]!.line.at(-1)).toEqual([place.lon, place.lat]);
    }
    expect(new Set(coloredRuns(route, route.totalMeters, kept, colors).map((run) => run.bin)).size).toBe(COLOR_BY_PALETTE.length);
  });
});

describe('the marker (AV-1205)', () => {
  const route = buildMapVideoRoute(activityThrough(straightNorth(2000)))!;

  it('points along the route', () => {
    expect(headingAt(route, 1000)).toBeCloseTo(0, 3);
    const east = buildMapVideoRoute(activityThrough(Array.from({ length: 101 }, (_, i) => ({ north: 0, east: i * 10 }))))!;
    expect(headingAt(east, 500)).toBeCloseTo(90, 1);
  });

  it('trails over the stretch just behind it, ending on it', () => {
    const trail = trailAt(route, 1000, 400);
    expect(trail[0]![1]).toBeCloseTo(positionAt(route, 600).lat, 9);
    expect(trail.at(-1)).toEqual([positionAt(route, 1000).lon, positionAt(route, 1000).lat]);
  });

  it('never trails across a gap between recordings', () => {
    const gapped = buildMapVideoRoute(
      activityThrough([
        ...straightNorth(500).map((point) => ({ ...point, segment: 0 })),
        ...straightNorth(500).map((point) => ({ north: 3000 + point.north, east: 0, segment: 1 })),
      ]),
    )!;
    const trail = trailAt(gapped, gapped.vertices[51]!.distance + 100, 400);
    for (const [, lat] of trail) expect(lat).toBeGreaterThanOrEqual(gapped.vertices[51]!.lat - 1e-12);
  });
});

describe('the credit in the frame (AV-1205, TD-064)', () => {
  it('names the map\'s source, and the terrain\'s when it is drawn', () => {
    expect(mapVideoAttribution(settings())).toBe('OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
    expect(mapVideoAttribution(settings({ basemap: { ...DEFAULT_MAP_VIDEO_SETTINGS.basemap, source: 'maptiler' } }))).toBe(
      '© MapTiler © OpenStreetMap contributors',
    );
    expect(mapVideoAttribution(settings({ terrain: { enabled: true, exaggeration: 1.5 } }))).toMatch(/OpenStreetMap · Terrain: Mapzen, AWS Open Data/);
  });

  it('credits no one for route only, which draws no one\'s map and no terrain', () => {
    const routeOnly = settings({ basemap: { ...DEFAULT_MAP_VIDEO_SETTINGS.basemap, source: 'route-only' }, terrain: { enabled: true, exaggeration: 2 } });
    expect(terrainActive(routeOnly)).toBe(false);
    expect(mapVideoAttribution(routeOnly)).toBeUndefined();
  });
});

describe('the style settings in a project (AV-1205)', () => {
  it('reopen as they were saved, and never hold a MapTiler key', () => {
    const styled = settings({
      basemap: { source: 'maptiler', style: 'dark', maptilerStyle: 'hybrid' },
      route: { color: '#123456', width: 9, casing: false, casingColor: '#ffffff', unrevealed: 'hidden', colorBy: 'elevation' },
      marker: { shape: 'arrow', size: 30, color: '#00ff00', trail: true },
      endpoints: { shown: false },
    });
    const json = serializeMapVideoProject({ activity: { fileName: null, points: 2 }, settings: styled });
    expect(json).not.toMatch(/key/i);
    const reopened = parseMapVideoProject(json);
    expect(reopened.ok && reopened.project.settings).toEqual(styled);
  });

  it('refuses an odd size, which the encoders cannot take', () => {
    expect(outputProblem({ output: { width: 1281, height: 720, fps: 30 }, lengthSeconds: 30 })).toBe('Each side must be an even number of pixels.');
    expect(outputProblem({ output: { width: 1280, height: 720, fps: 30 }, lengthSeconds: 30 })).toBeUndefined();
  });
});
