import { describe, expect, it } from 'vitest';
import {
  CHART_METRICS,
  DIAL_METRICS,
  canvasElementChoices,
  canvasTemplate,
  newCanvasComponent,
  newChartComponent,
  newCompassComponent,
  newDialComponent,
  newGradientComponent,
} from './customCanvas';
import { DEFAULT_COMPASS } from './compass';
import { DEFAULT_DIAL } from './dial';
import { DEFAULT_GRADIENT, addGradientBand, gradientBand, gradientGlyph, removeLastGradientBand, setGradientBand } from './gradient';
import { extractRoute } from './routeImage';
import { parseStillLayout } from './staticImage';
import {
  CHART_WINDOW_MAX,
  DEFAULT_CHART,
  MOMENT_COMPONENT_TYPES,
  OVERLAY_COMPONENT_TYPES,
  parseOverlayTemplate,
  resolveOverlayComponent,
  serializeOverlayTemplate,
  unavailableBindings,
  type OverlayComponent,
} from './template';
import { buildOverlayTimeline } from './timeline';
import type { Activity } from '../domain/activity';
import { makeActivity } from '../test/helpers/activity';

/** AV-1019 (TD-087). The four new types in a layout file, in the model and in the editor's list. */

const T0 = Date.parse('2026-09-24T08:00:00Z');
const SIZE = { width: 1920, height: 1080 };
const ride = (extra: (i: number) => object = () => ({})): Activity =>
  makeActivity(Array.from({ length: 61 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + (i * 5) / 111_320, lon: 7, speedMetersPerSecond: i / 6, heartRateBpm: 100 + i, ...extra(i) })));
const timelineOf = (activity: Activity) => buildOverlayTimeline(activity, { video: { durationSeconds: 60 } });
const timeline = timelineOf(ride((i) => ({ elevationMeters: 100 + i, powerWatts: 200 })));

const all = (): OverlayComponent[] => {
  const t = canvasTemplate([]);
  const dial = newDialComponent(t, 'speed', SIZE, timeline);
  const chart = newChartComponent(canvasTemplate([dial]), 'elevation', SIZE, timeline);
  const gradient = newGradientComponent(canvasTemplate([dial, chart]), SIZE);
  const compass = newCompassComponent(canvasTemplate([dial, chart, gradient]), SIZE);
  return [dial, chart, gradient, compass];
};
const parse = (components: OverlayComponent[]) => parseOverlayTemplate(serializeOverlayTemplate(canvasTemplate(components)));
const component = (type: string, extra: Record<string, unknown> = {}) => ({
  id: 'x',
  type,
  visible: true,
  rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  unitMode: 'auto',
  style: {},
  ...extra,
});
const read = (entry: Record<string, unknown>) => {
  const result = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', style: {}, components: [entry] }));
  if (!result.ok) throw new Error(result.error);
  return result;
};

