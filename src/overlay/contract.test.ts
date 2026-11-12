import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Activity, ActivityPoint, ActivitySensorStream } from '../domain/activity';
import { formatSpeed } from '../domain/units';
import {
  STORED_UNITS,
  contractProps,
  contractPropsFor,
  contractSectionOf,
  wholeActivityProps,
  type ComponentDraw,
  type ContractContext,
  type ContractContext2D,
  type ContractProps,
  type FigureProps,
  type GaugeProps,
  type RouteProps,
  type WholeActivityProps,
} from './contract';
import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_COMPONENT_TYPES,
  OVERLAY_TEMPLATE_VERSION,
  resolveOverlayComponent,
  type OverlayComponent,
  type OverlayComponentType,
  type OverlayTemplate,
  type SummaryStatKey,
} from './template';
import { OVERLAY_METRIC_KEYS, buildOverlayTimeline } from './timeline';
import { layoutStillText } from './staticImage';
import { makeActivity } from '../test/helpers/activity';
import { draw as drawFigure } from '../../docs/components/examples/figure';
import { draw as drawGauge } from '../../docs/components/examples/gauge';
import { draw as drawRoute } from '../../docs/components/examples/route';
import { draw as drawProfile } from '../../docs/components/examples/elevation-profile';
import { draw as drawWhole } from '../../docs/components/examples/whole-activity';

const T0 = Date.parse('2026-09-24T08:00:00Z');
const FRAME = { width: 1920, height: 1080 };
const stream: ActivitySensorStream = {
  key: 'ACCL',
  label: 'Acceleration',
  unit: 'm/s²',
  display: 'chart',
  valuesByPoint: Array.from({ length: 61 }, (_, i) => (i % 7) / 2),
};

/** A full ride: every metric, a route that bends, elevation, a stop, a camera stream and a name. */
const ride = (drop: (keyof ActivityPoint)[] = [], extra: Partial<Activity> = {}): Activity => {
  const activity = makeActivity(
    Array.from({ length: 61 }, (_, i) => {
      const point: Partial<ActivityPoint> = {
        time: new Date(T0 + i * 1000),
        lat: 46 + (i * 5) / 111_320,
        lon: 7 + Math.sin(i / 8) * 0.0004,
        elevationMeters: 100 + i + (i % 4),
        speedMetersPerSecond: 4 + 0.1 * i,
        powerWatts: 150 + 2 * i,
        cyclingCadenceRpm: 80 + (i % 5),
        runningCadenceSpm: 160,
        heartRateBpm: 120 + i / 2,
        temperatureCelsius: 18,
        gradePercent: 3 + (i % 3),
      };
      for (const key of drop) delete point[key];
      return point;
    }),
  );
  return { ...activity, sensorStreams: [stream], ...extra };
};

const component = (id: string, type: OverlayComponentType, extra: Partial<OverlayComponent> = {}): OverlayComponent => ({
  id,
  type,
  visible: true,
  rect: { x: 0.05, y: 0.05, width: 0.4, height: 0.2 },
  unitMode: 'auto',
  style: {},
  ...extra,
});
const templateOf = (components: OverlayComponent[]): OverlayTemplate => ({
  version: OVERLAY_TEMPLATE_VERSION,
  name: 'contract',
  style: DEFAULT_OVERLAY_STYLE,
  components,
});
const metric = (id: string, key: (typeof OVERLAY_METRIC_KEYS)[number], extra: Partial<OverlayComponent> = {}) =>
  component(id, 'text', { source: { kind: 'metric', metric: key }, ...extra });

