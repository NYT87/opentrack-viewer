import { describe, expect, it } from 'vitest';
import {
  CANVAS_PRESETS,
  UNDO_DEPTH,
  canvasElementChoices,
  canvasTemplate,
  checkCanvasSize,
  componentsFromPreset,
  duplicateComponent,
  growFigureToFit,
  moveComponent,
  moveLayer,
  newCanvasComponent,
  nudgeComponent,
  pushHistory,
  removeComponent,
  resizeComponent,
  scaleText,
  setHolder,
  type CanvasState,
} from './customCanvas';
import { buildOverlayTimeline } from './timeline';
import { extractRoute } from './routeImage';
import { DEFAULT_SHAPE, type OverlayComponent } from './template';
import type { Activity } from '../domain/activity';
import { makeActivity } from '../test/helpers/activity';

const T0 = Date.parse('2026-09-24T08:00:00Z');
const ride = (extra: (i: number) => object = () => ({})) =>
  makeActivity(Array.from({ length: 61 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + (i * 5) / 111_320, lon: 7, ...extra(i) })));
const timelineOf = (activity: Activity) => buildOverlayTimeline(activity, { video: { durationSeconds: 60 } });
const still = (activity: Activity) => ({ activity, route: extractRoute(activity), units: 'metric' as const, readerTimeZone: 'UTC' });

const box = (id: string, rect: OverlayComponent['rect'], extra: Partial<OverlayComponent> = {}): OverlayComponent => ({
  id,
  type: 'text',
  visible: true,
  rect,
  unitMode: 'auto',
  style: {},
  source: { kind: 'metric', metric: 'speed' },
  ...extra,
});
const card = (id: string, rect: OverlayComponent['rect']): OverlayComponent => ({ ...box(id, rect), type: 'shape', source: undefined, shape: DEFAULT_SHAPE });

