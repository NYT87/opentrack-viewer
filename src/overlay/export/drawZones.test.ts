import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { canvasTemplate, newZonesComponent } from '../customCanvas';
import { buildOverlayTimeline } from '../timeline';
import { defaultZones } from '../zones';
import type { OverlayComponent, PersonalFigures, ZonesShape } from '../template';
import { makeActivity } from '../../test/helpers/activity';

/** AV-1018 (TD-086). The zones component drawn by the one renderer, a test for each shape. */

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
// Heart rate 100 + 10 a second, moving at 5 m/s throughout: 150 bpm at 5 s.
const activity = makeActivity(
  Array.from({ length: 11 }, (_, i) => ({
    time: at(i),
    lat: 10 + i * 0.001,
    lon: 20,
    distanceMeters: i * 5,
    speedMetersPerSecond: 5,
    heartRateBpm: 100 + 10 * i,
    powerWatts: 100 + 20 * i,
  })),
);
const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 10 } });
const COLORS = defaultZones('heartRate').map((zone) => zone.color);
const SIZE = { width: 2000, height: 1000 };

interface Call {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  globalAlpha: unknown;
  font: string;
  shadowColor: unknown;
  lineWidth: unknown;
}

function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, shadowColor: 'rgba(0, 0, 0, 0)', lineWidth: 1, textAlign: 'start' };
  const ctx = new Proxy(state, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : (...args: unknown[]) => {
            calls.push({ op: key, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, globalAlpha: state.globalAlpha, font: String(state.font), shadowColor: state.shadowColor, lineWidth: state.lineWidth });
          },
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as OverlayContext2D;
  const of = (op: string) => calls.filter((call) => call.op === op);
  return { ctx, calls, of };
}

function zones(shape: ZonesShape, over: Partial<NonNullable<OverlayComponent['zones']>> = {}, extra: Partial<OverlayComponent> = {}): OverlayComponent {
  const base = newZonesComponent(canvasTemplate([]), 'heartRate', SIZE);
  return {
    ...base,
    rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
    style: { backgroundOpacity: 0 },
    zones: { ...base.zones!, shape, ...over },
    ...extra,
  };
}

function draw(component: OverlayComponent, personal: PersonalFigures | null = { maxHeartRate: 200 }, seconds = 5) {
  const renderer = createOverlayRenderer({ template: canvasTemplate([component]), timeline, activity, units: 'metric', ...SIZE, personal: personal ?? undefined });
  const recording = recorder();
  renderer.drawFrame(recording.ctx, seconds);
  return recording;
}

const BOX = { x: 200, y: 100, w: 800, h: 300 };
const colorOf = (call: Call) => String(call.fillStyle);

