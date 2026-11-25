import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { canvasTemplate, newSplitsComponent } from '../customCanvas';
import { buildOverlayTimeline } from '../timeline';
import { DEFAULT_SPLITS } from '../splits';
import type { OverlayComponent, OverlaySplitsSetting } from '../template';
import { makeActivity } from '../../test/helpers/activity';

/** AV-1021 (TD-090). The splits component drawn by the one renderer. */

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const SIZE = { width: 2000, height: 1000 };
// 5 m/s for the first 300 s, then 4 m/s to 600 s: 1500 m, then 1200 m more. A split every 500 m: 100 s each, then 125 s.
const activity = {
  ...makeActivity(
    Array.from({ length: 61 }, (_, i) => ({
      time: at(i * 10),
      lat: 10 + (i <= 30 ? 5 * i * 10 : 1500 + 4 * (i - 30) * 10) / 111_194.93,
      lon: 20,
      distanceMeters: i <= 30 ? 5 * i * 10 : 1500 + 4 * (i - 30) * 10,
    })),
  ),
};
const timeline = buildOverlayTimeline({ ...activity, metadata: { ...activity.metadata, sport: 'running' } }, { video: { durationSeconds: 600 } });
const FASTER = '#4ade80';
const SLOWER = '#f87171';

interface Call {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  globalAlpha: unknown;
  font: string;
  shadowColor: unknown;
  textAlign: unknown;
}

function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000', globalAlpha: 1, shadowColor: 'rgba(0, 0, 0, 0)', textAlign: 'start' };
  const ctx = new Proxy(state, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : (...args: unknown[]) => {
            calls.push({ op: key, args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha, font: String(state.font), shadowColor: state.shadowColor, textAlign: state.textAlign });
          },
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as OverlayContext2D;
  return { ctx, calls, texts: () => calls.filter((call) => call.op === 'fillText') };
}

function splits(over: Partial<OverlaySplitsSetting> = {}, extra: Partial<OverlayComponent> = {}): OverlayComponent {
  const base = newSplitsComponent(canvasTemplate([]), SIZE);
  return { ...base, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.6 }, style: { backgroundOpacity: 0 }, splits: { ...DEFAULT_SPLITS, source: 'distance', every: 500, ...over }, ...extra };
}

function draw(component: OverlayComponent, seconds: number, units: 'metric' | 'imperial' = 'metric') {
  const renderer = createOverlayRenderer({ template: canvasTemplate([component]), timeline, activity: { ...activity, metadata: { ...activity.metadata, sport: 'running' } }, units, ...SIZE });
  const recording = recorder();
  renderer.drawFrame(recording.ctx, seconds);
  return recording;
}

const strings = (recording: ReturnType<typeof recorder>) => recording.texts().map((call) => call.args[0]);
const BOX = { x: 200, y: 100, w: 600, h: 600 };

