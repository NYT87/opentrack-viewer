import { describe, expect, it } from 'vitest';
import type { OverlayContext2D } from '../overlay/export/drawOverlay';
import { canvasTemplate, newCanvasComponent } from '../overlay/customCanvas';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayTemplate } from '../overlay/template';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';
import { activityThrough, straightNorth, type TestPoint } from '../test/helpers/mapVideoRoutes';
import { createMapVideoFigures, mapVideoOverlayTimeline, shownActivity, summaryCardTemplate } from './figures';
import { buildMapVideoModel } from './model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from './project';

/** The committed formula ride: 61 points a second apart, speed 4 + 0.2 m/s a second, heart rate 100 + 1 a second. */
const ride = parseGpx(readFixture('overlay-ride.gpx'), { fileName: 'overlay-ride.gpx', idFactory: () => 'ride' });
const settings = (patch: Partial<MapVideoSettings> = {}): MapVideoSettings => ({ ...DEFAULT_MAP_VIDEO_SETTINGS, lengthSeconds: 10, ...patch });
const modelOf = (activity: typeof ride, patch?: Partial<MapVideoSettings>) => {
  const built = buildMapVideoModel(activity, settings(patch));
  if (!built.ok) throw new Error(built.error);
  return built.model;
};
const SPEED = 'metric:speed';
const HEART = 'metric:heartRate';

const round = (value: unknown): string => (typeof value === 'number' ? String(Math.round(value * 100) / 100) : JSON.stringify(value));

/** Every call on a context as a line: the display-list goldens of AV-1008 (TD-046), for the map video's frame. */
function displayList(draw: (ctx: OverlayContext2D) => void): string {
  const lines: string[] = [];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({ width: text.length * Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10) * 0.55 }),
  };
  const stateful = new Set(['fillText', 'fillRect', 'fill', 'stroke', 'arc']);
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        const call = `${key}(${args.map((arg) => (typeof arg === 'object' && arg !== null ? '[map frame]' : round(arg))).join(', ')})`;
        if (!stateful.has(key)) return void lines.push(call);
        const style = key === 'stroke' ? `stroke=${round(target.strokeStyle)} width=${round(target.lineWidth)}` : `fill=${round(target.fillStyle)}`;
        const font = key === 'fillText' ? ` font=${round(target.font)}` : '';
        lines.push(`${call} ${style}${font} alpha=${round(target.globalAlpha)}`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as OverlayContext2D;
  draw(ctx);
  return `${lines.join('\n')}\n`;
}

describe('figures on the map video\'s clock (AV-1207)', () => {
  const model = modelOf(ride, { intro: { enabled: true, seconds: 2 }, outro: { enabled: true, seconds: 2 } });
  const timeline = mapVideoOverlayTimeline(ride, model);

  it('read the activity where the marker is, not where a source video would be', () => {
    for (const t of [2, 4.5, 6]) {
      const frame = model.at(t);
      const sample = timeline.sampleAt(t)!;
      const elapsed = (frame.position.time! - ride.points[0]!.time!.getTime()) / 1000;
      expect(sample.activityElapsedSeconds).toBeCloseTo(elapsed, 6);
      expect(sample.values[HEART]).toBeCloseTo(100 + elapsed, 3);
      expect(sample.progress).toBeCloseTo(frame.sample.distance / model.route.totalMeters, 9);
      expect(sample.videoTimeSeconds).toBe(t);
    }
  });

  it('show the start through the intro and the end through the outro', () => {
    expect(timeline.sampleAt(0.5)!.values[HEART]).toBeCloseTo(100, 6);
    expect(timeline.sampleAt(9.5)!.values[HEART]).toBeCloseTo(160, 6);
    expect(timeline.durationSeconds).toBe(10);
  });

  it('hold the paused values through a shortened stop, rather than racing through it', () => {
    // 1 km at 5 m/s, ten minutes standing, 1 km more; heart rate climbing a beat a second all along.
    const points: TestPoint[] = straightNorth(1000, 10, 5);
    const t = points[points.length - 1]!.second!;
    for (let s = 5; s <= 600; s += 5) points.push({ north: 1000, east: 0, second: t + s });
    for (const point of straightNorth(1000, 10, 5).slice(1)) points.push({ north: 1000 + point.north, east: 0, second: t + 600 + point.second! });
    const stopped = activityThrough(points);
    stopped.points.forEach((point) => {
      point.heartRateBpm = 100 + (point.time!.getTime() - stopped.points[0]!.time!.getTime()) / 1000;
    });
    const paused = modelOf(stopped, { lengthSeconds: 30, timing: { mode: 'time', pauseBeatSeconds: 2 } });
    const [pause] = paused.timeline.pauses;
    expect(pause).toBeDefined();
    const clock = mapVideoOverlayTimeline(stopped, paused);
    const into = paused.timeline.introSeconds + pause!.startSeconds;
    const samples = [0.1, 0.9, 1.9].map((d) => clock.sampleAt(into + d)!);
    for (const sample of samples) {
      expect(sample.values[SPEED]).toBe(0);
      expect(sample.values['metric:pace']).toBeUndefined();
      expect(sample.activityElapsedSeconds).toBeCloseTo(t, 6);
      expect(sample.values[HEART]).toBeCloseTo(100 + t, 6);
    }
    // And after the beat, the ride goes on from the stop's end.
    expect(clock.sampleAt(paused.timeline.introSeconds + pause!.endSeconds + 0.05)!.activityElapsedSeconds).toBeGreaterThan(t + 600);
  });
});

