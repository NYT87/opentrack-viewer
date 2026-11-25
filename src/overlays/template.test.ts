import { describe, expect, it } from 'vitest';
import { computeStreams, type Activity, type ActivityPoint } from '../domain/activity';
import {
  BUILT_IN_TEMPLATES,
  METRIC_INFO,
  availabilityOf,
  compactHudTemplate,
  displayMetric,
  gaugeDashboardTemplate,
  resolveTemplate,
  routeInsetTemplate,
  staticAvailability,
  type OverlayTemplate,
} from './template';
import { OVERLAY_METRICS, buildTimeline } from './timeline';
import { MAX_COMPONENTS, PROJECT_FORMAT, parseProject, serializeProject } from './templateIO';

const T0 = Date.UTC(2024, 0, 1, 10);
const pt = (s: number, extra: Partial<ActivityPoint> = {}): ActivityPoint => ({
  index: s,
  time: new Date(T0 + s * 1000),
  lat: 42 + s * 1e-5,
  lon: -8,
  distanceMeters: s * 4,
  elevationMeters: 100,
  ...extra,
});
const activityOf = (points: ActivityPoint[]): Activity => ({
  id: 'a',
  source: { format: 'gpx', parserVersion: 't' },
  metadata: {},
  points,
  streams: computeStreams(points),
  warnings: [],
});
const availabilityFor = (points: ActivityPoint[]) => {
  const result = buildTimeline(activityOf(points));
  if (!result.ok) throw new Error(result.reason);
  return availabilityOf(result.timeline);
};
const plain = [0, 1, 2, 3].map((s) => pt(s));

