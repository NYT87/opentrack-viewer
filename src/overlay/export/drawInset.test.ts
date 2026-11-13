import { describe, expect, it } from 'vitest';
import { activityThrough, straightNorth, type TestPoint } from '../../test/helpers/mapVideoRoutes';
import { DEFAULT_ROUTE_INSET, OPENFREEMAP_CREDIT, parseRouteInsetSetting, type OverlayRouteInsetSetting } from '../routeInset';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayComponent, type OverlayTemplate } from '../template';
import { buildOverlayTimeline } from '../timeline';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';

/**
 * AV-1023 (TD-092). What the renderer draws for a route inset that follows, is round, has a trail,
 * a border or a map: the trail and the route ahead, the marker held in the centre, the basemap's
 * picture under the line, the credit, the trim.
 */

interface Call {
  op: string;
  args: unknown[];
  alpha: number;
  stroke: unknown;
  width: number;
  fill: unknown;
}

function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, measureText: (text: string) => ({ width: text.length * 4 }) };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ op: key, args, alpha: target.globalAlpha as number, stroke: target.strokeStyle, width: target.lineWidth as number, fill: target.fillStyle });
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as OverlayContext2D;
  return { ctx, calls, ops: (op: string) => calls.filter((call) => call.op === op) };
}

const T = { width: 1920, height: 1080 };
const insetComponent = (setting: OverlayRouteInsetSetting | undefined, extra: Partial<OverlayComponent> = {}): OverlayComponent => ({
  id: 'route',
  type: 'routeInset',
  visible: true,
  rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.3555556 },
  unitMode: 'auto',
  style: { backgroundOpacity: 0 },
  ...(setting ? { routeInset: setting } : {}),
  ...extra,
});
const templateOf = (component: OverlayComponent, privacyTrim?: OverlayTemplate['privacyTrim']): OverlayTemplate => ({
  version: OVERLAY_TEMPLATE_VERSION,
  name: 't',
  style: DEFAULT_OVERLAY_STYLE,
  components: [component],
  ...(privacyTrim ? { privacyTrim } : {}),
});
const parsed = (patch: object) => parseRouteInsetSetting({ ...DEFAULT_ROUTE_INSET, ...patch });

function draw(setting: OverlayRouteInsetSetting | undefined, seconds: number, options: { points?: TestPoint[]; trim?: OverlayTemplate['privacyTrim']; maps?: Parameters<ReturnType<typeof createOverlayRenderer>['drawFrame']>[2]; duration?: number } = {}) {
  const ride = activityThrough(options.points ?? straightNorth(1000, 10, 5));
  const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: options.duration ?? 200 } });
  const template = templateOf(insetComponent(setting), options.trim);
  const renderer = createOverlayRenderer({ template, timeline, activity: ride, units: 'metric', ...T });
  const rec = recorder();
  renderer.drawFrame(rec.ctx, seconds, options.maps ? { maps: options.maps.maps } : undefined);
  return { ...rec, renderer };
}

/** The `lineTo`/`moveTo` points of the strokes, by the stroke each belongs to. */
function strokes(calls: Call[]) {
  const result: { alpha: number; stroke: unknown; width: number; points: [number, number][] }[] = [];
  let points: [number, number][] = [];
  for (const call of calls) {
    if (call.op === 'beginPath') points = [];
    else if (call.op === 'moveTo' || call.op === 'lineTo') points.push([call.args[0] as number, call.args[1] as number]);
    else if (call.op === 'stroke') result.push({ alpha: call.alpha, stroke: call.stroke, width: call.width, points: [...points] });
  }
  return result;
}

