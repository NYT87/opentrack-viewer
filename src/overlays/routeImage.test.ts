import { describe, expect, it } from 'vitest';
import { computeStreams, type Activity, type ActivityPoint } from '../domain/activity';
import { projectRoute } from '../domain/routeProjection';
import {
  DEFAULT_ROUTE_IMAGE,
  MAX_IMAGE_SIZE,
  START_MARKER_COLOR,
  END_MARKER_COLOR,
  canvasToPng,
  drawRoute,
  renderRouteToCanvas,
  routeImageBaseName,
  validateRouteImageOptions,
  type DrawingContext,
} from './routeImage';

const pts: ActivityPoint[] = [
  { index: 0, lat: 42, lon: -8 },
  { index: 1, lat: 42.01, lon: -8 },
  { index: 2, lat: 42.01, lon: -7.99 },
];
const activityOf = (points: ActivityPoint[], name?: string, fileName?: string): Activity => ({
  id: 'a',
  source: { format: 'gpx', parserVersion: 't', fileName },
  metadata: { name },
  points,
  streams: computeStreams(points),
  warnings: [],
});

/** Records what is drawn, as a canvas would be told. */
function recorder() {
  const calls: string[] = [];
  const fills: unknown[] = [];
  const context = {
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    clearRect: (...a: number[]) => calls.push(`clear ${a.join(',')}`),
    beginPath: () => calls.push('begin'),
    moveTo: () => calls.push('move'),
    lineTo: () => calls.push('line'),
    arc: (_x: number, _y: number, r: number) => calls.push(`arc ${r}`),
    stroke: () => calls.push(`stroke ${context.strokeStyle}`),
    fill: () => {
      calls.push('fill');
      fills.push(context.fillStyle);
    },
  } satisfies DrawingContext & Record<string, unknown>;
  return { context, calls, fills };
}

const opts = { ...DEFAULT_ROUTE_IMAGE, width: 400, height: 300, padding: 20 };

describe('route overlay drawing (AV-1009)', () => {
  it('clears to transparent and never fills a background', () => {
    const { context, calls } = recorder();
    drawRoute(context, projectRoute(pts, opts), opts);
    expect(calls[0]).toBe('clear 0,0,400,300');
    // The only fills are the two marker discs, drawn after the line.
    expect(calls.filter((c) => c === 'fill')).toHaveLength(2);
    expect(calls.indexOf('fill')).toBeGreaterThan(calls.indexOf('stroke #ffffff'));
  });

  it('draws one polyline per segment, in the requested colour and width', () => {
    const { context, calls } = recorder();
    const two = [
      { index: 0, lat: 42, lon: -8, segmentIndex: 0 },
      { index: 1, lat: 42.01, lon: -8, segmentIndex: 0 },
      { index: 2, lat: 42.02, lon: -8, segmentIndex: 1 },
      { index: 3, lat: 42.03, lon: -8, segmentIndex: 1 },
    ];
    const styled = { ...opts, color: '#ff00aa', lineWidth: 7 };
    drawRoute(context, projectRoute(two, styled), styled);
    expect(calls.filter((c) => c.startsWith('stroke'))).toEqual(['stroke #ff00aa', 'stroke #ff00aa']);
    expect(context.lineWidth).toBe(7);
    expect(context.lineCap).toBe('round');
  });

  it('marks the start and end, or neither', () => {
    const on = recorder();
    drawRoute(on.context, projectRoute(pts, opts), opts);
    expect(on.fills).toEqual([START_MARKER_COLOR, END_MARKER_COLOR]);

    const off = recorder();
    drawRoute(off.context, projectRoute(pts, opts), { ...opts, showMarkers: false });
    expect(off.fills).toEqual([]);
    expect(off.calls.some((c) => c.startsWith('arc'))).toBe(false);
  });

  it('draws a lone point as markers only', () => {
    const { context, calls } = recorder();
    drawRoute(context, projectRoute([pts[0]!], opts), opts);
    expect(calls.some((c) => c.startsWith('stroke'))).toBe(false);
    expect(calls.filter((c) => c.startsWith('arc'))).toHaveLength(2);
  });
});

describe('route overlay options (AV-1009)', () => {
  it('accepts the defaults and the presets', () => {
    expect(() => validateRouteImageOptions(DEFAULT_ROUTE_IMAGE)).not.toThrow();
  });

  it.each([
    ['width too small', { width: 10 }],
    ['width too large', { width: MAX_IMAGE_SIZE + 1 }],
    ['fractional height', { height: 300.5 }],
    ['negative padding', { padding: -1 }],
    ['zero line width', { lineWidth: 0 }],
    ['no colour', { color: '  ' }],
    ['NaN width', { width: NaN }],
  ])('rejects %s with a typed error', (_name, override) => {
    expect(() => validateRouteImageOptions({ ...DEFAULT_ROUTE_IMAGE, ...override })).toThrow(
      expect.objectContaining({ name: 'ActivityError' }),
    );
  });

  it('sizes the canvas exactly as asked', () => {
    const { context } = recorder();
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    renderRouteToCanvas(canvas, activityOf(pts), { ...opts, width: 777, height: 333 });
    expect([canvas.width, canvas.height]).toEqual([777, 333]);
  });

  it('refuses an activity with no route, and a browser with no canvas', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => renderRouteToCanvas(canvas, activityOf([{ index: 0 }]), opts)).toThrow(/no GPS/);
    expect(() => renderRouteToCanvas(canvas, activityOf(pts), opts)).toThrow(/cannot draw/);
  });

  it('encodes as PNG, or reports that it could not', async () => {
    const seen: (string | undefined)[] = [];
    const good = {
      toBlob: (cb: (b: Blob | null) => void, type?: string) => {
        seen.push(type);
        cb(new Blob(['x'], { type }));
      },
    } as unknown as HTMLCanvasElement;
    expect((await canvasToPng(good)).type).toBe('image/png');
    expect(seen).toEqual(['image/png']);

    const bad = { toBlob: (cb: (b: Blob | null) => void) => cb(null) } as unknown as HTMLCanvasElement;
    await expect(canvasToPng(bad)).rejects.toThrow(/could not be created/);
  });

  it('names the file after the route, safely', () => {
    expect(routeImageBaseName(activityOf(pts, 'Morning Ride'))).toBe('morning-ride-route-overlay');
    expect(routeImageBaseName(activityOf(pts, undefined, 'GH010042.gpx'))).toBe('gh010042-route-overlay');
    expect(routeImageBaseName(activityOf(pts, '***'))).toBe('route-route-overlay');
  });
});
