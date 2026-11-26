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

  it('writes the distance so far alone, or of the whole, in the whole’s unit (TD-080)', () => {
    const parsed = read([
      { id: 'd', type: 'text', rect, source: { kind: 'metric', metric: 'distance' } },
      { id: 't', type: 'text', rect, source: { kind: 'metric', metric: 'distance' }, display: { ofTotal: true } },
      { id: 'n', type: 'text', rect, source: { kind: 'metric', metric: 'distance' }, display: { ofTotal: true, decimals: 1 } },
    ]);
    expect(parsed.template.components.map((entry) => entry.display)).toEqual([undefined, { ofTotal: true }, { ofTotal: true, decimals: 1 }]);
    const timeline = buildOverlayTimeline(
      makeActivity(Array.from({ length: 101 }, (_, i) => ({ time: at(i), distanceMeters: i * 42 }))),
      { video: { durationSeconds: 100 } },
    );
    const sample = timeline.sampleAt(10) as OverlaySample;
    const texts = parsed.template.components.map((entry) => resolveOverlayComponent(parsed.template, entry, sample, timeline, 'metric'));
    expect(texts.map((entry) => entry.status === 'ready' && entry.text)).toEqual(['420 m', '0.42 / 4.20 km', '0.4 / 4.2 km']);
    expect(resolveOverlayComponent(parsed.template, parsed.template.components[1]!, sample, timeline, 'imperial')).toMatchObject({ text: '0.26 / 2.61 mi' });
  });

  it('writes a pace of zero standing still, rather than hiding it (TD-080)', () => {
    const parsed = read([{ id: 'p', type: 'text', rect, source: { kind: 'metric', metric: 'pace' } }]);
    const timeline = buildOverlayTimeline(
      makeActivity([
        { time: at(0), speedMetersPerSecond: 4 },
        { time: at(2), speedMetersPerSecond: 0 },
        { time: at(4), speedMetersPerSecond: 0 },
      ]),
      { video: { durationSeconds: 4 } },
    );
    expect(resolveOverlayComponent(parsed.template, parsed.template.components[0]!, timeline.sampleAt(3), timeline, 'metric')).toMatchObject({
      status: 'ready',
      text: '0:00 /km',
    });
  });
});

describe('the elevation profile in a layout (AV-1211)', () => {
  const profile = component({ id: 'elevation-profile', type: 'elevationProfile', rect: { x: 0.05, y: 0.8, width: 0.6, height: 0.15 }, style: { textColor: '#ffeeaa', accentColor: '#ff3366' } });

  it('round-trips through a layout file, needing no data source', () => {
    const withProfile = { ...template, components: [profile] };
    expect(parseOverlayTemplate(serializeOverlayTemplate(withProfile))).toEqual({ ok: true, template: withProfile, warnings: [] });
  });

  it('is an element an earlier version does not know, so one opens the layout without it, with a warning', () => {
    // Before AV-1211, the parser knew this list less 'elevationProfile': as it reads any type it does not know.
    const json = JSON.stringify({ version: 2, components: [{ id: 'ok', type: 'progress', rect }, { id: 'future', type: 'contourMap', rect }] });
    const result = parseOverlayTemplate(json);
    expect(result.ok && result.template.components.map((c) => c.id)).toEqual(['ok']);
    expect(result.ok && result.warnings).toHaveLength(1);
  });

  it('is drawn at the moment\'s progress where the activity has elevation, and hidden where it has none', () => {
    const climbing = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: at(i), lat: 46 + i * 0.0001, lon: 7, elevationMeters: 100 + i })));
    const flatland = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: at(i), lat: 46 + i * 0.0001, lon: 7 })));
    const resolve = (activity: typeof climbing) => {
      const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 10 } });
      return resolveOverlayComponent({ ...template, components: [profile] }, profile, timeline.sampleAt(5), timeline, 'metric');
    };
    expect(resolve(climbing)).toMatchObject({ status: 'ready', fraction: expect.closeTo(0.5, 6) });
    expect(resolve(flatland)).toEqual({ status: 'hidden', reason: 'no_data', componentId: 'elevation-profile' });
  });
});

