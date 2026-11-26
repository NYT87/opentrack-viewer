import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, overlayCatalog, type OverlayControls } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { resolveOverlayComponent, DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayTemplate } from '../template';
import { makeActivity } from '../../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

/** A context that records what is drawn and with which font, instead of drawing. */
function recordingContext() {
  const calls: { op: string; args: unknown[]; font?: string; fillStyle?: unknown }[] = [];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    fillStyle: '#000',
    globalAlpha: 1,
  };
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args, font: String(state.font), fillStyle: state.fillStyle });
  };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return record(key);
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as OverlayContext2D;
  return { ctx, calls, ops: (name: string) => calls.filter((call) => call.op === name) };
}

const activity = (extra: (i: number) => object = () => ({})) =>
  makeActivity(
    Array.from({ length: 11 }, (_, i) => ({
      time: at(i),
      lat: 10 + i * 0.001,
      lon: 20 + i * 0.001,
      distanceMeters: i * 10,
      speedMetersPerSecond: i,
      ...extra(i),
    })),
  );

function render(options: {
  controls?: Partial<OverlayControls>;
  width?: number;
  height?: number;
  at?: number;
  source?: ReturnType<typeof activity>;
}) {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const source = options.source ?? activity();
  const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 } });
  const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS, ...options.controls }, timeline, width / height);
  const renderer = createOverlayRenderer({ template, timeline, activity: source, units: 'metric', width, height });
  const recording = recordingContext();
  renderer.drawFrame(recording.ctx, options.at ?? 5);
  return { ...recording, template, width, height };
}

const texts = (calls: ReturnType<typeof render>) => calls.ops('fillText').map((call) => String(call.args[0]));

