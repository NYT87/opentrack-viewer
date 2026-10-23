import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, overlayCatalog, type OverlayControls } from '../presets';
import { buildOverlayTimeline } from '../timeline';
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
