import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { canvasTemplate } from '../customCanvas';
import { buildOverlayTimeline } from '../timeline';
import type { OverlayComponent, OverlayFigureSetting } from '../template';
import { makeActivity } from '../../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const activity = makeActivity(
  Array.from({ length: 11 }, (_, i) => ({
    time: at(i),
    lat: 10 + i * 0.001,
    lon: 20 + i * 0.001,
    distanceMeters: i * 10,
    speedMetersPerSecond: i,
    heartRateBpm: 100 + i,
  })),
);

interface Painted {
  op: string;
  args: unknown[];
  font: string;
  fillStyle: unknown;
  globalAlpha: unknown;
  textAlign: unknown;
  shadowColor: unknown;
  shadowBlur: unknown;
}

/** Records every call with the state it was made in, instead of drawing. */
function recorder() {
  const calls: Painted[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000', globalAlpha: 1, textAlign: 'start', shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0 };
  const ctx = new Proxy(state, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : (...args: unknown[]) => {
            calls.push({ op: key, args, font: String(state.font), fillStyle: state.fillStyle, globalAlpha: state.globalAlpha, textAlign: state.textAlign, shadowColor: state.shadowColor, shadowBlur: state.shadowBlur });
          },
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as OverlayContext2D;
  return { ctx, calls, texts: () => calls.filter((call) => call.op === 'fillText') };
}

const figureComponent = (over: Partial<OverlayComponent> = {}): OverlayComponent => ({
  id: 'speed',
  type: 'text',
  visible: true,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
  unitMode: 'auto',
  style: { backgroundOpacity: 0 },
  source: { kind: 'metric', metric: 'speed' },
  ...over,
});

function draw(component: OverlayComponent, size = { width: 2000, height: 1000 }) {
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 10 } });
  const renderer = createOverlayRenderer({ template: canvasTemplate([component]), timeline, activity, units: 'metric', ...size });
  const recording = recorder();
  renderer.drawFrame(recording.ctx, 5);
  return { ...recording, ...size };
}
const withFigure = (figure: OverlayFigureSetting, over: Partial<OverlayComponent> = {}) => figureComponent({ figure, ...over });
const size = (call: Painted) => Number(/([\d.]+)px/.exec(call.font)![1]);

