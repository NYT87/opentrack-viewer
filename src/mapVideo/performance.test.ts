import { describe, expect, it } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MAX_ACTIVITY_POINTS } from '../parsers/limits';
import { FakeMap } from '../test/helpers/maplibreMock';
import { syntheticRide } from '../test/helpers/syntheticTelemetry';
import { buildMapVideoModel, type MapVideoModel } from './model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from './project';
import { drawVideoMap, installVideoLayers, styleVideoMap, videoMapColors } from './videoMap';

/**
 * AV-1210. A map video of the longest activity the app reads (250,000 points,
 * the import limit), made on the spot (`syntheticTelemetry`): the timing, the
 * camera path and the route's reveal, built once and asked for every frame.
 *
 * As in the overlay's checks (AV-1008), two kinds, since absolute times depend
 * on the machine:
 *
 *  - **Budgets**, generous enough for a slow CI runner, that catch an order of
 *    magnitude (a rebuild per frame, a copy of the route per frame).
 *  - **Scaling**, against a route a tenth as long on the same machine in the
 *    same run: building may grow with the route, and a frame may not grow
 *    faster than the stretch it draws.
 *
 * Each is the best of a few runs, so one scheduling hiccup is not a failure.
 */
const best = (runs: number, work: () => void): number => {
  let fastest = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
};

// A point a second, wandering round a circuit: 250,000 points, and a tenth of that.
const longest = syntheticRide({ seconds: MAX_ACTIVITY_POINTS - 1 });
const tenth = syntheticRide({ seconds: MAX_ACTIVITY_POINTS / 10 - 1 });

/** Thirty seconds at 30 fps, as recorded and coloured by elevation: the most the timing and the line do. */
const settings: MapVideoSettings = {
  ...DEFAULT_MAP_VIDEO_SETTINGS,
  timing: { ...DEFAULT_MAP_VIDEO_SETTINGS.timing, mode: 'time' },
  route: { ...DEFAULT_MAP_VIDEO_SETTINGS.route, colorBy: 'elevation' },
  marker: { ...DEFAULT_MAP_VIDEO_SETTINGS.marker, trail: true },
};

const build = (activity: typeof longest): MapVideoModel => {
  const built = buildMapVideoModel(activity, settings);
  if (!built.ok) throw new Error(built.error);
  return built.model;
};

/** Every frame asked of the model: its camera, its sample and its reveal. */
const everyFrame = (model: MapVideoModel) => {
  let points = 0;
  for (let f = 0; f < model.frameCount; f += 1) points += model.frame(f).reveal.lines.reduce((sum, line) => sum + line.length, 0);
  return points;
};

/** Every frame drawn on a map, as the preview and the export draw it (on a fake map: no WebGL here). */
const drawEveryFrame = (activity: typeof longest, model: MapVideoModel) => {
  const map = new FakeMap({}) as unknown as MapLibreMap;
  const colors = videoMapColors(activity, model, settings);
  installVideoLayers(map, settings);
  styleVideoMap(map, activity, model, settings, colors);
  for (let f = 0; f < model.frameCount; f += 1) drawVideoMap(map, model, settings, colors, model.timeline.frameSeconds(f, model.frameCount), 0);
};

describe('a map video of the longest activity (AV-1210)', () => {
  it('reads 250,000 points', () => {
    expect(longest.points).toHaveLength(MAX_ACTIVITY_POINTS);
    expect(build(longest).frameCount).toBe(900);
  });

  it('builds its timing, camera and reveal within budget, growing no faster than the route', () => {
    const long = best(3, () => build(longest));
    const short = best(3, () => build(tenth));
    // Measured on an M1, alone: 210 ms, and 20 ms for the tenth.
    expect(long).toBeLessThan(5_000);
    // Linear would be ten times; a sort or a log factor is allowed, a square is not.
    expect(long).toBeLessThan(Math.max(short, 5) * 25);
  });

  it('gives every frame within budget, its reveal no dearer per point drawn for the longer route', () => {
    const longModel = build(longest);
    const shortModel = build(tenth);
    let longPoints = 0;
    let shortPoints = 0;
    const long = best(3, () => (longPoints = everyFrame(longModel)));
    const short = best(3, () => (shortPoints = everyFrame(shortModel)));
    // Measured on an M1, alone: 140 ms for 900 frames drawing 5.9 million points, and 13 ms for the tenth.
    expect(long).toBeLessThan(5_000);
    expect(long / Math.max(longPoints, 1)).toBeLessThan((Math.max(short, 1) / Math.max(shortPoints, 1)) * 5);
  });

  it('draws every frame on the map within budget', () => {
    const model = build(longest);
    const long = best(2, () => drawEveryFrame(longest, model));
    // Measured on an M1, alone: 420 ms for 900 frames.
    expect(long).toBeLessThan(10_000);
  });
});
