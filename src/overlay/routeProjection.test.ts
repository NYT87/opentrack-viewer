import { describe, expect, it } from 'vitest';
import { MAX_POINT_STEP, MAX_ROUTE_POINTS, MIN_POINT_STEP, projectRoute } from './routeProjection';
import { syntheticRide } from '../test/helpers/syntheticTelemetry';
import { makeActivity } from '../test/helpers/activity';

const inBox = ([x, y]: [number, number]) => x >= 0 && x <= 1 && y >= 0 && y <= 1;

describe('projectRoute (AV-1004)', () => {
  it('fits a route inside the box without clipping, whatever the aspect', () => {
    const activity = makeActivity([
      { lat: 10, lon: 20 },
      { lat: 10.5, lon: 20.01 },
      { lat: 11, lon: 20 },
    ]);
    for (const aspect of [0.4, 1, 3]) {
      const route = projectRoute(activity, aspect)!;
      expect(route.segments.flat().every(inBox)).toBe(true);
    }
  });

  it('draws north up and keeps the aspect of the ground', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 0.5, lon: 0.5 },
        { lat: 0.6, lon: 0.5 },
      ]),
      1,
    )!;
    const [south, north] = route.segments[0]!;
    expect(north![1]).toBeLessThan(south![1]);
    expect(north![0]).toBeCloseTo(south![0]);
  });

  it('keeps a route across the antimeridian in one piece', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 1, lon: 179.9 },
        { lat: 1.1, lon: -179.9 },
      ]),
      1,
    )!;
    const xs = route.segments.flat().map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.9);
    expect(xs.every((x) => x >= 0 && x <= 1)).toBe(true);
  });

  it('centres a single place, and refuses an empty or invalid route', () => {
    const one = projectRoute(makeActivity([{ lat: 5, lon: 5 }]), 2)!;
    expect(one.segments[0]![0]).toEqual([0.5, 0.5]);
    expect(projectRoute(makeActivity([{ elevationMeters: 3 }]), 1)).toBeUndefined();
    expect(projectRoute(makeActivity([{ lat: 95, lon: 5 }, { lat: 0, lon: 0 }]), 1)).toBeUndefined();
    expect(projectRoute(makeActivity([{ lat: 5, lon: 5 }]), 0)).toBeUndefined();
  });

  it('splits at recorded segment boundaries', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 1, lon: 1, segmentIndex: 0 },
        { lat: 1.1, lon: 1.1, segmentIndex: 0 },
        { lat: 1.2, lon: 1.2, segmentIndex: 1 },
      ]),
      1,
    )!;
    expect(route.segments.map((s) => s.length)).toEqual([2, 1]);
  });

  it('splits the route at an invalid fix instead of joining across it', () => {
    const route = projectRoute(
      makeActivity([
        { lat: 1, lon: 1 },
        { lat: 1.1, lon: 1.1 },
        { lat: 95, lon: 1.2 }, // invalid
        { elevationMeters: 5 }, // no fix
        { lat: 1.3, lon: 1.3 },
        { lat: 1.4, lon: 1.4 },
      ]),
      1,
    )!;
    expect(route.segments.map((segment) => segment.length)).toEqual([2, 2]);
  });

  describe('a long route is drawn once, to what the box can show', () => {
    type Pt = [number, number];
    const toBox = (route: NonNullable<ReturnType<typeof projectRoute>>, lat: number, lon: number): Pt =>
      route.project({ lat, lon });

    /** Distance from a point to the nearest piece of line, in box heights (x scaled by the aspect). */
    const distanceToLine = (pieces: Pt[][], [x, y]: Pt, aspect: number): number => {
      let best = Infinity;
      for (const piece of pieces) {
        for (let i = 0; i < piece.length; i += 1) {
          const [ax, ay] = [piece[i]![0] * aspect, piece[i]![1]];
          const [bx, by] = i + 1 < piece.length ? [piece[i + 1]![0] * aspect, piece[i + 1]![1]] : [ax, ay];
          const [px, py] = [x * aspect, y];
          const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / length2));
          best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
        }
      }
      return best;
    };

    /**
     * The worst distance from the route to the line drawn for it: from every
     * (sampled) recorded point *and from the middle of the leg that follows it*.
     * Points alone would not notice a leg that was dropped between two that were
     * kept — the middle of a missing leg is where the line is not.
     */
    const worstError = (activity: ReturnType<typeof makeActivity>, aspect: number, every = 97) => {
      const route = projectRoute(activity, aspect)!;
      let worst = 0;
      for (let i = 0; i < activity.points.length; i += every) {
        const point = activity.points[i]!;
        worst = Math.max(worst, distanceToLine(route.segments, toBox(route, point.lat!, point.lon!), aspect));
        const next = activity.points[i + 1];
        if (next && (next.segmentIndex ?? 0) === (point.segmentIndex ?? 0)) {
          const mid = toBox(route, (point.lat! + next.lat!) / 2, (point.lon! + next.lon!) / 2);
          worst = Math.max(worst, distanceToLine(route.segments, mid, aspect));
        }
      }
      return { route, worst };
    };

    describe('six hours at camera rate, retracing the same loop about six times', () => {
      const ride = syntheticRide({ seconds: 6 * 3600, hz: 10 }); // 216,001 points
      const { route, worst } = worstError(ride, 1.5, 997);
      const points = route.segments.flat();

      it('keeps about the point budget, not two hundred thousand', () => {
        expect(points.length).toBeLessThanOrEqual(MAX_ROUTE_POINTS + 10);
        expect(points.length).toBeGreaterThan(MAX_ROUTE_POINTS / 4);
      });

      it('still starts and ends where the route does', () => {
        const [first, last] = [ride.points[0]!, ride.points.at(-1)!];
        const start = toBox(route, first.lat!, first.lon!);
        const end = toBox(route, last.lat!, last.lon!);
        expect(points[0]).toEqual(start);
        expect(points.at(-1)![0]).toBeCloseTo(end[0], 9);
        expect(points.at(-1)![1]).toBeCloseTo(end[1], 9);
      });

      it('never lets the line stray from the route by more than the visible-error bound', () => {
        expect(worst).toBeLessThanOrEqual(MAX_POINT_STEP + 1e-9);
      });
    });

    it('draws a small loop ridden a thousand times as that loop, not as two points', () => {
      // 100 laps of 100 points is already 10,000 points; 1,000 laps is 100,000 — the case
      // a step that grows with the distance travelled would collapse to its first and last.
      const laps = 1000;
      const perLap = 100;
      const loop = makeActivity(
        Array.from({ length: laps * perLap }, (_, i) => {
          const angle = ((i % perLap) / perLap) * 2 * Math.PI;
          return { lat: 51.5 + 0.0005 * Math.sin(angle), lon: -0.1 + 0.0005 * Math.cos(angle) };
        }),
      );
      const { route, worst } = worstError(loop, 1);
      const kept = route.segments.flat();
      // About one lap's worth of line, not a hundred thousand points...
      expect(kept.length).toBeLessThan(1000);
      // ...and it is the whole loop: the line spans the box top to bottom (less its padding),
      // and side to side by as much as the ground does — a degree of longitude is shorter than
      // one of latitude by the cosine of the latitude, so the loop is that much narrower.
      const xs = kept.map(([x]) => x);
      const ys = kept.map(([, y]) => y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.84 * Math.cos((51.5 * Math.PI) / 180), 1);
      expect(worst).toBeLessThanOrEqual(MAX_POINT_STEP + 1e-9);
    });

    it('draws a road ridden out and back once, without a chord across the way back', () => {
      // Out along a winding road and back along the same one.
      const road = (t: number) => ({ lat: 51.5 + 0.02 * t, lon: -0.1 + 0.01 * Math.sin(t * 9) });
      const way = Array.from({ length: 3000 }, (_, i) => road(i / 2999));
      const ridden = makeActivity([...way, ...way.slice().reverse()]);
      const { route, worst } = worstError(ridden, 1, 7);
      const pieces = route.segments;
      // Drawn once: about the points of one way, not of both.
      const oneWay = projectRoute(makeActivity(way), 1)!.segments.flat().length;
      expect(pieces.flat().length).toBeLessThan(oneWay * 1.15);
      expect(pieces.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS + 10);
      expect(worst).toBeLessThanOrEqual(MAX_POINT_STEP + 1e-9);
      // No spurious line: every piece of line lies on the road. The middle of each drawn
      // stretch is within a step of some point the road really passed through.
      const onRoad = way.map((p) => toBox(route, p.lat, p.lon));
      for (const piece of pieces) {
        for (let i = 0; i + 1 < piece.length; i += 1) {
          const mid: Pt = [(piece[i]![0] + piece[i + 1]![0]) / 2, (piece[i]![1] + piece[i + 1]![1]) / 2];
          const nearest = Math.min(...onRoad.map(([x, y]) => Math.hypot(x - mid[0], y - mid[1])));
          expect(nearest).toBeLessThan(MAX_POINT_STEP * 2);
        }
      }
    });

    it('stays bounded, and faithful to within the error bound, on noisy fixes', () => {
      // A loop ridden 300 times with a little GPS jitter on every fix (deterministic).
      const jitter = (i: number, k: number) => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453 % 1) * 0.00004;
      const noisy = makeActivity(
        Array.from({ length: 30_000 }, (_, i) => {
          const angle = ((i % 100) / 100) * 2 * Math.PI;
          return { lat: 51.5 + 0.0005 * Math.sin(angle) + jitter(i, 1), lon: -0.1 + 0.0005 * Math.cos(angle) + jitter(i, 2) };
        }),
      );
      const { route, worst } = worstError(noisy, 1, 31);
      expect(route.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS + 10);
      expect(worst).toBeLessThanOrEqual(MAX_POINT_STEP + 1e-9);
    });

    describe('a sparse route is drawn whole, whatever ground it comes back to', () => {
      const corners = { a: [51.5, -0.1], b: [51.5, -0.09], c: [51.51, -0.09], d: [51.51, -0.1] } as const;
      const through = (...names: (keyof typeof corners)[]) =>
        makeActivity(names.map((name) => ({ lat: corners[name][0], lon: corners[name][1] })));
      /** Every leg of the route has its middle on the line drawn. */
      const everyLegIsDrawn = (names: (keyof typeof corners)[]) => {
        const { worst } = worstError(through(...names), 1, 1);
        expect(worst).toBeLessThanOrEqual(MIN_POINT_STEP * 2);
      };

      it('draws a closed square, including the side that returns to the first corner', () => {
        everyLegIsDrawn(['a', 'b', 'c', 'd', 'a']);
      });

      it('draws three sides of a square and then the diagonal back to an earlier corner', () => {
        // a → b → c → d, then the diagonal d → b: it ends on ground already visited.
        everyLegIsDrawn(['a', 'b', 'c', 'd', 'b']);
        const route = projectRoute(through('a', 'b', 'c', 'd', 'b'), 1)!;
        // The diagonal is in the picture as a line, not as a lone point at the corner.
        const diagonalMid = route.project({ lat: 51.505, lon: -0.095 });
        expect(distanceToLine(route.segments, diagonalMid, 1)).toBeLessThanOrEqual(MIN_POINT_STEP);
        expect(route.segments.every((piece) => piece.length > 1)).toBe(true);
      });

      it('draws a figure of eight that crosses itself, and a route that returns to its start twice', () => {
        everyLegIsDrawn(['a', 'c', 'b', 'd', 'a']);
        everyLegIsDrawn(['a', 'b', 'a', 'd', 'a']);
      });

      it('draws a square ridden fifty times once, and still draws every side of it', () => {
        const lap = ['a', 'b', 'c', 'd'] as const;
        const names = Array.from({ length: 50 }, () => lap).flat();
        everyLegIsDrawn([...names, 'a']);
        const route = projectRoute(through(...names, 'a'), 1)!;
        // Not fifty squares' worth of line: about one, closed.
        expect(route.segments.flat().length).toBeLessThan(10);
      });

      it('draws a long leg between two distant points, however few points it has', () => {
        const route = projectRoute(through('a', 'c'), 1)!;
        expect(route.segments.flat()).toHaveLength(2);
        everyLegIsDrawn(['a', 'c']);
      });
    });

    // Big inputs on purpose, and measured work under a busy machine: the per-test timeout is not the bound under test.
    describe('the point budget is a hard bound', { timeout: 60_000 }, () => {
      /** A serpentine over a `side` × `side` grid: every point on a cell of its own, every leg new ground. */
      const serpentine = (side: number) =>
        makeActivity(
          Array.from({ length: side * side }, (_, i) => {
            const row = Math.floor(i / side);
            const col = row % 2 === 0 ? i % side : side - 1 - (i % side);
            return { lat: 51.5 + row * 0.0001, lon: -0.1 + col * 0.0001 };
          }),
        );

      it('holds for a 4,900-point serpentine grid, where no cell size within the error bound can', () => {
        const activity = serpentine(70);
        expect(activity.points).toHaveLength(4900);
        const route = projectRoute(activity, 1)!;
        const count = route.segments.flat().length;
        expect(count).toBeLessThanOrEqual(MAX_ROUTE_POINTS + 10);
        // Still a line across the whole grid: it begins and ends where the route does.
        const [first, last] = [activity.points[0]!, activity.points.at(-1)!];
        const start = route.project({ lat: first.lat!, lon: first.lon! });
        const end = route.project({ lat: last.lat!, lon: last.lon! });
        expect(route.segments[0]![0]).toEqual(start);
        expect(route.segments.at(-1)!.at(-1)![0]).toBeCloseTo(end[0], 9);
        expect(route.segments.at(-1)!.at(-1)![1]).toBeCloseTo(end[1], 9);
      });

      it('holds for a far bigger grid and for a long scribble, and for a wide box', () => {
        for (const [activity, aspect] of [
          [serpentine(120), 1],
          [serpentine(90), 3],
          [
            makeActivity(
              Array.from({ length: 20_000 }, (_, i) => ({
                lat: 51.5 + 0.01 * Math.sin(i * 1.7) * Math.cos(i * 0.013),
                lon: -0.1 + 0.01 * Math.cos(i * 2.3) * Math.sin(i * 0.011),
              })),
            ),
            1.5,
          ],
        ] as const) {
          expect(projectRoute(activity, aspect)!.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS + 10);
        }
      });

      describe('a route made of very many separate pieces', () => {
        /** `count` recorded segments of `perSegment` points each, laid out in a grid so none overlaps another. */
        const fragmented = (count: number, perSegment: number, length = (i: number) => 0.00002 + (i % 7) * 0.000005) =>
          makeActivity(
            Array.from({ length: count }, (_, s) =>
              Array.from({ length: perSegment }, (_, k) => ({
                lat: 51.5 + Math.floor(s / 50) * 0.0004 + k * length(s),
                lon: -0.1 + (s % 50) * 0.0004,
                segmentIndex: s,
              })),
            ).flat(),
          );

        it('holds the budget for 2,000 two-point segments, whose ends alone are 4,000 points', () => {
          const activity = fragmented(2000, 2);
          expect(activity.points).toHaveLength(4000);
          const route = projectRoute(activity, 1)!;
          expect(route.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
          // Every piece it kept is a whole piece: two points, a real leg of the route.
          for (const piece of route.segments) expect(piece).toHaveLength(2);
        });

        it('holds it for 5,000 segments of several points, and for a thousand single points', () => {
          expect(projectRoute(fragmented(5000, 6), 1)!.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
          expect(projectRoute(fragmented(4000, 1), 1)!.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
          expect(projectRoute(fragmented(2500, 3), 2)!.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
        });

        it('gives up the pieces that show least, the shortest, and keeps the longest', () => {
          // 2,000 short segments and one long one, in the middle of the recording.
          const long = 1000;
          const activity = fragmented(2000, 2, (i) => (i === long ? 0.01 : 0.00002));
          const route = projectRoute(activity, 1)!;
          expect(route.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
          const longest = route.segments.reduce((best, piece) =>
            Math.hypot(piece[1]![0] - piece[0]![0], piece[1]![1] - piece[0]![1]) >
            Math.hypot(best[1]![0] - best[0]![0], best[1]![1] - best[0]![1])
              ? piece
              : best,
          );
          const start = activity.points[long * 2]!;
          const end = activity.points[long * 2 + 1]!;
          expect(longest[0]).toEqual(route.project({ lat: start.lat!, lon: start.lon! }));
          expect(longest[1]![1]).toBeCloseTo(route.project({ lat: end.lat!, lon: end.lon! })[1], 9);
        });

        it('keeps the pieces it keeps in the order they were recorded, and gives the same answer every time', () => {
          const activity = fragmented(2200, 2);
          const route = projectRoute(activity, 1)!;
          expect(projectRoute(activity, 1)!.segments).toEqual(route.segments);
          // Each kept piece begins at some recorded segment's first point; those indices only ever increase.
          const startOf = new Map(
            Array.from({ length: 2200 }, (_, s) => {
              const p = activity.points[s * 2]!;
              const [x, y] = route.project({ lat: p.lat!, lon: p.lon! });
              return [`${x.toFixed(9)}:${y.toFixed(9)}`, s] as const;
            }),
          );
          const indices = route.segments.map((piece) => startOf.get(`${piece[0]![0].toFixed(9)}:${piece[0]![1].toFixed(9)}`));
          expect(indices.every((index) => index !== undefined)).toBe(true);
          expect(indices).toEqual([...indices].sort((x, y) => x! - y!));
          expect(new Set(indices).size).toBe(indices.length);
        });

        it('merges the spokes of a hub ridden out and back in one recorded run, rather than giving them up', () => {
          // One recorded segment: from a hub out along a spoke and back, 2,500 times, the spokes
          // fanning round the whole circle. At a fine cell every spoke is a piece of its own
          // (out is new ground, back is covered, the next spoke starts again at the hub): 5,000
          // two-point pieces. Those are not recorded segments, and a coarser cell merges them.
          const spokes = 2500;
          const points = Array.from({ length: spokes }, (_, i) => {
            const angle = (i / spokes) * 2 * Math.PI;
            return [
              { lat: 51.5, lon: -0.1 },
              { lat: 51.5 + 0.01 * Math.sin(angle), lon: -0.1 + 0.016 * Math.cos(angle) },
            ];
          }).flat();
          const hub = makeActivity([...points, { lat: 51.5, lon: -0.1 }]);
          const { route, worst } = worstError(hub, 1, 3);
          expect(route.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
          // Nothing was given up: every spoke, tip and middle, is within a few cells of the line drawn,
          // where dropping whole pieces would leave about half of them with no line at all.
          expect(worst).toBeLessThanOrEqual(MAX_POINT_STEP * 2);
          // And what is drawn is the star, all the way round: points well out from the middle in each quadrant.
          const drawn = route.segments.flat();
          for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
            expect(drawn.some(([x, y]) => (x - 0.5) * sx > 0.15 && (y - 0.5) * sy > 0.15)).toBe(true);
          }
        });

        it('keeps every piece, within the budget, when the ends themselves fit', () => {
          // 100 segments of 100 points each: the ends are 200 points, the rest are thinned to fit 3,000.
          const activity = fragmented(100, 100, () => 0.000004);
          const route = projectRoute(activity, 1)!;
          expect(route.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS);
          expect(route.segments).toHaveLength(100);
          for (const piece of route.segments) expect(piece.length).toBeGreaterThanOrEqual(2);
        });
      });

      it('does not give up the shape of a route that fits within the error bound', () => {
        // 40 × 40 = 1,600 points: under the budget at the pixel step, so nothing is coarsened.
        const route = projectRoute(serpentine(40), 1)!;
        expect(route.segments.flat()).toHaveLength(1600);
      });

      it('coarsens a route that is over budget only as far as it must', () => {
        // 56 × 56 = 3,136 points: just over. A coarser cell merges a few, and the line is still
        // within the visible-error bound of the route.
        const activity = serpentine(56);
        const { route, worst } = worstError(activity, 1, 5);
        expect(route.segments.flat().length).toBeLessThanOrEqual(MAX_ROUTE_POINTS + 10);
        expect(route.segments.flat().length).toBeGreaterThan(MAX_ROUTE_POINTS * 0.5);
        expect(worst).toBeLessThanOrEqual(MAX_POINT_STEP * 2);
      });
    });

    it('leaves a short route exactly as it was', () => {
      const short = syntheticRide({ seconds: 60, hz: 1 });
      expect(projectRoute(short, 1)!.segments.flat()).toHaveLength(61);
    });

    it('draws a dense route once per cell: no two neighbouring points of a piece share one', () => {
      const dense = projectRoute(
        makeActivity(Array.from({ length: 5000 }, (_, i) => ({ lat: 10 + i * 1e-5, lon: 20 }))),
        1,
      )!;
      const kept = dense.segments.flat();
      expect(kept.length).toBeLessThan(1500);
      const cells = kept.map(([x, y]) => `${Math.floor(x / MIN_POINT_STEP)}:${Math.floor(y / MIN_POINT_STEP)}`);
      expect(new Set(cells).size).toBeGreaterThanOrEqual(cells.length - 1); // the end of the route may share its cell
    });

    it('thins each recorded segment on its own, and keeps the end of each', () => {
      const route = projectRoute(
        makeActivity(
          Array.from({ length: 2000 }, (_, i) => ({
            lat: 10 + i * 1e-7,
            lon: 20 + i * 1e-7,
            segmentIndex: i < 1000 ? 0 : 1,
          })),
        ),
        1,
      )!;
      expect(route.segments).toHaveLength(2);
      for (const segment of route.segments) expect(segment.length).toBeLessThan(1000);
      // The boundary is not bridged: the first segment ends before the second begins.
      expect(route.segments[0]!.at(-1)![1]).toBeGreaterThan(route.segments[1]![0]![1]);
      // The end of the last segment is the end of the route.
      const end = route.project({ lat: 10 + 1999e-7, lon: 20 + 1999e-7 });
      expect(route.segments[1]!.at(-1)![1]).toBeCloseTo(end[1], 9);
    });
  });
});