describe('a figure’s label and value, styled apart (AV-1015, TD-083)', () => {
  const read = (components: object[], version = 2) => {
    const parsed = parseOverlayTemplate(JSON.stringify({ version, name: 'Canvas', style: {}, components }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed;
  };
  const speed = { id: 'speed', type: 'text', rect, source: { kind: 'metric', metric: 'speed' } };
  const figure = {
    showLabel: false,
    labelScale: 1.5,
    valueScale: 0.8,
    labelColor: '#FF0000',
    gap: 0.01,
    align: 'right',
    halo: { color: '#00FF00', opacity: 0.4 },
  };

  it('keeps every setting through a save and a read, in version 2', () => {
    const first = read([{ ...speed, figure }]);
    expect(first.template.version).toBe(2);
    expect(first.template.components[0]!.figure).toEqual({ ...figure, labelColor: '#ff0000', halo: { color: '#00ff00', opacity: 0.4 } });
    const again = read(JSON.parse(serializeOverlayTemplate(first.template)).components);
    expect(again.template).toEqual(first.template);
    expect(JSON.parse(serializeOverlayTemplate(first.template)).version).toBe(2);
  });

  it('opens a layout from before it as it was: no figure settings, the label in the text colour', () => {
    const parsed = read([{ ...speed, style: { textColor: '#123456' } }]);
    expect(parsed.template.components[0]).not.toHaveProperty('figure');
    expect(parsed.template.components[0]!.style.textColor).toBe('#123456');
  });

  it('keeps what reads and drops what does not: scales and gap and opacity in range, colours as #rrggbb, align named', () => {
    const parsed = read([
      { ...speed, figure: { labelScale: 99, valueScale: 0, labelColor: 'red', gap: 5, align: 'middle', halo: { color: 'black', opacity: 0.5 } } },
      { ...speed, id: 'two', figure: { labelScale: 0.001, gap: -1, halo: { color: '#000000', opacity: 7 } } },
      { ...speed, id: 'three', figure: { showLabel: true, labelColor: '#abc' } },
      { ...speed, id: 'four', figure: 'big' },
    ]);
    const [one, two, three, four] = parsed.template.components;
    expect(one!.figure).toEqual({ labelScale: 10, gap: 0.2 });
    expect(two!.figure).toEqual({ labelScale: 0.1, halo: { color: '#000000', opacity: 1 } });
    // Nothing set: no figure at all (a label shown is the default).
    expect(three).not.toHaveProperty('figure');
    expect(four).not.toHaveProperty('figure');
  });

  it('keeps a halo of 0 % (no halo), which is not the same as none set', () => {
    expect(read([{ ...speed, figure: { halo: { color: '#000000', opacity: 0 } } }]).template.components[0]!.figure).toEqual({ halo: { color: '#000000', opacity: 0 } });
  });

  it('keeps it for a gauge, and leaves it off everything that is not a live figure', () => {
    const parsed = read([
      { id: 'gauge', type: 'gauge', rect, source: { kind: 'metric', metric: 'speed' }, range: { min: 0, max: 20 }, figure },
      { id: 'bar', type: 'progress', rect, figure },
      { id: 'card', type: 'shape', rect, shape: { kind: 'ellipse' }, figure },
    ]);
    expect(parsed.template.components.map((component) => 'figure' in component)).toEqual([true, false, false]);
  });

  it('is ignored by a reader that predates it: a version 2 file with the field reads with the others’ fields unchanged', () => {
    // The parser reads fields by name and checks no other keys, so an older build drops this one and keeps the rest.
    const parsed = read([{ ...speed, display: { label: 'Pace' }, figure, somethingNew: 1 }]);
    expect(parsed.template.components[0]).toMatchObject({ id: 'speed', display: { label: 'Pace' } });
  });
});

describe('smoothing in a template (AV-1016)', () => {
  const T = new Date('2024-01-01T10:00:00Z');
  const ramp = makeActivity(
    Array.from({ length: 21 }, (_, i) => ({ time: new Date(T.getTime() + i * 1000), powerWatts: 100 + 10 * i, speedMetersPerSecond: i, distanceMeters: i * i / 2 })),
  );
  const timeline = buildOverlayTimeline(ramp, { video: { durationSeconds: 20 } });
  const power = (extra: Partial<OverlayComponent> = {}) =>
    component({ id: 'power', type: 'text', source: { kind: 'metric', metric: 'power' }, ...extra });
  const parseOne = (value: object) =>
    parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', components: [{ id: 'a', type: 'text', rect, source: { kind: 'metric', metric: 'power' }, ...value }] }));

  it('shows the trailing mean of the window up to the moment, and the moment itself when off', () => {
    const sample = timeline.sampleAt(10)!;
    const shown = (c: OverlayComponent) => resolveOverlayComponent(template, c, sample, timeline, 'metric');
    expect(shown(power())).toMatchObject({ status: 'ready', text: '200 W' });
    expect(shown(power({ smoothing: { windowSeconds: 4 } }))).toMatchObject({ text: '180 W' });
  });

  it('moves a gauge’s fill with the smoothed value, and is hidden by the moment’s own data', () => {
    const gauge = power({ type: 'gauge', range: { min: 100, max: 300 }, smoothing: { windowSeconds: 4 } });
    const ready = resolveOverlayComponent(template, gauge, timeline.sampleAt(10)!, timeline, 'metric');
    expect(ready).toMatchObject({ status: 'ready', fraction: 0.4 });
    expect(resolveOverlayComponent(template, gauge, undefined, timeline, 'metric')).toMatchObject({ status: 'hidden', reason: 'no_data' });
  });

  it('writes pace from the smoothed speed', () => {
    const pace = component({ id: 'pace', type: 'text', source: { kind: 'metric', metric: 'pace' }, smoothing: { windowSeconds: 4 } });
    // Speed 8 m/s at second 10, averaged over 8..12 is 8 m/s too: 1000 / 8 = 125 s/km.
    expect(resolveOverlayComponent(template, pace, timeline.sampleAt(10)!, timeline, 'metric')).toMatchObject({ text: '2:05 /km' });
  });

  it('keeps a window of 0 to 30 s, and drops anything else, so older layouts read unchanged', () => {
    const smoothing = (windowSeconds: unknown) => {
      const parsed = parseOne({ smoothing: { windowSeconds } });
      return parsed.ok ? parsed.template.components[0]!.smoothing : 'refused';
    };
    expect(smoothing(3)).toEqual({ windowSeconds: 3 });
    expect(smoothing(99)).toEqual({ windowSeconds: 30 });
    for (const off of [0, -2, 'x', null, Number.NaN]) expect(smoothing(off)).toBeUndefined();
    expect(parseOne({})).toMatchObject({ ok: true, warnings: [] });
    // Only a live figure or gauge, and only a source that is a reading.
    const total = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', components: [{ id: 'a', type: 'text', rect, source: { kind: 'metric', metric: 'distance' }, smoothing: { windowSeconds: 3 } }] }));
    expect(total.ok && total.template.components[0]!.smoothing).toBeUndefined();
  });

  it('round-trips through the layout file, and an older reader skips a climb figure it does not know', () => {
    const smoothed: OverlayTemplate = { ...template, components: [power({ smoothing: { windowSeconds: 3 } })] };
    expect(parseOverlayTemplate(serializeOverlayTemplate(smoothed))).toEqual({ ok: true, template: smoothed, warnings: [] });
    // What an older build does with metric:climb: that one component is skipped, with a warning; the rest opens.
    const older = parseOverlayTemplate(
      JSON.stringify({ version: 2, name: 'x', components: [{ id: 'a', type: 'text', rect, source: { kind: 'metric', metric: 'climbing' } }, { id: 'b', type: 'text', rect, source: { kind: 'metric', metric: 'speed' } }] }),
    );
    expect(older).toMatchObject({ ok: true, warnings: [expect.stringMatching(/missing or invalid data source/)] });
    expect(older.ok && older.template.components.map((c) => c.id)).toEqual(['b']);
  });

  it('writes climb as an elevation, in the unit chosen', () => {
    const climb = component({ id: 'climb', type: 'text', source: { kind: 'metric', metric: 'climb' } });
    const sample = { videoTimeSeconds: 1, activityElapsedSeconds: 1, values: { 'metric:climb': 100 } };
    const tl = { ...timeline, available: new Set(['metric:climb']) };
    expect(resolveOverlayComponent(template, climb, sample, tl, 'metric')).toMatchObject({ label: 'Climb so far', text: '100 m' });
    expect(resolveOverlayComponent(template, climb, sample, tl, 'imperial')).toMatchObject({ text: '328 ft' });
    expect(resolveOverlayComponent(template, { ...climb, display: { decimals: 1 } }, sample, tl, 'metric')).toMatchObject({ text: '100.0 m' });
  });
});

describe('the privacy trim in a template (AV-1022, TD-091)', () => {
  const read = (extra: object) => {
    const parsed = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', style: {}, components: [], ...extra }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.template;
  };

  it('round-trips as the two shares, and nothing else', () => {
    const first = read({ privacyTrim: { start: 0.08, end: 0.125 } });
    expect(first.privacyTrim).toEqual({ start: 0.08, end: 0.125 });
    expect(JSON.parse(serializeOverlayTemplate(first)).privacyTrim).toEqual({ start: 0.08, end: 0.125 });
    expect(first.version).toBe(2);
    const again = parseOverlayTemplate(serializeOverlayTemplate(first));
    expect(again.ok && again.template).toEqual(first);
  });

  it('opens a template without one with none, still within version 2', () => {
    const template = read({});
    expect('privacyTrim' in template).toBe(false);
    expect(template.version).toBe(2);
  });

  it('clamps a share to 0..45 % and drops a trim that hides nothing or is not one', () => {
    expect(read({ privacyTrim: { start: 0.9, end: -0.2 } }).privacyTrim).toEqual({ start: 0.45, end: 0 });
    expect(read({ privacyTrim: { start: 0, end: 0 } }).privacyTrim).toBeUndefined();
    expect(read({ privacyTrim: 'all' }).privacyTrim).toBeUndefined();
    expect(read({ privacyTrim: { start: 'a', end: null } }).privacyTrim).toBeUndefined();
  });
});

describe('the figures so far in a layout (AV-1025)', () => {
  const read = (components: object[]) => {
    const parsed = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'Canvas', style: {}, components }));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed;
  };
  const figure = (id: string, metric: string, extra: object = {}) => ({ id, type: 'text', rect, source: { kind: 'metric', metric }, ...extra });

  it('round-trips a stopwatch’s start and a clock’s zone and format, in version 2, and keeps neither where there is none', () => {
    const first = read([
      figure('sw', 'stopwatch', { stopwatch: { startSeconds: 125 } }),
      figure('sw-default', 'stopwatch'),
      figure('clock', 'clock', { clock: { zone: 'offset', offsetMinutes: 330, hour12: true, seconds: false, date: true } }),
      figure('clock-default', 'clock'),
      figure('max', 'maxSpeed'),
    ]);
    const [sw, swDefault, clock, clockDefault] = first.template.components;
    expect(sw!.stopwatch).toEqual({ startSeconds: 125 });
    expect(swDefault!.stopwatch).toBeUndefined();
    expect(clock!.clock).toEqual({ zone: 'offset', offsetMinutes: 330, hour12: true, seconds: false, date: true });
    expect(clockDefault!.clock).toBeUndefined();
    expect(first.template.version).toBe(2);
    const again = parseOverlayTemplate(serializeOverlayTemplate(first.template));
    expect(again).toEqual({ ok: true, template: first.template, warnings: [] });
    expect(JSON.parse(serializeOverlayTemplate(first.template)).version).toBe(2);
  });

  it('drops the settings where the figure is not a stopwatch or a clock, and a start that does not read', () => {
    const parsed = read([
      figure('speed', 'speed', { stopwatch: { startSeconds: 5 }, clock: { zone: 'utc' } }),
      figure('sw', 'stopwatch', { stopwatch: { startSeconds: 'soon' }, clock: { zone: 'utc' } }),
    ]);
    expect(parsed.template.components.map((entry) => [entry.stopwatch, entry.clock])).toEqual([[undefined, undefined], [undefined, undefined]]);
  });

  it('is skipped with a warning where a build does not know the figure: the same path an earlier build takes, and the version stays 2', () => {
    // An earlier build's list of figures has none of the new ones, so each reads as one it does not know.
    const parsed = read([figure('speed', 'speed'), figure('future', 'maxPowerNextYear'), figure('also', 'clockwork')]);
    expect(parsed.template.version).toBe(2);
    expect(parsed.template.components.map((entry) => entry.id)).toEqual(['speed']);
    expect(parsed.warnings).toEqual(['Component 2 was skipped: missing or invalid data source.', 'Component 3 was skipped: missing or invalid data source.']);
  });

  const timeline = buildOverlayTimeline(
    makeActivity(Array.from({ length: 61 }, (_, i) => ({ time: at(i), distanceMeters: i * 5, elevationMeters: 100 + (i % 20), heartRateBpm: 100 + i }))),
    { video: { durationSeconds: 60 } },
  );
  const textAt = (item: object, seconds: number, units: 'metric' | 'imperial' = 'metric', zone?: string) => {
    const parsed = read([item]);
    const resolved = resolveOverlayComponent(parsed.template, parsed.template.components[0]!, timeline.sampleAt(seconds), timeline, units, undefined, zone);
    return resolved.status === 'ready' ? resolved.text : resolved.status;
  };

  it('writes each figure as the app writes its kind, and the decimals the reader chose', () => {
    expect(textAt(figure('a', 'maxHeartRate'), 30)).toBe('130 bpm');
    expect(textAt(figure('a', 'maxHeartRate', { display: { decimals: 1 } }), 30)).toBe('130.0 bpm');
    expect(textAt(figure('a', 'averageSpeed'), 30)).toBe('18.0 km/h');
    expect(textAt(figure('a', 'averageSpeed', { display: { decimals: 0 } }), 30, 'imperial')).toBe('11 mph');
    expect(textAt(figure('a', 'averagePace'), 30)).toBe('3:20 /km');
    expect(textAt(figure('a', 'averageMovingPace', { display: { decimals: 2 } }), 30)).toBe('3:20 /km');
    expect(textAt(figure('a', 'averagePace'), 30, 'imperial')).toBe('5:22 /mi');
    expect(textAt(figure('a', 'elevationHighest'), 30)).toBe('119 m');
    expect(textAt(figure('a', 'elevationLowest', { display: { decimals: 1 } }), 30)).toBe('100.0 m');
    expect(textAt(figure('a', 'elevationHighest', { display: { ofTotal: true } }), 30)).toBe('119 / 119 m');
    expect(textAt(figure('a', 'elevationHighest', { display: { ofTotal: true, decimals: 1 } }), 10, 'imperial')).toBe('360.9 / 390.4 ft');
    expect(textAt(figure('a', 'stopwatch'), 59.9)).toBe('0:59');
    expect(textAt(figure('a', 'clock'), 30, 'metric', 'UTC')).toBe('10:00:30');
    // Times are clocks whatever the decimals.
    expect(textAt(figure('a', 'stopwatch', { display: { decimals: 2 } }), 30)).toBe('0:30');
    expect(textAt(figure('a', 'clock', { display: { decimals: 2 } }), 30, 'metric', 'UTC')).toBe('10:00:30');
  });

  it('hides a figure with no value at the moment, and leaves a stopwatch of its own start at 0:00 before it', () => {
    expect(textAt(figure('a', 'averageSpeed'), 0)).toBe('hidden');
    expect(textAt(figure('a', 'stopwatch', { stopwatch: { startSeconds: 40 } }), 30)).toBe('0:00');
    expect(textAt(figure('a', 'stopwatch', { stopwatch: { startSeconds: 40 } }), 50)).toBe('0:10');
    expect(textAt(figure('a', 'clock', { clock: { zone: 'offset', offsetMinutes: -300 } }), 30)).toBe('05:00:30');
  });
});

