import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE_IMAGE_OPTIONS,
  MARKER_RING,
  ROUTE_IMAGE_LIMITS,
  extractRoute,
  planRouteImage,
  routeImageFileName,
  scaleRouteImagePlan,
  type RouteImageOptions,
  type RouteImagePlan,
} from './routeImage';
import { makeActivity } from '../test/helpers/activity';
import type { ActivityPoint } from '../domain/activity';

const options = (patch: Partial<RouteImageOptions> = {}): RouteImageOptions => ({
  ...DEFAULT_ROUTE_IMAGE_OPTIONS,
  ...patch,
});

const route = (points: Partial<ActivityPoint>[]) => {
  const result = extractRoute(makeActivity(points));
  if (!result.ok) throw new Error(`expected a route, got ${result.error.code}`);
  return result.route;
};

const planOf = (points: Partial<ActivityPoint>[], patch: Partial<RouteImageOptions> = {}): RouteImagePlan => {
  const result = planRouteImage(route(points), options(patch));
  if (!result.ok) throw new Error(`expected a plan, got ${result.error.code}: ${result.error.message}`);
  return result.plan;
};

const diagonal = (n = 20, lon0 = 20) =>
  Array.from({ length: n }, (_, i) => ({ lat: 10 + i * 0.001, lon: lon0 + i * 0.002 }));

const allPoints = (plan: RouteImagePlan) => [...plan.runs.flat(), ...plan.dots];

const reachOf = (plan: RouteImagePlan) =>
  plan.start || plan.end ? Math.max(plan.lineWidth / 2, plan.markerRadius * MARKER_RING) : plan.lineWidth / 2;