describe('a zones bar drawn horizontally', () => {
  it('draws a segment for each zone in its colour, the current one bright and the others dimmed', () => {
    const { of } = draw(zones('horizontal'));
    const segments = of('fillRect').filter((call) => COLORS.includes(colorOf(call)));
    expect(segments.map(colorOf)).toEqual(COLORS);
    // 150 bpm of 200 is in the third zone.
    expect(segments.map((call) => call.globalAlpha)).toEqual([0.35, 0.35, 1, 0.35, 0.35]);
    // Left to right, the same size, side by side.
    const xs = segments.map((call) => call.args[0] as number);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(segments.map((call) => Math.round((call.args[2] as number) * 1000))).size).toBe(1);
  });

  it('puts a marker at the value’s place in its zone: half way through the third', () => {
    const { of } = draw(zones('horizontal'));
    const segments = of('fillRect').filter((call) => COLORS.includes(colorOf(call)));
    const [x, , w] = segments[2]!.args as number[];
    const marker = of('fillRect').find((call) => colorOf(call) === '#ffffff')!;
    const centre = (marker.args[0] as number) + (marker.args[2] as number) / 2;
    expect(centre).toBeCloseTo(x! + 0.5 * w!, 5);
  });

  it('writes the zone’s number and name, and the value', () => {
    const { of } = draw(zones('horizontal'));
    expect(of('fillText').map((call) => call.args[0])).toEqual(['Z3 Tempo', '150 bpm']);
  });

  it('writes what is asked and no more', () => {
    const texts = (show: Partial<{ number: boolean; name: boolean; value: boolean }>) =>
      draw(zones('horizontal', { show: { number: true, name: true, value: true, timeInZone: false, ...show } }))
        .of('fillText')
        .map((call) => call.args[0]);
    expect(texts({ number: false })).toEqual(['Tempo', '150 bpm']);
    expect(texts({ name: false })).toEqual(['Z3', '150 bpm']);
    expect(texts({ value: false })).toEqual(['Z3 Tempo']);
    expect(texts({ number: false, name: false })).toEqual(['150 bpm']);
    expect(texts({ number: false, name: false, value: false })).toEqual([]);
  });

  it('stays inside its box: it clips to it first, and nothing is drawn beyond it', () => {
    const { calls, of } = draw(zones('horizontal', { show: { number: true, name: true, value: true, timeInZone: true } }));
    expect(calls.findIndex((call) => call.op === 'clip')).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((call) => call.op === 'clip')).toBeLessThan(calls.findIndex((call) => call.op === 'fillRect'));
    for (const call of of('fillRect')) {
      const [x, y, w, h] = call.args as number[];
      expect(x).toBeGreaterThanOrEqual(BOX.x - 0.5 - 1e-6);
      expect(x! + w!).toBeLessThanOrEqual(BOX.x + BOX.w + 0.5 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(BOX.y - 6);
      expect(y! + h!).toBeLessThanOrEqual(BOX.y + BOX.h + 6);
    }
    expect(of('roundRect')[0]!.args.slice(0, 4)).toEqual([BOX.x, BOX.y, BOX.w, BOX.h]);
  });

  it('shows the time in each zone so far, as m:ss, under each segment', () => {
    // At 7 s seven moving seconds have passed, each in the zone of the heart rate it started at (100 to 160).
    const { of } = draw(zones('horizontal', { show: { number: true, name: true, value: true, timeInZone: true } }), { maxHeartRate: 200 }, 7);
    const texts = of('fillText').map((call) => call.args[0]);
    // Against the bounds 100, 120, 140, 160, 180: 100 and 110 in the first, 120 and 130 in the second, 140 and 150 in the third, 160 in the fourth.
    expect(texts.slice(-5)).toEqual(['0:02', '0:02', '0:02', '0:01', '0:00']);
    // Each time is in its zone's own colour.
    expect(of('fillText').slice(-5).map(colorOf)).toEqual(COLORS);
  });

  it('writes no times when they are not asked for', () => {
    expect(draw(zones('horizontal')).of('fillText')).toHaveLength(2);
  });
});

describe('a zones bar drawn vertically', () => {
  it('stacks the zones with the first at the bottom, the current one bright', () => {
    const { of } = draw(zones('vertical'));
    const segments = of('fillRect').filter((call) => COLORS.includes(colorOf(call)));
    expect(segments.map(colorOf)).toEqual(COLORS);
    expect(segments.map((call) => call.globalAlpha)).toEqual([0.35, 0.35, 1, 0.35, 0.35]);
    const ys = segments.map((call) => call.args[1] as number);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    // The marker is level with the middle of the third segment.
    const marker = of('fillRect').find((call) => colorOf(call) === '#ffffff')!;
    const [, y, , h] = segments[2]!.args as number[];
    expect((marker.args[1] as number) + (marker.args[3] as number) / 2).toBeCloseTo(y! + h! / 2, 5);
  });

  it('writes the times beside the bar, one a zone', () => {
    const { of } = draw(zones('vertical', { show: { number: true, name: true, value: true, timeInZone: true } }), { maxHeartRate: 200 }, 7);
    const times = of('fillText').slice(2);
    expect(times.map((call) => call.args[0])).toEqual(['0:02', '0:02', '0:02', '0:01', '0:00']);
    // Level with the segments, lowest first at the bottom: so each lower on the page than the next.
    const ys = times.map((call) => call.args[2] as number);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
  });
});

