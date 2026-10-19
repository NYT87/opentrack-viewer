import { describe, expect, it } from 'vitest';
import {
  END_MARKER_COLOR,
  START_MARKER_COLOR,
  drawRouteImage,
  renderRouteImagePng,
  type RouteImageCanvas,
} from './drawRouteImage';
import type { OverlayContext2D } from './drawOverlay';
import {
  DEFAULT_ROUTE_IMAGE_OPTIONS,
  RouteImageError,
  extractRoute,
  planRouteImage,
  type RouteImageOptions,
  type RouteImagePlan,
} from '../routeImage';
import { makeActivity } from '../../test/helpers/activity';

const plan = (patch: Partial<RouteImageOptions> = {}, points = 12): RouteImagePlan => {
  const extracted = extractRoute(
    makeActivity(Array.from({ length: points }, (_, i) => ({ lat: 10 + i * 0.001, lon: 20 + i * 0.002 }))),
  );
  if (!extracted.ok) throw new Error('route expected');
  const planned = planRouteImage(extracted.route, { ...DEFAULT_ROUTE_IMAGE_OPTIONS, ...patch });
  if (!planned.ok) throw new Error(planned.error.message);
  return planned.plan;
};

/** Records every call and every property set, in order, instead of drawing. */
function recordingContext() {
  const log: { op: string; args: unknown[]; fillStyle?: unknown; strokeStyle?: unknown }[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) =>
        log.push({ op: key, args, fillStyle: target.fillStyle, strokeStyle: target.strokeStyle });
    },
    set(target, key: string, value) {
      target[key] = value;
      log.push({ op: `set:${key}`, args: [value] });
      return true;
    },
  }) as unknown as OverlayContext2D;
  return { ctx, log, ops: (name: string) => log.filter((entry) => entry.op === name), state };
}

describe('drawRouteImage: nothing but the route (AV-1009)', () => {
  it('starts by clearing the whole canvas to transparent', () => {
    const { ctx, log } = recordingContext();
    drawRouteImage(ctx, plan({ width: 640, height: 480 }));
    expect(log[0]).toMatchObject({ op: 'clearRect', args: [0, 0, 640, 480] });
  });

  it('paints no background, picture, text or gradient: no rectangle, no image, no map', () => {
    const { ctx, log } = recordingContext();
    drawRouteImage(ctx, plan());
    const ops = new Set(log.map((entry) => entry.op));
    for (const forbidden of ['fillRect', 'drawImage', 'fillText', 'strokeText', 'putImageData', 'createPattern', 'createLinearGradient', 'rect', 'roundRect', 'setTransform']) {
      expect(ops.has(forbidden)).toBe(false);
    }
  });

  it('never draws at less than full opacity or with a blend that would wipe pixels', () => {
    const { ctx, log } = recordingContext();
    drawRouteImage(ctx, plan());
    expect(log.some((entry) => entry.op === 'set:globalAlpha')).toBe(false);
    expect(log.some((entry) => entry.op === 'set:globalCompositeOperation')).toBe(false);
  });

  it('draws only in the route colour and the marker colours', () => {
    const { ctx, log } = recordingContext();
    drawRouteImage(ctx, plan({ color: '#123456' }));
    const fills = new Set(log.filter((entry) => entry.op === 'fill').map((entry) => entry.fillStyle));
    expect([...fills].sort()).toEqual(['#ffffff', END_MARKER_COLOR, START_MARKER_COLOR].sort());
    const strokes = new Set(log.filter((entry) => entry.op === 'stroke').map((entry) => entry.strokeStyle));
    expect([...strokes]).toEqual(['#123456']);
  });

  it('strokes the route as one line with the width and round joins asked for', () => {
    const { ctx, ops, state } = recordingContext();
    drawRouteImage(ctx, plan({ lineWidth: 9 }));
    expect(state.lineWidth).toBe(9);
    expect(state.lineJoin).toBe('round');
    expect(state.lineCap).toBe('round');
    expect(ops('stroke')).toHaveLength(1);
    expect(ops('moveTo')).toHaveLength(1);
    expect(ops('lineTo').length).toBeGreaterThan(5);
  });

  it('strokes each piece of a broken route on its own, so no line crosses a gap', () => {
    const extracted = extractRoute(
      makeActivity([
        { lat: 10, lon: 20, segmentIndex: 0 },
        { lat: 10.01, lon: 20.01, segmentIndex: 0 },
        { lat: 10.02, lon: 20.02, segmentIndex: 1 },
        { lat: 10.03, lon: 20.03, segmentIndex: 1 },
      ]),
    );
    if (!extracted.ok) throw new Error('route expected');
    const planned = planRouteImage(extracted.route, DEFAULT_ROUTE_IMAGE_OPTIONS);
    if (!planned.ok) throw new Error('plan expected');
    const { ctx, ops } = recordingContext();
    drawRouteImage(ctx, planned.plan);
    expect(ops('stroke')).toHaveLength(2);
    expect(ops('moveTo')).toHaveLength(2);
  });

  it('puts the markers where the plan says, the start on top of the end', () => {
    const p = plan();
    const { ctx, log } = recordingContext();
    drawRouteImage(ctx, p);
    const arcs = log.filter((entry) => entry.op === 'arc');
    expect(arcs).toHaveLength(4);
    expect(arcs[0]!.args.slice(0, 2)).toEqual(p.end);
    expect(arcs[3]!.args.slice(0, 2)).toEqual(p.start);
    expect(arcs[3]!.fillStyle).toBe(START_MARKER_COLOR);
    expect(arcs[1]!.fillStyle).toBe(END_MARKER_COLOR);
  });

  it('draws no markers when they are off', () => {
    const { ctx, ops } = recordingContext();
    drawRouteImage(ctx, plan({ markers: false }));
    expect(ops('arc')).toHaveLength(0);
  });

  it('draws a single place as one dot of marker size in the route colour', () => {
    const extracted = extractRoute(makeActivity([{ lat: 10, lon: 20 }]));
    if (!extracted.ok) throw new Error('route expected');
    const planned = planRouteImage(extracted.route, { ...DEFAULT_ROUTE_IMAGE_OPTIONS, color: '#00ff00' });
    if (!planned.ok) throw new Error('plan expected');
    const { ctx, log } = recordingContext();
    drawRouteImage(ctx, planned.plan);
    const arcs = log.filter((entry) => entry.op === 'arc');
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.args[2]).toBe(planned.plan.markerRadius);
    expect(arcs[0]!.fillStyle).toBe('#00ff00');
    expect(log.some((entry) => entry.op === 'stroke')).toBe(false);
  });
});

