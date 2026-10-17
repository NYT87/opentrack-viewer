import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, overlayCatalog, type OverlayControls } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { parseGpx } from '../../parsers/gpx/parseGpx';
import { readFixture } from '../../test/helpers/fixtures';

/**
 * AV-1008. Deterministic render tests: the overlay drawn at fixed timestamps of
 * the committed ride, compared with committed goldens.
 *
 * What is compared is the *display list* — every canvas call, with its
 * arguments and the colour, font and alpha in force — not pixels. Pixels depend
 * on the platform's fonts and anti-aliasing and would differ between a Mac and
 * a CI runner; the display list is a pure function of the template, the
 * activity and the time, so it is the same everywhere. (The browser tests read
 * real pixels, for what pixels can safely say: where it is transparent and
 * where it is not.)
 *
 * A change to the drawing shows up as a diff in `__golden__/`. If it is
 * intended, regenerate with `npx vitest run -u` and review the diff.
 */
const ride = parseGpx(readFixture('overlay-ride.gpx'), { fileName: 'overlay-ride.gpx', idFactory: () => 'ride' });
const clip = { durationSeconds: 6 };
const timeline = buildOverlayTimeline(ride, { video: clip });

const round = (value: unknown): string =>
  typeof value === 'number' ? String(Math.round(value * 100) / 100) : JSON.stringify(value);

/** Records every call on a context as one stable line of text. */
function displayList(draw: (ctx: OverlayContext2D) => void): string {
  const lines: string[] = [];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  const stateful = new Set(['fillText', 'fillRect', 'fill', 'stroke', 'arc']);
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        const call = `${key}(${args.map(round).join(', ')})`;
        if (!stateful.has(key)) return void lines.push(call);
        const style = key === 'stroke' ? `stroke=${round(target.strokeStyle)} width=${round(target.lineWidth)}` : `fill=${round(target.fillStyle)}`;
        const font = key === 'fillText' ? ` font=${round(target.font)}` : '';
        lines.push(`${call} ${style}${font} alpha=${round(target.globalAlpha)}`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as OverlayContext2D;
  draw(ctx);
  return `${lines.join('\n')}\n`;
}

function golden(controls: Partial<OverlayControls>, at: number, size: [number, number] = [1280, 720]) {
  const [width, height] = size;
  const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS, ...controls }, timeline, width / height);
  const renderer = createOverlayRenderer({ template, timeline, activity: ride, units: 'metric', width, height });
  return displayList((ctx) => renderer.drawFrame(ctx, at));
}

const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
const snapshot = (name: string) => `./__golden__/${name}.txt`;

describe('overlay render goldens (AV-1008)', () => {
  describe.each([
    ['metric-strip', 'metric-strip'],
    ['compact-hud', 'compact-hud'],
    ['route-inset', 'route-inset'],
  ] as const)('%s', (name, presetId) => {
    it.each([0, 2.5, 5])('at %s s', async (seconds) => {
      await expect(golden({ presetId }, seconds)).toMatchFileSnapshot(snapshot(`${name}-t${String(seconds).replace('.', '_')}`));
    });
  });

  it('draws every component at once, at 5 s', async () => {
    await expect(golden({ enabled: everything }, 5)).toMatchFileSnapshot(snapshot('everything-t5'));
  });

  it('draws a portrait frame with shorter tiles, at 2.5 s', async () => {
    await expect(golden({ presetId: 'compact-hud', enabled: everything }, 2.5, [720, 1280])).toMatchFileSnapshot(
      snapshot('compact-hud-portrait-t2_5'),
    );
  });

  it('draws imperial units, at 5 s', async () => {
    await expect(golden({ unitMode: 'imperial' }, 5)).toMatchFileSnapshot(snapshot('metric-strip-imperial-t5'));
  });

  it('draws nothing but the clear outside the ride, so the frame stays transparent', async () => {
    const outside = golden({}, 99);
    expect(outside).toBe('clearRect(0, 0, 1280, 720)\n');
    await expect(outside).toMatchFileSnapshot(snapshot('outside-the-ride'));
  });

  it('is the same every time it is drawn: a pure function of template, data and time', () => {
    expect(golden({ enabled: everything }, 3.25)).toBe(golden({ enabled: everything }, 3.25));
    // And the frames either side of it differ, so the goldens are not blind to time.
    expect(golden({}, 3.25)).not.toBe(golden({}, 3.5));
  });

  it('states the values of the formulae at the timestamps the goldens use', () => {
    // 4 + 0.2 t m/s at 5 s is 5 m/s, 18.0 km/h; heart rate 100 + t.
    const list = golden({}, 5);
    expect(list).toContain('fillText("18.0 km/h"');
    expect(list).toContain('fillText("105 bpm"');
    expect(list).toContain('fillText("105 m"');
    expect(list).toContain('fillText("0:05"');
  });
});
