import { describe, expect, it } from 'vitest';
import { computeStreams, type Activity, type ActivityPoint } from '../domain/activity';
import { exportFrameSequence, type FrameSurface } from './exportFrames';
import { createOverlayRenderer, type OverlayContext2D } from './renderOverlay';
import {
  availabilityOf,
  compactHudTemplate,
  gaugeDashboardTemplate,
  routeInsetTemplate,
  type OverlayTemplate,
} from './template';
import { addComponent } from './templateEdit';
import { buildTimeline, sampleTimeline } from './timeline';

/**
 * AV-1008. Long timelines, without committing a long video.
 *
 * Everything an overlay does scales with the length of the recording, not with
 * the video it will sit on, so a day-long track is simulated directly. The
 * absolute budgets are deliberately very loose — tens of times what a normal
 * laptop needs — and the real guard is the *ratio* tests below: if four times
 * the data takes about four times as long, the cost is linear whatever the
 * machine's speed or load. An accidental O(n²) shows up as sixteen.
 */

const T0 = Date.UTC(2024, 0, 1);

/** A winding track of `count` one-second points, with every sensor a watch records. */
function longActivity(count: number): Activity {
  const points: ActivityPoint[] = Array.from({ length: count }, (_, s) => ({
    index: s,
    time: new Date(T0 + s * 1000),
    lat: 42 + Math.sin(s / 900) * 0.05 + s * 1e-7,
    lon: -8 + Math.cos(s / 700) * 0.05,
    elevationMeters: 200 + Math.sin(s / 300) * 50,
    heartRateBpm: 120 + Math.round(Math.sin(s / 200) * 30),
    cyclingCadenceRpm: 80 + Math.round(Math.sin(s / 50) * 10),
    powerWatts: 200 + Math.round(Math.sin(s / 100) * 80),
  }));
  return {
    id: 'long',
    source: { format: 'gpx', parserVersion: 't' },
    metadata: {},
    points,
    streams: computeStreams(points),
    warnings: [],
  };
}

/** A context that accepts anything and does nothing: this measures our work, not a canvas's. */
const noop = new Proxy(
  {},
  {
    get: (_t, name) => (name === 'measureText' ? () => ({ width: 0 }) : () => undefined),
    set: () => true,
  },
) as unknown as OverlayContext2D;

const everything = (): OverlayTemplate => {
  let template = gaugeDashboardTemplate();
  template = { ...template, components: [...template.components, ...routeInsetTemplate().components, ...compactHudTemplate().components] };
  for (const metric of ['heartRate', 'power', 'elevation'] as const) {
    template = addComponent(template, { type: 'chart', binding: { kind: 'metric', metric } });
  }
  return template;
};

const SIX_HOURS = 6 * 3600;
const ONE_DAY = 24 * 3600;