describe('a zones arc', () => {
  it('draws a segment of the arc for each zone in its colour, the current one bright, and a needle', () => {
    const { of } = draw(zones('arc'));
    const strokes = of('stroke').filter((call) => COLORS.includes(String(call.strokeStyle)));
    expect(strokes.map((call) => call.strokeStyle)).toEqual(COLORS);
    expect(strokes.map((call) => call.globalAlpha)).toEqual([0.35, 0.35, 1, 0.35, 0.35]);
    // Each segment is an arc of the same circle, one after the other, clockwise.
    const arcs = of('arc').slice(0, 5);
    expect(arcs).toHaveLength(5);
    expect(new Set(arcs.map((call) => `${call.args[0]},${call.args[1]},${call.args[2]}`)).size).toBe(1);
    const starts = arcs.map((call) => call.args[3] as number);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // The needle is a line from the centre, in the text colour.
    const needle = of('stroke').find((call) => call.strokeStyle === '#ffffff');
    expect(needle).toBeDefined();
    expect(of('lineTo')).toHaveLength(1);
  });

  it('stays inside the box', () => {
    const { of } = draw(zones('arc'));
    for (const call of of('arc').slice(0, 5)) {
      const [x, y, r] = call.args as number[];
      expect(x! - r!).toBeGreaterThanOrEqual(BOX.x - 1e-6);
      expect(x! + r!).toBeLessThanOrEqual(BOX.x + BOX.w + 1e-6);
      expect(y! - r!).toBeGreaterThanOrEqual(BOX.y - 1e-6);
    }
  });
});

describe('a zones figure', () => {
  it('writes the value in the colour of its zone, with the zone over it, and draws no bar', () => {
    const { of } = draw(zones('figure'));
    const texts = of('fillText');
    expect(texts.map((call) => call.args[0])).toEqual(['Z3 Tempo', '150 bpm']);
    expect(colorOf(texts[1]!)).toBe(COLORS[2]);
    expect(of('fillRect').filter((call) => COLORS.includes(colorOf(call)))).toEqual([]);
    expect(of('stroke')).toEqual([]);
  });

  it('changes colour with the zone as time goes on', () => {
    const colours = [0, 2, 5, 8, 10].map((t) => colorOf(draw(zones('figure'), { maxHeartRate: 200 }, t).of('fillText').at(-1)!));
    // 100, 120, 150, 180, 200 bpm of 200: zones 1, 2, 3, 5, 5.
    expect(colours).toEqual([COLORS[0], COLORS[1], COLORS[2], COLORS[4], COLORS[4]]);
  });

  it('writes the zone in the figure’s place when the value is hidden', () => {
    const texts = draw(zones('figure', { show: { number: true, name: true, value: false, timeInZone: false } })).of('fillText');
    expect(texts.map((call) => call.args[0])).toEqual(['Z3 Tempo']);
    expect(colorOf(texts[0]!)).toBe(COLORS[2]);
  });
});

describe('what the renderer leaves out', () => {
  it('draws nothing while the reader’s figure is missing, background and all', () => {
    const { calls } = draw(zones('horizontal', {}, { style: { backgroundOpacity: 0.5 } }), null);
    expect(calls.map((call) => call.op)).toEqual(['clearRect']);
    expect(draw(zones('horizontal'), {}).calls.map((call) => call.op)).toEqual(['clearRect']);
    expect(draw(zones('horizontal'), { ftp: 250 }).calls.map((call) => call.op)).toEqual(['clearRect']);
  });

  it('draws with bounds in values and no figure at all', () => {
    const { of } = draw(
      zones('horizontal', { basis: 'value', zones: [{ name: 'Low', color: '#112233', from: 0 }, { name: 'High', color: '#445566', from: 140 }] }),
      null,
    );
    expect(of('fillRect').filter((call) => ['#112233', '#445566'].includes(colorOf(call))).map((call) => call.globalAlpha)).toEqual([0.35, 1]);
    expect(of('fillText').map((call) => call.args[0])).toEqual(['Z2 High', '150 bpm']);
  });

  it('draws nothing where the activity has no heart rate, or at a moment it does not reach', () => {
    const bare = makeActivity(Array.from({ length: 5 }, (_, i) => ({ time: at(i), distanceMeters: i })));
    const bareTimeline = buildOverlayTimeline(bare, { video: { durationSeconds: 4 } });
    const renderer = createOverlayRenderer({ template: canvasTemplate([zones('horizontal')]), timeline: bareTimeline, activity: bare, units: 'metric', ...SIZE, personal: { maxHeartRate: 200 } });
    const recording = recorder();
    renderer.drawFrame(recording.ctx, 2);
    expect(recording.calls.map((call) => call.op)).toEqual(['clearRect']);
    expect(draw(zones('horizontal'), { maxHeartRate: 200 }, 50).calls.map((call) => call.op)).toEqual(['clearRect']);
  });

  it('draws power zones against the FTP, and not against the maximum heart rate', () => {
    const power = newZonesComponent(canvasTemplate([]), 'power', SIZE);
    const component = { ...power, smoothing: undefined, style: { backgroundOpacity: 0 } };
    expect(draw(component, { maxHeartRate: 190 }).calls.map((call) => call.op)).toEqual(['clearRect']);
    // 200 W at 5 s, of an FTP of 250: 80 %, so the third zone (Tempo is 76 to 91).
    expect(draw(component, { ftp: 250 }).of('fillText').map((call) => call.args[0])).toEqual(['Z3 Tempo', '200 W']);
  });
});