describe('a figure drawn with its own settings (AV-1015, TD-083)', () => {
  it('draws a figure with no settings as it always was: left, label at 75 %, value bold, the halo black at 80 %', () => {
    const { texts, width } = draw(figureComponent());
    const [label, value] = texts();
    const em = 0.022 * width;
    expect(label).toMatchObject({ args: ['SPEED', 0.1 * width + 0.6 * em, 0.1 * 1000 + Math.max(0.3 * em, (200 - (0.55 * em * 1.2 + 1.1 * em * 1.1)) / 2)], textAlign: 'left', fillStyle: '#ffffff', globalAlpha: 0.75, shadowColor: 'rgb(0 0 0 / 0.8)' });
    expect(label!.shadowBlur).toBeCloseTo(0.2 * em, 6);
    expect(size(label!)).toBeCloseTo(0.55 * em, 6);
    expect(value).toMatchObject({ args: ['18.0 km/h', label!.args[1], (label!.args[2] as number) + 0.55 * em * 1.2], textAlign: 'left', fillStyle: '#ffffff', globalAlpha: 1 });
    expect(value!.font).toMatch(/^bold /);
    expect(size(value!)).toBeCloseTo(1.1 * em, 6);
  });

  it('gives each line its own size and colour, and keeps the value in the text colour', () => {
    const { texts, width } = draw(withFigure({ labelScale: 2, valueScale: 0.5, labelColor: '#ff0000' }, { style: { backgroundOpacity: 0, textColor: '#00ff00' } }));
    const [label, value] = texts();
    const em = 0.022 * width;
    expect(size(label!)).toBeCloseTo(0.55 * em * 2, 6);
    expect(size(value!)).toBeCloseTo(1.1 * em * 0.5, 6);
    expect(label!.fillStyle).toBe('#ff0000');
    expect(label!.globalAlpha).toBe(0.75);
    expect(value!.fillStyle).toBe('#00ff00');
  });

  it('falls back to the text colour for the label when it has none of its own', () => {
    const { texts } = draw(figureComponent({ style: { backgroundOpacity: 0, textColor: '#123456' } }));
    expect(texts().map((call) => call.fillStyle)).toEqual(['#123456', '#123456']);
  });

  it('puts the label and the value a set distance apart, in frame widths', () => {
    const near = draw(withFigure({ gap: 0 })).texts();
    const far = draw(withFigure({ gap: 0.05 })).texts();
    const em = 0.022 * 2000;
    const apart = (calls: Painted[]) => (calls[1]!.args[2] as number) - (calls[0]!.args[2] as number);
    expect(apart(near)).toBeCloseTo(0.55 * em, 6);
    expect(apart(far)).toBeCloseTo(0.55 * em + 0.05 * 2000, 6);
    // Spacing scales with the picture: the same share of a frame twice as wide is twice the distance.
    const wide = draw(withFigure({ gap: 0.05 }), { width: 4000, height: 2000 }).texts();
    expect(apart(wide)).toBeCloseTo(2 * apart(far), 6);
  });

  it('aligns both lines to the left, the middle or the right of the box', () => {
    const box = { x: 0.1 * 2000, w: 0.3 * 2000 };
    const em = 0.022 * 2000;
    const x = (align: 'left' | 'center' | 'right') => draw(withFigure({ align })).texts().map((call) => [call.textAlign, call.args[1]]);
    expect(x('left')).toEqual([['left', box.x + 0.6 * em], ['left', box.x + 0.6 * em]]);
    expect(x('center')).toEqual([['center', box.x + box.w / 2], ['center', box.x + box.w / 2]]);
    expect(x('right')).toEqual([['right', box.x + box.w - 0.6 * em], ['right', box.x + box.w - 0.6 * em]]);
  });

  it('draws only the value, centred in the box’s height, when the label is hidden', () => {
    const { texts, width } = draw(withFigure({ showLabel: false }));
    const em = 0.022 * width;
    expect(texts().map((call) => call.args[0])).toEqual(['18.0 km/h']);
    expect(texts()[0]!.args[2]).toBeCloseTo(100 + (200 - 1.1 * em * 1.1) / 2, 6);
  });

  it('keeps a gauge’s track, full width, under the value whatever the alignment', () => {
    const gauge = withFigure({ align: 'right', showLabel: false }, { type: 'gauge', range: { min: 0, max: 20 } });
    const { calls, width } = draw(gauge);
    const em = 0.022 * width;
    const track = calls.filter((call) => call.op === 'fillRect');
    expect(track).toHaveLength(2);
    expect(track.map((call) => [call.shadowColor, call.shadowBlur])).toEqual([['transparent', 0], ['transparent', 0]]);
    // The box's inset either side, whichever way the text is aligned; the fill is 5 of 20 m/s.
    expect(track[0]!.args[0]).toBeCloseTo(0.1 * width + 0.6 * em, 6);
    expect(track[0]!.args[2]).toBeCloseTo(0.3 * width - 1.2 * em, 6);
    expect(track[1]!.args[2]).toBeCloseTo((0.3 * width - 1.2 * em) * 0.25, 6);
  });

  it('takes the halo’s colour and opacity, only on a clear background, and none at 0 %', () => {
    const halo = (opacity: number, background = 0) =>
      draw(withFigure({ halo: { color: '#336699', opacity } }, { style: { backgroundOpacity: background } })).texts().map((call) => [call.shadowColor, call.shadowBlur]);
    const em = 0.022 * 2000;
    expect(halo(0.5).map(([colour]) => colour)).toEqual(['rgb(51 102 153 / 0.5)', 'rgb(51 102 153 / 0.5)']);
    expect(halo(0.5)[0]![1]).toBeCloseTo(0.2 * em, 6);
    // At 0 % no shadow is set at all: the context's own, and no blur.
    expect(halo(0).map(([colour, blur]) => [colour, blur])).toEqual([['rgba(0, 0, 0, 0)', 0], ['rgba(0, 0, 0, 0)', 0]]);
    // As before, a background of 30 % or more draws no halo.
    expect(halo(0.5, 0.5)).toEqual([['rgba(0, 0, 0, 0)', 0], ['rgba(0, 0, 0, 0)', 0]]);
  });

  it('draws the same settings on a gauge and a text, and none on other components', () => {
    const gauge = draw(withFigure({ labelColor: '#ff0000' }, { type: 'gauge', range: { min: 0, max: 20 } }));
    expect(gauge.texts()[0]!.fillStyle).toBe('#ff0000');
    const other = draw(figureComponent({ type: 'progress', source: undefined, figure: { labelColor: '#ff0000' } }));
    expect(other.texts()).toEqual([]);
  });

  it('paints nothing past the frame’s edge when the text is too big for its box: the box is clipped, inside the frame', () => {
    const { calls, width, height } = draw(
      withFigure({ labelScale: 10, valueScale: 10, align: 'right' }, { rect: { x: 0.8, y: 0.8, width: 0.2, height: 0.2 } }),
    );
    const firstText = calls.findIndex((call) => call.op === 'fillText');
    const clip = calls.findIndex((call) => call.op === 'clip');
    expect(clip).toBeGreaterThanOrEqual(0);
    expect(clip).toBeLessThan(firstText);
    // The clip is the component's own box, and the box ends at the frame's edge.
    const boxes = calls.slice(0, clip).filter((call) => call.op === 'roundRect' || call.op === 'rect' || call.op === 'arcTo');
    expect(boxes.length).toBeGreaterThan(0);
    const [x, y, w, h] = (boxes.find((call) => call.op === 'roundRect')?.args ?? [0.8 * width, 0.8 * height, 0.2 * width, 0.2 * height]) as number[];
    expect(x! + w!).toBeLessThanOrEqual(width + 1e-6);
    expect(y! + h!).toBeLessThanOrEqual(height + 1e-6);
    // Every text is drawn inside that clip: save came before it and restore after the last.
    const restore = calls.map((call) => call.op).lastIndexOf('restore');
    expect(restore).toBeGreaterThan(calls.map((call) => call.op).lastIndexOf('fillText'));
  });
});