describe('the canvas’s resolution (AV-1011)', () => {
  it('takes the presets, and refuses what an encoder or a browser cannot, saying why', () => {
    for (const preset of CANVAS_PRESETS) expect(checkCanvasSize(preset.width, preset.height)).toBeUndefined();
    expect(CANVAS_PRESETS.map((preset) => preset.id)).toEqual(expect.arrayContaining(['1920x1080', '1080x1920', '1080x1080', '3840x2160']));
    expect(checkCanvasSize(1921, 1080)).toMatch(/even/);
    expect(checkCanvasSize(1920.5, 1080)).toMatch(/whole numbers/);
    expect(checkCanvasSize(32, 1080)).toMatch(/between 64 and 4096/);
    expect(checkCanvasSize(4096, 4096)).toMatch(/more than/);
  });

  it('keeps a layout’s proportions at another resolution: it is stored in fractions', () => {
    const activity = ride();
    const components = componentsFromPreset('compact-hud', timelineOf(activity), { width: 1920, height: 1080 });
    const template = canvasTemplate(components);
    for (const { rect } of template.components) {
      for (const value of [rect.x, rect.y, rect.width, rect.height]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    // The same template at twice the size: every box twice as large, in the same place.
    const px = (width: number, height: number) => template.components.map(({ rect }) => [rect.x * width, rect.y * height, rect.width * width, rect.height * height]);
    expect(px(3840, 2160)).toEqual(px(1920, 1080).map((values) => values.map((value) => value * 2)));
  });
});

describe('placing on the canvas (AV-1011)', () => {
  it('moves an element and keeps it inside the frame', () => {
    const components = [box('a', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 })];
    expect(moveComponent(components, 'a', 0.5, 0.5)[0]!.rect).toEqual({ x: 0.5, y: 0.5, width: 0.2, height: 0.1 });
    expect(moveComponent(components, 'a', 2, -1)[0]!.rect).toMatchObject({ x: 0.8, y: 0 });
    expect(nudgeComponent(components, 'a', -0.5, 0)[0]!.rect.x).toBe(0);
  });

  it('moves a shape with what it holds, as one, kept inside the frame as one', () => {
    const components = [
      card('card', { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }),
      box('speed', { x: 0.15, y: 0.15, width: 0.1, height: 0.05 }, { parentId: 'card' }),
      box('free', { x: 0.5, y: 0.5, width: 0.1, height: 0.05 }),
    ];
    const moved = moveComponent(components, 'card', 0.2, 0.3);
    expect(moved.find((c) => c.id === 'card')!.rect).toMatchObject({ x: 0.2, y: 0.3 });
    expect(moved.find((c) => c.id === 'speed')!.rect).toMatchObject({ x: 0.25, y: 0.35 });
    expect(moved.find((c) => c.id === 'free')!.rect).toMatchObject({ x: 0.5, y: 0.5 });
    // Pushed past the edge, the group stops where its furthest member meets it.
    const held = [card('card', { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }), box('wide', { x: 0.05, y: 0.15, width: 0.1, height: 0.05 }, { parentId: 'card' })];
    const left = moveComponent(held, 'card', -1, 0.1);
    expect(left.find((c) => c.id === 'wide')!.rect.x).toBe(0);
    expect(left.find((c) => c.id === 'card')!.rect.x).toBeCloseTo(0.05, 6);
    // A held element moves on its own when moved by itself.
    expect(moveComponent(components, 'speed', 0.6, 0.6).find((c) => c.id === 'card')!.rect).toMatchObject({ x: 0.1, y: 0.1 });
  });

  it('resizes between a hundredth of the frame and what is left of it', () => {
    const components = [box('a', { x: 0.7, y: 0.8, width: 0.2, height: 0.1 })];
    expect(resizeComponent(components, 'a', 0.5, 0.5)[0]!.rect).toMatchObject({ width: 0.3, height: 0.2 });
    expect(resizeComponent(components, 'a', 0, -1)[0]!.rect).toMatchObject({ width: 0.01, height: 0.01 });
  });

  it('resizes a text by scaling its words, within the text size limits', () => {
    const text = box('label', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, { type: 'label', style: { fontScale: 1.5 } });
    const scaled = (factor: number) => scaleText([text], 'label', text, factor)[0]!;
    expect(scaled(2).style.fontScale).toBe(3);
    expect(scaled(2).rect).toEqual(text.rect);
    expect(scaled(0.01).style.fontScale).toBe(0.1);
    expect(scaled(100).style.fontScale).toBe(10);
    expect(scaled(Number.NaN).style.fontScale).toBe(1.5);
  });

  it('changes the layer order: the last drawn is in front', () => {
    const order = (components: OverlayComponent[]) => components.map((c) => c.id);
    const components = ['a', 'b', 'c', 'd'].map((id) => box(id, { x: 0, y: 0, width: 0.1, height: 0.1 }));
    expect(order(moveLayer(components, 'b', 'front'))).toEqual(['a', 'c', 'd', 'b']);
    expect(order(moveLayer(components, 'c', 'back'))).toEqual(['c', 'a', 'b', 'd']);
    expect(order(moveLayer(components, 'b', 'forward'))).toEqual(['a', 'c', 'b', 'd']);
    expect(order(moveLayer(components, 'b', 'backward'))).toEqual(['b', 'a', 'c', 'd']);
    expect(order(moveLayer(components, 'a', 'backward'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('duplicates in front, just beside, inside the frame, with an id of its own', () => {
    const components = [box('speed-1', { x: 0.89, y: 0.5, width: 0.1, height: 0.1 }, { parentId: 'card' }), card('card', { x: 0, y: 0, width: 1, height: 1 })];
    const { components: next, id } = duplicateComponent(components, 'speed-1');
    expect(id).toBe('speed-2');
    const copy = next.at(-1)!;
    expect(copy).toMatchObject({ id: 'speed-2', parentId: 'card', source: { kind: 'metric', metric: 'speed' } });
    expect(copy.rect).toMatchObject({ x: 0.9, y: 0.52 });
  });

  it('deletes an element and lets go of what it held; holds only in a shape, never itself', () => {
    const components = [card('card', { x: 0, y: 0, width: 0.5, height: 0.5 }), box('speed', { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, { parentId: 'card' })];
    const next = removeComponent(components, 'card');
    expect(next).toHaveLength(1);
    expect(next[0]!.parentId).toBeUndefined();
    expect(setHolder(components, 'speed', undefined)[1]!.parentId).toBeUndefined();
    expect(setHolder(components, 'card', 'card')).toBe(components);
    expect(setHolder(components, 'card', 'speed')).toBe(components);
  });
});

describe('undo (AV-1011)', () => {
  it('keeps every state, the selection included, adds nothing for no change, and stops at its depth', () => {
    const a: CanvasState = { components: [], selectedId: undefined };
    const b: CanvasState = { components: a.components, selectedId: 'x' };
    let history = pushHistory([], a);
    history = pushHistory(history, a);
    expect(history).toHaveLength(1);
    history = pushHistory(history, b);
    expect(history).toEqual([a, b]);
    for (let i = 0; i < UNDO_DEPTH + 10; i += 1) history = pushHistory(history, { components: [], selectedId: String(i) });
    expect(history).toHaveLength(UNDO_DEPTH);
  });
});

describe('what the canvas offers (AV-1011)', () => {
  it('offers live figures, whole-activity ones, text and shapes, and says why one is missing', () => {
    const activity = ride();
    const choices = canvasElementChoices(timelineOf(activity), still(activity));
    const of = (key: string) => choices.find((choice) => choice.key === key);
    for (const key of ['metric:speed', 'metric:distance', 'metric:elapsed', 'metric:moving', 'metric:pace', 'gauge:speed', 'route', 'progress', 'still:label', 'still:date', 'still:distance', 'shape:roundedRect', 'shape:rect', 'shape:ellipse', 'shape:line']) {
      expect(of(key), key).toMatchObject({ available: true });
    }
    expect(of('metric:heartRate')).toMatchObject({ available: false, reason: 'This activity has no heart rate.' });
    expect(of('gauge:heartRate')).toMatchObject({ available: false });
    expect(of('metric:power')).toMatchObject({ available: false, reason: 'This activity has no power.' });

    const noPlace = makeActivity([{ time: new Date(T0) }, { time: new Date(T0 + 1000) }]);
    const placeless = canvasElementChoices(timelineOf(noPlace), still(noPlace));
    expect(placeless.find((choice) => choice.key === 'route')).toMatchObject({ available: false, reason: expect.stringMatching(/no positions/) });
    expect(placeless.find((choice) => choice.key === 'metric:distance')).toMatchObject({ available: false });
  });

  it('makes each new element in the frame, with an id of its own and the data it shows', () => {
    const activity = ride((i) => ({ heartRateBpm: 120 + i }));
    const timeline = timelineOf(activity);
    let template = canvasTemplate([]);
    for (const key of canvasElementChoices(timeline, still(activity)).map((choice) => choice.key)) {
      const component = newCanvasComponent(template, key, { width: 1920, height: 1080 }, timeline);
      expect(component.rect.x + component.rect.width, key).toBeLessThanOrEqual(1);
      expect(component.rect.y + component.rect.height, key).toBeLessThanOrEqual(1);
      expect(template.components.some((c) => c.id === component.id), key).toBe(false);
      template = canvasTemplate([...template.components, component]);
    }
    const byId = (prefix: string) => template.components.find((c) => c.id.startsWith(prefix))!;
    expect(byId('moving')).toMatchObject({ type: 'text', source: { kind: 'metric', metric: 'moving' } });
    expect(byId('speed-gauge')).toMatchObject({ type: 'gauge', range: { min: 0, max: 5 } });
    expect(byId('heartRate-gauge')).toMatchObject({ type: 'gauge', range: { min: 50, max: 200 } });
    expect(template.components.filter((c) => c.type === 'shape').map((c) => c.shape!.kind)).toEqual(['roundedRect', 'rect', 'ellipse', 'line']);
  });

  it('offers the elevation profile where the activity has elevation, says why not where it has none, and makes it a strip (AV-1211)', () => {
    const climbing = ride((i) => ({ elevationMeters: 100 + i }));
    const offer = (activity: Activity) => canvasElementChoices(timelineOf(activity), still(activity)).find((choice) => choice.key === 'elevationProfile');
    expect(offer(climbing)).toMatchObject({ label: 'Elevation profile', group: 'Live figures', available: true });
    expect(offer(ride())).toMatchObject({ available: false, reason: 'This activity has no elevation.' });
    for (const size of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
      const made = newCanvasComponent(canvasTemplate([]), 'elevationProfile', size, timelineOf(climbing));
      expect(made).toMatchObject({ id: 'elevation-profile-1', type: 'elevationProfile' });
      expect(made.source).toBeUndefined();
      // Four times as wide as it is tall, on the frame.
      expect((made.rect.width * size.width) / (made.rect.height * size.height)).toBeCloseTo(4, 6);
    }
  });

  it('starts from a built-in template’s layout', () => {
    const components = componentsFromPreset('metric-strip', timelineOf(ride()), { width: 1080, height: 1920 });
    expect(components.map((c) => c.id)).toEqual(expect.arrayContaining(['speed', 'distance', 'elapsed']));
  });
});

describe('growing a figure’s box to fit its text (AV-1015, TD-083)', () => {
  const frame = { width: 1920, height: 1080 };
  const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)![1]) * 0.55;
  const context = { timeline: timelineOf(ride()), units: 'metric' as const, measure };
  const em = 0.022 * frame.width;
  const small = { x: 0.1, y: 0.1, width: 0.05, height: 0.03 };
  const grow = (components: OverlayComponent[], id = 'a') => growFigureToFit(components, id, frame, context);
  const rectOf = (components: OverlayComponent[], id = 'a') => components.find((component) => component.id === id)!.rect;

  it('grows a box too small for its two lines, right and down, and never moves it', () => {
    const after = rectOf(grow([box('a', small)]));
    expect(after.x).toBe(small.x);
    expect(after.y).toBe(small.y);
    // The value "72.0 km/h" at 1.1 em and the inset either side; the two lines and the room above and below.
    expect(after.width * frame.width).toBeCloseTo(2 * 0.6 * em + '72.0 km/h'.length * 1.1 * em * 0.55, 3);
    expect(after.height * frame.height).toBeCloseTo(0.55 * em * 1.2 + 1.1 * em * 1.1 + 0.6 * em, 3);
  });

  it('never shrinks a box that is big enough, and returns the same list', () => {
    const roomy = [box('a', { x: 0.1, y: 0.1, width: 0.6, height: 0.5 })];
    expect(grow(roomy)).toBe(roomy);
  });

  it('grows to a bigger size, a longer label, more spacing, and takes back nothing when they shrink', () => {
    const roomy = box('a', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    const bigger = grow([{ ...roomy, figure: { valueScale: 3, labelScale: 3 } }]);
    expect(rectOf(bigger).width).toBeGreaterThan(0.2);
    expect(rectOf(bigger).height).toBeGreaterThan(0.1);
    const apart = grow([{ ...roomy, figure: { gap: 0.2 } }]);
    expect(rectOf(apart).height * frame.height).toBeGreaterThan(0.2 * frame.width);
    const labelled = grow([{ ...roomy, display: { label: 'An exceedingly long label for a speed' } }]);
    expect(rectOf(labelled).width).toBeGreaterThan(0.2);
    expect(rectOf(labelled).height).toBe(0.1);
    const smaller = grow([{ ...bigger[0]!, figure: { valueScale: 0.2, labelScale: 0.2 } }]);
    expect(rectOf(smaller)).toEqual(rectOf(bigger));
  });

  it('counts the label only while it is shown, and a gauge’s track', () => {
    const wide = box('a', { x: 0, y: 0, width: 0.01, height: 0.01 }, { display: { label: 'An exceedingly long label for a speed' } });
    const shown = rectOf(grow([wide]));
    const hidden = rectOf(grow([{ ...wide, figure: { showLabel: false } }]));
    expect(hidden.width).toBeLessThan(shown.width);
    expect(hidden.height).toBeLessThan(shown.height);
    const gauge = rectOf(grow([{ ...wide, type: 'gauge', range: { min: 0, max: 20 }, figure: { showLabel: false } }]));
    expect(gauge.height * frame.height - hidden.height * frame.height).toBeCloseTo(0.2 * em + 0.25 * em, 3);
  });

  it('stops at the frame’s edges: x + width and y + height stay within 1', () => {
    const edge = grow([box('a', { x: 0.95, y: 0.97, width: 0.02, height: 0.02 }, { figure: { valueScale: 10, labelScale: 10 } })]);
    const { x, y, width, height } = rectOf(edge);
    expect(x).toBe(0.95);
    expect(y).toBe(0.97);
    expect(x + width).toBeLessThanOrEqual(1);
    expect(y + height).toBeLessThanOrEqual(1);
    expect(width).toBeCloseTo(0.05, 6);
    expect(height).toBeCloseTo(0.03, 6);
  });

  it('keeps a box already past its room where it is, and touches no other element', () => {
    const others = [box('b', small), card('c', { x: 0.5, y: 0.5, width: 0.1, height: 0.1 })];
    const after = grow([box('a', { x: 0.1, y: 0.1, width: 0.01, height: 0.01 }, { parentId: 'c' }), ...others]);
    expect(after.slice(1)).toEqual(others);
    expect(after[0]!.parentId).toBe('c');
  });

  it('leaves anything that is not a live figure alone', () => {
    const list = [box('a', small, { type: 'routeInset', source: undefined }), card('c', small)];
    expect(grow(list)).toBe(list);
    expect(grow(list, 'c')).toBe(list);
    expect(grow(list, 'missing')).toBe(list);
  });

  it('lets a figure held by a shape grow to the frame, not the shape, and leaves the shape as it is', () => {
    const holder = card('c', { x: 0.1, y: 0.1, width: 0.06, height: 0.04 });
    const after = grow([holder, box('a', { x: 0.1, y: 0.1, width: 0.05, height: 0.03 }, { parentId: 'c' })]);
    expect(after[0]).toBe(holder);
    expect(rectOf(after).width).toBeGreaterThan(holder.rect.width);
  });

  it('sizes a sensor’s figure and an imperial one', () => {
    const metric = rectOf(grow([box('a', small)]));
    const imperial = rectOf(grow([box('a', small, { unitMode: 'imperial' })]));
    expect(imperial.width).not.toBe(metric.width);
    const sensor = growFigureToFit([box('a', small, { source: { kind: 'sensor', key: 'ACCL' } })], 'a', frame, context);
    // No such stream in this activity: sized for a three-digit reading.
    expect(rectOf(sensor).width).toBeGreaterThan(small.width);
  });

  it('sizes a distance of the total for the total’s own text', () => {
    const plain = rectOf(grow([box('a', small, { source: { kind: 'metric', metric: 'distance' } })]));
    const total = rectOf(grow([box('a', small, { source: { kind: 'metric', metric: 'distance' }, display: { ofTotal: true } })]));
    expect(total.width).toBeGreaterThan(plain.width);
  });

  it('sizes a smoothed figure for its widest value, as it does an unsmoothed one (AV-1016)', () => {
    const plain = rectOf(grow([box('a', small)]));
    const smoothed = rectOf(grow([box('a', small, { smoothing: { windowSeconds: 5 } })]));
    expect(smoothed).toEqual(plain);
  });
});