describe('drawing the overlay on a canvas (AV-1006)', () => {
  it('starts every frame by clearing to transparent, and never paints a backdrop', () => {
    const drawn = render({});
    expect(drawn.calls[0]).toMatchObject({ op: 'clearRect', args: [0, 0, 1920, 1080] });
    // Nothing covers the frame: no fill spans it, so what is not overlay stays clear.
    const full = drawn.ops('fillRect').filter((call) => call.args[2] === 1920 && call.args[3] === 1080);
    expect(full).toEqual([]);
    expect(drawn.ops('drawImage')).toEqual([]);
  });

  it("draws each figure's label and value from the same resolution the preview uses", () => {
    const drawn = render({ at: 5 });
    expect(texts(drawn)).toEqual(expect.arrayContaining(['SPEED', '18.0 km/h', 'DISTANCE', '50 m', 'TIME', '0:05']));
  });

  it('draws nothing for a component whose data is missing', () => {
    // The default template switches heart rate on; this activity has none.
    expect(texts(render({}))).not.toContain('HEART RATE');
    expect(texts(render({ source: activity((i) => ({ heartRateBpm: 100 + i })) }))).toContain('HEART RATE');
  });

  it('draws nothing outside the recording, but still clears', () => {
    const drawn = render({ at: 99 });
    expect(drawn.calls.map((call) => call.op)).toEqual(['clearRect']);
  });

  it('scales type and boxes with the picture size', () => {
    const fontPx = (drawn: ReturnType<typeof render>) =>
      parseFloat(/bold ([\d.]+)px/.exec(drawn.ops('fillText').find((call) => call.font?.includes('bold'))!.font!)![1]!);
    const hd = render({ width: 1920, height: 1080 });
    const uhd = render({ width: 3840, height: 2160 });
    expect(fontPx(uhd)).toBeCloseTo(fontPx(hd) * 2, 5);
    // 2.2% of the frame width, times 1.1 for a value, at scale 1.
    expect(fontPx(hd)).toBeCloseTo(0.022 * 1920 * 1.1, 5);
    const firstBox = (drawn: ReturnType<typeof render>) => drawn.ops('roundRect')[0]!.args as number[];
    expect(firstBox(uhd)[2]).toBeCloseTo(firstBox(hd)[2]! * 2, 5);
  });

  it("draws a gauge's track and the fraction of it that is full", () => {
    const drawn = render({
      controls: { presetId: 'compact-hud' },
      source: activity((i) => ({ heartRateBpm: i === 5 ? 125 : 100 + i * 5 })),
      at: 5,
    });
    const fills = drawn.ops('fillRect');
    const track = fills.find((call) => call.fillStyle === 'rgb(255 255 255 / 0.25)')!;
    const bar = fills[fills.indexOf(track) + 1]!;
    const trackWidth = track.args[2] as number;
    expect(bar.args[2] as number).toBeCloseTo(trackWidth * ((125 - 50) / 150), 5);
  });

  it('draws the route as lines and the current position as one dot', () => {
    const drawn = render({ controls: { presetId: 'route-inset' }, at: 5 });
    expect(drawn.ops('moveTo').length).toBe(1);
    expect(drawn.ops('lineTo').length).toBe(10);
    expect(drawn.ops('stroke').length).toBe(1);
    expect(drawn.ops('arc').length).toBe(1);
  });

  describe('the privacy trim (AV-1022, TD-091)', () => {
    // Eleven points a second apart, about 157 m between them: 0.3 hides the first three seconds, 0.2 the last two.
    const trimmed = { presetId: 'route-inset' as const, privacyTrim: { start: 0.3, end: 0.2 } };

    it('draws the kept route with the marker, and no marker in a hidden stretch', () => {
      expect(render({ controls: trimmed, at: 5 }).ops('arc').length).toBe(1);
      for (const hidden of [0, 1, 2.5, 8.5, 10]) {
        const drawn = render({ controls: trimmed, at: hidden });
        expect(drawn.ops('arc').length, `at ${hidden} s`).toBe(0);
        // The kept route is still drawn: only the marker goes.
        expect(drawn.ops('stroke').length).toBe(1);
      }
      // Just inside each cut it is drawn again.
      expect(render({ controls: trimmed, at: 3.1 }).ops('arc').length).toBe(1);
      expect(render({ controls: trimmed, at: 7.9 }).ops('arc').length).toBe(1);
    });

    it('draws only the kept part of the line: fewer points, and none of the hidden ends', () => {
      const whole = render({ controls: { presetId: 'route-inset' }, at: 5 });
      const drawn = render({ controls: trimmed, at: 5 });
      // The whole route is ten legs; the kept half of it, five (cut ends interpolated, a cut a hair off a vertex keeps one more).
      expect(whole.ops('lineTo').length).toBe(10);
      expect(drawn.ops('lineTo').length).toBeGreaterThanOrEqual(5);
      expect(drawn.ops('lineTo').length).toBeLessThanOrEqual(6);
    });

    it('still draws a short route under a trim, with no 100 m floor', () => {
      const small = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: at(i), lat: 10 + i * 0.0001, lon: 20, distanceMeters: i * 1.5 })));
      const drawn = render({ controls: { presetId: 'route-inset', privacyTrim: { start: 0.2, end: 0.2 } }, source: small, at: 5 });
      expect(drawn.ops('stroke').length).toBeGreaterThan(0);
    });

    it('changes nothing for a trim of nothing', () => {
      const same = render({ controls: { presetId: 'route-inset', privacyTrim: { start: 0, end: 0 } }, at: 5 });
      expect(same.calls).toEqual(render({ controls: { presetId: 'route-inset' }, at: 5 }).calls);
    });
  });

  it('fills the progress bar to the fraction elapsed', () => {
    const drawn = render({ controls: { enabled: { progress: true } }, at: 5 });
    const component = drawn.template.components.find((c) => c.id === 'progress')!;
    const width = component.rect.width * drawn.width;
    const fills = drawn.ops('fillRect').filter((call) => call.args[3] === component.rect.height * drawn.height);
    expect(fills.map((call) => call.args[2] as number)).toEqual([width, expect.closeTo(width * 0.5, 5)]);
  });

  it('keeps each component inside its own box', () => {
    const drawn = render({});
    expect(drawn.ops('clip').length).toBe(drawn.template.components.length);
    expect(drawn.ops('save').length).toBe(drawn.ops('restore').length);
  });

  it('omits the backdrop when the background is set to none', () => {
    const drawn = render({ controls: { backgroundOpacity: 0 } });
    // (The route's position dot is a fill too, in the accent colour, not a backdrop.)
    const backdrops = drawn.ops('fill').filter((call) => String(call.fillStyle).startsWith('rgb(0 0 0'));
    expect(backdrops).toEqual([]);
    expect(render({}).ops('fill').some((call) => String(call.fillStyle).startsWith('rgb(0 0 0'))).toBe(true);
  });

  it('works with a context that has no roundRect', () => {
    const { ctx, calls } = recordingContext();
    (ctx as unknown as { roundRect: undefined }).roundRect = undefined;
    const source = activity();
    const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 } });
    const { template } = buildOverlay(DEFAULT_OVERLAY_CONTROLS, timeline);
    createOverlayRenderer({ template, timeline, activity: source, units: 'metric', width: 640, height: 360 }).drawFrame(ctx, 5);
    expect(calls.some((call) => call.op === 'rect')).toBe(true);
  });

  it('draws every kind of component the catalog offers without error', () => {
    const source = {
      ...activity((i) => ({ heartRateBpm: 120, powerWatts: 200, runningCadenceSpm: 80, cyclingCadenceRpm: 90, elevationMeters: 5 + i })),
      sensorStreams: [{ key: 'ACCL', label: 'Acceleration', unit: 'm/s²', display: 'chart' as const, valuesByPoint: Array.from({ length: 11 }, (_, i) => i) }],
    };
    const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 } });
    const enabled = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
    const drawn = render({ source, controls: { enabled } });
    expect(texts(drawn)).toEqual(expect.arrayContaining(['ACCELERATION', '5 m/s²', 'POWER', '200 W']));
  });
});

