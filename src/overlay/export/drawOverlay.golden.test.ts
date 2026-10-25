import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, overlayCatalog, type OverlayControls } from '../presets';
import { DEFAULT_OVERLAY_STYLE as DEFAULT_OVERLAY_TEMPLATE_STYLE, type OverlayComponent } from '../template';
import type { OverlayMetricKey } from '../timeline';
import { buildOverlayTimeline } from '../timeline';
import { parseGpx } from '../../parsers/gpx/parseGpx';
import { readFixture } from '../../test/helpers/fixtures';

/**
 * AV-1008. Deterministic render tests: the overlay drawn at fixed timestamps of
 * the committed ride, compared with committed goldens.
 *
 * What is compared is the *display list* — every canvas call, with its
 * arguments and the colour, font and alpha in force — not pixels. Pixels depend
 * on the platform's fonts and anti-aliasing and would differ between a Mac and
 * a CI runner; the display list is a pure function of the template, the
 * activity and the time, so it is the same everywhere. (The browser tests read
 * real pixels, for what pixels can safely say: where it is transparent and
 * where it is not.)
 *
 * A change to the drawing shows up as a diff in `__golden__/`. If it is
 * intended, regenerate with `npx vitest run -u` and review the diff.
 */
const ride = parseGpx(readFixture('overlay-ride.gpx'), { fileName: 'overlay-ride.gpx', idFactory: () => 'ride' });
const clip = { durationSeconds: 6 };
const timeline = buildOverlayTimeline(ride, { video: clip });

const round = (value: unknown): string =>
  typeof value === 'number' ? String(Math.round(value * 100) / 100) : JSON.stringify(value);

/** Records every call on a context as one stable line of text. */
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
    // AV-1011. A fixed width per character, so a text's layout is the same on every machine.
    measureText: (text: string) => ({ width: text.length * Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10) * 0.55 }),
  };
  const stateful = new Set(['fillText', 'fillRect', 'fill', 'stroke', 'arc']);
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        const call = `${key}(${args.map(round).join(', ')})`;
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

function golden(controls: Partial<OverlayControls>, at: number, size: [number, number] = [1280, 720]) {
  const [width, height] = size;
  const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS, ...controls }, timeline, width / height);
  const renderer = createOverlayRenderer({ template, timeline, activity: ride, units: 'metric', width, height });
  return displayList((ctx) => renderer.drawFrame(ctx, at));
}

const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
const snapshot = (name: string) => `./__golden__/${name}.txt`;

describe('overlay render goldens (AV-1008)', () => {
  describe.each([
    ['metric-strip', 'metric-strip'],
    ['compact-hud', 'compact-hud'],
    ['route-inset', 'route-inset'],
  ] as const)('%s', (name, presetId) => {
    it.each([0, 2.5, 5])('at %s s', async (seconds) => {
      await expect(golden({ presetId }, seconds)).toMatchFileSnapshot(snapshot(`${name}-t${String(seconds).replace('.', '_')}`));
    });
  });

  it('draws every component at once, at 5 s', async () => {
    await expect(golden({ enabled: everything }, 5)).toMatchFileSnapshot(snapshot('everything-t5'));
  });

  it('draws a portrait frame with shorter tiles, at 2.5 s', async () => {
    await expect(golden({ presetId: 'compact-hud', enabled: everything }, 2.5, [720, 1280])).toMatchFileSnapshot(
      snapshot('compact-hud-portrait-t2_5'),
    );
  });

  it('draws imperial units, at 5 s', async () => {
    await expect(golden({ unitMode: 'imperial' }, 5)).toMatchFileSnapshot(snapshot('metric-strip-imperial-t5'));
  });

  it('draws nothing but the clear outside the ride, so the frame stays transparent', async () => {
    const outside = golden({}, 99);
    expect(outside).toBe('clearRect(0, 0, 1280, 720)\n');
    await expect(outside).toMatchFileSnapshot(snapshot('outside-the-ride'));
  });

  it('is the same every time it is drawn: a pure function of template, data and time', () => {
    expect(golden({ enabled: everything }, 3.25)).toBe(golden({ enabled: everything }, 3.25));
    // And the frames either side of it differ, so the goldens are not blind to time.
    expect(golden({}, 3.25)).not.toBe(golden({}, 3.5));
  });

  it('states the values of the formulae at the timestamps the goldens use', () => {
    // 4 + 0.2 t m/s at 5 s is 5 m/s, 18.0 km/h; heart rate 100 + t.
    const list = golden({}, 5);
    expect(list).toContain('fillText("18.0 km/h"');
    expect(list).toContain('fillText("105 bpm"');
    expect(list).toContain('fillText("105 m"');
    expect(list).toContain('fillText("0:05"');
  });
});

