import { describe, expect, it } from 'vitest';
import type { Activity, ActivityPoint } from '../../domain/activity';
import { createOverlayRenderer, BASE_FONT_FRACTION, type OverlayContext2D } from './drawOverlay';
import { canvasTemplate, newChartComponent, newCompassComponent, newDialComponent, newGradientComponent } from '../customCanvas';
import { DEFAULT_COMPASS } from '../compass';
import { DEFAULT_DIAL, dialAngle, dialTicks } from '../dial';
import { DEFAULT_GRADIENT } from '../gradient';
import { DEFAULT_CHART, type OverlayComponent } from '../template';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';
import { METERS_PER_DEGREE } from '../../test/helpers/mapVideoRoutes';

/** AV-1019 (TD-087). The dial, the chart, the gradient indicator and the compass drawn by the one renderer: their geometry, read back from the calls. */

const T0 = Date.parse('2026-09-24T08:00:00Z');
const SIZE = { width: 2000, height: 1000 };
const EM = BASE_FONT_FRACTION * SIZE.width;

interface Call {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  globalAlpha: number;
  lineWidth: unknown;
  textAlign: unknown;
}

function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, shadowColor: 'rgba(0, 0, 0, 0)', lineWidth: 1, textAlign: 'start' };
  const ctx = new Proxy(state, {
    get: (target, key: string) =>
      key in target
        ? target[key]
        : (...args: unknown[]) => {
            calls.push({ op: key, args, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle, globalAlpha: state.globalAlpha as number, lineWidth: state.lineWidth, textAlign: state.textAlign });
          },
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as OverlayContext2D;
  const of = (op: string) => calls.filter((call) => call.op === op);
  return { ctx, calls, of };
}

const draw = (component: OverlayComponent, activity: Activity, seconds: number, duration = 100, units: 'metric' | 'imperial' = 'metric') => {
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: duration } });
  const renderer = createOverlayRenderer({ template: canvasTemplate([component]), timeline, activity, units, ...SIZE });
  const recording = recorder();
  renderer.drawFrame(recording.ctx, seconds);
  return recording;
};

/** A square box, 500 px a side, at (200, 100): its centre is (450, 350). */
const SQUARE = { x: 0.1, y: 0.1, width: 0.25, height: 0.5 };
const CENTRE = { x: 450, y: 350 };
const place = (component: OverlayComponent, rect = SQUARE, over: Partial<OverlayComponent> = {}): OverlayComponent => ({
  ...component,
  rect,
  style: { backgroundOpacity: 0 },
  ...over,
});
const angleOf = ([x, y]: unknown[]) => Math.atan2((y as number) - CENTRE.y, (x as number) - CENTRE.x);
/** The difference between two angles in radians, in (-pi, pi]: 0 where they point the same way. */
const apart = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const timeline0 = buildOverlayTimeline(undefined);

/** Speed is the second: 0 at the start, 10 m/s at ten seconds. */
const ramp = makeActivity(
  Array.from({ length: 101 }, (_, i) => ({
    time: new Date(T0 + i * 1000),
    lat: 46 + (i * i * 0.05) / METERS_PER_DEGREE,
    lon: 7,
    speedMetersPerSecond: i / 10,
    heartRateBpm: 100 + i,
    elevationMeters: 200 + (i < 50 ? i : 100 - i),
  })),
);