describe('the four types in a layout file', () => {
  it('are component types, in version 2, and survive a round trip unchanged', () => {
    for (const type of ['dial', 'chart', 'gradient', 'compass']) expect(OVERLAY_COMPONENT_TYPES).toContain(type);
    const components = all();
    const template = canvasTemplate(components);
    expect(template.version).toBe(2);
    expect(parse(components)).toEqual({ ok: true, template, warnings: [] });
  });

  it('keep every setting through a round trip, including the optional ones', () => {
    const [dial, chart, gradient, compass] = all();
    const custom: OverlayComponent[] = [
      { ...dial!, range: { min: 20, max: 80 }, dial: { sweep: 200, majorStep: 15, minorTicks: 2, pointer: 'marker', trackColor: '#010203', fillColor: '#040506', needleColor: '#070809' }, smoothing: { windowSeconds: 4 }, figure: { showLabel: false, halo: { color: '#000000', opacity: 0.3 } } },
      { ...chart!, chart: { axis: 'time', window: 90, lineColor: '#112233', fillColor: '#445566', fillOpacity: 0.7, labels: false } },
      { ...gradient!, gradient: { bands: [{ from: -100, color: '#000001' }, { from: 0.5, color: '#000002' }, { from: 20, color: '#000003' }], glyph: false }, smoothing: { windowSeconds: 8 } },
      { ...compass!, compass: { style: 'needle', labels: false, roseColor: '#0a0b0c', needleColor: '#0d0e0f' }, display: { label: 'Facing' } },
    ];
    const result = parse(custom);
    expect(result).toEqual({ ok: true, template: canvasTemplate(custom), warnings: [] });
  });

  it('reads an invalid setting as its default, one setting at a time', () => {
    const result = read(
      component('dial', {
        source: { kind: 'metric', metric: 'speed' },
        dial: { sweep: 'wide', majorStep: -3, minorTicks: 'many', pointer: 'arrow', trackColor: 'red', fillColor: '#12345', needleColor: '#ABCDEF' },
      }),
    );
    expect(result.template.components[0]!.dial).toEqual({ ...DEFAULT_DIAL, needleColor: '#abcdef' });
    expect(result.warnings).toEqual([]);
  });

  it('clamps a number to its limits', () => {
    const low = read(component('dial', { source: { kind: 'metric', metric: 'speed' }, dial: { sweep: 10, minorTicks: -4, majorStep: 5 } })).template.components[0]!.dial!;
    expect(low).toMatchObject({ sweep: 180, minorTicks: 0, majorStep: 5 });
    const high = read(component('dial', { source: { kind: 'metric', metric: 'speed' }, dial: { sweep: 999, minorTicks: 77.6 } })).template.components[0]!.dial!;
    expect(high).toMatchObject({ sweep: 300, minorTicks: 9 });
    const chart = read(component('chart', { source: { kind: 'metric', metric: 'speed' }, chart: { window: 1e12, fillOpacity: 4 } })).template.components[0]!.chart!;
    expect(chart).toMatchObject({ window: CHART_WINDOW_MAX, fillOpacity: 1 });
  });

  it('reads a chart’s window as absent (the whole activity) unless it is a positive number', () => {
    for (const window of [0, -5, 'ten', null, Number.NaN]) {
      expect(read(component('chart', { source: { kind: 'metric', metric: 'speed' }, chart: { window } })).template.components[0]!.chart).toEqual(DEFAULT_CHART);
    }
    expect(read(component('chart', { source: { kind: 'metric', metric: 'speed' }, chart: { axis: 'distance', window: 250 } })).template.components[0]!.chart).toMatchObject({ axis: 'distance', window: 250 });
    expect(read(component('chart', { source: { kind: 'metric', metric: 'speed' }, chart: { axis: 'depth' } })).template.components[0]!.chart!.axis).toBe('time');
  });

  it('gives a component with no settings of its own the defaults', () => {
    expect(read(component('dial', { source: { kind: 'metric', metric: 'power' } })).template.components[0]!.dial).toEqual(DEFAULT_DIAL);
    expect(read(component('chart', { source: { kind: 'metric', metric: 'power' } })).template.components[0]!.chart).toEqual(DEFAULT_CHART);
    expect(read(component('gradient')).template.components[0]!.gradient).toEqual(DEFAULT_GRADIENT);
    expect(read(component('compass')).template.components[0]!.compass).toEqual(DEFAULT_COMPASS);
  });

  it('reads a band set as a whole, by the rules of the bands: two to ten, ascending, coloured', () => {
    const bands = (list: unknown) => read(component('gradient', { gradient: { bands: list } })).template.components[0]!.gradient!.bands;
    const good = [{ from: -100, color: '#111111' }, { from: 4, color: '#222222' }];
    expect(bands(good)).toEqual(good);
    for (const bad of [
      [{ from: 0, color: '#111111' }],
      Array.from({ length: 11 }, (_, i) => ({ from: i, color: '#111111' })),
      [{ from: 5, color: '#111111' }, { from: 5, color: '#222222' }],
      [{ from: 5, color: '#111111' }, { from: 1, color: '#222222' }],
      [{ from: 0, color: 'blue' }, { from: 1, color: '#222222' }],
      [{ from: 'x', color: '#111111' }, { from: 1, color: '#222222' }],
      'bands',
      null,
    ]) {
      expect(bands(bad)).toEqual(DEFAULT_GRADIENT.bands);
    }
    // Ten bands are allowed; a start outside the scale is kept inside it.
    const ten = Array.from({ length: 10 }, (_, i) => ({ from: i * 2, color: '#111111' }));
    expect(bands(ten)).toHaveLength(10);
    expect(bands([{ from: -900, color: '#111111' }, { from: 900, color: '#222222' }]).map((band) => band.from)).toEqual([-100, 100]);
  });

  it('reads a gradient indicator’s source as the grade and a compass’ as the heading, whatever the file says', () => {
    expect(read(component('gradient', { source: { kind: 'metric', metric: 'power' } })).template.components[0]!.source).toEqual({ kind: 'metric', metric: 'grade' });
    expect(read(component('compass', { source: { kind: 'sensor', key: 'ACCL' } })).template.components[0]!.source).toEqual({ kind: 'metric', metric: 'heading' });
    expect(read(component('compass')).template.components[0]!.source).toEqual({ kind: 'metric', metric: 'heading' });
  });

  it('needs a source for a dial and a chart, and skips one that has none, with a warning', () => {
    for (const type of ['dial', 'chart']) {
      const result = read(component(type, { source: { kind: 'metric', metric: 'speed2' } }));
      expect(result.template.components).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    }
  });

  it('keeps the figure’s styling on all four, and smoothing on all but the chart', () => {
    for (const type of ['dial', 'chart', 'gradient', 'compass']) {
      const source = { source: { kind: 'metric', metric: 'speed' } };
      const parsed = read(component(type, { ...source, figure: { labelScale: 2 }, smoothing: { windowSeconds: 40 } })).template.components[0]!;
      expect(parsed.figure, type).toEqual({ labelScale: 2 });
      expect(parsed.smoothing, type).toEqual(type === 'chart' ? undefined : { windowSeconds: 30 });
    }
  });

  it('never throws, whatever the settings are', () => {
    for (const junk of [null, 7, 'x', [], [1, 2], { sweep: {} }, { bands: [null, undefined, 3] }, { window: [] }, { labels: {} }]) {
      for (const type of ['dial', 'chart', 'gradient', 'compass']) {
        const entry = component(type, { source: { kind: 'metric', metric: 'speed' }, dial: junk, chart: junk, gradient: junk, compass: junk });
        expect(() => parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', style: {}, components: [entry] }))).not.toThrow();
      }
    }
  });

  it('leave an older layout as it was: no setting, no field, the profile as it was', () => {
    const older = {
      version: 2,
      name: 'Old',
      style: {},
      components: [
        component('elevationProfile', { id: 'profile' }),
        component('gauge', { id: 'g', source: { kind: 'metric', metric: 'speed' }, range: { min: 0, max: 15 } }),
        component('zones', { id: 'z', source: { kind: 'metric', metric: 'heartRate' } }),
      ],
    };
    const result = parseOverlayTemplate(JSON.stringify(older));
    expect(result.ok && result.warnings).toEqual([]);
    const parsed = result.ok ? result.template.components : [];
    expect(parsed.map((entry) => entry.type)).toEqual(['elevationProfile', 'gauge', 'zones']);
    for (const entry of parsed) for (const key of ['dial', 'chart', 'gradient', 'compass']) expect(entry).not.toHaveProperty(key);
  });

  it('are left out of a still, with a warning each', () => {
    const text = JSON.stringify({ kind: 'opentrack-overlay-layout', version: 1, image: { width: 1280, height: 720 }, template: canvasTemplate(all()) });
    const result = parseStillLayout(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.template.components).toEqual([]);
    expect(result.warnings).toEqual([
      'Speed dial was left out: it is drawn only on a video.'.replace('Speed dial', 'Dial'),
      'Elevation chart was left out: it is drawn only on a video.'.replace('Elevation chart', 'Chart'),
      'Gradient indicator was left out: it is drawn only on a video.',
      'Compass was left out: it is drawn only on a video.',
    ]);
    expect(MOMENT_COMPONENT_TYPES).toEqual(['zones', 'dial', 'chart', 'gradient', 'compass']);
  });
});

describe('resolving them against the data', () => {
  const [dial, chart, gradient, compass] = all();
  const template = canvasTemplate(all());
  const resolve = (item: OverlayComponent, seconds = 30, from = timeline) =>
    resolveOverlayComponent(template, item, from.sampleAt(seconds), from, 'metric');

  it('gives a dial the value’s place in its range, pinned at the ends, and the figure’s text', () => {
    const ready = resolve({ ...dial!, range: { min: 0, max: 10 } });
    expect(ready).toMatchObject({ status: 'ready', fraction: 0.5, value: 5, range: { min: 0, max: 10 }, label: 'Speed', text: '18.0 km/h' });
    expect(resolve({ ...dial!, range: { min: 6, max: 10 } })).toMatchObject({ fraction: 0 });
    expect(resolve({ ...dial!, range: { min: 0, max: 2 } })).toMatchObject({ fraction: 1 });
  });

  it('gives a dial with no range the activity’s own, rounded', () => {
    const ready = resolve({ ...dial!, range: undefined });
    // 0 to 10 m/s: 0 to 10 in steps of 2... 10 m/s is the top.
    expect(ready).toMatchObject({ status: 'ready', range: { min: 0, max: 10 } });
  });

  it('smooths a dial’s value as a figure’s, and hides it where the moment has none', () => {
    const smoothed = resolve({ ...dial!, range: { min: 0, max: 10 }, smoothing: { windowSeconds: 10 } }, 30);
    expect(smoothed).toMatchObject({ status: 'ready' });
    expect((smoothed as { value: number }).value).toBeCloseTo(4.17, 1);
    expect(resolve({ ...dial!, source: { kind: 'metric', metric: 'cyclingCadence' } })).toMatchObject({ status: 'hidden', reason: 'no_data' });
    expect(resolveOverlayComponent(template, dial!, undefined, timeline, 'metric')).toMatchObject({ status: 'hidden', reason: 'no_data' });
  });

  it('gives a chart nothing to draw only where the activity has no values for it, or no distance for a distance axis', () => {
    expect(resolve(chart!)).toMatchObject({ status: 'ready' });
    expect(resolve({ ...chart!, source: { kind: 'metric', metric: 'cyclingCadence' } })).toMatchObject({ status: 'hidden', reason: 'no_data' });
    const indoors = timelineOf(ride((i) => ({ lat: undefined, lon: undefined, elevationMeters: i })));
    expect(resolve({ ...chart!, chart: { ...DEFAULT_CHART, axis: 'distance' } }, 30, indoors)).toMatchObject({ status: 'hidden', reason: 'no_data' });
    expect(resolve({ ...chart!, chart: { ...DEFAULT_CHART, axis: 'time' } }, 30, indoors)).toMatchObject({ status: 'ready' });
  });

  it('gives the gradient indicator the grade and the compass the heading, written as figures', () => {
    expect(resolve(gradient!)).toMatchObject({ status: 'ready', label: 'Grade' });
    // 1 m up every 5 m of the ride: 20 %, derived from the elevation.
    expect((resolve(gradient!) as { value: number }).value).toBeCloseTo(20, 0);
    expect((resolve(gradient!) as { text: string }).text).toBe('20.0 %');
    expect(resolve(compass!)).toMatchObject({ status: 'ready', label: 'Heading', text: '0° N' });
  });

  it('says what is not in the activity, as for any figure', () => {
    const bare = timelineOf(ride());
    const warnings = unavailableBindings(template, bare).map((warning) => warning.source);
    expect(warnings).toEqual(expect.arrayContaining(['metric:grade']));
    expect(warnings).not.toContain('metric:heading');
    const indoors = timelineOf(ride((i) => ({ lat: undefined, lon: undefined, elevationMeters: i })));
    expect(unavailableBindings(template, indoors).map((warning) => warning.source)).toContain('metric:heading');
  });
});

describe('the Add list', () => {
  const choices = canvasElementChoices(timeline, { activity: ride(), route: extractRoute(ride()), units: 'metric', readerTimeZone: 'UTC' });
  const choice = (key: string) => choices.find((entry) => entry.key === key)!;

  it('offers a dial, a chart, the gradient indicator and the compass among the live figures, each with the reason when the activity cannot', () => {
    for (const metric of DIAL_METRICS) expect(choice(`dial:${metric}`).group).toBe('Live figures');
    for (const metric of CHART_METRICS) expect(choice(`chart:${metric}`).group).toBe('Live figures');
    expect(choice('dial:speed')).toMatchObject({ label: 'Speed dial', available: true });
    expect(choice('chart:heartRate')).toMatchObject({ label: 'Heart rate chart', available: true });
    expect(choice('dial:cyclingCadence')).toMatchObject({ available: false, reason: 'This activity has no cycling cadence.' });
    expect(choice('gradient')).toMatchObject({ label: 'Gradient indicator', available: true });
    expect(choice('compass')).toMatchObject({ label: 'Compass', available: true });
    const none = canvasElementChoices(timelineOf(makeActivity([{ time: new Date(T0), speedMetersPerSecond: 1 }, { time: new Date(T0 + 1000), speedMetersPerSecond: 2 }])), { activity: ride(), route: extractRoute(ride()), units: 'metric', readerTimeZone: 'UTC' });
    expect(none.find((entry) => entry.key === 'gradient')).toMatchObject({ available: false, reason: expect.stringContaining('no gradient') });
    expect(none.find((entry) => entry.key === 'compass')).toMatchObject({ available: false, reason: expect.stringContaining('no heading') });
  });

  it('makes each, in the frame, with an id of its own and the settings that suit it', () => {
    const t = canvasTemplate([]);
    for (const key of ['dial:speed', 'dial:heartRate', 'chart:speed', 'chart:elevation', 'gradient', 'compass'] as const) {
      const made = newCanvasComponent(t, key, SIZE, timeline);
      expect(made.rect.x + made.rect.width).toBeLessThanOrEqual(1);
      expect(made.rect.y + made.rect.height).toBeLessThanOrEqual(1);
      expect(made.visible).toBe(true);
      const again = newCanvasComponent(canvasTemplate([made]), key, SIZE, timeline);
      expect(again.id).not.toBe(made.id);
    }
    expect(newCanvasComponent(t, 'dial:speed', SIZE, timeline)).toMatchObject({ type: 'dial', range: { min: 0, max: 10 }, dial: DEFAULT_DIAL });
    expect(newCanvasComponent(t, 'dial:heartRate', SIZE, timeline).range).toEqual({ min: 100, max: 160 });
    expect(newCanvasComponent(t, 'chart:elevation', SIZE, timeline).chart!.axis).toBe('distance');
    expect(newCanvasComponent(t, 'chart:speed', SIZE, timeline).chart!.axis).toBe('time');
    expect(newCanvasComponent(t, 'gradient', SIZE, timeline).smoothing).toEqual({ windowSeconds: 5 });
    expect(newCanvasComponent(t, 'compass', SIZE, timeline).smoothing).toEqual({ windowSeconds: 3 });
  });

  it('makes a dial and a compass square in pixels, whatever the frame’s shape', () => {
    for (const size of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const key of ['dial:speed', 'compass'] as const) {
        const made = newCanvasComponent(canvasTemplate([]), key, size, timeline);
        expect((made.rect.width * size.width) / (made.rect.height * size.height)).toBeCloseTo(1, 3);
      }
    }
  });

  it('starts a chart of elevation along time where the activity has no distance', () => {
    const indoors = timelineOf(ride((i) => ({ lat: undefined, lon: undefined, elevationMeters: i })));
    expect(newChartComponent(canvasTemplate([]), 'elevation', SIZE, indoors).chart!.axis).toBe('time');
  });
});