/** Every kind of built-in component, in the states the renderer draws them in. */
function builtIns(): OverlayComponent[] {
  const list: OverlayComponent[] = [];
  for (const key of OVERLAY_METRIC_KEYS) {
    list.push(metric(`figure-${key}`, key));
    list.push(component(`gauge-${key}`, 'gauge', { source: { kind: 'metric', metric: key }, range: { min: 0, max: 200 } }));
  }
  list.push(
    metric('imperial', 'speed', { unitMode: 'imperial' }),
    metric('decimals', 'speed', { display: { decimals: 2, label: 'My speed' } }),
    metric('smoothed', 'power', { smoothing: { windowSeconds: 5 } }),
    metric('smoothed-pace', 'pace', { smoothing: { windowSeconds: 3 } }),
    // A total is never smoothed (TD-084): the setting is there and has no effect.
    metric('smoothed-total', 'distance', { smoothing: { windowSeconds: 5 } }),
    metric('of-total', 'distance', { display: { ofTotal: true, decimals: 1 } }),
    metric('styled', 'heartRate', {
      figure: { showLabel: false, labelScale: 1.5, labelColor: '#ff0000', align: 'right', halo: { color: '#000000', opacity: 0.5 } },
      style: { textColor: '#00ff00', fontScale: 2, backgroundOpacity: 0 },
    }),
    component('sensor-figure', 'text', { source: { kind: 'sensor', key: 'ACCL' } }),
    component('sensor-gauge', 'gauge', { source: { kind: 'sensor', key: 'ACCL' }, range: { min: 0, max: 3 } }),
    component('chart', 'sensorChart', { source: { kind: 'sensor', key: 'ACCL' }, windowSeconds: 10 }),
    // No range: the renderer draws a figure without a track.
    component('gauge-no-range', 'gauge', { source: { kind: 'metric', metric: 'speed' } }),
    component('route', 'routeInset'),
    component('progress', 'progress'),
    component('profile', 'elevationProfile'),
    component('text', 'label', { content: 'Morning ride\nwith Ana', text: { align: 'center', weight: 'normal' } }),
    component('date-iso', 'date', { date: { format: 'iso', withTime: true, timeZone: 'reader' } }),
    component('date-activity', 'date', { date: { format: 'long', withTime: false, timeZone: 'activity' } }),
    component('card', 'shape'),
  );
  for (const stat of ['speed', 'pace', 'distance', 'elapsed', 'moving', 'climb'] as SummaryStatKey[]) {
    list.push(component(`summary-${stat}`, 'summary', { summary: { stat }, text: { align: 'left', weight: 'bold', caption: stat !== 'pace' } }));
  }
  return list;
}

/** Text measured at 0.6 of its size per character, as the recording context does. */
const measureText = (text: string, font: string) => text.length * 0.6 * Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
const context = (activity: Activity | undefined, extra: Partial<ContractContext> = {}): ContractContext => ({
  frame: FRAME,
  measureText,
  units: 'metric',
  activity,
  readerTimeZone: 'UTC',
  ...extra,
});

/** Props every section shares, and the rules of a plain JSON value: no undefined, no NaN, no function, no Date. */
function checkValid(props: ContractProps): void {
  expect(props.box.width).toBeGreaterThan(0);
  expect(props.box.height).toBeGreaterThan(0);
  expect(props.box.x).toBeGreaterThanOrEqual(0);
  expect(props.box.x + props.box.width).toBeLessThanOrEqual(FRAME.width + 1e-6);
  expect(props.box.y + props.box.height).toBeLessThanOrEqual(FRAME.height + 1e-6);
  expect(props.frame).toEqual(FRAME);
  expect(props.fontPx).toBeGreaterThan(0);
  expect(props.style.textColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(props.style.accentColor).toMatch(/^#[0-9a-f]{6}$/i);
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'number') expect(Number.isFinite(value), path).toBe(true);
    else if (typeof value === 'string' || typeof value === 'boolean') return;
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (typeof value === 'object' && value !== null) {
      expect(Object.getPrototypeOf(value), path).toBe(Object.prototype);
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    } else throw new Error(`${path} is ${String(value)}: absent data is an absent member`);
  };
  walk(props, 'props');
  if (props.section === 'figure' || props.section === 'gauge') {
    expect(props.text).not.toBe('');
    expect(props.label).not.toBe('');
    expect(props.videoTimeSeconds).toBeGreaterThanOrEqual(0);
  }
  if (props.section === 'gauge') {
    expect(props.fraction).toBeGreaterThanOrEqual(0);
    expect(props.fraction).toBeLessThanOrEqual(1);
    expect(props.range.min).toBeLessThan(props.range.max);
  }
  if (props.section === 'route' && props.progress !== undefined) {
    expect(props.progress).toBeGreaterThanOrEqual(0);
    expect(props.progress).toBeLessThanOrEqual(1);
  }
  if (props.section === 'wholeActivity') expect(props.text).not.toBe('');
}