/** A small deterministic generator, so "any route" is the same routes every run. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('extractRoute (AV-1009)', () => {
  it('reads the usable fixes in order, as one run', () => {
    const geometry = route(diagonal(5));
    expect(geometry.runs).toHaveLength(1);
    expect(geometry.runs[0]).toHaveLength(5);
    expect(geometry.skippedFixes).toBe(0);
    expect(geometry.bounds.minLat).toBeCloseTo(10);
    expect(geometry.bounds.maxLat).toBeCloseTo(10.004);
  });

  it('refuses an empty activity, and one with no locations, as having no location', () => {
    for (const points of [[], [{ index: 0 }, { index: 1, elevationMeters: 4 }]]) {
      const result = extractRoute(makeActivity(points));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('no_location');
    }
  });

  it('refuses an activity whose every coordinate is invalid, saying so', () => {
    const result = extractRoute(
      makeActivity([
        { lat: 91, lon: 0 },
        { lat: 0, lon: 181 },
        { lat: Number.NaN, lon: 3 },
        { lat: Infinity, lon: 3 },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no_valid_coordinates');
      expect(result.error.message).toMatch(/outside the valid range/);
    }
  });

  it('leaves invalid fixes out, counts them, and breaks the line there', () => {
    const geometry = route([
      { lat: 10, lon: 20 },
      { lat: 10.001, lon: 20.001 },
      { lat: 95, lon: 20.002 },
      { lat: 10.003, lon: 20.003 },
      { lat: 10.004, lon: 20.004 },
    ]);
    expect(geometry.skippedFixes).toBe(1);
    expect(geometry.runs.map((run) => run.length)).toEqual([2, 2]);
  });

  it('breaks the line at a point with no coordinates at all, without counting it as invalid', () => {
    const geometry = route([
      { lat: 10, lon: 20 },
      { lat: 10.001, lon: 20.001 },
      { elevationMeters: 5 },
      { lat: 10.002, lon: 20.002 },
      { lat: 10.003, lon: 20.003 },
    ]);
    expect(geometry.skippedFixes).toBe(0);
    expect(geometry.runs.map((run) => run.length)).toEqual([2, 2]);
  });

  it('draws no line across a stretch with no coordinates', () => {
    const plan = planOf(
      [
        { lat: 10, lon: 20 },
        { lat: 10.001, lon: 20.001 },
        { elevationMeters: 1 },
        { elevationMeters: 2 },
        { lat: 10.01, lon: 20.01 },
        { lat: 10.011, lon: 20.011 },
      ],
      { markers: false },
    );
    expect(plan.runs).toHaveLength(2);
    expect(plan.notes.join(' ')).toMatch(/gaps/);
  });

  it('breaks the line at a recorded segment boundary', () => {
    const geometry = route([
      { lat: 10, lon: 20, segmentIndex: 0 },
      { lat: 10.001, lon: 20.001, segmentIndex: 0 },
      { lat: 10.01, lon: 20.01, segmentIndex: 1 },
      { lat: 10.011, lon: 20.011, segmentIndex: 1 },
    ]);
    expect(geometry.runs).toHaveLength(2);
  });

  it('does not change the activity it reads', () => {
    const activity = makeActivity(diagonal(6));
    const before = JSON.stringify(activity.points);
    Object.freeze(activity.points);
    activity.points.forEach((point) => Object.freeze(point));
    extractRoute(activity);
    expect(JSON.stringify(activity.points)).toBe(before);
  });
});

describe('planRouteImage: fitting the route (AV-1009)', () => {
  it('uses the size asked for, exactly', () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
      [333, 777],
      [16, 16],
      [4096, 4096],
    ] as const) {
      const plan = planOf(diagonal(), { width, height, lineWidth: 2, paddingFraction: 0.05 });
      expect([plan.width, plan.height]).toEqual([width, height]);
    }
  });

  it('fits the whole route inside the padding and centres it, whatever the shape of the image', () => {
    for (const [width, height] of [
      [1920, 1080],
      [1080, 1920],
      [1000, 1000],
      [2000, 200],
      [200, 2000],
    ] as const) {
      const plan = planOf(diagonal(), { width, height, paddingFraction: 0.1, lineWidth: 4 });
      const xs = allPoints(plan).map(([x]) => x);
      const ys = allPoints(plan).map(([, y]) => y);
      // The margin is outside the stroke: half a line (and the markers) is inside it.
      const pad = 0.1 * Math.min(width, height) + reachOf(plan) + 1;
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(pad - 1e-6);
      expect(Math.max(...xs)).toBeLessThanOrEqual(width - pad + 1e-6);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(pad - 1e-6);
      expect(Math.max(...ys)).toBeLessThanOrEqual(height - pad + 1e-6);
      // Centred.
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(width / 2, 3);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(height / 2, 3);
      // Fills the padded box in one direction at least.
      const fillsX = Math.max(...xs) - Math.min(...xs);
      const fillsY = Math.max(...ys) - Math.min(...ys);
      const innerW = width - 2 * pad;
      const innerH = height - 2 * pad;
      expect(Math.max(fillsX / innerW, fillsY / innerH)).toBeCloseTo(1, 3);
    }
  });

  it('keeps the route its shape: longitude is scaled by latitude, not stretched to the box', () => {
    // 0.01 degrees of latitude, 0.01 of longitude at 60 N: half as wide on the ground.
    const plan = planOf(
      [
        { lat: 60, lon: 10 },
        { lat: 60.01, lon: 10.01 },
      ],
      { width: 1000, height: 1000, paddingFraction: 0.1, lineWidth: 2, markers: false },
    );
    const [[x0, y0], [x1, y1]] = plan.runs[0] as [[number, number], [number, number]];
    const widthOnScreen = Math.abs(x1 - x0);
    const heightOnScreen = Math.abs(y1 - y0);
    expect(widthOnScreen / heightOnScreen).toBeCloseTo(Math.cos((60.005 * Math.PI) / 180), 2);
  });

  it('puts north at the top and east at the right', () => {
    const plan = planOf(
      [
        { lat: 10, lon: 20 },
        { lat: 10.01, lon: 20.01 },
      ],
      { markers: false },
    );
    const [[x0, y0], [x1, y1]] = plan.runs[0] as [[number, number], [number, number]];
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeLessThan(y0);
  });

  it('draws a due-east route as a horizontal line in the middle, not as nothing', () => {
    const plan = planOf(
      Array.from({ length: 5 }, (_, i) => ({ lat: 10, lon: 20 + i * 0.01 })),
      { markers: false },
    );
    const ys = plan.runs[0]!.map(([, y]) => y);
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeCloseTo(plan.height / 2);
    expect(plan.runs[0]![4]![0] - plan.runs[0]![0]![0]).toBeGreaterThan(plan.width / 2);
  });

  it('draws a due-north route as a vertical line in the middle', () => {
    const plan = planOf(
      Array.from({ length: 5 }, (_, i) => ({ lat: 10 + i * 0.01, lon: 20 })),
      { markers: false },
    );
    const xs = plan.runs[0]!.map(([x]) => x);
    expect(new Set(xs).size).toBe(1);
    expect(xs[0]).toBeCloseTo(plan.width / 2);
  });

  it('is the same every time for the same input', () => {
    const a = planOf(diagonal(50), { width: 640, height: 360 });
    const b = planOf(diagonal(50), { width: 640, height: 360 });
    expect(b).toEqual(a);
  });
});

describe('planRouteImage: never clipped (AV-1009)', () => {
  const insideWithReach = (plan: RouteImagePlan) => {
    const reach = reachOf(plan);
    for (const [x, y] of allPoints(plan)) {
      expect(x - reach).toBeGreaterThanOrEqual(0);
      expect(y - reach).toBeGreaterThanOrEqual(0);
      expect(x + reach).toBeLessThanOrEqual(plan.width);
      expect(y + reach).toBeLessThanOrEqual(plan.height);
    }
  };

  it('keeps the whole stroke and the markers inside the image for any route, size, width and padding', () => {
    const random = seeded(7);
    for (let trial = 0; trial < 150; trial += 1) {
      const count = 2 + Math.floor(random() * 40);
      const points = Array.from({ length: count }, () => ({
        lat: -60 + random() * 120,
        lon: -170 + random() * 340,
      }));
      const width = 16 + Math.floor(random() * 1500);
      const height = 16 + Math.floor(random() * 1500);
      const result = planRouteImage(
        route(points),
        options({
          width,
          height,
          lineWidth: 1 + Math.floor(random() * 30),
          paddingFraction: random() * 0.4,
          markers: random() > 0.5,
        }),
      );
      if (!result.ok) {
        // Refused is allowed; clipped is not.
        expect(result.error.code).toBe('no_room');
        continue;
      }
      insideWithReach(result.plan);
    }
  });

  it('keeps a padding of nothing from letting the stroke cross the edge', () => {
    const plan = planOf(diagonal(), { paddingFraction: 0, lineWidth: 40, markers: false });
    for (const [x, y] of allPoints(plan)) {
      expect(Math.min(x, y, plan.width - x, plan.height - y)).toBeGreaterThanOrEqual(20);
    }
    insideWithReach(plan);
  });

  it('measures the padding to the outside of the stroke, so the margin seen is the margin asked for', () => {
    const plan = planOf(diagonal(), { paddingFraction: 0.1, lineWidth: 40, markers: false });
    // The route fills the padded box in one direction, so the tightest side is the padding.
    const tightest =
      Math.min(...allPoints(plan).flatMap(([x, y]) => [x, y, plan.width - x, plan.height - y])) -
      plan.lineWidth / 2;
    expect(tightest).toBeCloseTo(0.1 * 1080 + 1, 3);
  });

  it('leaves more room for start and end markers, which are wider than the line', () => {
    const plain = planOf(diagonal(), { paddingFraction: 0, lineWidth: 10, markers: false });
    const marked = planOf(diagonal(), { paddingFraction: 0, lineWidth: 10, markers: true });
    const edge = (plan: RouteImagePlan) => Math.min(...allPoints(plan).map(([x]) => x));
    expect(edge(marked)).toBeGreaterThan(edge(plain));
    insideWithReach(marked);
  });

  it('refuses, rather than clips, a stroke and padding that leave no room', () => {
    const result = planRouteImage(route(diagonal()), options({ width: 16, height: 16, lineWidth: 256 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('no_room');
  });

  it('keeps a route at the top of the world inside, where longitude has no width', () => {
    const plan = planOf(
      [
        { lat: 89.9, lon: 0 },
        { lat: 89.95, lon: 90 },
        { lat: 89.9, lon: 180 },
      ],
      { lineWidth: 6 },
    );
    insideWithReach(plan);
    for (const [x, y] of allPoints(plan)) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
  });
});

describe('planRouteImage: single points (AV-1009)', () => {
  it('draws a one-point route as a centred dot, not as nothing and not as an error', () => {
    const plan = planOf([{ lat: 10, lon: 20 }], { width: 800, height: 400 });
    expect(plan.singlePlace).toBe(true);
    expect(plan.runs).toEqual([]);
    expect(plan.dots).toEqual([[400, 200]]);
    expect(plan.start).toBeUndefined();
    expect(plan.end).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/single place/);
  });

  it('treats a route that never moves as one place', () => {
    const plan = planOf(Array.from({ length: 30 }, () => ({ lat: 10, lon: 20 })));
    expect(plan.singlePlace).toBe(true);
    expect(plan.dots).toHaveLength(1);
  });

  it('draws an isolated fix between gaps as a dot of its own', () => {
    const plan = planOf(
      [
        { lat: 10, lon: 20, segmentIndex: 0 },
        { lat: 10.01, lon: 20.01, segmentIndex: 0 },
        { lat: 10.02, lon: 20.02, segmentIndex: 1 },
        { lat: 10.03, lon: 20.03, segmentIndex: 2 },
        { lat: 10.04, lon: 20.04, segmentIndex: 2 },
      ],
      { markers: false },
    );
    expect(plan.runs).toHaveLength(2);
    expect(plan.dots).toHaveLength(1);
    expect(plan.notes.join(' ')).toMatch(/gaps/);
  });
});

describe('planRouteImage: the antimeridian (AV-1009)', () => {
  const east = [179.9, 179.95, -180, -179.95, -179.9].map((lon, i) => ({ lat: 10 + i * 0.01, lon }));
  const sameRouteAtZero = [-0.1, -0.05, 0, 0.05, 0.1].map((lon, i) => ({ lat: 10 + i * 0.01, lon }));

  it('draws a route that crosses it as one continuous line, not one stretched across the world', () => {
    const crossing = planOf(east, { markers: false });
    expect(crossing.runs).toHaveLength(1);
    const xs = crossing.runs[0]!.map(([x]) => x);
    // Monotone eastward, evenly spaced: no jump.
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(0);
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.01);
  });

  it('draws it exactly as it would draw the same route anywhere else', () => {
    const crossing = planOf(east, { markers: false });
    const elsewhere = planOf(sameRouteAtZero, { markers: false });
    crossing.runs[0]!.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(elsewhere.runs[0]![i]![0], 3);
      expect(y).toBeCloseTo(elsewhere.runs[0]![i]![1], 3);
    });
  });

  it('does the same going west across it', () => {
    const west = [...east].reverse();
    const plan = planOf(west, { markers: false });
    const xs = plan.runs[0]!.map(([x]) => x);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]!).toBeLessThan(xs[i - 1]!);
  });

  it('keeps pieces on either side of a gap in the same picture', () => {
    const plan = planOf(
      [
        { lat: 10, lon: 179.9, segmentIndex: 0 },
        { lat: 10.01, lon: 179.95, segmentIndex: 0 },
        { lat: 10.02, lon: -179.95, segmentIndex: 1 },
        { lat: 10.03, lon: -179.9, segmentIndex: 1 },
      ],
      { markers: false },
    );
    const first = plan.runs[0]!;
    const second = plan.runs[1]!;
    expect(second[0]![0]).toBeGreaterThan(first[first.length - 1]![0]);
    expect(second[0]![0] - first[first.length - 1]![0]).toBeLessThan(plan.width / 2);
  });
});

describe('planRouteImage: styling (AV-1009)', () => {
  it('carries the colour and the width asked for', () => {
    const plan = planOf(diagonal(), { color: '#12ab34', lineWidth: 7 });
    expect(plan.color).toBe('#12ab34');
    expect(plan.lineWidth).toBe(7);
  });

  it('marks the start and the end where the route starts and ends, when asked', () => {
    const plan = planOf(diagonal(10), { markers: true });
    expect(plan.start).toEqual(plan.runs[0]![0]);
    expect(plan.end).toEqual(plan.runs[0]![plan.runs[0]!.length - 1]);
    expect(plan.start).not.toEqual(plan.end);
  });

  it('marks the start and end of a route with gaps at its first and last fix', () => {
    const plan = planOf(
      [
        { lat: 10, lon: 20, segmentIndex: 0 },
        { lat: 10.01, lon: 20.01, segmentIndex: 0 },
        { lat: 10.02, lon: 20.02, segmentIndex: 1 },
        { lat: 10.03, lon: 20.03, segmentIndex: 1 },
      ],
      { markers: true },
    );
    expect(plan.start).toEqual(plan.runs[0]![0]);
    expect(plan.end).toEqual(plan.runs[1]![1]);
  });

  it('draws no markers when they are off', () => {
    const plan = planOf(diagonal(), { markers: false });
    expect(plan.start).toBeUndefined();
    expect(plan.end).toBeUndefined();
  });

  it('sizes markers from the line, never smaller than can be seen', () => {
    expect(planOf(diagonal(), { lineWidth: 1 }).markerRadius).toBeGreaterThanOrEqual(4);
    expect(planOf(diagonal(), { lineWidth: 40 }).markerRadius).toBeGreaterThan(40);
  });

  it('honours a larger padding by leaving more room around the route', () => {
    const edge = (padding: number) =>
      Math.min(...allPoints(planOf(diagonal(), { paddingFraction: padding, lineWidth: 2, markers: false })).map(([x]) => x));
    expect(edge(0.3)).toBeGreaterThan(edge(0.1));
  });

  it('does not draw points a pixel could not tell apart, and keeps the end', () => {
    const dense = Array.from({ length: 5000 }, (_, i) => ({ lat: 10 + i * 1e-7, lon: 20 + i * 1e-7 }));
    const plan = planOf(dense, { markers: false, width: 200, height: 200, lineWidth: 2 });
    // A diagonal of about 200 px at half a pixel a point: hundreds, not five thousand.
    expect(plan.runs[0]!.length).toBeLessThan(500);
    const last = plan.runs[0]![plan.runs[0]!.length - 1]!;
    const biggest = Math.max(...allPoints(plan).map(([x]) => x));
    expect(last[0]).toBeCloseTo(biggest, 3);
  });
});

describe('planRouteImage: refusing what cannot be drawn (AV-1009)', () => {
  const geometry = route(diagonal());
  const code = (patch: Partial<RouteImageOptions>) => {
    const result = planRouteImage(geometry, options(patch));
    return result.ok ? 'ok' : result.error.code;
  };

  it.each([
    ['a fractional width', { width: 100.5 }],
    ['a fractional height', { height: 99.9 }],
    ['an empty width', { width: Number.NaN }],
    ['an infinite height', { height: Infinity }],
    ['a width below the minimum', { width: ROUTE_IMAGE_LIMITS.minSide - 1 }],
    ['a height below the minimum', { height: 0 }],
    ['a negative size', { width: -1920 }],
    ['a width above the maximum', { width: ROUTE_IMAGE_LIMITS.maxSide + 1 }],
    ['too many pixels', { width: 8192, height: 8192 }],
  ] as const)('refuses %s as invalid dimensions', (_name, patch) => {
    expect(code(patch)).toBe('invalid_dimensions');
  });

  it('accepts the largest size within the pixel budget', () => {
    expect(code({ width: 7680, height: 4320 })).toBe('ok');
  });

  it.each([
    ['a colour name', { color: 'red' }],
    ['a functional colour', { color: 'rgb(1 2 3)' }],
    ['a short bad hex', { color: '#12' }],
    ['a non-hex hex', { color: '#gggggg' }],
    ['an empty colour', { color: '' }],
    ['a zero width line', { lineWidth: 0 }],
    ['a NaN line width', { lineWidth: Number.NaN }],
    ['a too-wide line', { lineWidth: ROUTE_IMAGE_LIMITS.maxLineWidth + 1 }],
    ['negative padding', { paddingFraction: -0.01 }],
    ['padding over the limit', { paddingFraction: 0.41 }],
    ['NaN padding', { paddingFraction: Number.NaN }],
  ] as const)('refuses %s as an invalid style', (_name, patch) => {
    expect(code(patch)).toBe('invalid_style');
  });

  it('accepts three- and six-digit hex colours in either case', () => {
    expect(code({ color: '#FA0' })).toBe('ok');
    expect(code({ color: '#ff6A00' })).toBe('ok');
  });

  it('says what is wrong in words the reader can act on', () => {
    const result = planRouteImage(geometry, options({ width: 8192, height: 8192 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/million pixels/);
  });
});

describe('scaleRouteImagePlan and file names (AV-1009)', () => {
  it('scales the picture and the stroke together, so a preview is the export, smaller', () => {
    const plan = planOf(diagonal(), { width: 1920, height: 1080, lineWidth: 12 });
    const half = scaleRouteImagePlan(plan, 0.5);
    expect([half.width, half.height]).toEqual([960, 540]);
    expect(half.lineWidth).toBeCloseTo(6);
    expect(half.runs[0]![3]![0]).toBeCloseTo(plan.runs[0]![3]![0] / 2);
    expect(half.start![1]).toBeCloseTo(plan.start![1] / 2);
    expect(half.color).toBe(plan.color);
  });

  it('names a route image for its size and nothing else', () => {
    expect(routeImageFileName({ width: 1920, height: 1080 })).toBe('route-overlay-1920x1080.png');
  });
});