describe('type and halo follow the figure settings (AV-1015)', () => {
  it('draws a dark halo under the text on a clear background, and none on a solid one', () => {
    const clear = draw(zones('horizontal'));
    expect(clear.of('fillText').every((call) => call.shadowColor === 'rgb(0 0 0 / 0.8)')).toBe(true);
    const solid = draw(zones('horizontal', {}, { style: { backgroundOpacity: 0.6 } }));
    expect(solid.of('fillText').every((call) => call.shadowColor === 'rgba(0, 0, 0, 0)')).toBe(true);
    const own = draw(zones('horizontal', {}, { figure: { halo: { color: '#ff0000', opacity: 0.5 } } }));
    expect(own.of('fillText')[0]!.shadowColor).toBe('rgb(255 0 0 / 0.5)');
  });

  it('takes the label’s and the value’s sizes and the label’s colour, and can hide the label', () => {
    const big = draw(zones('horizontal', {}, { figure: { labelScale: 2, valueScale: 0.5, labelColor: '#00ff00' } })).of('fillText');
    const size = (call: Call) => Number(/([\d.]+)px/.exec(call.font)![1]);
    const base = draw(zones('horizontal')).of('fillText');
    expect(size(big[0]!)).toBeCloseTo(2 * size(base[0]!), 6);
    expect(size(big[1]!)).toBeCloseTo(0.5 * size(base[1]!), 6);
    expect(colorOf(big[0]!)).toBe('#00ff00');
    expect(draw(zones('horizontal', {}, { figure: { showLabel: false } })).of('fillText').map((call) => call.args[0])).toEqual(['150 bpm']);
  });

  it('aligns the type', () => {
    const align = (value: 'left' | 'center' | 'right') => draw(zones('horizontal', {}, { figure: { align: value } })).of('fillText')[0]!.args[1] as number;
    expect(align('left')).toBeLessThan(align('center'));
    expect(align('center')).toBeLessThan(align('right'));
    expect(align('center')).toBeCloseTo(BOX.x + BOX.w / 2, 6);
  });
});

describe('the time in each zone is read from the raw values, not the smoothed ones', () => {
  it('counts a spike in the zone it was in although the figure shown is smoothed', () => {
    // 140 W with one second of 400 W at 5 s, smoothed over 5 s: the zone shown barely moves, the time does.
    const spiky = makeActivity(
      Array.from({ length: 11 }, (_, i) => ({ time: at(i), distanceMeters: i * 5, powerWatts: i === 5 ? 400 : 140 })),
    );
    const line = buildOverlayTimeline(spiky, { video: { durationSeconds: 10 } });
    const base = newZonesComponent(canvasTemplate([]), 'power', SIZE);
    const component: OverlayComponent = {
      ...base,
      rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 },
      style: { backgroundOpacity: 0 },
      smoothing: { windowSeconds: 5 },
      zones: { ...base.zones!, show: { number: true, name: true, value: true, timeInZone: true } },
    };
    const renderer = createOverlayRenderer({ template: canvasTemplate([component]), timeline: line, activity: spiky, units: 'metric', ...SIZE, personal: { ftp: 250 } });
    const recording = recorder();
    renderer.drawFrame(recording.ctx, 10);
    const texts = recording.of('fillText').map((call) => call.args[0]);
    // 140 W of 250 is 56 %: the second zone. The spike's second (400 W: 160 %) is in the seventh.
    expect(texts.slice(-7)).toEqual(['0:00', '0:09', '0:00', '0:00', '0:00', '0:00', '0:01']);
  });
});