describe('figures on a clear background (TD-059)', () => {
  it('draws the same halo under the type as the preview, below the halo opacity', async () => {
    const { needsHalo, HALO_BELOW_OPACITY } = await import('../template');
    expect(needsHalo({ backgroundOpacity: 0 })).toBe(true);
    expect(needsHalo({ backgroundOpacity: HALO_BELOW_OPACITY })).toBe(false);
  });
});

describe('smoothed figures (AV-1016)', () => {
  it('draws the same number the preview resolves, from the same timeline, and a frame depends on no other', () => {
    const source = activity((i) => ({ powerWatts: 100 + 10 * i }));
    const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 } });
    const template: OverlayTemplate = {
      version: OVERLAY_TEMPLATE_VERSION,
      name: 'Smoothed',
      style: DEFAULT_OVERLAY_STYLE,
      components: [
        { id: 'power', type: 'text', visible: true, rect: { x: 0.05, y: 0.05, width: 0.2, height: 0.1 }, unitMode: 'auto', style: {}, source: { kind: 'metric', metric: 'power' }, smoothing: { windowSeconds: 4 } },
      ],
    };
    const renderer = createOverlayRenderer({ template, timeline, activity: source, units: 'metric', width: 1920, height: 1080 });
    const drawnAt = (time: number) => {
      const recording = recordingContext();
      renderer.drawFrame(recording.ctx, time);
      return recording.ops('fillText').map((call) => String(call.args[0]));
    };
    const previewAt = (time: number) =>
      (resolveOverlayComponent(template, template.components[0]!, timeline.sampleAt(time), timeline, 'metric') as { text: string }).text;
    // Seconds 4..8 of 100 + 10 s average 160 W; the raw value would be 180 W.
    expect(drawnAt(8)).toContain('160 W');
    expect(drawnAt(8)).toContain(previewAt(8));
    // Out of order and repeated, the same.
    const frames = [9, 2, 8, 2, 9].map(drawnAt);
    expect(frames[2]).toEqual(drawnAt(8));
    expect(frames[1]).toEqual(frames[3]);
    expect(frames[0]).toContain(previewAt(9));
  });
});