describe('the contract adapter (AV-1017)', () => {
  const plain = ride();
  // The file states its time zone, so a date in the activity's own zone can be drawn.
  const activity = ride([], { metadata: { name: 'Lake loop', utcOffsetMinutes: 120 } });
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 60 } });
  const template = templateOf(builtIns());

  it('maps every built-in component, at every moment the renderer draws it, to valid props of its section', () => {
    const seen = new Set<string>();
    for (const t of [0, 0.5, 13.3, 30, 59.9, 60]) {
      const sample = timeline.sampleAt(t);
      for (const item of template.components) {
        const props = contractPropsFor(template, item, sample, timeline, context(activity));
        const section = contractSectionOf(item);
        if (section === undefined) {
          expect(item.type).toBe('shape');
          expect(props).toBeUndefined();
          continue;
        }
        // Whatever the renderer draws has props, and what it does not draw has none.
        const ready = sample ? resolveOverlayComponent(template, item, sample, timeline, 'metric') : undefined;
        const drawn = section === 'wholeActivity' ? true : ready?.status === 'ready';
        expect(props !== undefined, `${item.id} at ${t}`).toBe(drawn);
        if (!props) continue;
        expect(props.section).toBe(section);
        checkValid(props);
        seen.add(`${item.type}:${props.section}`);
      }
    }
    // Every type of component but the shape reaches a section; a gauge is both a gauge and, with no range, a figure.
    for (const type of OVERLAY_COMPONENT_TYPES.filter((type) => type !== 'shape' && type !== 'sensorChart')) {
      expect([...seen].some((key) => key.startsWith(`${type}:`)), type).toBe(true);
    }
    expect(seen).toContain('gauge:gauge');
    expect(seen).toContain('gauge:figure');
    expect(seen).toContain('sensorChart:figure');
  });

  it('survives structuredClone and a JSON round trip unchanged, with no member present as undefined', () => {
    const sample = timeline.sampleAt(20);
    for (const item of template.components) {
      const props = contractPropsFor(template, item, sample, timeline, context(activity));
      if (!props) continue;
      expect(structuredClone(props), item.id).toStrictEqual(props);
      expect(JSON.parse(JSON.stringify(props)), item.id).toStrictEqual(props);
    }
  });

  it('gives a figure its value in the stored unit and its text in the reader’s', () => {
    const sample = timeline.sampleAt(20)!;
    const speed = contractPropsFor(template, metric('s', 'speed'), sample, timeline, context(activity)) as FigureProps;
    expect(speed.section).toBe('figure');
    expect(speed.unit).toBe('m/s');
    expect(speed.value).toBeCloseTo(6, 5);
    expect(speed.text).toBe(formatSpeed(speed.value, 'metric'));
    expect(speed.label).toBe('Speed');

    const imperial = contractPropsFor(template, metric('s', 'speed', { unitMode: 'imperial' }), sample, timeline, context(activity)) as FigureProps;
    expect(imperial.value).toBe(speed.value);
    expect(imperial.unitSystem).toBe('imperial');
    expect(imperial.text).toBe(formatSpeed(speed.value, 'imperial'));

    // `auto` follows the reader's unit system.
    const auto = contractPropsFor(template, metric('s', 'speed'), sample, timeline, context(activity, { units: 'imperial' })) as FigureProps;
    expect(auto.unitSystem).toBe('imperial');

    for (const key of OVERLAY_METRIC_KEYS) {
      const props = contractPropsFor(template, metric('m', key), sample, timeline, context(activity)) as FigureProps | undefined;
      if (props) expect(props.unit).toBe(STORED_UNITS[key]);
    }
    const accel = contractPropsFor(template, component('a', 'text', { source: { kind: 'sensor', key: 'ACCL' } }), sample, timeline, context(activity)) as FigureProps;
    expect(accel.unit).toBe('m/s²');
    expect(accel.source).toEqual({ kind: 'sensor', key: 'ACCL' });
  });

  it('keeps the styling, the smoothing window and the total only where the component has them', () => {
    const sample = timeline.sampleAt(30)!;
    const get = (id: string) => contractPropsFor(template, template.components.find((c) => c.id === id)!, sample, timeline, context(activity)) as FigureProps;
    expect(get('figure-speed').figure).toBeUndefined();
    expect('figure' in get('figure-speed')).toBe(false);
    expect(get('styled').figure).toEqual({ showLabel: false, labelScale: 1.5, labelColor: '#ff0000', align: 'right', halo: { color: '#000000', opacity: 0.5 } });
    expect(get('styled').style).toMatchObject({ textColor: '#00ff00', fontScale: 2, backgroundOpacity: 0 });
    expect(get('styled').fontPx).toBeCloseTo(0.022 * FRAME.width * 2, 6);

    // A smoothed value is the trailing mean, and says over how long.
    expect(get('smoothed').smoothingWindowSeconds).toBe(5);
    expect(get('smoothed').value).not.toBe(get('figure-power').value);
    expect(get('smoothed').value).toBeCloseTo(150 + 2 * 27.5, 0);
    expect('smoothingWindowSeconds' in get('smoothed-total')).toBe(false);
    expect(get('smoothed-total').value).toBe(get('figure-distance').value);

    expect(get('of-total').totalDistanceMeters).toBe(timeline.distanceTotalMeters);
    expect(get('of-total').text).toContain(' / ');
    expect('totalDistanceMeters' in get('figure-distance')).toBe(false);
    expect(get('decimals').label).toBe('My speed');
  });

  it('gives a gauge its range and the same fraction the renderer resolved, clamped', () => {
    const sample = timeline.sampleAt(20)!;
    for (const item of [template.components.find((c) => c.id === 'gauge-speed')!, template.components.find((c) => c.id === 'sensor-gauge')!]) {
      const ready = resolveOverlayComponent(template, item, sample, timeline, 'metric');
      if (ready.status !== 'ready') throw new Error('not ready');
      const props = contractProps(ready, sample, timeline, context(activity)) as GaugeProps;
      expect(props.section).toBe('gauge');
      expect(props.range).toEqual(item.range);
      expect(props.fraction).toBe(ready.fraction);
    }
    const low = { ...template.components.find((c) => c.id === 'gauge-speed')!, range: { min: 50, max: 60 } };
    expect((contractPropsFor(template, low, sample, timeline, context(activity)) as GaugeProps).fraction).toBe(0);
    const high = { ...low, range: { min: 0, max: 1 } };
    expect((contractPropsFor(template, high, sample, timeline, context(activity)) as GaugeProps).fraction).toBe(1);
  });

  it('gives the route in the box’s own space, the position and the profile with its cursor', () => {
    const sample = timeline.sampleAt(30)!;
    const route = contractPropsFor(template, template.components.find((c) => c.id === 'route')!, sample, timeline, context(activity)) as RouteProps;
    expect(route.part).toBe('route');
    expect(route.route!.segments.length).toBeGreaterThan(0);
    for (const [x, y] of route.route!.segments.flat()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
    expect(route.route!.position).toHaveLength(2);
    expect(route.profile).toBeUndefined();
    expect(route.progress).toBeCloseTo(0.5, 1);

    const profile = contractPropsFor(template, template.components.find((c) => c.id === 'profile')!, sample, timeline, context(activity)) as RouteProps;
    expect(profile.part).toBe('elevationProfile');
    expect(profile.profile!.runs.length).toBeGreaterThan(0);
    expect(profile.profile!.cursor).toHaveLength(2);
    expect(profile.route).toBeUndefined();

    const progress = contractPropsFor(template, template.components.find((c) => c.id === 'progress')!, sample, timeline, context(activity)) as RouteProps;
    expect(progress.part).toBe('progress');
    expect(progress.progress).toBe(sample.progress);
    expect(progress.route).toBeUndefined();
    expect(progress.profile).toBeUndefined();
  });

  it('gives the whole activity’s figures in stored units, the date as UTC, the zone offset and the name', () => {
    const withOffset = ride([], { metadata: { name: 'Lake loop', utcOffsetMinutes: 120 } });
    const get = (id: string, from = withOffset) =>
      wholeActivityProps(template.components.find((c) => c.id === id)!, context(from)) as WholeActivityProps;

    const speed = get('summary-speed');
    expect(speed.kind).toBe('summary');
    expect(speed.summary).toEqual({ stat: 'speed', value: withOffset.derived!.averageMovingSpeedMetersPerSecond ?? withOffset.derived!.averageSpeedMetersPerSecond, basis: expect.stringMatching(/moving|elapsed/) });
    expect(speed.caption).toBe('Avg speed');
    expect(speed.activityName).toBe('Lake loop');
    expect(get('summary-distance').summary).toEqual({ stat: 'distance', value: withOffset.derived!.distanceMeters });
    expect(get('summary-elapsed').summary!.value).toBe(60);
    expect(get('summary-climb').summary!.value).toBe(withOffset.derived!.elevationGainMeters);
    // The reader turned the caption off.
    expect('caption' in get('summary-pace')).toBe(false);

    const date = get('date-activity');
    expect(date.date).toEqual({ startTime: '2026-09-24T08:00:00.000Z', utcOffsetMinutes: 120 });
    expect(date.text).toBe('Thursday 24 September 2026');
    expect('summary' in date).toBe(false);
    // No offset in the file: none in the props, and the activity's own zone is not drawn at all.
    expect(wholeActivityProps(template.components.find((c) => c.id === 'date-activity')!, context(plain))).toBeUndefined();
    expect(get('date-iso', plain).date).toEqual({ startTime: '2026-09-24T08:00:00.000Z' });
    expect(get('date-iso', plain).text).toBe('2026-09-24 08:00');

    const text = get('text');
    expect(text.kind).toBe('text');
    expect(text.text).toBe('Morning ride\nwith Ana');
    expect(text).toMatchObject({ align: 'center', weight: 'normal' });
    expect('caption' in text).toBe(false);
    // The activity's name is absent where the file states none.
    expect('activityName' in get('summary-speed', ride([], { metadata: {} }))).toBe(false);
  });

  it('gives a whole-activity component the box its words take, as the renderer lays it out, even from a new text’s tiny rect', () => {
    const tiny = component('new', 'label', { content: 'Morning ride', rect: { x: 0.9, y: 0.95, width: 0.01, height: 0.01 }, text: { align: 'right', weight: 'bold' } });
    const props = wholeActivityProps(tiny, context(activity))!;
    const item = layoutStillText(tiny, { ok: true, caption: '', value: 'Morning ride' }, '#ffffff', FRAME, measureText);
    expect(props.box).toEqual({ x: item.box.x, y: item.box.y, width: item.box.w, height: item.box.h });
    expect(props.box.x + props.box.width).toBeLessThanOrEqual(FRAME.width);
    expect(props.box.y + props.box.height).toBeLessThanOrEqual(FRAME.height);
    expect(props.box.width).toBeGreaterThan(100);
    drawsInside(drawWhole, props);
    // Without a measure it is the stored rect.
    expect(wholeActivityProps(tiny, context(activity, { measureText: undefined }))!.box.width).toBeCloseTo(0.01 * FRAME.width);
  });

  it('carries the sample’s times, a fractional smoothing window and a stream with no unit', () => {
    const sample = timeline.sampleAt(20)!;
    const noUnit: Activity = { ...activity, sensorStreams: [{ ...stream, unit: undefined }] };
    const bare = buildOverlayTimeline(noUnit, { video: { durationSeconds: 60 } });
    const s = bare.sampleAt(20)!;
    const figure = contractPropsFor(template, component('a', 'text', { source: { kind: 'sensor', key: 'ACCL' } }), s, bare, context(noUnit)) as FigureProps;
    expect('unit' in figure).toBe(false);
    expect(figure.videoTimeSeconds).toBe(s.videoTimeSeconds);
    expect(figure.activityElapsedSeconds).toBe(s.activityElapsedSeconds);
    const half = contractPropsFor(template, metric('h', 'power', { smoothing: { windowSeconds: 0.5 } }), sample, timeline, context(activity)) as FigureProps;
    expect(half.smoothingWindowSeconds).toBe(0.5);
  });

  it('passes missing data as absence: the component is not drawn, and nothing is a placeholder', () => {
    const bare = ride(['heartRateBpm', 'elevationMeters', 'powerWatts', 'lat', 'lon']);
    const bareTimeline = buildOverlayTimeline(bare, { video: { durationSeconds: 60 } });
    const bareTemplate = templateOf(builtIns());
    const sample = bareTimeline.sampleAt(20);
    const drawn = new Map<string, ContractProps | undefined>();
    for (const item of bareTemplate.components) drawn.set(item.id, contractPropsFor(bareTemplate, item, sample, bareTimeline, context(bare)));
    expect(drawn.get('figure-heartRate')).toBeUndefined();
    expect(drawn.get('gauge-power')).toBeUndefined();
    expect(drawn.get('route')).toBeUndefined();
    expect(drawn.get('profile')).toBeUndefined();
    expect(drawn.get('figure-speed')).toBeDefined();
    for (const props of drawn.values()) if (props) checkValid(props);

    // Outside the recording only what describes the whole activity is drawn.
    const late = bareTimeline.sampleAt(500);
    expect(contractPropsFor(bareTemplate, metric('s', 'speed'), late, bareTimeline, context(bare))).toBeUndefined();
    expect(contractPropsFor(bareTemplate, bareTemplate.components.find((c) => c.id === 'summary-elapsed')!, late, bareTimeline, context(bare))).toBeDefined();
    // A hidden component, and a whole-activity one without an activity, are not drawn.
    expect(contractPropsFor(template, { ...metric('s', 'speed'), visible: false }, timeline.sampleAt(1), timeline, context(activity))).toBeUndefined();
    expect(contractPropsFor(template, template.components.find((c) => c.id === 'summary-speed')!, undefined, timeline, context(undefined))).toBeUndefined();

    // A route component given no activity has a route-less props, not an empty route.
    const sampleNow = timeline.sampleAt(20)!;
    const ready = resolveOverlayComponent(template, template.components.find((c) => c.id === 'route')!, sampleNow, timeline, 'metric');
    if (ready.status !== 'ready') throw new Error('not ready');
    const noActivity = contractProps(ready, sampleNow, timeline, context(undefined)) as RouteProps;
    expect('route' in noActivity).toBe(false);
  });

  it('is a section for every built-in type, and the shape is the one without', () => {
    for (const type of OVERLAY_COMPONENT_TYPES) {
      const section = contractSectionOf(component('x', type, { range: { min: 0, max: 1 } }));
      expect(section === undefined, type).toBe(type === 'shape');
    }
  });
});