describe('a route inset that follows (AV-1023)', () => {
  const frame = { x: 0.1 * T.width, y: 0.1 * T.height, w: 0.2 * T.width, h: 0.3555556 * T.height };
  const center = [frame.x + frame.w / 2, frame.y + frame.h / 2];

  it('draws the marker in the centre of its box, the route moving under it', () => {
    for (const t of [20, 100, 160]) {
      const { ops } = draw(parsed({ view: 'follow', zoom: 16 }), t);
      const arcs = ops('arc').filter((call) => (call.args[2] as number) < frame.w / 4);
      expect(arcs.length).toBeGreaterThan(0);
      expect(arcs[0]!.args[0]).toBeCloseTo(center[0]!, 3);
      expect(arcs[0]!.args[1]).toBeCloseTo(center[1]!, 3);
    }
  });

  it('draws north up as a vertical line, and the same ride heading up as a vertical line too', () => {
    for (const orientation of ['north', 'heading'] as const) {
      const { calls } = draw(parsed({ view: 'follow', zoom: 17, orientation }), 100);
      const trail = strokes(calls)[strokes(calls).length - 1]!;
      const xs = trail.points.map((point) => point[0]);
      expect(Math.max(...xs) - Math.min(...xs), orientation).toBeLessThan(0.5);
    }
  });

  it('turns an eastbound ride up when heading up: east runs up the box', () => {
    const points: TestPoint[] = Array.from({ length: 101 }, (_, i) => ({ north: 0, east: i * 10, second: i * 2 }));
    const north = strokes(draw(parsed({ view: 'follow', zoom: 17, orientation: 'north' }), 100, { points }).calls).pop()!.points;
    const heading = strokes(draw(parsed({ view: 'follow', zoom: 17, orientation: 'heading' }), 100, { points }).calls).pop()!.points;
    // North up: the trail runs along the box's horizontal; heading up, along its vertical.
    const spread = (list: [number, number][], axis: 0 | 1) => Math.max(...list.map((p) => p[axis])) - Math.min(...list.map((p) => p[axis]));
    expect(spread(north, 1)).toBeLessThan(0.5);
    expect(spread(heading, 0)).toBeLessThan(0.5);
    expect(spread(heading, 1)).toBeGreaterThan(20);
  });

  it('draws the trail behind at full strength and the route ahead dimmed, or not at all', () => {
    const shown = strokes(draw(parsed({ view: 'follow', zoom: 14 }), 100).calls);
    const dimmed = strokes(draw(parsed({ view: 'follow', zoom: 14, ahead: 'dimmed' }), 100).calls);
    const hidden = strokes(draw(parsed({ view: 'follow', zoom: 14, ahead: 'hidden' }), 100).calls);
    expect(shown.map((s) => s.alpha)).toEqual([0.85, 0.85]);
    expect(dimmed.map((s) => s.alpha)).toEqual([0.3, 0.85]);
    expect(hidden).toHaveLength(1);
  });

  it('draws only the last minutes of the trail: a minute is 300 m of this ride', () => {
    const all = strokes(draw(parsed({ view: 'follow', zoom: 14, ahead: 'hidden' }), 150).calls)[0]!.points;
    const last = strokes(draw(parsed({ view: 'follow', zoom: 14, ahead: 'hidden', trail: 1 }), 150).calls)[0]!.points;
    const length = (list: [number, number][]) => Math.abs(list[0]![1] - list[list.length - 1]![1]);
    expect(length(last)).toBeLessThan(length(all));
    // 750 m in; a minute behind is 450 m: 300 m of line at zoom 14 (about 9.5 m a pixel on a 1080 frame, a fifth of a 384 px box... ) ends at the marker.
    expect(last[last.length - 1]![1]).toBeCloseTo(center[1]!, 3);
  });

  it('draws the whole route where the view is the whole route, the trail and what is ahead of the marker', () => {
    const { calls } = draw(parsed({ view: 'whole', ahead: 'dimmed', border: { width: 0.01, color: '#ff0000' } }), 100);
    const all = strokes(calls);
    expect(all).toHaveLength(3);
    const [ahead, trail] = all;
    expect(ahead!.alpha).toBe(0.3);
    expect(trail!.alpha).toBe(0.85);
    // The trail ends where the ahead begins: the marker.
    expect(trail!.points[trail!.points.length - 1]).toEqual(ahead!.points[0]);
  });

  it('draws a border over everything, in its colour, twice its width on the clip’s edge', () => {
    const { calls } = draw(parsed({ view: 'follow', border: { width: 0.01, color: '#ff0000' } }), 100);
    const last = strokes(calls).pop()!;
    expect(last.stroke).toBe('#ff0000');
    expect(last.width).toBeCloseTo(0.01 * T.height * 2, 6);
  });

  it('clips a round inset to a circle and draws it in the centred square', () => {
    const { calls } = draw(parsed({ shape: 'round', view: 'follow' }), 100);
    const clipAt = calls.findIndex((call) => call.op === 'clip');
    const arcBefore = calls.slice(0, clipAt).filter((call) => call.op === 'arc').pop()!;
    const side = Math.min(frame.w, frame.h);
    expect(arcBefore.args[2]).toBeCloseTo(side / 2, 6);
    expect(arcBefore.args[0]).toBeCloseTo(frame.x + frame.w / 2, 6);
  });

  it('draws the line in its colour and width, over the text colour', () => {
    const { calls } = draw(parsed({ view: 'follow', lineColor: '#00ff00', lineWidth: 0.1 }), 100);
    const trail = strokes(calls).pop()!;
    expect(trail.stroke).toBe('#00ff00');
    expect(trail.width).toBeCloseTo(0.1 * Math.min(frame.w, frame.h), 6);
  });

  it('is the old inset exactly with no setting, and with the defaults', () => {
    const a = draw(undefined, 100).calls.map((c) => `${c.op}${JSON.stringify(c.args)}`);
    const b = draw(DEFAULT_ROUTE_INSET, 100).calls.map((c) => `${c.op}${JSON.stringify(c.args)}`);
    expect(b).toEqual(a);
    expect(draw(parsed({ view: 'follow' }), 100).calls.map((c) => c.op)).not.toEqual(draw(undefined, 100).calls.map((c) => c.op));
  });
});

