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
  type ChartProps,
  type ContractProps,
  type DialProps,
  type FigureProps,
  type GaugeProps,
  type GradientProps,
  type HeadingProps,
  type RouteProps,
  type WholeActivityProps,
  type ZoneProps,
} from './contract';
import { DEFAULT_COMPASS } from './compass';
import { DEFAULT_DIAL, dialAngle } from './dial';
import { DEFAULT_GRADIENT } from './gradient';
import { defaultZonesSetting, zoneBounds } from './zones';
import {
  DEFAULT_CHART,
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
import { draw as drawZones } from '../../docs/components/examples/zones';
import { draw as drawDial } from '../../docs/components/examples/dial';
import { draw as drawChart } from '../../docs/components/examples/chart';
import { draw as drawGradient } from '../../docs/components/examples/gradient';
import { draw as drawCompass } from '../../docs/components/examples/compass';

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

/** A zones component with its default zones (in percent of the reader's figure unless `setting` says otherwise). */
const zones = (
  id: string,
  source: 'heartRate' | 'power',
  extra: Partial<OverlayComponent> = {},
  setting: Partial<NonNullable<OverlayComponent['zones']>> = {},
) =>
  component(id, 'zones', {
    source: { kind: 'metric', metric: source },
    zones: { ...defaultZonesSetting(source), ...setting },
    ...extra,
  });

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
    // AV-1018. Zones: both sources, each shape, with and without time in zone and smoothing.
    zones('zones-hr', 'heartRate'),
    zones('zones-power', 'power', { smoothing: { windowSeconds: 3 } }),
    zones('zones-arc', 'heartRate', {}, { shape: 'arc', show: { number: true, name: false, value: true, timeInZone: true } }),
    zones('zones-values', 'power', {}, { basis: 'value', zones: [{ name: 'Low', color: '#00ff00', from: 0 }, { name: 'High', color: '#ff0000', from: 200 }] }),
  );
  // AV-1019. Dials, charts, the gradient indicator and the compass, in the states the renderer draws them in.
  const speed = { kind: 'metric', metric: 'speed' } as const;
  list.push(
    component('dial', 'dial', { source: speed, range: { min: 0, max: 20 }, dial: { ...DEFAULT_DIAL } }),
    component('dial-smoothed', 'dial', {
      source: { kind: 'metric', metric: 'heartRate' },
      range: { min: 100, max: 160 },
      smoothing: { windowSeconds: 3 },
      figure: { labelScale: 1.2 },
      unitMode: 'imperial',
      dial: { ...DEFAULT_DIAL, majorStep: 20, pointer: 'marker', sweep: 300 },
    }),
    component('dial-own-range', 'dial', { source: { kind: 'metric', metric: 'power' } }),
    component('dial-beyond', 'dial', { source: speed, range: { min: 0, max: 3 } }),
    component('chart-time', 'chart', { source: speed, chart: { ...DEFAULT_CHART } }),
    component('chart-window', 'chart', {
      source: { kind: 'metric', metric: 'heartRate' },
      chart: { ...DEFAULT_CHART, axis: 'distance', window: 100, labels: true },
      figure: { labelScale: 1.5 },
    }),
    component('chart-sensor', 'chart', { source: { kind: 'sensor', key: 'ACCL' }, chart: { ...DEFAULT_CHART, labels: false } }),
    component('gradient', 'gradient', { source: { kind: 'metric', metric: 'grade' }, gradient: { ...DEFAULT_GRADIENT }, smoothing: { windowSeconds: 5 }, figure: { align: 'right' } }),
    component('gradient-no-glyph', 'gradient', { source: { kind: 'metric', metric: 'grade' }, gradient: { ...DEFAULT_GRADIENT, glyph: false } }),
    component('compass', 'compass', { source: { kind: 'metric', metric: 'heading' }, compass: { ...DEFAULT_COMPASS }, smoothing: { windowSeconds: 3 } }),
    component('compass-needle', 'compass', { source: { kind: 'metric', metric: 'heading' }, compass: { ...DEFAULT_COMPASS, style: 'needle' } }),
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
  personal: { maxHeartRate: 190, ftp: 250 },
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
  if (props.section === 'dial') {
    expect(props.range.min).toBeLessThan(props.range.max);
    expect(props.fraction).toBeGreaterThanOrEqual(0);
    expect(props.fraction).toBeLessThanOrEqual(1);
    expect(Math.abs(props.angleDegrees)).toBeLessThanOrEqual(props.sweepDegrees / 2 + 1e-9);
    expect(props.ticks.length).toBeGreaterThan(0);
    expect(props.ticks.every((tick, i) => i === 0 || tick.fraction > props.ticks[i - 1]!.fraction)).toBe(true);
    for (const color of [props.trackColor, props.fillColor, props.needleColor]) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  }
  if (props.section === 'chart') {
    expect(props.cursor.x).toBeGreaterThanOrEqual(0);
    expect(props.cursor.x).toBeLessThanOrEqual(1);
    if (props.cursor.y !== undefined) expect(props.value).toBeDefined();
    for (const run of props.runs) {
      for (const point of run) for (const v of point) expect(v >= -1e-9 && v <= 1 + 1e-9).toBe(true);
    }
    if (props.showLabels) expect(props.labels).toBeDefined();
    else expect(props.labels).toBeUndefined();
  }
  if (props.section === 'gradient') {
    expect(props.bandIndex).toBeGreaterThanOrEqual(0);
    expect(props.bandIndex).toBeLessThan(props.bands.length);
    expect(props.color).toBe(props.bands[props.bandIndex]!.color);
    expect(props.text).not.toBe('');
  }
  if (props.section === 'compass') {
    expect(props.value).toBeGreaterThanOrEqual(0);
    expect(props.value).toBeLessThan(360);
    expect(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']).toContain(props.cardinal);
    expect(props.text).toMatch(/^\d+° (N|NE|E|SE|S|SW|W|NW)$/);
    expect(props.northAngleDegrees).toBeGreaterThanOrEqual(0);
    expect(props.northAngleDegrees).toBeLessThan(360);
    expect(props.needleAngleDegrees).toBeGreaterThanOrEqual(0);
    expect(props.needleAngleDegrees).toBeLessThan(360);
  }
  if (props.section === 'zones') {
    expect(props.zones.length).toBeGreaterThanOrEqual(2);
    expect(props.zones.length).toBeLessThanOrEqual(10);
    expect(props.zoneIndex).toBeGreaterThanOrEqual(0);
    expect(props.zoneIndex).toBeLessThan(props.zones.length);
    expect(props.fractionInZone).toBeGreaterThanOrEqual(0);
    expect(props.fractionInZone).toBeLessThanOrEqual(1);
    const bounds = props.zones.map((zone) => zone.lowerBound);
    expect([...bounds].sort((a, b) => a - b)).toEqual(bounds);
    for (const zone of props.zones) expect(zone.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(props.unit).toBe(props.source === 'heartRate' ? 'bpm' : 'W');
    if (props.timeInZoneSeconds) expect(props.timeInZoneSeconds).toHaveLength(props.zones.length);
  }
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
        const ready = sample ? resolveOverlayComponent(template, item, sample, timeline, 'metric', context(activity).personal) : undefined;
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

  it('gives zones the zone, the bounds in absolute units and the zones’ names and colours (AV-1018)', () => {
    const sample = timeline.sampleAt(30)!;
    const hr = contractPropsFor(template, template.components.find((c) => c.id === 'zones-hr')!, sample, timeline, context(activity)) as ZoneProps;
    expect(hr.section).toBe('zones');
    expect(hr.source).toBe('heartRate');
    expect(hr.unit).toBe('bpm');
    // 150 bpm at 30 s, of a maximum of 190: bounds 95, 114, 133, 152, 171, so the third zone, nearly at the fourth.
    expect(hr.value).toBeCloseTo(135, 5);
    expect(hr.zoneIndex).toBe(2);
    expect(hr.zones.map((zone) => zone.lowerBound)).toEqual([95, 114, 133, 152, 171]);
    expect(hr.zones.map((zone) => zone.name)).toEqual(['Recovery', 'Endurance', 'Tempo', 'Threshold', 'Maximum']);
    expect(hr.fractionInZone).toBeCloseTo((135 - 133) / (152 - 133), 5);
    expect(hr.text).toBe('135 bpm');
    expect(hr.timeInZoneSeconds).toBeUndefined();
    expect(hr.smoothingWindowSeconds).toBeUndefined();

    const power = contractPropsFor(template, template.components.find((c) => c.id === 'zones-power')!, sample, timeline, context(activity)) as ZoneProps;
    expect(power.unit).toBe('W');
    expect(power.smoothingWindowSeconds).toBe(3);
    expect(power.zones).toHaveLength(7);
    expect(power.zones[1]!.lowerBound).toBeCloseTo(140);

    // Bounds in values are given as they are, and need no figure.
    const values = contractPropsFor(template, template.components.find((c) => c.id === 'zones-values')!, sample, timeline, context(activity, { personal: undefined })) as ZoneProps;
    expect(values.zones.map((zone) => zone.lowerBound)).toEqual([0, 200]);
    expect(values.zoneIndex).toBe(1);
  });

  it('gives the time in each zone only when asked, and it adds up to the moving time (AV-1018)', () => {
    const arc = template.components.find((c) => c.id === 'zones-arc')!;
    for (const t of [0, 10, 30, 59]) {
      const props = contractPropsFor(template, arc, timeline.sampleAt(t), timeline, context(activity)) as ZoneProps;
      expect(props.timeInZoneSeconds, `at ${t}`).toHaveLength(5);
      const sum = props.timeInZoneSeconds!.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(timeline.sampleAt(t)!.values['metric:moving']!, 6);
    }
  });

  it('gives no props for zones that are not drawn: a figure the reader has not entered, or no data (AV-1018)', () => {
    const hr = template.components.find((c) => c.id === 'zones-hr')!;
    const sample = timeline.sampleAt(30);
    expect(contractPropsFor(template, hr, sample, timeline, context(activity, { personal: undefined }))).toBeUndefined();
    expect(contractPropsFor(template, hr, sample, timeline, context(activity, { personal: { ftp: 250 } }))).toBeUndefined();
    const noHr = ride(['heartRateBpm']);
    const bare = buildOverlayTimeline(noHr, { video: { durationSeconds: 60 } });
    expect(contractPropsFor(template, hr, bare.sampleAt(30), bare, context(noHr))).toBeUndefined();
    // Never the reader's figure itself: the props carry the bounds, which are all a component needs.
    const props = contractPropsFor(template, hr, sample, timeline, context(activity))!;
    expect(JSON.stringify(props)).not.toContain('maxHeartRate');
    expect(zoneBounds(hr.zones!, { maxHeartRate: 190 })).toEqual((props as ZoneProps).zones.map((zone) => zone.lowerBound));
  });

  describe('the dial, the chart, the gradient indicator and the compass (AV-1019)', () => {
    const at = (id: string, t = 30, from: Activity = activity) =>
      contractPropsFor(template, template.components.find((c) => c.id === id)!, timeline.sampleAt(t), timeline, context(from));

    it('gives a dial everything a gauge has, the pointer’s angle for the fraction, and the ticks worked out', () => {
      const dial = at('dial', 30) as DialProps;
      expect(dial.section).toBe('dial');
      const gauge = contractPropsFor(template, { ...template.components.find((c) => c.id === 'dial')!, type: 'gauge' }, timeline.sampleAt(30), timeline, context(activity)) as GaugeProps;
      const { section: _a, ...fromDial } = dial;
      const { section: _b, ...fromGauge } = gauge;
      void _a;
      void _b;
      expect({ ...fromDial, sweepDegrees: undefined, angleDegrees: undefined, ticks: undefined, pointer: undefined, trackColor: undefined, fillColor: undefined, needleColor: undefined }).toEqual({
        ...fromGauge,
        sweepDegrees: undefined,
        angleDegrees: undefined,
        ticks: undefined,
        pointer: undefined,
        trackColor: undefined,
        fillColor: undefined,
        needleColor: undefined,
      });
      expect(dial.sweepDegrees).toBe(240);
      expect(dial.angleDegrees).toBeCloseTo((dial.fraction - 0.5) * 240, 9);
      // The angle is the renderer's: the canvas angle of the same fraction.
      expect(((dial.angleDegrees - 90) * Math.PI) / 180).toBeCloseTo(dialAngle(240, dial.fraction), 9);
      expect(dial.ticks[0]).toEqual({ fraction: 0, major: true });
      expect(dial.pointer).toBe('needle');
    });

    it('pins a value beyond a dial’s range at its end, and gives the activity’s own range where none is set', () => {
      const beyond = at('dial-beyond', 60) as DialProps;
      expect(beyond.fraction).toBe(1);
      expect(beyond.angleDegrees).toBe(120);
      expect(beyond.value).toBeGreaterThan(beyond.range.max);
      const own = at('dial-own-range') as DialProps;
      expect(own.range).toEqual({ min: 140, max: 280 });
      expect(own.range.min).toBeLessThan(own.range.max);
    });

    it('carries a dial’s smoothing and styling, and its settings', () => {
      const dial = at('dial-smoothed') as DialProps;
      expect(dial).toMatchObject({ smoothingWindowSeconds: 3, figure: { labelScale: 1.2 }, pointer: 'marker', sweepDegrees: 300, unitSystem: 'imperial' });
      expect(dial.ticks.filter((tick) => tick.major).map((tick) => tick.fraction)).toEqual([0, 1 / 3, 2 / 3, 1].map((v) => expect.closeTo(v, 9)));
    });

    it('gives a chart the line in 0..1 of the box, the cursor, the value and the labels as the renderer draws them', () => {
      const chart = at('chart-time', 15) as ChartProps;
      expect(chart.section).toBe('chart');
      expect(chart.axis).toBe('time');
      expect(chart.window).toBeUndefined();
      expect(chart.cursor.x).toBeCloseTo(0.25, 6);
      expect(chart.cursor.y).toBeDefined();
      expect(chart.value).toBeCloseTo(5.5, 6);
      expect(chart.unit).toBe('m/s');
      expect(chart.yRange).toEqual({ low: 4, high: 10 });
      // A chart's labels are on unless the reader turned them off: the ends of the range and of the activity.
      expect(chart.labels).toEqual({ yHigh: '36.0 km/h', yLow: '14.4 km/h', xStart: '0:00', xEnd: '1:00' });
      expect((at('chart-sensor') as ChartProps).labels).toBeUndefined();
      expect(chart.runs).toHaveLength(1);
      expect(chart.runs[0]![0]![0]).toBe(0);
      const windowed = at('chart-window', 30) as ChartProps;
      expect(windowed).toMatchObject({ axis: 'distance', window: 100, showLabels: true, cursor: { x: 0.5 } });
      expect(windowed.labels).toMatchObject({ xStart: '−100 m', xEnd: '+100 m' });
      expect(windowed.labels!.yHigh).toMatch(/bpm$/);
      expect(windowed.figure).toEqual({ labelScale: 1.5 });
      // A camera stream has its own unit.
      expect((at('chart-sensor') as ChartProps).unit).toBe('m/s²');
    });

    it('gives a chart no props where the renderer draws nothing for it: no activity, or a figure the ride lacks', () => {
      const chart = template.components.find((c) => c.id === 'chart-time')!;
      expect(contractPropsFor(template, chart, timeline.sampleAt(30), timeline, context(undefined))).toBeUndefined();
      const bare = ride(['cyclingCadenceRpm']);
      const bareTimeline = buildOverlayTimeline(bare, { video: { durationSeconds: 60 } });
      const cadence: OverlayComponent = { ...chart, source: { kind: 'metric', metric: 'cyclingCadence' } };
      expect(contractPropsFor(template, cadence, bareTimeline.sampleAt(30), bareTimeline, context(bare))).toBeUndefined();
    });

    it('gives the gradient indicator its band, colour and glyph worked out, the glyph absent when off', () => {
      const props = at('gradient', 20) as GradientProps;
      expect(props.section).toBe('gradient');
      expect(props.bands).toEqual(DEFAULT_GRADIENT.bands);
      expect(props.bandIndex).toBe(2);
      expect(props.color).toBe(DEFAULT_GRADIENT.bands[2]!.color);
      expect(props.glyph).toBe('up');
      expect(props.smoothingWindowSeconds).toBe(5);
      expect(props.text).toBe(`${props.value.toFixed(1)} %`);
      expect('glyph' in (at('gradient-no-glyph', 20) as GradientProps)).toBe(false);
    });

    it('gives the compass its heading as degrees and a letter, and the angles of the rose and the needle worked out', () => {
      const rose = at('compass') as HeadingProps;
      expect(rose.section).toBe('compass');
      expect(rose.compassStyle).toBe('rose');
      expect(rose.northAngleDegrees).toBeCloseTo((360 - rose.value) % 360, 9);
      expect(rose.needleAngleDegrees).toBe(0);
      expect(rose.text).toBe(`${Math.round(rose.value) % 360}° ${rose.cardinal}`);
      const needle = at('compass-needle') as HeadingProps;
      expect(needle.northAngleDegrees).toBe(0);
      expect(needle.needleAngleDegrees).toBeCloseTo(needle.value, 9);
      expect(needle.smoothingWindowSeconds).toBeUndefined();
      expect(rose.smoothingWindowSeconds).toBe(3);
    });

    it('is a section of its own for each', () => {
      for (const [type, section] of [['dial', 'dial'], ['chart', 'chart'], ['gradient', 'gradient'], ['compass', 'compass']] as const) {
        expect(contractSectionOf(component('x', type))).toBe(section);
      }
    });
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

  it('the zones example draws every zone in its colour, the current one bright, inside its box (AV-1018)', () => {
    for (const t of [0, 20, 40, 60]) {
      const zone = propsBig('zones-hr', t) as ZoneProps;
      const { points, log } = drawsInside(drawZones, zone);
      expect(points.length).toBeGreaterThan(5);
      expect(log).toEqual([`${zone.zones[zone.zoneIndex]!.name} ${zone.text}`]);
    }
    const seven = propsBig('zones-power') as ZoneProps;
    expect(seven.zones).toHaveLength(7);
    drawsInside(drawZones, seven);
    // The ends of every zone set the marker inside the box.
    for (const fractionInZone of [0, 1]) for (const zoneIndex of [0, 4]) drawsInside(drawZones, { ...(propsBig('zones-hr') as ZoneProps), fractionInZone, zoneIndex });
  });

  it('the dial example draws the track, the fill, the ticks, a needle and the value, inside its box, at the ends of the range and beyond (AV-1019)', () => {
    for (const id of ['dial', 'dial-smoothed', 'dial-own-range', 'dial-beyond']) {
      for (const t of [0, 20, 60]) {
        const dial = propsBig(id, t) as DialProps;
        const { points, log } = drawsInside(drawDial, dial);
        expect(points.length, id).toBeGreaterThan(10);
        expect(log).toEqual([dial.text]);
      }
    }
    const dial = propsBig('dial') as DialProps;
    for (const fraction of [0, 1]) drawsInside(drawDial, { ...dial, fraction, angleDegrees: (fraction - 0.5) * dial.sweepDegrees });
  });

  it('the chart example draws its runs, the cursor and its labels inside its box, with nothing across a gap (AV-1019)', () => {
    for (const id of ['chart-time', 'chart-window', 'chart-sensor']) {
      for (const t of [0, 30, 60]) {
        const chart = propsBig(id, t) as ChartProps;
        const { points, log } = drawsInside(drawChart, chart);
        expect(points.length, id).toBeGreaterThan(5);
        if (chart.labels) expect(log).toEqual([chart.labels.yHigh, chart.labels.xStart, chart.labels.xEnd].filter(Boolean));
        else expect(log).toEqual([]);
      }
    }
    const without = structuredClone(propsBig('chart-time') as ChartProps);
    without.runs = [];
    delete without.cursor.y;
    expect(drawsInside(drawChart, without).points.length).toBeGreaterThan(0);
  });

  it('the gradient example draws its glyph and its text in the band’s colour, inside its box (AV-1019)', () => {
    for (const id of ['gradient', 'gradient-no-glyph']) {
      const props = propsBig(id) as GradientProps;
      const { log } = drawsInside(drawGradient, props);
      expect(log).toEqual([props.text]);
    }
    for (const glyph of ['up', 'down', 'flat'] as const) drawsInside(drawGradient, { ...(propsBig('gradient') as GradientProps), glyph });
  });

  it('the compass example draws its ring, its letters, its needle and the heading, inside its box, at every heading (AV-1019)', () => {
    for (const id of ['compass', 'compass-needle']) {
      const props = propsBig(id) as HeadingProps;
      const { log } = drawsInside(drawCompass, props);
      expect(log).toEqual(['N', 'E', 'S', 'W', props.text]);
      for (const value of [0, 90, 179.9, 270, 359.9]) {
        drawsInside(drawCompass, { ...props, value, northAngleDegrees: (360 - value) % 360, needleAngleDegrees: value });
      }
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
    { page: 'zones.md', ids: ['zones-hr', 'zones-power', 'zones-arc', 'zones-values'] },
    { page: 'dials.md', ids: ['dial', 'dial-smoothed', 'dial-own-range'] },
    { page: 'charts.md', ids: ['chart-time', 'chart-window', 'chart-sensor'] },
    { page: 'gradient.md', ids: ['gradient', 'gradient-no-glyph'] },
    { page: 'compass.md', ids: ['compass', 'compass-needle'] },
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
    for (const page of ['figures.md', 'gauges.md', 'along-the-route.md', 'whole-activity.md', 'zones.md', 'dials.md', 'charts.md', 'gradient.md', 'compass.md']) {
      expect(readme).toContain(page);
    }
    expect(readme).toContain('/issues/21');
    expect(readme).toContain('TD-087');
  });
});

void realContextsFit;