describe('a dial', () => {
  const dial = (over: Partial<NonNullable<OverlayComponent['dial']>> = {}, extra: Partial<OverlayComponent> = {}) =>
    place(newDialComponent(canvasTemplate([]), 'speed', SIZE, timeline0), SQUARE, { range: { min: 0, max: 10 }, dial: { ...DEFAULT_DIAL, ...over }, ...extra });
  const needle = (component: OverlayComponent, seconds: number) => {
    const { of } = draw(component, ramp, seconds);
    const lines = of('lineTo').filter((call) => call.strokeStyle === (component.dial?.needleColor ?? DEFAULT_DIAL.needleColor) && call.lineWidth !== 0);
    return lines[0] ? { tip: lines[0].args, arcs: of('arc'), of } : undefined;
  };

  it('points the needle at the range’s start and end, centred at the top, for each sweep', () => {
    for (const sweep of [180, 240, 300]) {
      const component = dial({ sweep });
      expect(apart(angleOf(needle(component, 0)!.tip), dialAngle(sweep, 0))).toBeCloseTo(0, 6);
      expect(apart(angleOf(needle(component, 100)!.tip), dialAngle(sweep, 1))).toBeCloseTo(0, 6);
      expect(apart(angleOf(needle(component, 50)!.tip), dialAngle(sweep, 0.5))).toBeCloseTo(0, 6);
    }
    // At a half of the range of a 240 degree dial, the needle points straight up.
    const up = needle(dial(), 50)!.tip as number[];
    expect(up[0]).toBeCloseTo(CENTRE.x, 6);
    expect(up[1]).toBeLessThan(CENTRE.y);
  });

  it('pins a value beyond the range at its end, above and below', () => {
    const narrow = dial({}, { range: { min: 3, max: 6 } });
    // 0 m/s is under the range, 10 m/s over it.
    expect(apart(angleOf(needle(narrow, 0)!.tip), dialAngle(240, 0))).toBeCloseTo(0, 6);
    expect(apart(angleOf(needle(narrow, 100)!.tip), dialAngle(240, 1))).toBeCloseTo(0, 6);
  });

  it('moves the needle in proportion between the ends: a quarter of the range is a quarter of the sweep', () => {
    const quarter = apart(angleOf(needle(dial(), 25)!.tip), angleOf(needle(dial(), 0)!.tip));
    expect(quarter).toBeCloseTo((240 / 4) * (Math.PI / 180), 6);
  });

  it('fills the track up to the value in the fill colour, and the whole track in the track colour', () => {
    const component = dial({ trackColor: '#112233', fillColor: '#44aa66' });
    const { of } = draw(component, ramp, 25);
    const arcs = of('arc');
    const track = arcs.find((call) => call.strokeStyle === '#112233' && call.args.length === 5 && call.args[2] !== 0)!;
    const fill = arcs.find((call) => call.strokeStyle === '#44aa66')!;
    expect(track.args[3]).toBeCloseTo(dialAngle(240, 0), 9);
    expect(track.args[4]).toBeCloseTo(dialAngle(240, 1), 9);
    expect(fill.args[3]).toBeCloseTo(dialAngle(240, 0), 9);
    expect(fill.args[4]).toBeCloseTo(dialAngle(240, 0.25), 9);
    // Nothing is filled at the start.
    expect(draw(component, ramp, 0).of('arc').some((call) => call.strokeStyle === '#44aa66')).toBe(false);
  });

  it('draws a marker on the arc instead of a needle when asked', () => {
    const { of } = draw(dial({ pointer: 'marker', needleColor: '#abcdef' }), ramp, 50);
    expect(of('lineTo').some((call) => call.strokeStyle === '#abcdef')).toBe(false);
    const dot = of('arc').find((call) => call.fillStyle === '#abcdef')!;
    const x = dot.args[0] as number;
    const y = dot.args[1] as number;
    // Half way round a centred arc is the top, at the arc's radius.
    expect(x).toBeCloseTo(CENTRE.x, 6);
    expect(y).toBeLessThan(CENTRE.y - 150);
  });

  it('draws the ticks the range and settings give: the major ones longer than the minor', () => {
    const { of } = draw(dial({ majorStep: 2.5, minorTicks: 4 }), ramp, 50);
    const wanted = dialTicks({ min: 0, max: 10 }, { majorStep: 2.5, minorTicks: 4 }, { metric: 'speed', units: 'metric' });
    const ticks = of('lineTo').filter((call) => call.strokeStyle === DEFAULT_DIAL.trackColor);
    expect(ticks).toHaveLength(wanted.length);
    const length = (call: Call, index: number) => {
      const [x1, y1] = of('moveTo').filter((c) => c.strokeStyle === DEFAULT_DIAL.trackColor)[index]!.args as number[];
      return Math.hypot((call.args[0] as number) - x1!, (call.args[1] as number) - y1!);
    };
    const majors = Math.max(...ticks.map(length));
    const minors = Math.min(...ticks.map(length));
    expect(majors).toBeGreaterThan(minors * 1.5);
  });

  it('writes the label and the value in the middle, and nothing for missing data', () => {
    const { of } = draw(dial(), ramp, 50);
    // AV-1020: the numbers beside the ticks come first; the label and the value are the last two.
    expect(of('fillText').slice(-2).map((call) => call.args[0])).toEqual(['SPEED', '18.0 km/h']);
    for (const call of of('fillText')) expect(call.textAlign).toBe('center');
    expect(draw(dial({}, { source: { kind: 'metric', metric: 'power' } }), ramp, 50).of('fillText')).toEqual([]);
  });

  it('is clipped to its box before anything is drawn, and draws nothing outside the frame’s data', () => {
    const { calls } = draw(dial(), ramp, 50);
    expect(calls.findIndex((call) => call.op === 'clip')).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((call) => call.op === 'clip')).toBeLessThan(calls.findIndex((call) => call.op === 'arc'));
    // Beyond the activity there is nothing to read.
    expect(draw(dial(), ramp, 100, 150).calls.filter((call) => call.op === 'arc').length).toBeGreaterThan(0);
    expect(draw(dial(), ramp, 120, 150).calls.filter((call) => call.op === 'arc')).toEqual([]);
  });

  it('uses the activity’s own range, rounded, where none is set', () => {
    const own = dial({}, { range: undefined });
    // 0 to 10 m/s is 0 to 36 km/h, rounded in km/h to 40 (AV-1020): 10 m/s is 0.9 of it.
    expect(apart(angleOf(needle(own, 100)!.tip), dialAngle(240, 0.9))).toBeCloseTo(0, 6);
    expect(apart(angleOf(needle(own, 50)!.tip), dialAngle(240, 0.45))).toBeCloseTo(0, 6);
  });

  describe('the numbers beside the major ticks (AV-1020, TD-089)', () => {
    const numbers = (component: OverlayComponent, units: 'metric' | 'imperial' = 'metric') =>
      draw(component, ramp, 50, 100, units).of('fillText').map((call) => call.args[0]);

    it('are in km/h or mph, whatever the stored range, drawn inside the ticks', () => {
      expect(numbers(dial()).slice(0, -2)).toEqual(['0', '5', '10', '15', '20', '25', '30', '35']);
      // The same 0 to 10 m/s is 22.4 mph: steps of 5.
      expect(numbers(dial(), 'imperial').slice(0, -2)).toEqual(['0', '5', '10', '15', '20']);
      const { of } = draw(dial(), ramp, 50);
      const first = of('fillText')[0]!;
      const radius = Math.hypot((first.args[1] as number) - CENTRE.x, (first.args[2] as number) - CENTRE.y);
      // Inside the ring of ticks, whose inner ends are 0.69 of the dial's radius from the centre.
      expect(radius).toBeLessThan(0.69 * 240);
      expect(first.fillStyle).toBe('#ffffff');
    });

    it('are written as m:ss for a pace, in the dial’s own units', () => {
      const pace = dial({}, { source: { kind: 'metric', metric: 'pace' }, range: { min: 180, max: 420 }, unitMode: 'metric', rect: { x: 0.05, y: 0.02, width: 0.45, height: 0.96 } });
      expect(numbers(pace)).toContain('3:00');
      expect(numbers(pace)).toContain('7:00');
      // 180 to 420 s/km is 290 to 676 s/mi: the ticks are every 60 s from 4:50.
      const miles = dial({}, { source: { kind: 'metric', metric: 'pace' }, range: { min: 180, max: 420 }, unitMode: 'imperial', rect: { x: 0.05, y: 0.02, width: 0.45, height: 0.96 } });
      expect(numbers(miles)[0]).toBe('4:50');
    });

    it('use the component’s units, not the reader’s, when it has its own', () => {
      expect(numbers(dial({}, { unitMode: 'imperial' })).slice(0, -2)).toEqual(['0', '5', '10', '15', '20']);
    });

    it('are drawn on a dial of the size Add makes, for a speed and a pace', () => {
      const added = (metric: 'speed' | 'pace') => {
        const made = newDialComponent(canvasTemplate([]), metric, { width: 1920, height: 1080 }, buildOverlayTimeline(ramp, { video: { durationSeconds: 100 } }));
        return draw(made, ramp, 50, 100).of('fillText').length;
      };
      expect(added('speed')).toBeGreaterThan(2);
      expect(added('pace')).toBeGreaterThan(2);
    });

    it('are left out when they would touch the label and value in the middle, as on a 300 degree sweep', () => {
      expect(numbers(dial({ sweep: 300 })).length).toBe(2);
      expect(numbers(dial({ sweep: 240 })).length).toBeGreaterThan(2);
    });

    it('are drawn or not alike in the preview, drawn smaller than the frame, and in the export', () => {
      const count = (width: number, height: number) => {
        const renderer = createOverlayRenderer({ template: canvasTemplate([dial()]), timeline: buildOverlayTimeline(ramp, { video: { durationSeconds: 100 } }), activity: ramp, units: 'metric', width, height });
        const recording = recorder();
        renderer.drawFrame(recording.ctx, 50);
        return recording.of('fillText').length;
      };
      expect(count(1000, 500)).toBe(count(500, 250));
    });

    it('are left out, all of them, on a dial too small to read them, and where they would touch', () => {
      const tiny = dial({}, { rect: { x: 0.1, y: 0.1, width: 0.02, height: 0.04 } });
      expect(numbers(tiny).every((text) => !/^\d+$/.test(String(text)))).toBe(true);
      // A step of 0.1 km/h on a 36 km/h range is capped to 50 ticks: too close for their numbers.
      expect(numbers(dial({ majorStep: 0.1 })).slice(0, -2)).toEqual([]);
    });
  });
});

