import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './export/drawOverlay';
import { runExport } from './export/runExport';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from './presets';
import { projectRoute } from './routeProjection';
import { projectSeries } from './series';
import { buildOverlayTimeline } from './timeline';
import { syntheticRide } from '../test/helpers/syntheticTelemetry';

/**
 * AV-1008. Performance checks on long timelines, without a long video — or any
 * video — anywhere: the telemetry is made on the spot (`syntheticTelemetry`),
 * and what is measured is what a long recording costs the overlay.
 *
 * Two kinds of check, because absolute times depend on the machine:
 *
 *  - **Budgets**, generous enough to hold on a slow CI runner, that catch an
 *    order-of-magnitude regression (a rebuild per frame, a copy per sample).
 *  - **Scaling**, which compares a long recording with a short one on the same
 *    machine in the same run, so the machine cancels out. Sampling must not
 *    cost more per call because the recording is longer (it is a binary search),
 *    and building must grow no faster than the recording does.
 *
 * Each is the best of a few runs, so one scheduling hiccup is not a failure.
 */
const best = (runs: number, work: () => void): number => {
  let fastest = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    work();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
};

/** A deterministic scatter over [0, 1): the same "random" times on every run. */
const scatter = (i: number) => ((i * 2654435761) % 4294967296) / 4294967296;

const HOURS = 3600;
const long = syntheticRide({ seconds: 6 * HOURS, hz: 10, sensorStream: true }); // 216,001 points
const medium = syntheticRide({ seconds: 6 * HOURS, hz: 1, sensorStream: true }); // 21,601 points
const short = syntheticRide({ seconds: 600, hz: 1, sensorStream: true }); // 601 points