describe('renderRouteImagePng (AV-1009)', () => {
  const fakeCanvas = (overrides: Partial<RouteImageCanvas> = {}, sizes?: number[][]) =>
    (width: number, height: number): RouteImageCanvas => {
      sizes?.push([width, height]);
      return {
        getContext: () => recordingContext().ctx,
        toPng: () => Promise.resolve(new Blob([new Uint8Array(8)], { type: 'image/png' })),
        ...overrides,
      };
    };

  it('makes a canvas of exactly the planned size and returns the PNG', async () => {
    const sizes: number[][] = [];
    const blob = await renderRouteImagePng(plan({ width: 800, height: 600 }), {
      createCanvas: fakeCanvas({}, sizes),
    });
    expect(sizes).toEqual([[800, 600]]);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(8);
  });

  it.each([
    ['no 2d context', { getContext: () => null }],
    ['no blob', { toPng: () => Promise.resolve(null) }],
    ['an empty blob', { toPng: () => Promise.resolve(new Blob([], { type: 'image/png' })) }],
    ['a blob of another type', { toPng: () => Promise.resolve(new Blob([new Uint8Array(4)], { type: 'image/jpeg' })) }],
    ['an encoder that throws', { toPng: () => Promise.reject(new Error('out of memory')) }],
  ] as const)('reports %s as a failed render, not as a file', async (_name, overrides) => {
    await expect(
      renderRouteImagePng(plan(), { createCanvas: fakeCanvas(overrides as Partial<RouteImageCanvas>) }),
    ).rejects.toMatchObject({ name: 'RouteImageError', code: 'render_failed' });
  });

  it('reports a canvas that cannot be made at all', async () => {
    await expect(
      renderRouteImagePng(plan(), {
        createCanvas: () => {
          throw new Error('too large');
        },
      }),
    ).rejects.toBeInstanceOf(RouteImageError);
  });
});