describe('built-in templates (AV-1003)', () => {
  it('offers the three agreed templates, each named and buildable in either unit system', () => {
    expect(BUILT_IN_TEMPLATES.map((t) => t.label)).toEqual(['Compact HUD', 'Route inset', 'Gauge dashboard']);
    for (const entry of BUILT_IN_TEMPLATES) {
      for (const units of ['metric', 'imperial'] as const) {
        const template = entry.create(units);
        expect(template.units).toBe(units);
        expect(template.components.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every component inside the frame with unique ids', () => {
    for (const entry of BUILT_IN_TEMPLATES) {
      const { components } = entry.create();
      expect(new Set(components.map((c) => c.id)).size).toBe(components.length);
      for (const { box } of components) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(1);
        expect(box.y + box.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it('scales the speed dial to the unit system', () => {
    const max = (t: OverlayTemplate) => t.components.find((c) => c.id === 'speed' && c.type === 'gauge')!;
    expect((max(gaugeDashboardTemplate('metric')) as { max: number }).max).toBe(60);
    expect((max(gaugeDashboardTemplate('imperial')) as { max: number }).max).toBe(40);
  });

  it('describes every metric', () => {
    for (const metric of OVERLAY_METRICS) expect(METRIC_INFO[metric].label).toBeTruthy();
  });
});

describe('what a template can show (AV-1003)', () => {
  it('draws everything switched on when the data is there', () => {
    const resolved = resolveTemplate(compactHudTemplate(), availabilityFor(plain));
    // Heart rate is off by default, so it is neither drawn nor reported.
    expect(resolved.components.map((c) => c.id)).toEqual(['speed', 'distance', 'time', 'elevation']);
    expect(resolved.hidden).toEqual([]);
  });

  it('hides a component with no data and says why, instead of drawing a placeholder', () => {
    const template = compactHudTemplate();
    template.components.find((c) => c.id === 'heart-rate')!.visible = true;
    const resolved = resolveTemplate(template, availabilityFor(plain));
    expect(resolved.components.map((c) => c.id)).not.toContain('heart-rate');
    expect(resolved.hidden).toHaveLength(1);
    expect(resolved.hidden[0]!.reason).toMatch(/Heart rate is not in this activity.*heart-rate sensor/);
  });

  it('shows a gauge only for the sensors that were recorded', () => {
    const withPower = [0, 1, 2].map((s) => pt(s, { powerWatts: 200, heartRateBpm: 140 }));
    const resolved = resolveTemplate(gaugeDashboardTemplate(), availabilityFor(withPower));
    expect(resolved.components.map((c) => c.id).sort()).toEqual(['heart-rate', 'power', 'speed']);
    expect(resolved.hidden.map((h) => h.component.id)).toEqual(['cadence']);
  });

  it('binds to a camera stream by key', () => {
    const activity = activityOf(plain);
    activity.sensorStreams = [{ key: 'ACCL', label: 'Shake', display: 'chart', valuesByPoint: [1, 2, 3, 4] }];
    const timeline = buildTimeline(activity);
    if (!timeline.ok) throw new Error();
    const template: OverlayTemplate = {
      name: 't',
      units: 'metric',
      components: [
        { ...compactHudTemplate().components[0]!, id: 'a', type: 'text', binding: { kind: 'sensor', key: 'ACCL' } } as never,
        { ...compactHudTemplate().components[0]!, id: 'b', type: 'text', binding: { kind: 'sensor', key: 'GYRO' } } as never,
      ],
    };
    const resolved = resolveTemplate(template, availabilityOf(timeline.timeline));
    expect(resolved.components.map((c) => c.id)).toEqual(['a']);
    expect(resolved.hidden[0]!.reason).toMatch(/GYRO stream is not in this recording/);
  });

  it('keeps only a still route when there is no clock', () => {
    const availability = staticAvailability(true);
    expect(resolveTemplate(routeInsetTemplate(), availability).components.map((c) => c.id)).toEqual(['route']);
    const hud = resolveTemplate(compactHudTemplate(), availability);
    expect(hud.components).toEqual([]);
    expect(hud.hidden[0]!.reason).toMatch(/no timestamps/);
    expect(resolveTemplate(routeInsetTemplate(), staticAvailability(false)).hidden.map((h) => h.component.id)).toContain('route');
  });
});

describe('metric display (AV-1003)', () => {
  it('words values the way the viewer does, in both unit systems', () => {
    expect(displayMetric('speed', 10, 'metric').text).toBe('36.0 km/h');
    expect(displayMetric('speed', 10, 'imperial').text).toBe('22.4 mph');
    expect(displayMetric('pace', 300, 'metric').text).toBe('5:00 /km');
    expect(displayMetric('distance', 1500, 'metric').text).toBe('1.50 km');
    expect(displayMetric('elapsed', 75, 'metric').text).toMatch(/1:15/);
    expect(displayMetric('heartRate', 141.6, 'metric').text).toBe('142 bpm');
    expect(displayMetric('temperature', 20, 'imperial').text).toBe('68 °F');
  });

  it('gives a gauge its needle position in display units', () => {
    expect(displayMetric('speed', 10, 'metric').value).toBeCloseTo(36, 6);
    expect(displayMetric('speed', 10, 'imperial').value).toBeCloseTo(22.37, 1);
    expect(displayMetric('elevation', 100, 'imperial').value).toBeCloseTo(328.08, 1);
  });

  it('shows a dash, with its unit, when there is no reading', () => {
    expect(displayMetric('power', undefined, 'metric')).toEqual({ text: '—', unit: 'W' });
    expect(displayMetric('speed', NaN, 'imperial')).toEqual({ text: '—', unit: 'mph' });
  });
});

describe('overlay project file (AV-1003)', () => {
  const roundTrip = (template: OverlayTemplate) => {
    const result = parseProject(serializeProject(template));
    if (!result.ok) throw new Error(result.problems.join('; '));
    return result.template;
  };

  it('round-trips every built-in template exactly', () => {
    for (const entry of BUILT_IN_TEMPLATES) {
      for (const units of ['metric', 'imperial'] as const) {
        const template = entry.create(units);
        expect(roundTrip(template)).toEqual(template);
      }
    }
  });

  it('round-trips every component type, including a sensor binding and a chart', () => {
    const { visible, box, style } = compactHudTemplate().components[0]!;
    const common = { visible, box, style };
    const template: OverlayTemplate = {
      name: 'Everything',
      units: 'imperial',
      components: [
        { ...common, id: 'a', type: 'text', binding: { kind: 'sensor', key: 'ACCL' }, label: '' },
        { ...common, id: 'b', type: 'chart', binding: { kind: 'metric', metric: 'heartRate' }, windowSeconds: 60 },
        { ...common, id: 'c', type: 'progress' },
        { ...common, id: 'd', type: 'route', lineWidth: 3, showMarker: false },
        { ...common, id: 'e', type: 'gauge', binding: { kind: 'metric', metric: 'power' }, min: 0, max: 400, label: 'Watts' },
      ],
    };
    expect(roundTrip(template)).toEqual(template);
  });

  it('holds the template and nothing about a video or an activity', () => {
    const text = serializeProject(compactHudTemplate());
    expect(JSON.parse(text)).toEqual({
      format: PROJECT_FORMAT,
      version: 1,
      template: compactHudTemplate(),
    });
    expect(text).not.toMatch(/fileName|"lat"|"lon"|timestamp/i);
  });

  it('says plainly what is wrong with a file it cannot read', () => {
    const bad = (text: string) => {
      const result = parseProject(text);
      expect(result.ok).toBe(false);
      return result.ok ? [] : result.problems.join(' | ');
    };
    expect(bad('not json')).toMatch(/not valid JSON/);
    expect(bad('[]')).toMatch(/not an OpenTrack overlay project/);
    expect(bad('{"format":"other"}')).toMatch(/not an OpenTrack overlay project/);
    expect(bad(`{"format":"${PROJECT_FORMAT}","version":2}`)).toMatch(/newer version/);
    expect(bad(`{"format":"${PROJECT_FORMAT}","version":0}`)).toMatch(/unsupported version/);
    expect(bad('x'.repeat(300_000))).toMatch(/too large/);
  });

  describe('rejecting bad values, with where they are', () => {
    const file = (mutate: (t: ReturnType<typeof compactHudTemplate>) => void) => {
      const template = compactHudTemplate();
      mutate(template);
      return JSON.stringify({ format: PROJECT_FORMAT, version: 1, template });
    };
    const problems = (text: string): string => {
      const result = parseProject(text);
      expect(result.ok).toBe(false);
      return result.ok ? '' : result.problems.join(' | ');
    };

    it.each([
      ['a box outside the frame', (t) => (t.components[0]!.box.x = 0.95), /components\[0\]\.box: must sit inside the frame/],
      ['a zero-size box', (t) => (t.components[0]!.box.width = 0), /above zero/],
      ['a negative position', (t) => (t.components[0]!.box.y = -0.1), /box\.y: must be between/],
      ['a font scale of zero', (t) => (t.components[0]!.style.fontScale = 0), /fontScale/],
      ['a non-numeric size', (t) => ((t.components[0]!.box as never as Record<string, unknown>).width = 'wide'), /box\.width: must be a number/],
      ['an unknown metric', (t) => (((t.components[0] as never as { binding: { metric: string } }).binding.metric = 'warp')), /binding\.metric: must be one of/],
      ['an unknown component type', (t) => ((t.components[0] as never as { type: string }).type = 'video'), /type: must be/],
      ['a duplicate id', (t) => (t.components[1]!.id = t.components[0]!.id), /used twice/],
      ['an empty id', (t) => (t.components[0]!.id = ''), /cannot be empty/],
      ['an unknown unit system', (t) => ((t as never as { units: string }).units = 'nautical'), /units: must be/],
      ['a script-like colour', (t) => (t.components[0]!.style.color = 'url(javascript:alert(1))'), /must be a colour/],
      ['a colour with a function', (t) => (t.components[0]!.style.backgroundColor = 'var(--x)'), /must be a colour/],
      ['an over-long name', (t) => (t.name = 'x'.repeat(200)), /at most 80/],
    ] as [string, (t: ReturnType<typeof compactHudTemplate>) => void, RegExp][])('%s', (_name, mutate, expected) => {
      expect(problems(file(mutate))).toMatch(expected);
    });

    it('rejects a gauge whose range is empty or backwards', () => {
      const template = gaugeDashboardTemplate();
      (template.components[0] as { min: number; max: number }).min = 50;
      (template.components[0] as { min: number; max: number }).max = 50;
      expect(problems(JSON.stringify({ format: PROJECT_FORMAT, version: 1, template }))).toMatch(/min must be less than max/);
    });

    it('rejects too many components', () => {
      const base = compactHudTemplate().components[0]!;
      const template = {
        name: 't',
        units: 'metric',
        components: Array.from({ length: MAX_COMPONENTS + 1 }, (_, i) => ({ ...base, id: `c${i}` })),
      };
      expect(problems(JSON.stringify({ format: PROJECT_FORMAT, version: 1, template }))).toMatch(/at most 50/);
    });

    it('reports no more than a handful of problems', () => {
      const template = compactHudTemplate();
      template.components.forEach((c) => {
        c.box.x = 5;
        c.box.y = 5;
        c.style.fontScale = 99;
      });
      const result = parseProject(JSON.stringify({ format: PROJECT_FORMAT, version: 1, template }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.length).toBeLessThanOrEqual(10);
    });
  });

  it('drops properties it does not know instead of carrying them along', () => {
    const template = compactHudTemplate();
    const raw = JSON.parse(JSON.stringify({ format: PROJECT_FORMAT, version: 1, template }));
    raw.template.components[0].onclick = 'alert(1)';
    raw.template.components[0].style.extra = 'x';
    raw.extra = 1;
    const result = parseProject(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template).toEqual(template);
      expect('onclick' in result.template.components[0]!).toBe(false);
    }
  });

  it('is not poisoned by a __proto__ key', () => {
    // JSON.parse makes this an own property, which is the dangerous case.
    const text = serializeProject(compactHudTemplate()).replace(
      '{\n  "format"',
      '{\n  "__proto__": {"polluted": true},\n  "format"',
    );
    expect(text).toContain('"__proto__"');
    const result = parseProject(text);
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('accepts the ordinary ways of writing a colour', () => {
    for (const color of ['#fff', '#ffd166', '#ffd16680', 'white', 'rgb(255, 0, 0)', 'rgba(0,0,0,0.5)', 'hsl(120, 50%, 50%)', 'transparent']) {
      const template = compactHudTemplate();
      template.components[0]!.style.color = color;
      expect(parseProject(serializeProject(template)).ok).toBe(true);
    }
  });
});