// Measured work, repeated for the best of a few runs, on a machine that may be
// busy running the rest of the suite: the per-test timeout is not the budget
// under test, so it is generous. The budgets are the assertions.
describe('long timelines (AV-1008)', { timeout: 90_000 }, () => {
  it('is long: six hours at camera rate is over 200,000 points', () => {
    expect(long.points.length).toBeGreaterThan(200_000);
  });

  describe('building the timeline', () => {
    it('takes a bounded time for six hours at 10 Hz', () => {
      const ms = best(3, () => buildOverlayTimeline(long, { video: { durationSeconds: 6 * HOURS } }));
      expect(ms).toBeLessThan(4000);
    });

    it('grows with the recording, no faster: ten times the points cost far less than a hundred times', () => {
      // Warmed up first, so the first run's compilation is not mistaken for growth.
      buildOverlayTimeline(medium);
      buildOverlayTimeline(long);
      const small = best(7, () => buildOverlayTimeline(medium));
      const large = best(7, () => buildOverlayTimeline(long));
      // 10× the points: linear is 10×, and a busy machine's garbage collector may make it 20×;
      // quadratic would be 100×. The line is drawn between them.
      expect(large / Math.max(small, 0.05)).toBeLessThan(50);
    });
  });

  describe('sampling it, which is what every preview frame and every export frame does', () => {
    const timeline = buildOverlayTimeline(long, { video: { durationSeconds: 6 * HOURS } });

    it('answers 200,000 playback-order samples within a budget', () => {
      const ms = best(3, () => {
        for (let i = 0; i < 200_000; i += 1) timeline.sampleAt((i / 200_000) * 6 * HOURS);
      });
      expect(ms).toBeLessThan(3000);
    });

    it('answers 100,000 scattered seeks within a budget, and every one in range has values', () => {
      let withValues = 0;
      const ms = best(3, () => {
        withValues = 0;
        for (let i = 0; i < 100_000; i += 1) {
          const sample = timeline.sampleAt(scatter(i) * 6 * HOURS);
          if (sample?.values['metric:speed'] !== undefined) withValues += 1;
        }
      });
      expect(ms).toBeLessThan(3000);
      expect(withValues).toBeGreaterThan(99_000);
    });

    it('costs no more per sample on a long recording than on a short one', () => {
      const shortTimeline = buildOverlayTimeline(short);
      const perCall = (target: typeof timeline, seconds: number) =>
        best(5, () => {
          for (let i = 0; i < 50_000; i += 1) target.sampleAt(scatter(i) * seconds);
        }) / 50_000;
      // 360× the points: a binary search costs a few more steps, a scan would
      // cost 360×. Allow room for noise in the tiny short-timeline baseline on
      // a shared CI runner while still catching a linear scan.
      expect(perCall(timeline, 6 * HOURS) / Math.max(perCall(shortTimeline, 600), 1e-6)).toBeLessThan(16);
    });
  });

  describe('drawing it', () => {
    const timeline = buildOverlayTimeline(medium, { video: { durationSeconds: 6 * HOURS } });
    const { template } = buildOverlay(DEFAULT_OVERLAY_CONTROLS, timeline, 16 / 9);
    // A canvas that does nothing, cheaply: the cost measured is the overlay's own,
    // not the price of recording calls on a Proxy.
    const calls = { count: 0 };
    const count = () => void (calls.count += 1);
    const ctx = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      lineJoin: '',
      lineCap: '',
      shadowColor: '',
      shadowBlur: 0,
      textAlign: '',
      textBaseline: '',
      clearRect: count,
      save: count,
      restore: count,
      beginPath: count,
      roundRect: count,
      rect: count,
      clip: count,
      fill: count,
      fillRect: count,
      fillText: count,
      moveTo: count,
      lineTo: count,
      stroke: count,
      arc: count,
      closePath: count,
    } as unknown as OverlayContext2D;

    it('draws 5,000 frames of a six-hour ride within a budget, and the route is projected once, not per frame', () => {
      const renderer = createOverlayRenderer({ template, timeline, activity: medium, units: 'metric', width: 1920, height: 1080 });
      const ms = best(3, () => {
        for (let i = 0; i < 5000; i += 1) renderer.drawFrame(ctx, (i / 5000) * 6 * HOURS);
      });
      expect(ms).toBeLessThan(5000);
      expect(calls.count).toBeGreaterThan(5000);
    }, 30_000);

    it('draws 5,000 frames of a six-hour ride with five 30 s smoothed figures within a budget (AV-1016)', () => {
      // Each smoothed figure takes at most 121 samples a frame, so the cost is a fixed multiple and a
      // six-hour recording costs no more per frame than a short one: the line is the budget above's, twice.
      const smoothed = {
        ...template,
        components: (['speed', 'pace', 'power', 'heartRate', 'cyclingCadence'] as const).map((metric) => ({
          id: metric,
          type: 'text' as const,
          visible: true,
          rect: { x: 0.05, y: 0.05, width: 0.2, height: 0.1 },
          unitMode: 'auto' as const,
          style: {},
          source: { kind: 'metric' as const, metric },
          smoothing: { windowSeconds: 30 },
        })),
      };
      const renderer = createOverlayRenderer({ template: smoothed, timeline, activity: medium, units: 'metric', width: 1920, height: 1080 });
      const before = calls.count;
      const ms = best(3, () => {
        for (let i = 0; i < 5000; i += 1) renderer.drawFrame(ctx, (i / 5000) * 6 * HOURS);
      });
      expect(calls.count).toBeGreaterThan(before);
      expect(ms).toBeLessThan(10_000);
    }, 60_000);

    it('draws 5,000 frames of a six-hour ride with a dial, a whole chart, a windowed chart, a gradient indicator and a compass within a budget, the series made once (AV-1019)', () => {
      // The series is projected once per chart, and a window costs a search and the points in it, so a frame
      // costs no more on a six-hour ride than on a short one: the line is the budget above's.
      const base = { visible: true, unitMode: 'auto' as const, style: {}, rect: { x: 0.05, y: 0.05, width: 0.3, height: 0.2 } };
      const moment = {
        ...template,
        components: [
          { ...base, id: 'dial', type: 'dial' as const, source: { kind: 'metric' as const, metric: 'speed' as const }, range: { min: 0, max: 10 }, smoothing: { windowSeconds: 5 } },
          { ...base, id: 'whole', type: 'chart' as const, source: { kind: 'metric' as const, metric: 'heartRate' as const }, chart: { axis: 'time' as const, lineColor: '#ffffff', fillColor: '#ffffff', fillOpacity: 0.25, labels: true } },
          { ...base, id: 'window', type: 'chart' as const, source: { kind: 'metric' as const, metric: 'power' as const }, chart: { axis: 'distance' as const, window: 2000, lineColor: '#ffffff', fillColor: '#ffffff', fillOpacity: 0.25, labels: true } },
          { ...base, id: 'gradient', type: 'gradient' as const, source: { kind: 'metric' as const, metric: 'grade' as const }, smoothing: { windowSeconds: 5 } },
          { ...base, id: 'compass', type: 'compass' as const, source: { kind: 'metric' as const, metric: 'heading' as const }, smoothing: { windowSeconds: 3 } },
        ],
      };
      const renderer = createOverlayRenderer({ template: moment, timeline, activity: medium, units: 'metric', width: 1920, height: 1080 });
      renderer.drawFrame(ctx, 1); // projects both series once, outside the measurement
      const before = calls.count;
      const ms = best(3, () => {
        for (let i = 0; i < 5000; i += 1) renderer.drawFrame(ctx, (i / 5000) * 6 * HOURS);
      });
      expect(calls.count).toBeGreaterThan(before + 5000);
      expect(ms).toBeLessThan(10_000);
    }, 60_000);

    it('projects a 216,000-point series within a budget, and slices a window of it in a moment (AV-1019)', () => {
      const values = (index: number) => long.points[index]!.heartRateBpm;
      expect(best(3, () => void projectSeries(long, values, 'time'))).toBeLessThan(2500);
      const series = projectSeries(long, values, 'time')!;
      const ms = best(3, () => {
        for (let i = 0; i < 5000; i += 1) series.window(series.first + scatter(i) * 6 * HOURS, 60);
      });
      expect(ms).toBeLessThan(2000);
    }, 30_000);

    it('derives the grade and the heading for a 216,000-point ride within the timeline’s budget (AV-1019)', () => {
      expect(best(3, () => void buildOverlayTimeline(long, { video: { durationSeconds: 6 * HOURS } }))).toBeLessThan(4000);
    }, 30_000);

    it('projects a 216,000-point route within a budget', () => {
      expect(best(3, () => void projectRoute(long, 1.5))).toBeLessThan(2500);
    }, 30_000);

    it('costs the same per frame whether the ride is six minutes or six hours', () => {
      const frameCost = (activity: typeof medium, seconds: number) => {
        const tl = buildOverlayTimeline(activity, { video: { durationSeconds: seconds } });
        const t = buildOverlay(DEFAULT_OVERLAY_CONTROLS, tl, 16 / 9).template;
        const renderer = createOverlayRenderer({ template: t, timeline: tl, activity, units: 'metric', width: 1920, height: 1080 });
        renderer.drawFrame(ctx, 1); // projects the route once, outside the measurement
        return best(7, () => {
          for (let i = 0; i < 2000; i += 1) renderer.drawFrame(ctx, scatter(i) * seconds);
        });
      };
      // The route is thinned to a budget, so a recording 36× longer draws a route about 5× heavier
      // (3,000 points against 600), where drawing every point would cost 36× — and 360× at camera
      // rate. The line is drawn between the two, wide enough for a busy machine.
      expect(frameCost(medium, 6 * HOURS) / Math.max(frameCost(short, 600), 0.05)).toBeLessThan(20);
    }, 30_000);
  });

  describe('writing the archive', () => {
    it('streams thousands of frames through the ZIP writer within a budget, holding none of them', async () => {
      const frame = new Uint8Array(16_384).fill(7);
      let written = 0;
      let largestChunk = 0;
      const started = performance.now();
      const result = await runExport({
        frameCount: 3000,
        fps: 30,
        width: 1920,
        height: 1080,
        videoDurationSeconds: 100,
        telemetryOffsetSeconds: 0,
        templateName: 'perf',
        renderFrame: async () => frame,
        sink: {
          write: (chunk) => {
            written += chunk.length;
            largestChunk = Math.max(largestChunk, chunk.length);
          },
        },
      });
      const ms = performance.now() - started;
      expect(result.frameCount).toBe(3000);
      expect(written).toBeGreaterThan(3000 * 16_384);
      // Streamed: nothing larger than one frame (or the directory) was ever held at once.
      expect(largestChunk).toBeLessThan(3000 * 100);
      expect(ms).toBeLessThan(8000);
    }, 30_000);
  });
});