describe('a route inset with a map (AV-1023)', () => {
  const withMap = parsed({ view: 'follow', map: { provider: 'openfreemap', style: 'liberty' } });
  const bitmap = { width: 384, height: 384 } as unknown as CanvasImageSource;

  it('draws the basemap’s picture first, in the inset’s box, under the line, and credits the provider', () => {
    const { calls } = draw(withMap, 100, { maps: { maps: { bitmaps: new Map([['route', bitmap]]) } } });
    const imageAt = calls.findIndex((call) => call.op === 'drawImage');
    const strokeAt = calls.findIndex((call) => call.op === 'stroke');
    expect(imageAt).toBeGreaterThan(-1);
    expect(imageAt).toBeLessThan(strokeAt);
    expect(calls[imageAt]!.args.slice(1)).toEqual([192, 108, 384, 384 * (0.3555556 * 1080) / 384]);
    expect(calls.some((call) => call.op === 'fillText' && call.args[0] === OPENFREEMAP_CREDIT)).toBe(true);
  });

  it('draws the credit while a live map shows under the canvas, though it draws no picture', () => {
    const { calls } = draw(withMap, 100, { maps: { maps: { live: new Set(['route']) } } });
    expect(calls.some((call) => call.op === 'drawImage')).toBe(false);
    expect(calls.some((call) => call.op === 'fillText' && call.args[0] === OPENFREEMAP_CREDIT)).toBe(true);
  });

  it('does not dim a live map with the background: the export’s opaque picture covers the fill, so the preview must not show it', () => {
    const renderer = (style: object) => {
      const ride = activityThrough(straightNorth(1000, 10, 5));
      const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
      return { ride, timeline, template: templateOf(insetComponent(withMap, { style })) };
    };
    const { ride, timeline, template } = renderer({ backgroundOpacity: 0.35 });
    const r = createOverlayRenderer({ template, timeline, activity: ride, units: 'metric', ...T });
    const none = recorder();
    r.drawFrame(none.ctx, 100);
    const live = recorder();
    r.drawFrame(live.ctx, 100, { maps: { live: new Set(['route']) } });
    expect(none.ops('fill').some((call) => call.fill === 'rgb(0 0 0 / 0.35)')).toBe(true);
    expect(live.ops('fill').some((call) => call.fill === 'rgb(0 0 0 / 0.35)')).toBe(false);
  });

  it('credits nothing, and draws no picture, where no map shows', () => {
    const { calls } = draw(withMap, 100);
    expect(calls.some((call) => call.op === 'fillText')).toBe(false);
    expect(calls.some((call) => call.op === 'drawImage')).toBe(false);
  });

  it('credits nothing for an inset with no map, though a bitmap is offered for its id', () => {
    const { calls } = draw(parsed({ view: 'follow' }), 100, { maps: { maps: { bitmaps: new Map([['route', bitmap]]) } } });
    expect(calls.some((call) => call.op === 'fillText' || call.op === 'drawImage')).toBe(false);
  });

  it('keeps the credit whole inside the inset, squeezed to fit', () => {
    const { calls } = draw(withMap, 100, { maps: { maps: { live: new Set(['route']) } } });
    const credit = calls.find((call) => call.op === 'fillText')!;
    const plate = calls.filter((call) => call.op === 'fillRect').pop()!;
    expect(credit.args[1] as number).toBeGreaterThanOrEqual(plate.args[0] as number);
    expect((plate.args[0] as number) + (plate.args[2] as number)).toBeLessThanOrEqual(192 + 384 + 1e-6);
  });

  it('asks the page for a picture only for insets with a map that are drawn at this moment', () => {
    const ride = activityThrough(straightNorth(1000, 10, 5));
    const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
    const make = (setting: OverlayRouteInsetSetting | undefined, trim?: OverlayTemplate['privacyTrim']) =>
      createOverlayRenderer({ template: templateOf(insetComponent(setting), trim), timeline, activity: ride, units: 'metric', ...T });
    expect(make(withMap).insetsAt(100)).toEqual(['route']);
    expect(make(withMap).insetsAt(9999)).toEqual([]);
    expect(make(parsed({ view: 'follow' })).insetsAt(100)).toEqual([]);
    expect(make(undefined).insetsAt(100)).toEqual([]);
    // Too little kept: no route is drawn, and none of the area is asked for.
    expect(make(withMap, { start: 0.45, end: 0.45 }).insetsAt(100)).toEqual(['route']);
    const short = activityThrough(straightNorth(150, 10, 5));
    const shortRenderer = createOverlayRenderer({ template: templateOf(insetComponent(withMap), { start: 0.45, end: 0.45 }), timeline: buildOverlayTimeline(short, { video: { durationSeconds: 40 } }), activity: short, units: 'metric', ...T });
    expect(shortRenderer.insetsAt(20)).toEqual([]);
  });
});