describe('components shown for part of the video (AV-1029, TD-101)', () => {
  const source = activity();
  const draw = (visibility: object | undefined, time: number, options?: { ghostHidden?: boolean }, cutStartSeconds?: number) => {
    const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 }, cutStartSeconds });
    const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS }, timeline, 16 / 9);
    const timed: OverlayTemplate = { ...template, components: template.components.filter((c) => c.id === template.components[0]!.id).map((c) => ({ ...c, ...(visibility ? { visibility } : {}) })) as never };
    const renderer = createOverlayRenderer({ template: timed, timeline, activity: source, units: 'metric', width: 1920, height: 1080 });
    const recording = recordingContext();
    renderer.drawFrame(recording.ctx, time, options);
    return { ...recording, renderer, template: timed };
  };
  // The alpha each fillText was drawn at: the proxy records state per call only for the font, so read it from a spy.
  const alphas = (visibility: object | undefined, time: number) => {
    const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 } });
    const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS }, timeline, 16 / 9);
    const timed = { ...template, components: [{ ...template.components[0]!, visibility }] } as OverlayTemplate;
    const state: Record<string, unknown> = { font: '10px sans-serif', fillStyle: '#000', globalAlpha: 1 };
    const seen: number[] = [];
    const stack: unknown[] = [];
    const ctx = new Proxy(state, {
      get: (target, key: string) => (key === 'save' ? () => stack.push(target.globalAlpha) : key === 'restore' ? () => ((target.globalAlpha = stack.pop()), undefined) : key in target ? target[key] : key === 'fillText' ? () => seen.push(target.globalAlpha as number) : key === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: (target, key: string, value) => ((target[key] = value), true),
    }) as unknown as OverlayContext2D;
    createOverlayRenderer({ template: timed, timeline, activity: source, units: 'metric', width: 1920, height: 1080 }).drawFrame(ctx, time);
    return { seen, final: state.globalAlpha };
  };

  it('draws a component only within [from, to), at the frame boundaries', () => {
    const window = { from: 2, to: 4 };
    const drawn = (t: number) => draw(window, t).ops('fillText').length > 0;
    // 30 fps: the frame before, the first, the last and the one after.
    expect([1.966, 2, 3.966, 4].map(drawn)).toEqual([false, true, true, false]);
    expect(draw(undefined, 0).ops('fillText').length).toBeGreaterThan(0);
  });

  it('keeps the window where it is under a cut, which is in the video\'s own seconds', () => {
    const window = { from: 4, to: 6 };
    const drawn = (t: number) => draw(window, t, undefined, 3).ops('fillText').length > 0;
    // The cut starts at 3 s: the window is still 4 to 6 in the video, not 7 to 9.
    expect([3.5, 4.5, 5.5, 6.5].map(drawn)).toEqual([false, true, true, false]);
  });

  it('multiplies the fade into what the component draws, labels at 0.75 included, and leaves the context as it found it', () => {
    const full = alphas(undefined, 5);
    expect(new Set(full.seen)).toEqual(new Set([0.75, 1]));
    const faded = alphas({ from: 4, fadeIn: 2 }, 5);
    expect(faded.seen.length).toBe(full.seen.length);
    expect(faded.seen.map((a) => Math.round(a * 1000) / 1000)).toEqual(full.seen.map((a) => Math.round(a * 0.5 * 1000) / 1000));
    expect(faded.final).toBe(1);
  });

  it('draws nothing for a hidden component, unless the editor asks for a ghost: faded, with a dashed outline', () => {
    const window = { from: 8, to: 9 };
    expect(draw(window, 2).calls.map((call) => call.op)).toEqual(['clearRect']);
    const ghost = draw(window, 2, { ghostHidden: true });
    expect(ghost.ops('fillText').length).toBeGreaterThan(0);
    expect(ghost.ops('setLineDash')[0]?.args).toEqual([[6, 4]]);
    expect(ghost.ops('strokeRect')).toHaveLength(1);
    // Inside its window nothing is added.
    expect(draw(window, 8.5, { ghostHidden: true }).ops('strokeRect')).toEqual([]);
    expect(alphas(window, 2).seen).toEqual([]);
  });

  it('asks for no map tile for an inset that is not shown', () => {
    const timeline = buildOverlayTimeline(source, { video: { durationSeconds: 10 } });
    const base = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS }, timeline, 16 / 9).template;
    const inset = { id: 'm', type: 'routeInset' as const, visible: true, rect: { x: 0.7, y: 0.1, width: 0.25, height: 0.25 }, unitMode: 'auto' as const, style: {}, routeInset: { map: { style: 'osm' } } } as never;
    const ids = (visibility?: object) =>
      createOverlayRenderer({ template: { ...base, components: [{ ...(inset as object), ...(visibility ? { visibility } : {}) }] } as OverlayTemplate, timeline, activity: source, units: 'metric', width: 1920, height: 1080 }).insetsAt(5);
    expect(ids()).toEqual(['m']);
    expect(ids({ from: 8 })).toEqual([]);
    expect(ids({ from: 8, to: 9 })).toEqual([]);
  });
});