describe('a chart', () => {
  const pad = 0.3 * EM;
  const strip = { x: 0.1, y: 0.1, width: 0.5, height: 0.3 };
  const boxOf = { x: 200, y: 100, w: 1000, h: 300 };
  const chart = (setting: Partial<NonNullable<OverlayComponent['chart']>> = {}, metric: 'speed' | 'heartRate' | 'elevation' = 'heartRate') =>
    place(newChartComponent(canvasTemplate([]), metric, SIZE, timeline0), strip, { chart: { ...DEFAULT_CHART, labels: false, ...setting } });
  /** The cursor bar, which is the only fillRect in the accent colour. */
  const cursorOf = (component: OverlayComponent, seconds: number, activity: Activity = ramp) => {
    const recording = draw(component, activity, seconds);
    const bar = recording.of('fillRect').find((call) => call.fillStyle === '#ff6a00')!;
    const [x, y, w, h] = bar.args as number[];
    return { ...recording, centre: x! + w! / 2, top: y!, height: h! };
  };
  /** The points of the paths stroked in a colour: a path's points are recorded before its stroke style is set, so they are read by the stroke that ends them. */
  const lineOf = (calls: Call[], color: string) => {
    const points: Call[] = [];
    let path: Call[] = [];
    for (const call of calls) {
      if (call.op === 'beginPath') path = [];
      else if (call.op === 'moveTo' || call.op === 'lineTo') path.push(call);
      else if (call.op === 'stroke' && call.strokeStyle === color) points.push(...path);
    }
    return points;
  };
  const area = { x: boxOf.x + pad, w: boxOf.w - 2 * pad, y: boxOf.y + pad, h: boxOf.h - 2 * pad };

  it('puts the cursor at the moment’s share of the activity on a time axis', () => {
    for (const [seconds, share] of [[0, 0], [25, 0.25], [50, 0.5], [100, 1]] as const) {
      expect(cursorOf(chart(), seconds).centre).toBeCloseTo(area.x + share * area.w, 6);
    }
  });

  it('puts it at the distance’s share on a distance axis, which is not the time’s where the speed changes', () => {
    // The ramp's distance is the square of the time: half way in time is a quarter of the way along.
    const along = cursorOf(chart({ axis: 'distance' }), 50).centre;
    expect(along).toBeCloseTo(area.x + 0.25 * area.w, 1);
    expect(cursorOf(chart({ axis: 'distance' }), 100).centre).toBeCloseTo(area.x + area.w, 6);
  });

  it('keeps the cursor in the middle of a window, for each axis, wherever now is', () => {
    for (const axis of ['time', 'distance'] as const) {
      for (const seconds of [0, 10, 50, 90, 100]) {
        expect(cursorOf(chart({ axis, window: axis === 'time' ? 20 : 500 }), seconds).centre, `${axis} at ${seconds}`).toBeCloseTo(area.x + area.w / 2, 6);
      }
    }
  });

  it('draws the window’s part of the line, from its left edge to its right, rescaled to its own range', () => {
    const { of, calls } = draw(chart({ window: 20 }), ramp, 50);
    expect(of('stroke').find((call) => call.strokeStyle === '#ffffff')).toBeDefined();
    const points = lineOf(calls, '#ffffff');
    const xs = points.map((call) => call.args[0] as number);
    expect(Math.min(...xs)).toBeCloseTo(area.x, 6);
    expect(Math.max(...xs)).toBeCloseTo(area.x + area.w, 6);
    // The heart rate rises 1 bpm a second: 40 to 60 s is 140 to 160 bpm, spread over the height, highest at the top.
    const ys = points.map((call) => call.args[1] as number);
    expect(Math.min(...ys)).toBeCloseTo(area.y + 0.12 * area.h, 6);
    expect(Math.max(...ys)).toBeCloseTo(area.y + 0.92 * area.h, 6);
  });

  it('puts the cursor’s dot on the line at the figure’s value', () => {
    const { of } = draw(chart({ window: 20 }), ramp, 50);
    const dot = of('arc').find((call) => call.fillStyle === '#ff6a00')!;
    // 150 bpm is the middle of 140 to 160.
    expect(dot.args[0]).toBeCloseTo(area.x + area.w / 2, 6);
    expect(dot.args[1] as number).toBeCloseTo(area.y + ((0.12 + 0.92) / 2) * area.h, 1);
  });

  it('draws a gap in the data as a gap in the line, and no dot in it', () => {
    const gappy = makeActivity(ramp.points.map((point, i) => ({ ...point, heartRateBpm: i >= 40 && i <= 60 ? undefined : point.heartRateBpm })));
    const { of } = draw(chart(), gappy, 50);
    expect(of('stroke').filter((call) => call.strokeStyle === '#ffffff')).toHaveLength(2);
    // The figure has no value at 50 s: the cursor bar is there, and no dot on it.
    expect(of('fillRect').some((call) => call.fillStyle === '#ff6a00')).toBe(true);
    expect(of('arc').some((call) => call.fillStyle === '#ff6a00')).toBe(false);
    // And a recording gap with a pause is two lines.
    const paused = makeActivity(ramp.points.map((point, i) => ({ ...point, time: new Date(T0 + (i < 50 ? i : i + 600) * 1000) })));
    expect(draw(chart(), paused, 20, 800).of('stroke').filter((call) => call.strokeStyle === '#ffffff')).toHaveLength(2);
  });

  it('draws the line and fill in the chosen colours, the fill as translucent as asked', () => {
    const { of } = draw(chart({ lineColor: '#123456', fillColor: '#654321', fillOpacity: 0.4 }), ramp, 50);
    expect(of('stroke').some((call) => call.strokeStyle === '#123456' && call.globalAlpha === 1)).toBe(true);
    const fill = of('fill').find((call) => call.fillStyle === '#654321')!;
    expect(fill.globalAlpha).toBeCloseTo(0.4, 9);
  });

  it('writes the y range’s ends and the x window when labels are on, and nothing when off', () => {
    const on = draw(chart({ labels: true }), ramp, 50).of('fillText').map((call) => call.args[0]);
    // 100 to 200 bpm, from 0:00 to the 1:40 the activity lasts.
    expect(on).toEqual(['200 bpm', '100 bpm', '0:00', '1:40']);
    expect(draw(chart({ labels: false }), ramp, 50).of('fillText')).toEqual([]);
    const windowed = draw(chart({ labels: true, window: 30 }), ramp, 50).of('fillText').map((call) => call.args[0]);
    expect(windowed).toEqual(['180 bpm', '120 bpm', '−0:30', '+0:30']);
    const distance = draw(chart({ labels: true, axis: 'distance', window: 500 }), ramp, 50).of('fillText').map((call) => call.args[0]);
    expect(distance.slice(-2)).toEqual(['−500 m', '+500 m']);
  });

  it('draws nothing for a figure the activity does not have, or a distance axis without distance', () => {
    expect(draw(chart({}, 'speed'), makeActivity(ramp.points.map((point) => ({ ...point, speedMetersPerSecond: undefined, lat: undefined, lon: undefined }))), 50).of('stroke')).toEqual([]);
    const indoors = makeActivity(ramp.points.map((point) => ({ ...point, lat: undefined, lon: undefined })));
    expect(draw(chart({ axis: 'distance' }), indoors, 50).of('stroke')).toEqual([]);
    expect(draw(chart({ axis: 'time' }), indoors, 50).of('stroke').length).toBeGreaterThan(0);
  });

  it('draws nothing, background included, where it has no place on its axis', () => {
    const dropout = makeActivity(ramp.points.map((point, i) => ({ ...point, lat: i >= 40 && i <= 60 ? undefined : point.lat, lon: i >= 40 && i <= 60 ? undefined : point.lon })));
    const shaded = { ...chart({ axis: 'distance' }), style: { backgroundOpacity: 0.5 } };
    expect(draw(shaded, dropout, 50).of('fill')).toEqual([]);
    expect(draw(shaded, ramp, 50).of('fill').length).toBeGreaterThan(0);
  });

  it('stays in its box', () => {
    const { calls } = draw(chart({ labels: true, window: 30 }), ramp, 50);
    expect(calls.findIndex((call) => call.op === 'clip')).toBeLessThan(calls.findIndex((call) => call.op === 'stroke'));
    for (const call of calls.filter((entry) => entry.op === 'fillRect')) {
      const [x, y, w, h] = call.args as number[];
      expect(x).toBeGreaterThanOrEqual(boxOf.x - 1e-6);
      expect(x! + w!).toBeLessThanOrEqual(boxOf.x + boxOf.w + 1e-6);
      expect(y).toBeGreaterThanOrEqual(boxOf.y - 1e-6);
      expect(y! + h!).toBeLessThanOrEqual(boxOf.y + boxOf.h + 1e-6);
    }
  });
});