describe('an image component (AV-1030, TD-102)', () => {
  const PNG = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\n....')}`;
  const base = { rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, unitMode: 'auto' as const, style: {}, visible: true };
  const image: OverlayComponent = { ...base, id: 'logo', type: 'image', image: { src: PNG, fit: 'cover', opacity: 0.4, name: 'logo.png' } };
  const holder: OverlayTemplate = { version: OVERLAY_TEMPLATE_VERSION, name: 'logo', style: DEFAULT_OVERLAY_STYLE, components: [image] };

  it('round-trips through the layout unchanged, picture included, with its window and its holder', () => {
    const card: OverlayComponent = { ...base, id: 'card', type: 'shape', shape: { kind: 'rect', fill: '#000000', fillOpacity: 0.5, stroke: '#ffffff', strokeOpacity: 0, strokeWidth: 0, radius: 0 } };
    const timed: OverlayComponent = { ...image, parentId: 'card', visibility: { from: 2, to: 8, fadeIn: 1 } };
    const template: OverlayTemplate = { ...holder, components: [card, timed] };
    expect(parseOverlayTemplate(serializeOverlayTemplate(template))).toEqual({ ok: true, template, warnings: [] });
  });

  it('keeps the component when its picture cannot be read, with none, so the editor and the exports can say so', () => {
    for (const src of ['', 'https://example.com/logo.png', 'data:image/gif;base64,R0lGODlh', 'data:image/png;base64,@@', 42]) {
      const parsed = parseOverlayTemplate(JSON.stringify({ ...holder, components: [{ ...image, image: { ...image.image, src } }] }));
      expect(parsed).toMatchObject({ ok: true, warnings: [] });
      if (!parsed.ok) throw new Error(parsed.error);
      expect(parsed.template.components[0]).toMatchObject({ id: 'logo', type: 'image', image: { src: '', fit: 'cover', opacity: 0.4 } });
    }
  });

  it('reads a fit and an opacity as they may be used, and a missing setting as the defaults', () => {
    const read = (value: unknown) => {
      const parsed = parseOverlayTemplate(JSON.stringify({ ...holder, components: [{ ...image, image: value }] }));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.template.components[0]!.image;
    };
    expect(read({ src: PNG, fit: 'sideways', opacity: 7 })).toEqual({ src: PNG, fit: 'contain', opacity: 1 });
    expect(read({ src: PNG, opacity: -3 })).toMatchObject({ opacity: 0 });
    expect(read(undefined)).toEqual({ src: '', fit: 'contain', opacity: 1 });
    // The name is plain text, on one line.
    expect(read({ src: PNG, name: '<b>a</b>\nb' })?.name).toBe('<b>a</b>');
  });
});