describe('splits drawn', () => {
  it('writes the split under way over its time so far, with its pace', () => {
    expect(strings(draw(splits(), 50))).toEqual(['SPLIT 1', '0:50', '3:20 /km']);
  });

  it('writes the last finished split, in the colour of how it went, and says so in words', () => {
    // At 450 s the fourth split (125 s, 4 m/s) has ended: slower than the third (100 s).
    const recording = draw(splits(), 450);
    expect(strings(recording)).toEqual(['SPLIT 5', '0:25', '4:10 /km', 'SPLIT 4 · SLOWER', '2:05', '4:10 /km']);
    const byText = (text: string) => recording.texts().find((call) => call.args[0] === text)!;
    expect(byText('2:05').fillStyle).toBe(SLOWER);
    // The pace, which both the split under way and the last one write alike, is in each one's colour.
    expect(recording.texts().filter((call) => call.args[0] === '4:10 /km').map((call) => call.fillStyle)).toEqual(['#ffffff', SLOWER]);
    // The split under way, and a split that was the same as the one before, are in the text colour.
    expect(byText('0:25').fillStyle).toBe('#ffffff');
    expect(draw(splits(), 250).texts().find((call) => call.args[0] === '1:40')!.fillStyle).toBe('#ffffff');
  });

  it('writes faster splits in the faster colour, and the colours are the reader’s', () => {
    // 4 m/s for 150 s (600 m), then 6 m/s for 150 s: a split every 600 m takes 150 s, then 100 s.
    const quicker = makeActivity(Array.from({ length: 31 }, (_, i) => ({ time: at(i * 10), lat: 10, lon: 20, distanceMeters: i <= 15 ? 40 * i : 600 + 60 * (i - 15) })));
    const line = buildOverlayTimeline(quicker, { video: { durationSeconds: 300 } });
    const draws = (setting: Partial<OverlaySplitsSetting>) => {
      const renderer = createOverlayRenderer({ template: canvasTemplate([splits({ every: 600, ...setting })]), timeline: line, activity: quicker, units: 'metric', ...SIZE });
      const recording = recorder();
      renderer.drawFrame(recording.ctx, 260);
      return recording;
    };
    const defaults = draws({});
    expect(strings(defaults)).toContain('SPLIT 2 · FASTER');
    expect(defaults.texts().find((call) => call.args[0] === '1:40')!.fillStyle).toBe(FASTER);
    const own = draws({ fasterColor: '#00ff00', slowerColor: '#ff00ff' });
    expect(own.texts().find((call) => call.args[0] === '1:40')!.fillStyle).toBe('#00ff00');
  });

  it('writes no word, and the text colour, for the first split and for a split that was the same', () => {
    const first = draw(splits(), 150);
    expect(strings(first)).toEqual(['SPLIT 2', '0:50', '3:20 /km', 'SPLIT 1', '1:40', '3:20 /km']);
    expect(first.texts().every((call) => call.fillStyle === '#ffffff' || String(call.args[0]).startsWith('SPLIT'))).toBe(true);
  });

  it('lists the last N, newest first, each with its number, its time and its pace', () => {
    const recording = draw(splits({ list: 3, showLast: false }), 450);
    expect(strings(recording)).toEqual(['SPLIT 5', '0:25', '4:10 /km', '4', '2:05', '4:10 /km', '3', '1:40', '3:20 /km', '2', '1:40', '3:20 /km']);
    expect(recording.texts().find((call) => call.args[0] === '2:05')!.fillStyle).toBe(SLOWER);
  });

  it('writes pace, average speed or neither, in the reader’s units', () => {
    expect(strings(draw(splits({ rate: 'speed' }), 450)).slice(0, 3)).toEqual(['SPLIT 5', '0:25', '14.4 km/h']);
    expect(strings(draw(splits({ rate: 'speed' }), 450, 'imperial')).slice(2, 3)).toEqual(['8.9 mph']);
    expect(strings(draw(splits({ rate: 'none' }), 450))).toEqual(['SPLIT 5', '0:25', 'SPLIT 4 · SLOWER', '2:05']);
    // A run with no rate chosen reads pace; the sport is the activity's.
    expect(strings(draw(splits({ rate: undefined }), 50))).toEqual(['SPLIT 1', '0:50', '3:20 /km']);
  });

  it('draws the splits of the other clock: a split by elapsed time holds what moving time would', () => {
    expect(strings(draw(splits({ time: 'elapsed' }), 50)).slice(0, 2)).toEqual(['SPLIT 1', '0:50']);
  });

  it('honours the label’s settings: hidden, its own text, its colour and size, and the halo', () => {
    expect(strings(draw(splits({}, { figure: { showLabel: false } }), 450)).filter((text) => String(text).startsWith('SPLIT'))).toEqual([]);
    expect(strings(draw(splits({}, { display: { label: 'Lap' } }), 450)).filter((text) => String(text).startsWith('LAP'))).toEqual(['LAP 5', 'LAP 4 · SLOWER']);
    const styled = draw(splits({}, { figure: { labelColor: '#ff0000', labelScale: 2 } }), 50);
    const label = styled.texts().find((call) => call.args[0] === 'SPLIT 1')!;
    expect(label.fillStyle).toBe('#ff0000');
    expect(Number(/([\d.]+)px/.exec(label.font)![1])).toBeCloseTo(0.55 * 0.022 * 2000 * 2, 6);
    // With a clear background the type has the halo, and a halo of opacity 0 turns it off.
    expect(draw(splits({}, { style: { backgroundOpacity: 0 } }), 50).texts()[0]!.shadowColor).toBe('rgb(0 0 0 / 0.8)');
    expect(draw(splits({}, { style: { backgroundOpacity: 0 }, figure: { halo: { color: '#000000', opacity: 0 } } }), 50).texts()[0]!.shadowColor).not.toBe('rgb(0 0 0 / 0.8)');
    expect(draw(splits({}, { style: { backgroundOpacity: 0.8 } }), 50).texts()[0]!.shadowColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('stays inside its box: it clips to it, and every line is written inside it', () => {
    const recording = draw(splits({ list: 10 }), 560);
    const { calls } = recording;
    expect(calls.findIndex((call) => call.op === 'clip')).toBeGreaterThanOrEqual(0);
    expect(calls.find((call) => call.op === 'roundRect')!.args.slice(0, 4)).toEqual([BOX.x, BOX.y, BOX.w, BOX.h]);
    const fonts = (call: Call) => Number(/([\d.]+)px/.exec(call.font)![1]);
    for (const call of recording.texts()) {
      const y = call.args[2] as number;
      expect(y).toBeGreaterThanOrEqual(BOX.y);
      expect(y + fonts(call)).toBeLessThanOrEqual(BOX.y + BOX.h + 1);
      // Each line is given a width to fit in, inside the box.
      expect(call.args[3] as number).toBeLessThanOrEqual(BOX.w);
    }
  });

  it('lists no more than fits: a list in a short box is cut, never drawn beyond it', () => {
    const recording = draw(splits({ list: 10 }, { rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.12 } }), 590);
    const rows = recording.texts().filter((call) => /^\d+$/.test(String(call.args[0])));
    expect(rows.length).toBeLessThan(10);
    for (const call of rows) expect(call.args[2] as number).toBeLessThanOrEqual(100 + 120);
  });

  it('draws nothing where the activity has no splits, and the background only where there is none to show', () => {
    const bare = buildOverlayTimeline(makeActivity([{ time: at(0) }, { time: at(10) }]), { video: { durationSeconds: 10 } });
    const renderer = createOverlayRenderer({ template: canvasTemplate([splits({}, { style: { backgroundOpacity: 0.5 } })]), timeline: bare, activity: undefined, units: 'metric', ...SIZE });
    const recording = recorder();
    renderer.drawFrame(recording.ctx, 5);
    expect(recording.calls.filter((call) => call.op === 'fill' || call.op === 'fillText')).toEqual([]);
  });

  it('is the same picture for the same time, and different for another', () => {
    const a = strings(draw(splits({ list: 2 }), 333));
    expect(strings(draw(splits({ list: 2 }), 333))).toEqual(a);
    expect(strings(draw(splits({ list: 2 }), 334))).not.toEqual(a);
  });

  it('finds the splits once per renderer: a later frame costs a lookup, not another pass', () => {
    let reads = 0;
    const counted = { ...timeline, splitStreams: () => (reads += 1, timeline.splitStreams!()) };
    const renderer = createOverlayRenderer({ template: canvasTemplate([splits({ list: 2 }), { ...splits(), id: 'again' }]), timeline: counted, activity, units: 'metric', ...SIZE });
    for (const t of [10, 150, 450, 599]) renderer.drawFrame(recorder().ctx, t);
    expect(reads).toBe(1);
  });

  it('draws with the faster colour by default being a green and the slower a red', () => {
    expect(DEFAULT_SPLITS.fasterColor).toBe(FASTER);
    expect(DEFAULT_SPLITS.slowerColor).toBe(SLOWER);
  });
});