describe('a gradient indicator', () => {
  /** A ride with a recorded grade of exactly `grade` throughout. */
  const steady = (grade: number) => makeActivity(Array.from({ length: 31 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + (i * 5) / METERS_PER_DEGREE, lon: 7, gradePercent: grade })));
  const indicator = (over: Partial<NonNullable<OverlayComponent['gradient']>> = {}) => {
    const base = newGradientComponent(canvasTemplate([]), SIZE);
    return place(base, { x: 0.1, y: 0.1, width: 0.3, height: 0.15 }, { gradient: { ...DEFAULT_GRADIENT, ...over }, smoothing: undefined });
  };
  const colourAt = (grade: number) => {
    const texts = draw(indicator(), steady(grade), 10, 30).of('fillText');
    return texts[texts.length - 1]!.fillStyle;
  };
  const [descent, flat, yellow, orange, red, dark] = DEFAULT_GRADIENT.bands.map((band) => band.color);

  it('is coloured by the band the grade is in: the colour changes at each bound, which belongs to the band above', () => {
    expect(colourAt(-30)).toBe(descent);
    expect(colourAt(-1.01)).toBe(descent);
    expect(colourAt(-1)).toBe(flat);
    expect(colourAt(2.99)).toBe(flat);
    expect(colourAt(3)).toBe(yellow);
    expect(colourAt(5.99)).toBe(yellow);
    expect(colourAt(6)).toBe(orange);
    expect(colourAt(8.99)).toBe(orange);
    expect(colourAt(9)).toBe(red);
    expect(colourAt(11.99)).toBe(red);
    expect(colourAt(12)).toBe(dark);
    expect(colourAt(25)).toBe(dark);
  });

  it('uses the bands the reader set', () => {
    const bands = [{ from: -100, color: '#111111' }, { from: 0, color: '#222222' }];
    const texts = draw(indicator({ bands }), steady(0.5), 10, 30).of('fillText');
    expect(texts[texts.length - 1]!.fillStyle).toBe('#222222');
    expect(draw(indicator({ bands }), steady(-0.5), 10, 30).of('fillText').at(-1)!.fillStyle).toBe('#111111');
  });

  it('writes the grade with one decimal, and the label over it', () => {
    expect(draw(indicator(), steady(6.54), 10, 30).of('fillText').map((call) => call.args[0])).toEqual(['GRADE', '6.5 %']);
  });

  it('draws a glyph as a path: a triangle up, a triangle down, a bar for flat, in the band’s colour', () => {
    const up = draw(indicator(), steady(8), 10, 30);
    const moves = up.of('moveTo');
    const lines = up.of('lineTo');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.fillStyle).toBe(orange);
    // The apex is above the base, centred over it.
    const [ax, ay] = moves[0]!.args as number[];
    const [bx, by] = lines[0]!.args as number[];
    const [cx, cy] = lines[1]!.args as number[];
    expect(ay).toBeLessThan(by!);
    expect(by).toBe(cy);
    expect(ax).toBeCloseTo((bx! + cx!) / 2, 9);
    expect(up.of('fill').some((call) => call.fillStyle === orange)).toBe(true);

    const down = draw(indicator(), steady(-8), 10, 30);
    const [dx, dy] = down.of('moveTo')[0]!.args as number[];
    const [ex, ey] = down.of('lineTo')[0]!.args as number[];
    const [fx, fy] = down.of('lineTo')[1]!.args as number[];
    expect(dy).toBe(ey);
    expect(fy).toBeGreaterThan(dy!);
    expect(fx).toBeCloseTo((dx! + ex!) / 2, 9);

    const level = draw(indicator(), steady(0), 10, 30);
    expect(level.of('moveTo')).toHaveLength(0);
    const [, , barW, barH] = level.of('rect').at(-1)!.args as number[];
    expect(barW).toBeGreaterThan(barH! * 2);
  });

  it('chooses the glyph at one percent either way', () => {
    const kind = (grade: number) => {
      const recording = draw(indicator(), steady(grade), 10, 30);
      return recording.of('moveTo').length === 1 ? (((recording.of('lineTo')[0]!.args as number[])[1]! > (recording.of('moveTo')[0]!.args as number[])[1]!) ? 'up' : 'down') : 'flat';
    };
    expect(kind(1)).toBe('up');
    expect(kind(0.99)).toBe('flat');
    expect(kind(-0.99)).toBe('flat');
    expect(kind(-1)).toBe('down');
  });

  it('draws no glyph when it is off, and nothing when the activity has no grade', () => {
    const none = draw(indicator({ glyph: false }), steady(8), 10, 30);
    expect(none.of('closePath')).toEqual([]);
    expect(none.of('rect')).toEqual([]);
    expect(none.of('fillText')).toHaveLength(2);
    const noGrade = makeActivity(Array.from({ length: 31 }, (_, i) => ({ time: new Date(T0 + i * 1000) })));
    expect(draw(indicator(), noGrade, 10, 30).of('fillText')).toEqual([]);
  });

  it('gives the glyph the halo the text has on a clear background', () => {
    const shadowed: string[] = [];
    const recording = recorder();
    const ctx = new Proxy(recording.ctx as object, { set: (t, k: string, v) => { if (k === 'shadowBlur' && v) shadowed.push('on'); return Reflect.set(t, k, v); } }) as unknown as OverlayContext2D;
    const component = indicator();
    const activity = steady(8);
    createOverlayRenderer({ template: canvasTemplate([component]), timeline: buildOverlayTimeline(activity, { video: { durationSeconds: 30 } }), activity, units: 'metric', ...SIZE }).drawFrame(ctx, 10);
    expect(shadowed).toHaveLength(2);
  });

  it('keeps the glyph and the text inside its box', () => {
    const recording = draw(indicator(), steady(8), 10, 30);
    const box = { x: 200, y: 100, w: 600, h: 150 };
    for (const call of [...recording.of('moveTo'), ...recording.of('lineTo')]) {
      expect(call.args[0] as number).toBeGreaterThanOrEqual(box.x);
      expect(call.args[0] as number).toBeLessThanOrEqual(box.x + box.w);
      expect(call.args[1] as number).toBeGreaterThanOrEqual(box.y);
      expect(call.args[1] as number).toBeLessThanOrEqual(box.y + box.h);
    }
  });
});