/** Best of a few runs, so one slow moment on a busy machine does not decide the answer. */
function bestOf(runs: number, work: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('overlays at scale (AV-1008)', () => {
  it('prepares a day of one-second telemetry quickly', () => {
    const activity = longActivity(ONE_DAY);
    const started = performance.now();
    const result = buildTimeline(activity);
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it('answers a hundred thousand lookups in a day-long timeline quickly', () => {
    const result = buildTimeline(longActivity(ONE_DAY));
    if (!result.ok) throw new Error(result.reason);
    const started = performance.now();
    let answered = 0;
    for (let i = 0; i < 100_000; i += 1) {
      if (sampleTimeline(result.timeline, (i * 0.86) % ONE_DAY).status === 'ok') answered += 1;
    }
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(answered).toBe(100_000);
  }, 60_000);

  it('draws two minutes of video from a six-hour recording with every component on', () => {
    const activity = longActivity(SIX_HOURS);
    const timeline = buildTimeline(activity);
    if (!timeline.ok) throw new Error(timeline.reason);
    const renderer = createOverlayRenderer({
      activity,
      timeline: timeline.timeline,
      template: everything(),
      availability: availabilityOf(timeline.timeline),
    });
    expect(renderer.resolved.hidden).toEqual([]);

    const started = performance.now();
    // 2 minutes at 30 fps, from the middle of the recording.
    for (let frame = 0; frame < 3_600; frame += 1) {
      renderer.render(noop, 1920, 1080, frame / 30, 10_000);
    }
    // The route is projected once, not once per frame.
    expect(performance.now() - started).toBeLessThan(45_000);
  }, 60_000);

  it('exports a few thousand frames, end to end, without slowing down as it goes', async () => {
    const activity = longActivity(3600);
    const timeline = buildTimeline(activity);
    if (!timeline.ok) throw new Error(timeline.reason);
    const renderer = createOverlayRenderer({
      activity,
      timeline: timeline.timeline,
      template: everything(),
      availability: availabilityOf(timeline.timeline),
    });
    const surface: FrameSurface = { context: noop, toPng: async () => new Uint8Array(2_000) };

    const stamps: number[] = [];
    const started = performance.now();
    await exportFrameSequence({
      options: { fps: 30, width: 1920, height: 1080, startSeconds: 0, endSeconds: 100, offsetSeconds: 0 },
      renderer,
      baseName: 'scale',
      createSurface: () => surface,
      onArchive: () => undefined,
      onProgress: (p) => {
        if (p.framesDone % 500 === 0) stamps.push(performance.now());
      },
    });
    expect(performance.now() - started).toBeLessThan(60_000);

    // Steady: the last block of frames takes about as long as the first, so no
    // cost grows with the number of frames already written.
    const blocks = stamps.slice(1).map((t, i) => t - stamps[i]!);
    expect(blocks.length).toBeGreaterThan(3);
    expect(Math.max(...blocks)).toBeLessThan(Math.max(2_000, 8 * Math.min(...blocks)));
  }, 60_000);

  it('thins a huge route for the corner inset instead of stroking every point', () => {
    const activity = longActivity(SIX_HOURS);
    const timeline = buildTimeline(activity);
    if (!timeline.ok) throw new Error(timeline.reason);
    const renderer = createOverlayRenderer({
      activity,
      timeline: timeline.timeline,
      template: routeInsetTemplate(),
      availability: availabilityOf(timeline.timeline),
    });
    let strokedVertices = 0;
    const counting = new Proxy(
      {},
      {
        get: (_t, name) => {
          if (name === 'lineTo') return () => (strokedVertices += 1);
          if (name === 'measureText') return () => ({ width: 0 });
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as OverlayContext2D;
    renderer.render(counting, 1920, 1080, 100, 0);
    expect(strokedVertices).toBeLessThan(2_000);
  }, 60_000);

  describe('cost grows in proportion to the data, not faster', () => {
    // Four times the data should take about four times as long. Quadratic work
    // would take sixteen; the limit leaves room for memory and GC noise.
    const LIMIT = 9;

    it('preparing the timeline', () => {
      const small = longActivity(30_000);
      const large = longActivity(120_000);
      const tSmall = bestOf(3, () => buildTimeline(small));
      const tLarge = bestOf(3, () => buildTimeline(large));
      expect(tLarge / tSmall).toBeLessThan(LIMIT);
    }, 60_000);

    it('looking a moment up', () => {
      const build = (n: number) => {
        const r = buildTimeline(longActivity(n));
        if (!r.ok) throw new Error(r.reason);
        return r.timeline;
      };
      const small = build(30_000);
      const large = build(240_000);
      const lookups = (timeline: typeof small, span: number) => () => {
        for (let i = 0; i < 20_000; i += 1) sampleTimeline(timeline, (i * 7.3) % span);
      };
      const tSmall = bestOf(3, lookups(small, 30_000));
      const tLarge = bestOf(3, lookups(large, 240_000));
      // The same number of lookups in eight times the data. A binary search barely
      // notices (about 1); a scan from the start would take about eight times as long.
      expect(tLarge / tSmall).toBeLessThan(4);
    }, 60_000);

    it('drawing a frame, once the route has been projected', () => {
      const frameCost = (n: number) => {
        const activity = longActivity(n);
        const timeline = buildTimeline(activity);
        if (!timeline.ok) throw new Error(timeline.reason);
        const renderer = createOverlayRenderer({
          activity,
          timeline: timeline.timeline,
          template: everything(),
          availability: availabilityOf(timeline.timeline),
        });
        renderer.render(noop, 1920, 1080, 0, 0); // projects the route, once
        return bestOf(3, () => {
          for (let frame = 0; frame < 300; frame += 1) renderer.render(noop, 1920, 1080, frame / 30, 0);
        });
      };
      // A frame costs the same from a long recording as from a short one: the
      // route was thinned when it was projected, and a lookup is a binary search.
      expect(frameCost(120_000) / frameCost(10_000)).toBeLessThan(3);
    }, 60_000);

    it('making the frame sequence', async () => {
      const makeRun = async (frames: number) => {
        const activity = longActivity(3600);
        const timeline = buildTimeline(activity);
        if (!timeline.ok) throw new Error(timeline.reason);
        const renderer = createOverlayRenderer({
          activity,
          timeline: timeline.timeline,
          template: compactHudTemplate(),
          availability: availabilityOf(timeline.timeline),
        });
        const surface: FrameSurface = { context: noop, toPng: async () => new Uint8Array(500) };
        const started = performance.now();
        await exportFrameSequence({
          options: { fps: 100, width: 640, height: 360, startSeconds: 0, endSeconds: frames / 100, offsetSeconds: 0 },
          renderer,
          baseName: 'r',
          createSurface: () => surface,
          onArchive: () => undefined,
        });
        return performance.now() - started;
      };
      await makeRun(500); // warm up
      const small = Math.min(await makeRun(1_000), await makeRun(1_000));
      const large = Math.min(await makeRun(4_000), await makeRun(4_000));
      expect(large / small).toBeLessThan(LIMIT);
    }, 60_000);
  });
});
