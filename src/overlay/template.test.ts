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

describe('version 2: the still image’s components (AV-1010)', () => {
  const still = {
    version: 2,
    name: 'Still',
    style: {},
    components: [
      { id: 't', type: 'label', rect, content: 'Hello <b>', text: { align: 'center', weight: 'normal' } },
      { id: 's', type: 'summary', rect, summary: { stat: 'moving' }, text: { caption: false } },
      { id: 'd', type: 'date', rect, date: { format: 'long', withTime: true, timeZone: 'activity' } },
      { id: 'r', type: 'routeInset', rect, route: { lineWidth: 0.01, padding: 0.08, markers: false } },
      { id: 'bad-stat', type: 'summary', rect, summary: { stat: 'calories' } },
      { id: 'bad-date', type: 'date', rect, date: { format: 'roman' } },
      { id: 'no-text', type: 'label', rect },
    ],
  };

  it('reads texts, figures, dates and a route’s setting, and skips what it cannot, with a warning each', () => {
    const parsed = parseOverlayTemplate(JSON.stringify(still));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.template.components.map((entry) => entry.id)).toEqual(['t', 's', 'd', 'r']);
    expect(parsed.template.components[0]).toMatchObject({ content: 'Hello <b>', text: { align: 'center', weight: 'normal' } });
    expect(parsed.template.components[1]).toMatchObject({ summary: { stat: 'moving' }, text: { align: 'left', weight: 'bold', caption: false } });
    expect(parsed.template.components[2]).toMatchObject({ date: { format: 'long', withTime: true, timeZone: 'activity' } });
    expect(parsed.template.components[3]).toMatchObject({ route: { lineWidth: 0.01, padding: 0.08, markers: false } });
    expect(parsed.warnings).toEqual([
      'Component 5 was skipped: unknown figure "calories".',
      'Component 6 was skipped: unknown date format "roman".',
      'Component 7 was skipped: a text with no content.',
    ]);
    // And back again, unchanged.
    const again = parseOverlayTemplate(serializeOverlayTemplate(parsed.template));
    expect(again.ok && again.template).toEqual(parsed.template);
  });

  it('still reads a version 1 template', () => {
    expect(parseOverlayTemplate(JSON.stringify({ ...template, version: 1 }))).toMatchObject({ ok: true });
  });

  it('hides a text, figure or date in a video, where a frame shows a moment', () => {
    const parsed = parseOverlayTemplate(JSON.stringify(still));
    if (!parsed.ok) throw new Error(parsed.error);
    const timeline = buildOverlayTimeline(makeActivity([{ time: at(0), lat: 1, lon: 1 }, { time: at(1), lat: 1.001, lon: 1 }]), {
      video: { durationSeconds: 1 },
    });
    const sample = timeline.sampleAt(0) as OverlaySample;
    for (const entry of parsed.template.components.slice(0, 3)) {
      expect(resolveOverlayComponent(parsed.template, entry, sample, timeline, 'metric')).toEqual({
        status: 'hidden',
        reason: 'still_image_only',
        componentId: entry.id,
      });
    }
  });
});

describe('rects at the frame’s edge (AV-1010, review R1-C2)', () => {
  const at = (x: number, width: number) => ({
    version: 2,
    name: 'Edge',
    style: {},
    components: [{ id: 't', type: 'label', content: 'x', rect: { x, y: 0, width, height: 0.1 } }],
  });

  it('reads a rect a hair past the edge from rounding, kept inside, and still refuses one really outside', () => {
    const hair = parseOverlayTemplate(JSON.stringify(at(0.9896844444444446, 0.010315555555555555)));
    if (!hair.ok) throw new Error(hair.error);
    expect(hair.warnings).toEqual([]);
    const { rect: kept } = hair.template.components[0]!;
    expect(kept.x + kept.width).toBeLessThanOrEqual(1);
    expect(parseOverlayTemplate(JSON.stringify(at(0.95, 0.1)))).toMatchObject({
      ok: true,
      warnings: ['Component 1 was skipped: invalid rect (must lie within the frame, as fractions of 0..1).'],
    });
  });
});

describe('shapes, holding and a figure’s format (AV-1011)', () => {
  const read = (components: object[]) => {
    const parsed = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'Canvas', style: {}, components }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed;
  };

  it('reads a shape, keeping its colours and transparencies in range, and refuses an unknown one', () => {
    const parsed = read([
      { id: 'card', type: 'shape', rect, shape: { kind: 'ellipse', fill: '#123456', fillOpacity: 2, stroke: 'red', strokeOpacity: 0.5, strokeWidth: 9, radius: -1 } },
      { id: 'blob', type: 'shape', rect, shape: { kind: 'star' } },
    ]);
    expect(parsed.template.components).toHaveLength(1);
    expect(parsed.template.components[0]!.shape).toEqual({
      kind: 'ellipse',
      fill: '#123456',
      fillOpacity: 1,
      stroke: '#ffffff',
      strokeOpacity: 0.5,
      strokeWidth: 0.1,
      radius: 0.02,
    });
    expect(parsed.warnings).toEqual(['Component 2 was skipped: unknown shape "star".']);
  });

  it('keeps a component in a shape’s hold only when that shape is there', () => {
    const parsed = read([
      { id: 'card', type: 'shape', rect, shape: { kind: 'rect' } },
      { id: 'a', type: 'text', rect, source: { kind: 'metric', metric: 'speed' }, parentId: 'card' },
      { id: 'b', type: 'text', rect, source: { kind: 'metric', metric: 'speed' }, parentId: 'gone' },
    ]);
    expect(parsed.template.components.map((c) => c.parentId)).toEqual([undefined, 'card', undefined]);
  });

  it('writes a figure with its own label and decimal places, and times as clocks whatever is chosen', () => {
    const parsed = read([
      { id: 's', type: 'text', rect, source: { kind: 'metric', metric: 'speed' }, display: { label: 'Velocity', decimals: 2 } },
      { id: 'm', type: 'text', rect, source: { kind: 'metric', metric: 'moving' }, display: { decimals: 0 } },
    ]);
    const timeline = buildOverlayTimeline(
      makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: at(i), lat: 1 + (i * 5) / 111_320, lon: 1 }))),
      { video: { durationSeconds: 10 } },
    );
    const sample = timeline.sampleAt(5) as OverlaySample;
    const [speed, moving] = parsed.template.components.map((entry) => resolveOverlayComponent(parsed.template, entry, sample, timeline, 'metric'));
    expect(speed).toMatchObject({ status: 'ready', label: 'Velocity', text: expect.stringMatching(/^1[78]\.\d\d km\/h$/) });
    expect(moving).toMatchObject({ status: 'ready', label: 'Moving time', text: '0:05' });
    expect(resolveOverlayComponent(parsed.template, parsed.template.components[0]!, sample, timeline, 'imperial')).toMatchObject({
      text: expect.stringMatching(/^1[01]\.\d\d mph$/),
    });
  });
});
