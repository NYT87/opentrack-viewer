import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_TEMPLATE_VERSION,
  parseOverlayTemplate,
  resolveOverlayComponent,
  serializeOverlayTemplate,
  unavailableBindings,
  type OverlayComponent,
  type OverlayTemplate,
} from './template';
import { buildOverlayTimeline, type OverlaySample } from './timeline';
import { makeActivity } from '../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 };

const component = (over: Partial<OverlayComponent> & Pick<OverlayComponent, 'id' | 'type'>): OverlayComponent => ({
  visible: true,
  rect,
  unitMode: 'auto',
  style: {},
  ...over,
});

const template: OverlayTemplate = {
  version: OVERLAY_TEMPLATE_VERSION,
  name: 'Test HUD',
  style: DEFAULT_OVERLAY_STYLE,
  components: [
    component({ id: 'speed', type: 'text', source: { kind: 'metric', metric: 'speed' } }),
    component({
      id: 'hr',
      type: 'gauge',
      source: { kind: 'metric', metric: 'heartRate' },
      range: { min: 60, max: 180 },
      style: { accentColor: '#f00' },
    }),
    component({ id: 'map', type: 'routeInset' }),
    component({ id: 'bar', type: 'progress' }),
    component({
      id: 'accl',
      type: 'sensorChart',
      source: { kind: 'sensor', key: 'ACCL' },
      windowSeconds: 10,
    }),
  ],
};

const activity = () =>
  makeActivity([
    { time: at(0), lat: 10, lon: 20, distanceMeters: 0, speedMetersPerSecond: 10 },
    { time: at(10), lat: 10.1, lon: 20.1, distanceMeters: 100, speedMetersPerSecond: 10 },
  ]);

describe('overlay template serialization (AV-1003)', () => {
  it('round-trips through JSON unchanged', () => {
    const result = parseOverlayTemplate(serializeOverlayTemplate(template));
    expect(result).toEqual({ ok: true, template, warnings: [] });
  });

  it('rejects malformed JSON, the wrong shape and unknown versions', () => {
    expect(parseOverlayTemplate('{nope')).toMatchObject({ ok: false });
    expect(parseOverlayTemplate('[]')).toMatchObject({ ok: false });
    expect(parseOverlayTemplate('{"version":99,"components":[]}')).toMatchObject({ ok: false });
    expect(parseOverlayTemplate('{"version":1}')).toMatchObject({ ok: false });
  });

  it('drops invalid components with a warning and keeps the rest', () => {
    const json = JSON.stringify({
      version: 1,
      components: [
        { id: 'ok', type: 'progress', rect },
        { id: 'bad-type', type: 'hologram', rect },
        { id: 'no-source', type: 'text', rect },
        { id: 'bad-rect', type: 'progress', rect: { x: 0, y: 0, width: 0, height: 1 } },
        { id: 'ok', type: 'progress', rect },
        { id: 'left', type: 'progress', rect: { x: -0.1, y: 0, width: 0.2, height: 0.2 } },
        { id: 'right', type: 'progress', rect: { x: 0.9, y: 0, width: 0.2, height: 0.2 } },
        { id: 'below', type: 'progress', rect: { x: 0, y: 0.95, width: 0.1, height: 0.1 } },
        { id: 'edge', type: 'progress', rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
      ],
    });
    const result = parseOverlayTemplate(json);
    expect(result.ok && result.template.components.map((c) => c.id)).toEqual(['ok', 'edge']);
    expect(result.ok && result.warnings).toHaveLength(7);
    expect(result.ok && result.template.name).toBe('Untitled template');
  });

  it('clamps and defaults style tokens and unit modes', () => {
    const json = JSON.stringify({
      version: 1,
      style: { backgroundOpacity: 4, fontScale: -1 },
      components: [{ id: 'a', type: 'progress', rect, unitMode: 'furlongs', visible: false }],
    });
    const result = parseOverlayTemplate(json);
    expect(result.ok && result.template.style).toEqual({ ...DEFAULT_OVERLAY_STYLE, backgroundOpacity: 1 });
    expect(result.ok && result.template.components[0]).toMatchObject({ unitMode: 'auto', visible: false });
  });
});

describe('resolving components against data (AV-1003)', () => {
  const timeline = buildOverlayTimeline(activity());
  const sample = timeline.sampleAt(5);
  const byId = (id: string): OverlayComponent => {
    const found = template.components.find((c) => c.id === id);
    if (!found) throw new Error(`no component ${id}`);
    return found;
  };
  const resolve = (id: string, units: 'metric' | 'imperial' = 'metric', ...rest: [OverlaySample?]) =>
    resolveOverlayComponent(template, byId(id), rest.length ? rest[0] : sample, timeline, units);

  it('formats a text metric in the reader\'s unit system, or the component\'s own', () => {
    expect(resolve('speed')).toMatchObject({ status: 'ready', label: 'Speed', text: '36.0 km/h' });
    expect(resolve('speed', 'imperial')).toMatchObject({ text: '22.4 mph' });
    const fixed = { ...byId('speed'), unitMode: 'imperial' as const };
    expect(resolveOverlayComponent(template, fixed, sample, timeline, 'metric')).toMatchObject({
      text: '22.4 mph',
    });
  });

  it('hides a component whose metric the activity does not have', () => {
    expect(resolve('hr')).toEqual({ status: 'hidden', reason: 'no_data', componentId: 'hr' });
    expect(resolve('accl')).toMatchObject({ status: 'hidden', reason: 'no_data' });
  });

  it('hides everything outside the recording and a disabled component', () => {
    expect(resolve('speed', 'metric', timeline.sampleAt(99))).toMatchObject({ status: 'hidden' });
    const off = { ...byId('speed'), visible: false };
    expect(resolveOverlayComponent(template, off, sample, timeline, 'metric')).toMatchObject({
      reason: 'disabled',
    });
  });

  it('resolves route and progress components from position and progress', () => {
    expect(resolve('map')).toMatchObject({ status: 'ready' });
    expect(resolve('bar')).toMatchObject({ status: 'ready', fraction: 0.5 });
    const noGps = buildOverlayTimeline(makeActivity([{ time: at(0) }, { time: at(2) }]));
    expect(
      resolveOverlayComponent(template, byId('map'), noGps.sampleAt(1), noGps, 'metric'),
    ).toMatchObject({ status: 'hidden', reason: 'no_position' });
  });

  it('computes a gauge fraction within its range and merges style tokens', () => {
    const withHr = buildOverlayTimeline(
      makeActivity([
        { time: at(0), heartRateBpm: 60 },
        { time: at(10), heartRateBpm: 180 },
      ]),
    );
    const resolved = resolveOverlayComponent(template, byId('hr'), withHr.sampleAt(5), withHr, 'metric');
    expect(resolved).toMatchObject({ status: 'ready', fraction: 0.5, text: '120 bpm' });
    expect(resolved.status === 'ready' && resolved.style).toEqual({
      ...DEFAULT_OVERLAY_STYLE,
      accentColor: '#f00',
    });
  });

  it('warns about visible components bound to unavailable data', () => {
    const warnings = unavailableBindings(template, timeline);
    expect(warnings.map((w) => w.componentId)).toEqual(['hr', 'accl']);
    expect(warnings[0]).toMatchObject({ source: 'metric:heartRate' });
    expect(warnings[0]?.message).toContain('Heart rate');
  });
});