describe('a route inset under the privacy trim (AV-1022, TD-091)', () => {
  const trim = { start: 0.2, end: 0.2 };
  const frame = { x: 192, y: 108, w: 384, h: 384 };

  it('draws no marker while the moment is in a hidden stretch, and holds the camera at the kept end', () => {
    const early = draw(parsed({ view: 'follow', zoom: 15 }), 10, { trim });
    const earlier = draw(parsed({ view: 'follow', zoom: 15 }), 2, { trim });
    // No marker: the only arcs would be the marker's.
    expect(early.ops('arc')).toHaveLength(0);
    // The camera has not moved between the two moments: the same line is drawn.
    expect(strokes(early.calls).map((s) => s.points)).toEqual(strokes(earlier.calls).map((s) => s.points));
  });

  it('draws the route behind the held camera as nothing at the start, and all of it at the end', () => {
    const start = strokes(draw(parsed({ view: 'follow', zoom: 14 }), 10, { trim }).calls);
    const end = strokes(draw(parsed({ view: 'follow', zoom: 14 }), 190, { trim }).calls);
    // At the start: the trail is empty (the camera is at the first kept vertex), the whole kept route is ahead.
    expect(start).toHaveLength(1);
    expect(start[0]!.points.length).toBeGreaterThan(1);
    // At the end: all of it is behind, and nothing is ahead.
    expect(end).toHaveLength(1);
    expect(end[0]!.points[end[0]!.points.length - 1]![1]).toBeCloseTo(frame.y + frame.h / 2, 3);
  });

  it('draws no vertex of the hidden stretches: the kept 600 m fit the whole view, and nothing lies beyond them', () => {
    const { calls } = draw(parsed({ view: 'whole' , border: { width: 0.01, color: '#ffffff' } }), 100, { trim });
    const lines = strokes(calls).filter((s) => s.width !== 0.01 * T.height * 2);
    const ys = lines.flatMap((s) => s.points.map((p) => p[1]));
    // The kept route is a vertical line of 600 m, fitted in the box; the end points sit inside the padded box, not at the 1 km extent.
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(frame.h * 0.85);
  });

  it('draws the leg between the first kept vertex and the next while held before the kept start, so there is no gap in the route ahead', () => {
    const start = strokes(draw(parsed({ view: 'follow', zoom: 18 }), 2, { trim }).calls);
    // Held at the first kept vertex (the box's centre): the route ahead starts there, on the centre.
    expect(start).toHaveLength(1);
    const first = start[0]!.points[0]!;
    expect(first[0]).toBeCloseTo(frame.x + frame.w / 2, 3);
    expect(first[1]).toBeCloseTo(frame.y + frame.h / 2, 3);
  });

  it('draws no inset at all, though the box and its border are there, when under 100 m is kept', () => {
    const short = activityThrough(straightNorth(150, 10, 5));
    const timeline = buildOverlayTimeline(short, { video: { durationSeconds: 40 } });
    const renderer = createOverlayRenderer({ template: templateOf(insetComponent(parsed({ view: 'follow' })), { start: 0.45, end: 0.45 }), timeline, activity: short, units: 'metric', ...T });
    const { ctx, calls } = recorder();
    renderer.drawFrame(ctx, 20);
    expect(calls.some((call) => call.op === 'stroke' || call.op === 'arc')).toBe(false);
  });
});