describe('what the figures may draw (AV-1207, TD-066)', () => {
  it('leave the trimmed stretches out of the route they draw, and keep the whole activity\'s totals', () => {
    const long = activityThrough(straightNorth(3000));
    const model = modelOf(long, { privacyTrim: { startMeters: 500, endMeters: 400 } });
    const shown = shownActivity(long, model, settings({ privacyTrim: { startMeters: 500, endMeters: 400 } }));
    const lowest = model.route.vertices[0]!.lat;
    const highest = model.route.vertices[model.route.vertices.length - 1]!.lat;
    for (const point of shown.points) {
      expect(point.lat!).toBeGreaterThanOrEqual(lowest - 1e-12);
      expect(point.lat!).toBeLessThanOrEqual(highest + 1e-12);
    }
    expect(shown.points.length).toBeLessThan(long.points.length);
    expect(shown.derived).toBe(long.derived);
  });
});

describe('the summary card (AV-1207)', () => {
  const card = (patch?: Partial<MapVideoSettings>) => {
    const model = modelOf(ride, patch);
    const figures = createMapVideoFigures({ activity: ride, model, settings: settings(patch), units: 'metric', width: 1280, height: 720 });
    return (t: number) => displayList((ctx) => figures.drawFrame(ctx, t));
  };

  it('shows the totals through the outro, and nothing before it', () => {
    const draw = card();
    expect(draw(5)).toBe('\n');
    const outro = draw(9);
    expect(outro).toMatch(/fillText\("DISTANCE"/);
    expect(outro).toMatch(/fillText\("MOVING TIME"/);
    expect(outro).toMatch(/fillText\("ELEVATION GAIN"/);
    expect(outro).toMatch(/fillText\("AVG SPEED"/);
    expect(outro).not.toMatch(/Mapzen/);
  });

  it('is left out when turned off, and credits the terrain in full when it is drawn', () => {
    expect(card({ summaryCard: { enabled: false } })(9)).toBe('\n');
    expect(card({ terrain: { enabled: true, exaggeration: 1.5 } })(9)).toMatch(/fillText\("[^"]*Mapzen/);
  });

  it('reads pace for a run', () => {
    const template = summaryCardTemplate('running', { width: 1920, height: 1080 });
    expect(template.components.map((component) => component.summary?.stat).filter(Boolean)).toEqual(['distance', 'moving', 'climb', 'pace']);
  });
});

describe('a composited map video frame, as a golden (AV-1207)', () => {
  it('draws the figures over the map frame, the same every time', async () => {
    const model = modelOf(ride);
    const timeline = mapVideoOverlayTimeline(ride, model);
    const empty: OverlayTemplate = { version: OVERLAY_TEMPLATE_VERSION, name: 'Figures', style: DEFAULT_OVERLAY_STYLE, components: [] };
    const size = { width: 1280, height: 720 };
    const components = (['metric:speed', 'metric:heartRate', 'progress', 'route', 'still:distance'] as const).reduce(
      (list, key) => [...list, newCanvasComponent({ ...empty, components: list }, key, size, timeline)],
      [] as OverlayTemplate['components'],
    );
    const figures = createMapVideoFigures({ activity: ride, model, settings: settings({ overlay: canvasTemplate(components) }), units: 'metric', ...size });
    // The map's pixels stand in as one opaque frame drawn first, as the export composites them.
    const frame = (t: number) => displayList((ctx) => {
      ctx.drawImage({} as CanvasImageSource, 0, 0, size.width, size.height);
      figures.drawFrame(ctx, t);
    });
    const at5 = frame(5);
    expect(at5.split('\n')[0]).toBe('drawImage([map frame], 0, 0, 1280, 720)');
    expect(frame(5)).toBe(at5);
    expect(frame(6)).not.toBe(at5);
    await expect(at5).toMatchFileSnapshot('./__golden__/map-video-figures-t5.txt');
  });
});