// ---------------------------------------------------------------------------
// The context a component draws with, and the examples in the documentation

/** Compile-time: a real context, on the page or in a worker, is a `ContractContext2D`. */
const realContextsFit = (canvas: CanvasRenderingContext2D, offscreen: OffscreenCanvasRenderingContext2D): ContractContext2D[] => [canvas, offscreen];

interface Point {
  x: number;
  y: number;
}

/**
 * A context that records what is drawn and has only what a component may use:
 * calling anything else, or setting any other property, throws. It reports every
 * point drawn at, with text measured at 0.6 of its size per character.
 */
function recordingContext() {
  const points: Point[] = [];
  const log: string[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', textAlign: 'left', lineWidth: 1 };
  const stack: Record<string, unknown>[] = [];
  const sizeOf = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
  const point = (x: unknown, y: unknown) => points.push({ x: Number(x), y: Number(y) });
  const rectangle = (x: unknown, y: unknown, w: unknown, h: unknown) => {
    point(x, y);
    point(Number(x) + Number(w), Number(y) + Number(h));
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: point,
    lineTo: point,
    arc: (x, y, r) => {
      point(Number(x) - Number(r), Number(y) - Number(r));
      point(Number(x) + Number(r), Number(y) + Number(r));
    },
    fill: () => undefined,
    stroke: () => undefined,
    fillRect: rectangle,
    strokeRect: rectangle,
    rect: rectangle,
    roundRect: rectangle,
    clip: () => undefined,
    fillText: (text, x, y) => {
      const width = String(text).length * 0.6 * sizeOf();
      const at = Number(x);
      const left = state.textAlign === 'center' ? at - width / 2 : state.textAlign === 'right' ? at - width : at;
      point(left, y);
      point(left + width, Number(y) + sizeOf());
      log.push(String(text));
    },
    strokeText: () => undefined,
    measureText: (text) => ({ width: String(text).length * 0.6 * sizeOf() }),
    setLineDash: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
  };
  const allowed = new Set(['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha', 'font', 'textAlign', 'textBaseline', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY']);
  const ctx = new Proxy(state, {
    get(_, key: string) {
      if (key in methods) return methods[key];
      if (allowed.has(key)) return state[key];
      throw new Error(`a component used ctx.${key}, which the contract does not give it`);
    },
    set(_, key: string, value) {
      if (!allowed.has(key)) throw new Error(`a component set ctx.${key}, which the contract does not give it`);
      state[key] = value;
      return true;
    },
  }) as unknown as ContractContext2D;
  return { ctx, points, log };
}

function drawsInside<P extends ContractProps>(draw: ComponentDraw<P>, props: P): { points: Point[]; log: string[] } {
  const { ctx, points, log } = recordingContext();
  draw(ctx, structuredClone(props));
  const { x, y, width, height } = props.box;
  for (const point of points) {
    expect(point.x).toBeGreaterThanOrEqual(x - 1e-6);
    expect(point.x).toBeLessThanOrEqual(x + width + 1e-6);
    expect(point.y).toBeGreaterThanOrEqual(y - 1e-6);
    expect(point.y).toBeLessThanOrEqual(y + height + 1e-6);
  }
  return { points, log };
}

describe('the examples in docs/components (AV-1017)', () => {
  const activity = ride([], { metadata: { name: 'Lake loop', utcOffsetMinutes: 120 } });
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 60 } });
  const template = templateOf(builtIns());
  const props = (id: string, t = 30, from: Activity = activity) =>
    contractPropsFor(template, template.components.find((c) => c.id === id)!, timeline.sampleAt(t), timeline, context(from));
  const big = (id: string) => ({ ...template.components.find((c) => c.id === id)!, rect: { x: 0.05, y: 0.05, width: 0.45, height: 0.2 } });
  const propsBig = (id: string, t = 30) =>
    contractPropsFor(template, big(id), timeline.sampleAt(t), timeline, context(activity));

  it('the figure draws its label and its text, inside its box, at every moment', () => {
    for (const t of [0, 20, 60]) {
      const figure = propsBig('figure-speed', t) as FigureProps;
      const { points, log } = drawsInside(drawFigure, figure);
      expect(points.length).toBeGreaterThan(0);
      expect(log).toEqual([figure.label.toUpperCase(), figure.text]);
    }
  });

  it('the gauge draws its text and a track that fills to the fraction', () => {
    const gauge = propsBig('gauge-speed') as GaugeProps;
    const { ctx, points } = recordingContext();
    drawGauge(ctx, gauge);
    expect(points.length).toBeGreaterThan(0);
    drawsInside(drawGauge, gauge);
    for (const fraction of [0, 1]) drawsInside(drawGauge, { ...gauge, fraction });
  });

  it('the route and the profile draw inside their boxes, and nothing without their data', () => {
    const route = propsBig('route') as RouteProps;
    expect(drawsInside(drawRoute, route).points.length).toBeGreaterThan(10);
    const profile = propsBig('profile') as RouteProps;
    expect(drawsInside(drawProfile, profile).points.length).toBeGreaterThan(10);
    const without = structuredClone(route);
    delete without.route;
    expect(drawsInside(drawRoute, without).points).toEqual([]);
    const noProfile = structuredClone(profile);
    delete noProfile.profile;
    expect(drawsInside(drawProfile, noProfile).points).toEqual([]);
    // The cursor and the progress at the ends of the activity stay inside.
    for (const t of [0, 60]) drawsInside(drawProfile, propsBig('profile', t) as RouteProps);
  });

  it('the whole-activity example draws its caption and its text inside its box', () => {
    for (const id of ['summary-speed', 'summary-distance', 'date-activity', 'text', 'summary-pace']) {
      const whole = propsBig(id) as WholeActivityProps;
      const { log } = drawsInside(drawWhole, whole);
      for (const line of whole.text.split('\n')) expect(log).toContain(line);
      if (whole.caption) expect(log).toContain(whole.caption.toUpperCase());
    }
  });

  it('a component that reaches beyond the contract is stopped by the recording context', () => {
    const { ctx } = recordingContext();
    expect(() => (ctx as unknown as { getImageData: () => void }).getImageData()).toThrow(/getImageData/);
    expect(() => ((ctx as unknown as { canvas: unknown }).canvas)).toThrow(/canvas/);
    expect(() => {
      (ctx as unknown as { globalCompositeOperation: string }).globalCompositeOperation = 'copy';
    }).toThrow(/globalCompositeOperation/);
  });

  it('a draw is the same picture for the same props', () => {
    const figure = propsBig('figure-speed') as FigureProps;
    const a = recordingContext();
    const b = recordingContext();
    drawFigure(a.ctx, figure);
    drawFigure(b.ctx, structuredClone(figure));
    expect(a.points).toEqual(b.points);
    expect(a.log).toEqual(b.log);
    expect(props('figure-speed')).toBeDefined();
  });
});

