import { describe, expect, it } from 'vitest';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';
import { createOverlayRenderer, type OverlayContext2D } from './renderOverlay';
import {
  availabilityOf,
  compactHudTemplate,
  gaugeDashboardTemplate,
  routeInsetTemplate,
  type OverlayTemplate,
} from './template';
import { buildTimeline } from './timeline';

/**
 * AV-1008. Golden frames: each built-in template, drawn from a real fixture at
 * fixed video times, recorded as the exact sequence of drawing calls.
 *
 * The calls, not the pixels. Pixels depend on the machine's fonts and
 * anti-aliasing, so a pixel golden would pass here and fail on someone else's
 * laptop for reasons that have nothing to do with the overlay. The call log is
 * what the renderer *decides* — what to draw, where, in what colour, at what
 * size — and it is identical everywhere. Text width is faked from the font size
 * so the layout logic that depends on it is exercised the same way each time.
 *
 * A snapshot that changes is a visible change to what users see. Review it like
 * a screenshot diff: if the new frame is what was intended, update the snapshot.
 */

const STYLE_PROPERTIES = new Set([
  'font',
  'fillStyle',
  'strokeStyle',
  'globalAlpha',
  'lineWidth',
  'lineCap',
  'lineJoin',
  'textAlign',
  'textBaseline',
]);

const round = (value: unknown): string => {
  if (typeof value === 'number') return String(Number(value.toFixed(2)));
  // Font sizes carry floating-point noise; round the number inside the string.
  if (typeof value === 'string') return value.replace(/(\d+\.\d+)px/g, (_m, n) => `${Number(Number(n).toFixed(2))}px`);
  return String(value);
};

function logContext() {
  const lines: string[] = [];
  const state: Record<string, unknown> = { font: '10px sans-serif', globalAlpha: 1 };
  const context = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (STYLE_PROPERTIES.has(name)) return state[name];
        if (name === 'measureText') {
          return (text: string) => {
            const size = Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10);
            return { width: text.length * size * 0.55 };
          };
        }
        return (...args: unknown[]) => {
          lines.push(`${name}(${args.map(round).join(', ')})`);
        };
      },
      set: (_target, name: string, value: unknown) => {
        state[name] = value;
        lines.push(`${name} = ${round(value)}`);
        return true;
      },
    },
  ) as unknown as OverlayContext2D;
  return { context, lines };
}

const W = 1280;
const H = 720;

function frame(fixture: string, template: OverlayTemplate, videoSeconds: number, offset = 0): string {
  const activity = parseGpx(readFixture(fixture), { fileName: fixture, idFactory: () => 'golden' });
  const result = buildTimeline(activity);
  if (!result.ok) throw new Error(result.reason);
  const renderer = createOverlayRenderer({
    activity,
    timeline: result.timeline,
    template,
    availability: availabilityOf(result.timeline),
  });
  const { context, lines } = logContext();
  renderer.render(context, W, H, videoSeconds, offset);
  return lines.join('\n');
}

const TEMPLATES = [
  ['compact HUD', compactHudTemplate],
  ['route inset', routeInsetTemplate],
  ['gauge dashboard', gaugeDashboardTemplate],
] as const;

describe('golden overlay frames (AV-1008)', () => {
  describe('a clean recording', () => {
    for (const [name, make] of TEMPLATES) {
      for (const t of [0, 5.5, 10]) {
        it(`${name} at ${t} s`, () => {
          expect(frame('overlay-sync.gpx', make('metric'), t)).toMatchSnapshot();
        });
      }
    }
  });

  describe('a recording with a pause and a missing reading', () => {
    // Seconds 0–4, a pause, then 8–11; heart rate is missing at second 2.
    const moments: [string, number][] = [
      ['before the pause', 1],
      ['at the missing heart-rate reading', 2],
      ['inside the pause', 6],
      ['after the pause', 9.5],
      ['past the end', 30],
    ];
    for (const [name, make] of TEMPLATES) {
      for (const [when, t] of moments) {
        it(`${name}, ${when}`, () => {
          const template = make('metric');
          // Enable every readout so the missing reading is what decides the frame.
          for (const c of template.components) c.visible = true;
          expect(frame('overlay-gaps.gpx', template, t)).toMatchSnapshot();
        });
      }
    }
  });

  it('compact HUD in imperial units', () => {
    expect(frame('overlay-sync.gpx', compactHudTemplate('imperial'), 5)).toMatchSnapshot();
  });

  it('the same moment, reached through the offset instead of the video time', () => {
    const direct = frame('overlay-sync.gpx', compactHudTemplate(), 5);
    const shifted = frame('overlay-sync.gpx', compactHudTemplate(), 2, 3);
    expect(shifted).toBe(direct);
  });

  describe('what each frame is made of', () => {
    it('draws nothing but a clear before the telemetry begins', () => {
      const log = frame('overlay-sync.gpx', compactHudTemplate(), -1);
      expect(log.startsWith(`clearRect(0, 0, ${W}, ${H})`)).toBe(true);
      expect(log).not.toMatch(/fillText|fillRect|stroke\(|fill\(|arc\(|lineTo/);
    });

    it('draws nothing from the telemetry inside a pause, except the route', () => {
      const log = frame('overlay-gaps.gpx', routeInsetTemplate(), 6);
      expect(log).toContain('lineTo');
      // No marker: a dot there would say where the athlete was while not recording.
      expect(log).not.toContain('arc(');
    });

    it('is the same every time it is drawn', () => {
      expect(frame('overlay-gaps.gpx', gaugeDashboardTemplate(), 2)).toBe(
        frame('overlay-gaps.gpx', gaugeDashboardTemplate(), 2),
      );
    });
  });
});