describe('a compass', () => {
  /** A ride that goes `legs` of (heading in degrees, number of 5 m steps), a step a second. */
  const heading = (legs: [number, number][]): Activity => {
    const points: Partial<ActivityPoint>[] = [];
    let north = 0;
    let east = 0;
    let second = 0;
    const lonScale = METERS_PER_DEGREE * Math.cos((46 * Math.PI) / 180);
    const push = () => points.push({ time: new Date(T0 + second * 1000), lat: 46 + north / METERS_PER_DEGREE, lon: 7 + east / lonScale });
    push();
    for (const [degrees, steps] of legs) {
      for (let i = 0; i < steps; i += 1) {
        north += 5 * Math.cos((degrees * Math.PI) / 180);
        east += 5 * Math.sin((degrees * Math.PI) / 180);
        second += 1;
        push();
      }
    }
    return makeActivity(points);
  };
  const compass = (over: Partial<NonNullable<OverlayComponent['compass']>> = {}, extra: Partial<OverlayComponent> = {}) =>
    place(newCompassComponent(canvasTemplate([]), SIZE), SQUARE, { compass: { ...DEFAULT_COMPASS, ...over }, smoothing: undefined, ...extra });
  const R = 250 - 0.25 * EM;
  const labelAt = (recording: ReturnType<typeof draw>, letter: string) => {
    const call = recording.of('fillText').find((entry) => entry.args[0] === letter)!;
    return { x: (call.args[1] as number) - CENTRE.x, y: CENTRE.y - (call.args[2] as number) };
  };
  /** Where north is, in degrees clockwise from the top, from the N label. */
  const northAngle = (recording: ReturnType<typeof draw>) => {
    const { x, y } = labelAt(recording, 'N');
    return (((Math.atan2(x, y) * 180) / Math.PI) + 360) % 360;
  };

  it('turns the rose so the heading is up: north is at the top heading north, and a quarter turn round for each cardinal heading', () => {
    // 20 steps at each heading: the heading is read from the last 20 m.
    const cases: [number, number][] = [[0, 0], [90, 270], [180, 180], [270, 90]];
    for (const [degrees, north] of cases) {
      const recording = draw(compass(), heading([[degrees, 12]]), 11, 12);
      expect(northAngle(recording), `heading ${degrees}`).toBeCloseTo(north, 0);
    }
  });

  it('keeps the marker fixed at the top and the labels where the headings put them', () => {
    const recording = draw(compass(), heading([[90, 12]]), 11, 12);
    const east = labelAt(recording, 'E');
    // Heading east: east is up.
    expect(east.x).toBeCloseTo(0, 3);
    expect(east.y).toBeGreaterThan(0);
    const marker = recording.of('moveTo').find((call) => call.fillStyle === DEFAULT_COMPASS.needleColor)!;
    expect(marker.args[0]).toBeCloseTo(CENTRE.x, 6);
    expect(marker.args[1] as number).toBeLessThan(CENTRE.y);
  });

  it('points the needle along the heading on a fixed rose, north up, for each cardinal heading', () => {
    for (const degrees of [0, 90, 180, 270]) {
      const recording = draw(compass({ style: 'needle' }), heading([[degrees, 12]]), 11, 12);
      const tip = recording.of('moveTo').filter((call) => call.fillStyle === DEFAULT_COMPASS.needleColor).at(-1)!.args as number[];
      const angle = ((Math.atan2(tip[0]! - CENTRE.x, CENTRE.y - tip[1]!) * 180) / Math.PI + 360) % 360;
      expect(angle).toBeCloseTo(degrees, 0);
      // The rose does not turn: north is at the top.
      expect(northAngle(recording)).toBeCloseTo(0, 6);
    }
  });

  it('does not swing across 359 and 1 degrees: a two degree turn is two degrees of rose', () => {
    const turn = heading([[359, 12], [1, 12]]);
    const before = draw(compass(), turn, 11, 24);
    const after = draw(compass(), turn, 23, 24);
    const swing = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);
    expect(swing(northAngle(before), northAngle(after))).toBeLessThan(10);
    for (const recording of [before, after]) {
      const angle = northAngle(recording);
      expect(Math.min(angle, 360 - angle)).toBeLessThan(5);
    }
  });

  it('smooths a heading across 359 and 1 by the circular mean, so the rose stays at the top and not at the bottom', () => {
    const jitter = heading(Array.from({ length: 24 }, (_, i): [number, number] => [i % 2 === 0 ? 359 : 1, 1]));
    const recording = draw(compass({}, { smoothing: { windowSeconds: 8 } }), jitter, 22, 24);
    const angle = northAngle(recording);
    expect(Math.min(angle, 360 - angle)).toBeLessThan(8);
    // A mean of the degrees would read 180: south at the top.
    const raw = (359 + 1) / 2;
    expect(raw).toBe(180);
  });

  it('labels the cardinal points, or not', () => {
    const on = draw(compass(), heading([[0, 12]]), 11, 12).of('fillText').map((call) => call.args[0]);
    expect(on).toEqual(expect.arrayContaining(['N', 'E', 'S', 'W']));
    const off = draw(compass({ labels: false }), heading([[0, 12]]), 11, 12).of('fillText').map((call) => call.args[0]);
    expect(off).toEqual(['HEADING', '0° N']);
  });

  it('writes the heading as degrees and a letter, as a figure', () => {
    const texts = draw(compass({ labels: false }), heading([[123, 12]]), 11, 12).of('fillText').map((call) => call.args[0]);
    expect(texts).toEqual(['HEADING', '123° SE']);
  });

  it('draws nothing before the activity has moved 20 m, or without positions', () => {
    expect(draw(compass(), heading([[90, 12]]), 2, 12).of('arc')).toEqual([]);
    const indoors = makeActivity(Array.from({ length: 12 }, (_, i) => ({ time: new Date(T0 + i * 1000) })));
    expect(draw(compass(), indoors, 8, 12).of('arc')).toEqual([]);
  });

  it('holds the last heading through a stop', () => {
    const stopped = makeActivity([
      ...heading([[90, 12]]).points.map((point) => ({ ...point })),
      ...heading([[90, 12]]).points.slice(0, 4).map((point, i) => ({ ...point, time: new Date(T0 + (300 + i) * 1000), lat: heading([[90, 12]]).points[12]!.lat, lon: heading([[90, 12]]).points[12]!.lon })),
    ]);
    const during = draw(compass({ labels: false }), stopped, 150, 400).of('fillText').map((call) => call.args[0]);
    expect(during).toEqual(['HEADING', '90° E']);
  });

  it('stays inside its box', () => {
    const recording = draw(compass(), heading([[45, 12]]), 11, 12);
    for (const call of [...recording.of('moveTo'), ...recording.of('lineTo')]) {
      expect(call.args[0] as number).toBeGreaterThanOrEqual(200);
      expect(call.args[0] as number).toBeLessThanOrEqual(700);
      expect(call.args[1] as number).toBeGreaterThanOrEqual(100);
      expect(call.args[1] as number).toBeLessThanOrEqual(600);
    }
    expect(R).toBeGreaterThan(0);
  });
});
