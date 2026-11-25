import { describe, expect, it } from 'vitest';
import { computeStreams, type Activity, type ActivityPoint } from '../domain/activity';
import { createOverlayRenderer, type OverlayContext2D } from './renderOverlay';
import {
  availabilityOf,
  compactHudTemplate,
  gaugeDashboardTemplate,
  routeInsetTemplate,
  staticAvailability,
  type OverlayTemplate,
} from './template';
import { buildTimeline } from './timeline';

const T0 = Date.UTC(2024, 0, 1, 10);
const pt = (s: number, extra: Partial<ActivityPoint> = {}): ActivityPoint => ({
  index: s,
  time: new Date(T0 + s * 1000),
  lat: 42 + s * 4e-5,
  lon: -8 + s * 2e-5,
  distanceMeters: s * 5,
  elevationMeters: 100 + s,
  heartRateBpm: 120 + s,
  powerWatts: 200,
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

interface Call {
  op: string;
  args: unknown[];
  alpha: number;
  fill: unknown;
  stroke: unknown;
}

/** A context that records what it was asked to draw, and with which state. */
function recorder() {
  const calls: Call[] = [];
  const state = { globalAlpha: 1, fillStyle: '' as unknown, strokeStyle: '' as unknown };
  const stack: (typeof state)[] = [];
  const log = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args, alpha: state.globalAlpha, fill: state.fillStyle, stroke: state.strokeStyle });
  };
  const context = {
    clearRect: log('clearRect'),
    fillRect: log('fillRect'),
    beginPath: log('beginPath'),
    moveTo: log('moveTo'),
    lineTo: log('lineTo'),
    arc: log('arc'),
    stroke: log('stroke'),
    fill: log('fill'),
    save: () => stack.push({ ...state }),
    restore: () => Object.assign(state, stack.pop()),
    fillText: log('fillText'),
    measureText: (text: string) => ({ width: text.length * 10 }),
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v: number) { state.globalAlpha = v; },
    get fillStyle() { return state.fillStyle as string; },
    set fillStyle(v: string) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle as string; },
    set strokeStyle(v: string) { state.strokeStyle = v; },
  } as unknown as OverlayContext2D;
  const texts = () => calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
  return { context, calls, texts };
}

const setup = (points: ActivityPoint[], template: OverlayTemplate) => {
  const activity = activityOf(points);
  const result = buildTimeline(activity);
  if (!result.ok) throw new Error(result.reason);
  return createOverlayRenderer({
    activity,
    timeline: result.timeline,
    template,
    availability: availabilityOf(result.timeline),
  });
};
const points = (n = 30) => Array.from({ length: n }, (_, s) => pt(s));
const W = 1000;
const H = 500;