describe('the gradient’s bands', () => {
  it('finds the band of a grade, a bound belonging to the band above it', () => {
    const bands = DEFAULT_GRADIENT.bands;
    expect([-50, -1.0001, -1, 0, 2.9999, 3, 6, 9, 12, 40].map((grade) => gradientBand(grade, bands))).toEqual([0, 0, 1, 1, 1, 2, 3, 4, 5, 5]);
  });

  it('chooses a glyph at one percent', () => {
    expect([2, 1, 0.99, 0, -0.99, -1, -9].map(gradientGlyph)).toEqual(['up', 'up', 'flat', 'flat', 'flat', 'down', 'down']);
  });

  it('adds a band above the last, up to ten, and takes the last away, down to two', () => {
    let setting = DEFAULT_GRADIENT;
    for (let i = 0; i < 6; i += 1) setting = addGradientBand(setting);
    expect(setting.bands).toHaveLength(10);
    expect(addGradientBand(setting)).toBe(setting);
    const froms = setting.bands.map((band) => band.from);
    expect([...froms].sort((a, b) => a - b)).toEqual(froms);
    for (let i = 0; i < 12; i += 1) setting = removeLastGradientBand(setting);
    expect(setting.bands).toHaveLength(2);
    expect(removeLastGradientBand(setting)).toBe(setting);
  });

  it('keeps a start between its neighbours, whatever is typed, and the first band is the floor', () => {
    const moved = (index: number, from: number) => setGradientBand(DEFAULT_GRADIENT, index, { from }).bands.map((band) => band.from);
    expect(moved(2, 100)[2]).toBeLessThan(6);
    expect(moved(2, -50)[2]).toBeGreaterThan(-1);
    expect(moved(2, 4.26)[2]).toBe(4.3);
    expect(moved(0, 5)[0]).toBe(-100);
    expect(setGradientBand(DEFAULT_GRADIENT, 1, { color: '#abcdef' }).bands[1]).toEqual({ from: -1, color: '#abcdef' });
  });
});