describe('the documentation says what the contract holds (AV-1017)', () => {
  const read = (name: string) => readFileSync(`docs/components/${name}`, 'utf8');
  const keysOf = (value: unknown, into = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
    else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        into.add(key);
        if (key !== 'figure') keysOf(item, into);
      }
    }
    return into;
  };

  const activity = ride([], { metadata: { name: 'Lake loop', utcOffsetMinutes: 120 } });
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 60 } });
  const template = templateOf(builtIns());
  const sections: { page: string; ids: string[] }[] = [
    { page: 'figures.md', ids: ['figure-speed', 'smoothed', 'of-total', 'styled', 'sensor-figure'] },
    { page: 'gauges.md', ids: ['gauge-speed'] },
    { page: 'along-the-route.md', ids: ['route', 'profile', 'progress'] },
    { page: 'whole-activity.md', ids: ['summary-speed', 'date-activity', 'text'] },
  ];

  for (const { page, ids } of sections) {
    it(`${page} documents every prop its section gives`, () => {
      const text = read(page);
      const keys = new Set<string>();
      for (const id of ids) {
        const props = contractPropsFor(template, template.components.find((c) => c.id === id)!, timeline.sampleAt(30), timeline, context(activity));
        expect(props, id).toBeDefined();
        keysOf(props, keys);
      }
      for (const key of keys) expect(text.includes(`\`${key}\``), `${page} does not mention \`${key}\``).toBe(true);
    });
  }

  it('every example named in a page exists as a file, and every example file is named', () => {
    const files = readdirSync('docs/components/examples').filter((name) => name.endsWith('.ts'));
    const pages = readdirSync('docs/components').filter((name) => name.endsWith('.md'));
    const text = pages.map(read).join('\n');
    for (const file of files) expect(text.includes(`examples/${file}`), file).toBe(true);
    for (const [, name] of text.matchAll(/examples\/([\w-]+\.ts)/g)) expect(files).toContain(name);
  });

  it('the README links the decision and the issue, and says loading is not built', () => {
    const readme = read('README.md');
    expect(readme).toContain('TD-085');
    expect(readme).toContain('/issues/19');
    expect(readme).toMatch(/not built/i);
    for (const page of ['figures.md', 'gauges.md', 'along-the-route.md', 'whole-activity.md', 'zones.md']) {
      expect(readme).toContain(page);
    }
  });
});

void realContextsFit;