describe('custom canvas render goldens (AV-1011)', () => {
  const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const shape = (id: string, kind: 'roundedRect' | 'rect' | 'ellipse' | 'line', rect: ReturnType<typeof at>): OverlayComponent => ({
    id,
    type: 'shape',
    visible: true,
    rect,
    unitMode: 'auto',
    style: {},
    shape: { kind, fill: '#102030', fillOpacity: 0.5, stroke: '#ffcc00', strokeOpacity: 0.8, strokeWidth: 0.01, radius: 0.03 },
  });
  const figure = (id: string, metric: OverlayMetricKey, rect: ReturnType<typeof at>, extra: Partial<OverlayComponent> = {}): OverlayComponent => ({
    id,
    type: 'text',
    visible: true,
    rect,
    unitMode: 'auto',
    style: {},
    source: { kind: 'metric', metric },
    ...extra,
  });
  const custom = (components: OverlayComponent[], seconds: number, size: [number, number] = [1280, 720]) => {
    const [width, height] = size;
    const template = { version: 2 as const, name: 'Custom', style: DEFAULT_OVERLAY_TEMPLATE_STYLE, components };
    const renderer = createOverlayRenderer({ template, timeline, activity: ride, units: 'metric', width, height, readerTimeZone: 'UTC' });
    return displayList((ctx) => renderer.drawFrame(ctx, seconds));
  };

  it('draws each shape: a rounded rectangle, a rectangle, an ellipse and a line', async () => {
    const list = custom(
      [
        shape('rounded', 'roundedRect', at(0.05, 0.05, 0.3, 0.2)),
        shape('square', 'rect', at(0.4, 0.05, 0.2, 0.2)),
        shape('round', 'ellipse', at(0.65, 0.05, 0.3, 0.2)),
        shape('rule', 'line', at(0.05, 0.4, 0.9, 0.05)),
      ],
      5,
    );
    expect(list).toContain('roundRect(');
    expect(list).toContain('ellipse(');
    expect(list).toContain('lineTo(');
    await expect(list).toMatchFileSnapshot(snapshot('custom-shapes-t5'));
  });

  it('draws each data component bound to the timeline, with its label and format', async () => {
    const list = custom(
      [
        figure('speed', 'speed', at(0.02, 0.02, 0.2, 0.12)),
        figure('pace', 'pace', at(0.24, 0.02, 0.2, 0.12)),
        figure('distance', 'distance', at(0.46, 0.02, 0.2, 0.12), { display: { label: 'Ridden', decimals: 2 } }),
        figure('elapsed', 'elapsed', at(0.68, 0.02, 0.2, 0.12)),
        figure('moving', 'moving', at(0.02, 0.2, 0.2, 0.12)),
        figure('speed-gauge', 'speed', at(0.24, 0.2, 0.2, 0.12), { type: 'gauge', range: { min: 0, max: 10 } }),
        figure('hr', 'heartRate', at(0.46, 0.2, 0.2, 0.12), { type: 'gauge', range: { min: 50, max: 200 } }),
        { id: 'route', type: 'routeInset', visible: true, rect: at(0.7, 0.2, 0.25, 0.4), unitMode: 'auto', style: {} },
        { id: 'progress', type: 'progress', visible: true, rect: at(0.02, 0.9, 0.96, 0.02), unitMode: 'auto', style: {} },
      ],
      5,
    );
    expect(list).toContain('fillText("RIDDEN"');
    expect(list).toContain('fillText("0.02 km"'); // 22 m, to two places
    expect(list).toContain('fillText("MOVING TIME"');
    await expect(list).toMatchFileSnapshot(snapshot('custom-data-t5'));
  });

  it('draws shapes and texts for the whole activity where the activity does not reach, and its figures only where it does', () => {
    // A two-minute video, the minute-long ride starting 30 s in: it covers 30 s to 90 s.
    const late = buildOverlayTimeline(ride, { video: { durationSeconds: 120 }, offsetSeconds: 30 });
    expect([late.sampleAt(10), late.sampleAt(60), late.sampleAt(100)].map(Boolean)).toEqual([false, true, false]);
    const card = shape('card', 'rect', at(0.05, 0.05, 0.3, 0.2));
    const title: OverlayComponent = { id: 'title', type: 'label', visible: true, rect: at(0.05, 0.3, 0.01, 0.01), unitMode: 'auto', style: {}, content: 'Day 1', text: { align: 'left', weight: 'bold' } };
    const speed = figure('speed', 'speed', at(0.5, 0.05, 0.2, 0.12));
    const draw = (components: OverlayComponent[], seconds: number) => {
      const template = { version: 2 as const, name: 'Custom', style: DEFAULT_OVERLAY_TEMPLATE_STYLE, components };
      const renderer = createOverlayRenderer({ template, timeline: late, activity: ride, units: 'metric', width: 1280, height: 720, readerTimeZone: 'UTC' });
      return displayList((ctx) => renderer.drawFrame(ctx, seconds));
    };
    for (const seconds of [10, 60, 100]) {
      const list = draw([card, title, speed], seconds);
      expect(list, `${seconds} s`).toContain('fill() fill="#102030"');
      expect(list, `${seconds} s`).toContain('fillText("Day 1"');
      expect(list.includes('km/h'), `${seconds} s`).toBe(seconds === 60);
    }
    // With shapes and texts alone, a frame the activity does not reach is the same as one it does.
    expect(draw([card, title], 10)).toBe(draw([card, title], 60));
  });

  it('draws the still image’s text, figure and date on the canvas, the same in every frame', async () => {
    const still: OverlayComponent[] = [
      { id: 'text', type: 'label', visible: true, rect: at(0.05, 0.05, 0.01, 0.01), unitMode: 'auto', style: { fontScale: 2 }, content: 'Day 1', text: { align: 'left', weight: 'bold' } },
      { id: 'sum', type: 'summary', visible: true, rect: at(0.05, 0.3, 0.01, 0.01), unitMode: 'auto', style: {}, summary: { stat: 'distance' }, text: { align: 'left', weight: 'bold', caption: true } },
      { id: 'date', type: 'date', visible: true, rect: at(0.99, 0.99, 0.01, 0.01), unitMode: 'auto', style: {}, date: { format: 'iso', withTime: true, timeZone: 'reader' }, text: { align: 'right', weight: 'normal' } },
    ];
    const list = custom(still, 1);
    expect(list).toContain('fillText("Day 1"');
    expect(list).toContain('fillText("DISTANCE"');
    expect(custom(still, 4)).toBe(list);
    await expect(list).toMatchFileSnapshot(snapshot('custom-still-t1'));
  });
});
