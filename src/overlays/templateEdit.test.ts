import { describe, expect, it } from 'vitest';
import {
  addComponent,
  canAddComponent,
  describeComponent,
  removeComponent,
  setBox,
  setChartWindow,
  setGaugeRange,
  setLabel,
  setRouteOptions,
  setStyle,
  setUnits,
  setVisible,
} from './templateEdit';
import {
  compactHudTemplate,
  gaugeDashboardTemplate,
  routeInsetTemplate,
  type OverlayTemplate,
} from './template';
import { MAX_COMPONENTS, parseProject, serializeProject } from './templateIO';

const find = (t: OverlayTemplate, id: string) => t.components.find((c) => c.id === id)!;
/** Anything an edit produces must be something the project file accepts back. */
const survivesRoundTrip = (t: OverlayTemplate) => {
  const result = parseProject(serializeProject(t));
  if (!result.ok) throw new Error(result.problems.join('; '));
  expect(result.template).toEqual(t);
};

describe('editing a template (AV-1005)', () => {
  it('never changes the template it was given', () => {
    const original = compactHudTemplate();
    const snapshot = JSON.stringify(original);
    setVisible(original, 'speed', false);
    setBox(original, 'speed', { x: 0.5 });
    setStyle(original, 'speed', { color: '#ff0000' });
    addComponent(original, { type: 'progress' });
    removeComponent(original, 'speed');
    setUnits(original, 'imperial');
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('ignores an id that is not there', () => {
    const t = compactHudTemplate();
    expect(setVisible(t, 'nope', false)).toBe(t);
    expect(setBox(t, 'nope', { x: 0.1 })).toBe(t);
    expect(removeComponent(t, 'nope')).toBe(t);
  });

  describe('visibility and units', () => {
    it('shows and hides a component', () => {
      const t = setVisible(compactHudTemplate(), 'heart-rate', true);
      expect(find(t, 'heart-rate').visible).toBe(true);
      expect(find(setVisible(t, 'heart-rate', false), 'heart-rate').visible).toBe(false);
    });

    it('changes the unit system, and returns the same object when nothing changes', () => {
      const t = compactHudTemplate('metric');
      expect(setUnits(t, 'imperial').units).toBe('imperial');
      expect(setUnits(t, 'metric')).toBe(t);
    });
  });

  describe('position and size', () => {
    it('moves a component', () => {
      const t = setBox(compactHudTemplate(), 'speed', { x: 0.5, y: 0.3 });
      expect(find(t, 'speed').box).toMatchObject({ x: 0.5, y: 0.3 });
      survivesRoundTrip(t);
    });

    it('stops at the frame edge instead of hanging off it', () => {
      const t = setBox(compactHudTemplate(), 'speed', { x: 5, y: -3 });
      const { box } = find(t, 'speed');
      expect(box.x).toBeCloseTo(1 - box.width, 9);
      expect(box.y).toBe(0);
      survivesRoundTrip(t);
    });

    it('pushes a component back in when it is grown past the edge', () => {
      const moved = setBox(compactHudTemplate(), 'speed', { x: 0.9 });
      const grown = setBox(moved, 'speed', { width: 0.5 });
      const { box } = find(grown, 'speed');
      expect(box.width).toBe(0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(1 + 1e-9);
      survivesRoundTrip(grown);
    });

    it('keeps a component from shrinking to nothing or growing past the frame', () => {
      const tiny = setBox(compactHudTemplate(), 'speed', { width: 0, height: -1 });
      expect(find(tiny, 'speed').box.width).toBeGreaterThan(0);
      expect(find(tiny, 'speed').box.height).toBeGreaterThan(0);
      const huge = setBox(compactHudTemplate(), 'speed', { width: 9, height: 9 });
      expect(find(huge, 'speed').box).toMatchObject({ width: 1, height: 1, x: 0, y: 0 });
      survivesRoundTrip(tiny);
      survivesRoundTrip(huge);
    });

    it('refuses a non-numeric position', () => {
      const t = compactHudTemplate();
      expect(setBox(t, 'speed', { x: NaN })).toEqual(t);
      expect(setBox(t, 'speed', { width: Infinity })).toEqual(t);
    });
  });

  describe('style', () => {
    it('changes colours and text size', () => {
      const t = setStyle(compactHudTemplate(), 'speed', { color: '#00ff00', accentColor: 'red', fontScale: 1.5 });
      expect(find(t, 'speed').style).toMatchObject({ color: '#00ff00', accentColor: 'red', fontScale: 1.5 });
      survivesRoundTrip(t);
    });

    it('can remove the panel', () => {
      const t = setStyle(compactHudTemplate(), 'speed', { backgroundColor: 'transparent' });
      expect(find(t, 'speed').style.backgroundColor).toBe('transparent');
      survivesRoundTrip(t);
    });

    it('refuses a colour the project file would refuse', () => {
      const before = find(compactHudTemplate(), 'speed').style;
      for (const bad of ['url(x)', 'var(--a)', '', 'javascript:alert(1)']) {
        expect(find(setStyle(compactHudTemplate(), 'speed', { color: bad }), 'speed').style.color).toBe(before.color);
      }
    });

    it('clamps text size to what the project file allows', () => {
      expect(find(setStyle(compactHudTemplate(), 'speed', { fontScale: 100 }), 'speed').style.fontScale).toBe(4);
      expect(find(setStyle(compactHudTemplate(), 'speed', { fontScale: 0 }), 'speed').style.fontScale).toBe(0.25);
      expect(find(setStyle(compactHudTemplate(), 'speed', { fontScale: NaN }), 'speed').style.fontScale).toBe(1);
    });
  });

  describe('component options', () => {
    it('changes a dial range, but only to a real range', () => {
      const t = gaugeDashboardTemplate();
      const ok = setGaugeRange(t, 'power', 0, 800);
      expect(find(ok, 'power')).toMatchObject({ min: 0, max: 800 });
      expect(setGaugeRange(t, 'power', 5, 5)).toBe(t);
      expect(setGaugeRange(t, 'power', 10, 1)).toBe(t);
      expect(setGaugeRange(t, 'power', NaN, 1)).toBe(t);
      // Not a gauge: untouched.
      expect(setGaugeRange(compactHudTemplate(), 'speed', 0, 5)).toEqual(compactHudTemplate());
      survivesRoundTrip(ok);
    });

    it('changes a route inset', () => {
      const t = setRouteOptions(routeInsetTemplate(), 'route', { lineWidth: 9, showMarker: false });
      expect(find(t, 'route')).toMatchObject({ lineWidth: 9, showMarker: false });
      expect(find(setRouteOptions(routeInsetTemplate(), 'route', { lineWidth: 999 }), 'route')).toMatchObject({ lineWidth: 50 });
      survivesRoundTrip(t);
    });

    it('changes how far back a chart looks, within limits', () => {
      const t = addComponent(compactHudTemplate(), { type: 'chart', binding: { kind: 'metric', metric: 'heartRate' } });
      const id = t.components.at(-1)!.id;
      expect(find(setChartWindow(t, id, 120), id)).toMatchObject({ windowSeconds: 120 });
      expect(find(setChartWindow(t, id, 1), id)).toMatchObject({ windowSeconds: 5 });
      expect(find(setChartWindow(t, id, 99999), id)).toMatchObject({ windowSeconds: 600 });
    });

    it('relabels a readout, or restores the default', () => {
      const t = setLabel(compactHudTemplate(), 'speed', 'Velocity');
      expect(find(t, 'speed')).toMatchObject({ label: 'Velocity' });
      expect('label' in find(setLabel(t, 'speed', undefined), 'speed')).toBe(false);
      expect(find(setLabel(compactHudTemplate(), 'speed', 'x'.repeat(200)), 'speed')).toMatchObject({ label: 'x'.repeat(80) });
      survivesRoundTrip(t);
    });
  });

  describe('adding and removing', () => {
    it('adds a readout for any measurement, with a fresh id', () => {
      let t = compactHudTemplate();
      t = addComponent(t, { type: 'text', binding: { kind: 'metric', metric: 'pace' } });
      t = addComponent(t, { type: 'text', binding: { kind: 'metric', metric: 'pace' } });
      const ids = t.components.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id.startsWith('pace-readout'))).toHaveLength(2);
      survivesRoundTrip(t);
    });

    it('adds each kind of component, bound to a sensor stream where that makes sense', () => {
      let t: OverlayTemplate = { name: 'Blank', units: 'metric', components: [] };
      t = addComponent(t, { type: 'gauge', binding: { kind: 'metric', metric: 'power' } });
      t = addComponent(t, { type: 'gauge', binding: { kind: 'sensor', key: 'ACCL' } });
      t = addComponent(t, { type: 'chart', binding: { kind: 'metric', metric: 'speed' } });
      t = addComponent(t, { type: 'route' });
      t = addComponent(t, { type: 'progress' });
      expect(t.components.map((c) => c.type)).toEqual(['gauge', 'gauge', 'chart', 'route', 'progress']);
      expect(find(t, 'sensor-ACCL-gauge')).toMatchObject({ binding: { kind: 'sensor', key: 'ACCL' } });
      survivesRoundTrip(t);
    });

    it('starts a dial in a range that suits its measurement and the units', () => {
      const speed = (units: 'metric' | 'imperial') =>
        find(
          addComponent({ name: 'B', units, components: [] }, { type: 'gauge', binding: { kind: 'metric', metric: 'speed' } }),
          'speed-gauge',
        );
      expect(speed('metric')).toMatchObject({ min: 0, max: 60 });
      expect(speed('imperial')).toMatchObject({ min: 0, max: 40 });
    });

    it('does not stack new components exactly on top of each other', () => {
      let t: OverlayTemplate = { name: 'B', units: 'metric', components: [] };
      for (let i = 0; i < 3; i += 1) t = addComponent(t, { type: 'text', binding: { kind: 'metric', metric: 'speed' } });
      expect(new Set(t.components.map((c) => c.box.y)).size).toBe(3);
      for (const { box } of t.components) expect(box.y + box.height).toBeLessThanOrEqual(1);
    });

    it('stops at the component limit the project file enforces', () => {
      let t: OverlayTemplate = { name: 'B', units: 'metric', components: [] };
      for (let i = 0; i < MAX_COMPONENTS + 5; i += 1) t = addComponent(t, { type: 'progress' });
      expect(t.components).toHaveLength(MAX_COMPONENTS);
      expect(canAddComponent(t)).toBe(false);
      survivesRoundTrip(t);
    });

    it('removes a component', () => {
      const t = removeComponent(compactHudTemplate(), 'speed');
      expect(t.components.map((c) => c.id)).not.toContain('speed');
    });
  });

  it('names components for people', () => {
    const t = addComponent(compactHudTemplate(), { type: 'chart', binding: { kind: 'sensor', key: 'ACCL' } });
    expect(describeComponent(find(t, 'speed'))).toBe('Speed readout');
    expect(describeComponent(find(setLabel(t, 'speed', 'Velocity'), 'speed'))).toBe('Velocity readout');
    expect(describeComponent(find(gaugeDashboardTemplate(), 'power'))).toBe('Power gauge');
    expect(describeComponent(find(routeInsetTemplate(), 'route'))).toBe('Route inset');
    expect(describeComponent(find(routeInsetTemplate(), 'progress'))).toBe('Progress bar');
    expect(describeComponent(t.components.at(-1)!)).toBe('ACCL stream chart');
  });
});