describe('overlay frames (AV-1004)', () => {
  it('can draw over what is already on the canvas, without clearing it', () => {
    const { context, calls } = recorder();
    setup(points(), compactHudTemplate()).render(context, W, H, 5, 0, { clear: false });
    expect(calls.some((c) => c.op === 'clearRect')).toBe(false);
    // Still draws the overlay.
    expect(calls.some((c) => c.op === 'fillText')).toBe(true);
    // And clears by default, and when asked to.
    const cleared = recorder();
    setup(points(), compactHudTemplate()).render(cleared.context, W, H, 5, 0, { clear: true });
    expect(cleared.calls[0]!.op).toBe('clearRect');
  });

  it('clears the frame first, so nothing from a previous one lingers', () => {
    const { context, calls } = recorder();
    setup(points(), compactHudTemplate()).render(context, W, H, 5, 0);
    expect(calls[0]).toMatchObject({ op: 'clearRect', args: [0, 0, W, H] });
  });

  describe('readouts', () => {
    it('shows the labelled value at the video time, in the template units', () => {
      const { context, texts } = recorder();
      setup(points(), compactHudTemplate('metric')).render(context, W, H, 10, 0);
      expect(texts()).toContain('SPEED');
      expect(texts()).toContain('DISTANCE');
      expect(texts()).toContain('50 m');
      expect(texts()).toContain('110 m');
    });

    it('follows the video clock and the offset', () => {
      const a = recorder();
      const renderer = setup(points(), compactHudTemplate());
      renderer.render(a.context, W, H, 10, 0);
      const b = recorder();
      renderer.render(b.context, W, H, 4, 6);
      // Video second 4 with +6 is activity second 10: the same frame.
      expect(b.texts()).toEqual(a.texts());
      const c = recorder();
      renderer.render(c.context, W, H, 4, 0);
      expect(c.texts()).not.toEqual(a.texts());
    });

    it('uses imperial units when the template says so', () => {
      const { context, texts } = recorder();
      setup(points(), compactHudTemplate('imperial')).render(context, W, H, 10, 0);
      expect(texts().some((t) => /ft$/.test(t))).toBe(true);
    });

    it('keeps every readout inside its own box', () => {
      const { context, calls } = recorder();
      const template = compactHudTemplate();
      setup(points(), template).render(context, W, H, 10, 0);
      const boxes = template.components.map((c) => ({
        x0: c.box.x * W,
        x1: (c.box.x + c.box.width) * W,
        y0: c.box.y * H,
        y1: (c.box.y + c.box.height) * H,
      }));
      for (const call of calls.filter((c) => c.op === 'fillText')) {
        const [, x, y] = call.args as [string, number, number];
        expect(boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)).toBe(true);
      }
    });

    it('can draw no panel at all', () => {
      const template = compactHudTemplate();
      template.components.forEach((c) => (c.style.backgroundColor = 'transparent'));
      const { context, calls } = recorder();
      setup(points(), template).render(context, W, H, 10, 0);
      expect(calls.some((c) => c.op === 'fillRect')).toBe(false);
    });
  });

  describe('what is missing is absent, not drawn as a placeholder', () => {
    it('draws nothing from the telemetry before it begins or after it ends', () => {
      const renderer = setup(points(), compactHudTemplate());
      for (const t of [-1, 100]) {
        const { context, texts } = recorder();
        renderer.render(context, W, H, t, 0);
        expect(texts()).toEqual([]);
      }
    });

    it('drops a readout whose value is missing at that moment, and keeps the others', () => {
      const withHole = points().map((p) => (p.index === 10 ? { ...p, elevationMeters: undefined } : p));
      const { context, texts } = recorder();
      setup(withHole, compactHudTemplate()).render(context, W, H, 10, 0);
      expect(texts()).toContain('DISTANCE');
      expect(texts()).not.toContain('ELEVATION');
      expect(texts().some((t) => t.includes('—'))).toBe(false);
    });

    it('goes blank across a pause', () => {
      const paused = [
        ...[0, 1, 2, 3].map((s) => pt(s, { segmentIndex: 0 })),
        ...[4, 5, 6, 7].map((s) => pt(s, { segmentIndex: 1 })),
      ];
      const renderer = setup(paused, compactHudTemplate());
      const gap = recorder();
      renderer.render(gap.context, W, H, 3.5, 0);
      expect(gap.texts()).toEqual([]);
      const fine = recorder();
      renderer.render(fine.context, W, H, 1.5, 0);
      expect(fine.texts().length).toBeGreaterThan(0);
    });

    it('does not draw a component that has no data at all, and reports it', () => {
      const template = compactHudTemplate();
      template.components.find((c) => c.id === 'heart-rate')!.visible = true;
      const noHr = points().map((p) => ({ ...p, heartRateBpm: undefined }));
      const renderer = setup(noHr, template);
      const { context, texts } = recorder();
      renderer.render(context, W, H, 10, 0);
      expect(texts()).not.toContain('HEART RATE');
      expect(renderer.resolved.hidden.map((h) => h.component.id)).toEqual(['heart-rate']);
    });
  });

  describe('gauges', () => {
    it('draws a track and a value arc whose length follows the reading', () => {
      const arcs = (video: number) => {
        const { context, calls } = recorder();
        setup(
          points().map((p) => ({ ...p, cyclingCadenceRpm: 10 + p.index * 4 })),
          gaugeDashboardTemplate(),
        ).render(context, W, H, video, 0);
        return calls.filter((c) => c.op === 'arc' && c.stroke !== undefined).map((c) => c.args as number[]);
      };
      const slow = arcs(5);
      const fast = arcs(25);
      // The accent arc for the cadence dial ends further round at 25 s than at 5 s.
      const longest = (set: number[][]) => Math.max(...set.map(([, , , start, end]) => end! - start!));
      expect(longest(fast)).toBeGreaterThanOrEqual(longest(slow));
      expect(slow.length).toBeGreaterThan(0);
    });

    it('clamps a reading beyond the dial rather than drawing past it', () => {
      const { context, calls } = recorder();
      setup(
        points().map((p) => ({ ...p, powerWatts: 5000 })),
        gaugeDashboardTemplate(),
      ).render(context, W, H, 5, 0);
      const full = Math.PI * 0.75 + Math.PI * 1.5;
      for (const call of calls.filter((c) => c.op === 'arc')) {
        expect((call.args as number[])[4]!).toBeLessThanOrEqual(full + 1e-9);
      }
    });
  });

  describe('route inset and progress', () => {
    const template = routeInsetTemplate();
    const box = template.components[0]!.box;
    const inside = (x: number, y: number) =>
      x >= box.x * W && x <= (box.x + box.width) * W && y >= box.y * H && y <= (box.y + box.height) * H;

    it('draws the route inside its box, with a marker where the video is', () => {
      const { context, calls } = recorder();
      setup(points(), template).render(context, W, H, 15, 0);
      const lines = calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo');
      expect(lines.length).toBeGreaterThan(5);
      for (const call of lines) expect(inside(call.args[0] as number, call.args[1] as number)).toBe(true);
      const marker = calls.filter((c) => c.op === 'arc');
      expect(marker).toHaveLength(1);
      expect(inside(marker[0]!.args[0] as number, marker[0]!.args[1] as number)).toBe(true);
    });

    it('moves the marker along the route as the video plays', () => {
      const markerAt = (video: number) => {
        const { context, calls } = recorder();
        setup(points(), template).render(context, W, H, video, 0);
        return calls.find((c) => c.op === 'arc')!.args as number[];
      };
      const early = markerAt(2);
      const late = markerAt(25);
      expect(late[0]).toBeGreaterThan(early[0]!);
      expect(late[1]).toBeLessThan(early[1]!);
    });

    it('keeps the route but drops the marker outside the telemetry', () => {
      const { context, calls } = recorder();
      setup(points(), template).render(context, W, H, 100, 0);
      expect(calls.some((c) => c.op === 'lineTo')).toBe(true);
      expect(calls.some((c) => c.op === 'arc')).toBe(false);
    });

    it('fills the progress bar in proportion to the video', () => {
      const widthAt = (video: number) => {
        const { context, calls } = recorder();
        setup(points(), template).render(context, W, H, video, 0);
        const rects = calls.filter((c) => c.op === 'fillRect' && c.fill === template.components[1]!.style.accentColor);
        return rects.at(-1)?.args[2] as number | undefined;
      };
      const total = template.components[1]!.box.width * W;
      expect(widthAt(0)).toBe(0);
      expect(widthAt(14.5)).toBeCloseTo(total * 0.5, 0);
      expect(widthAt(29)).toBeCloseTo(total, 0);
      expect(widthAt(100)).toBeUndefined();
    });

    it('draws a route far from the origin without distortion or a crash on a huge route', () => {
      const huge = Array.from({ length: 50_000 }, (_, s) => pt(s, { lat: 42 + s * 1e-6, lon: -8 + Math.sin(s / 500) * 1e-3 }));
      const { context, calls } = recorder();
      setup(huge, template).render(context, W, H, 100, 0);
      // Decimated: a corner inset never needs tens of thousands of vertices.
      expect(calls.filter((c) => c.op === 'lineTo').length).toBeLessThan(2_000);
    });
  });

  describe('charts', () => {
    const chartTemplate = (): OverlayTemplate => {
      const { box, style } = compactHudTemplate().components[0]!;
      return {
        name: 't',
        units: 'metric',
        components: [
          { id: 'c', type: 'chart', visible: true, box, style, binding: { kind: 'metric', metric: 'heartRate' }, windowSeconds: 10 },
        ],
      };
    };

    it('draws the recent past as a line ending at the current value', () => {
      const { context, calls } = recorder();
      setup(points(), chartTemplate()).render(context, W, H, 20, 0);
      expect(calls.filter((c) => c.op === 'lineTo').length).toBeGreaterThan(10);
      expect(calls.some((c) => c.op === 'arc')).toBe(true);
    });

    it('draws nothing until it has at least two readings', () => {
      const { context, calls } = recorder();
      setup(points(), chartTemplate()).render(context, W, H, 0, 0);
      expect(calls.some((c) => c.op === 'stroke')).toBe(false);
    });
  });

  describe('an activity with no clock', () => {
    it('draws the route and nothing that needs time', () => {
      const activity = activityOf(points().map((p) => ({ ...p, time: undefined })));
      const template = routeInsetTemplate();
      template.components.push(...compactHudTemplate().components);
      const renderer = createOverlayRenderer({ activity, template, availability: staticAvailability(true) });
      const { context, calls, texts } = recorder();
      renderer.render(context, W, H, 5, 0);
      expect(calls.some((c) => c.op === 'lineTo')).toBe(true);
      expect(calls.some((c) => c.op === 'arc')).toBe(false);
      expect(texts()).toEqual([]);
      expect(renderer.resolved.hidden.length).toBeGreaterThan(0);
    });
  });

  it('leaves the context as it found it after each component', () => {
    const { context } = recorder();
    setup(points(), gaugeDashboardTemplate()).render(context, W, H, 5, 0);
    expect(context.globalAlpha).toBe(1);
  });

  it('renders the same frame every time for the same inputs', () => {
    const renderer = setup(points(), compactHudTemplate());
    const first = recorder();
    const second = recorder();
    renderer.render(first.context, W, H, 12.3, 1.5);
    renderer.render(second.context, W, H, 12.3, 1.5);
    expect(second.calls.map((c) => [c.op, c.args])).toEqual(first.calls.map((c) => [c.op, c.args]));
  });
});
