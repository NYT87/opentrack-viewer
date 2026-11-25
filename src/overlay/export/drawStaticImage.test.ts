import { describe, expect, it } from 'vitest';
import { drawStillImage, renderStillImagePng, stillImageFileName } from './drawStaticImage';
import { defaultStaticLayout, planStillImage, type MeasureText, type StillImagePlan } from '../staticImage';
import { extractRoute } from '../routeImage';
import type { OverlayComponent } from '../template';
import type { OverlayContext2D } from './drawOverlay';
import { makeActivity } from '../../test/helpers/activity';

const measure: MeasureText = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)![1]) * 0.5;
const ride = makeActivity(Array.from({ length: 10 }, (_, i) => ({ lat: 46 + i * 0.001, lon: 7 + i * 0.001 })));

/** Records every call and every font, colour and alignment in force at a `fillText`. */
function recorder() {
  const calls: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        const at = key === 'fillText' ? ` [${String(target.font)} ${String(target.fillStyle)} ${String(target.textAlign)}]` : '';
        calls.push(`${key}(${args.map((arg) => (typeof arg === 'number' ? Math.round(arg) : JSON.stringify(arg))).join(', ')})${at}`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as OverlayContext2D;
  return { ctx, calls };
}

function plan(components: OverlayComponent[]): StillImagePlan {
  const layout = defaultStaticLayout(800, 400);
  const planned = planStillImage(
    { ...layout, template: { ...layout.template, components: [...layout.template.components, ...components] } },
    { activity: ride, route: extractRoute(ride), units: 'metric' },
    measure,
  );
  if (!planned.ok) throw planned.error;
  return planned.plan;
}

const text = (content: string): OverlayComponent => ({
  id: 'text-1',
  type: 'label',
  visible: true,
  rect: { x: 0.5, y: 0.5, width: 0.01, height: 0.01 },
  unitMode: 'auto',
  style: { textColor: '#ffcc00', fontScale: 1 },
  content,
  text: { align: 'center', weight: 'bold' },
});

describe('drawing the still image (AV-1010)', () => {
  it('clears to transparent, strokes the route, then writes each text where it was planned', () => {
    const { ctx, calls } = recorder();
    const still = plan([text('Day 1')]);
    drawStillImage(ctx, still);
    expect(calls[0]).toBe('clearRect(0, 0, 800, 400)');
    expect(calls.some((call) => call.startsWith('stroke('))).toBe(true);
    const item = still.items[1]!;
    if (item.kind !== 'text') throw new Error('not text');
    const line = item.lines[0]!;
    expect(calls).toContain(
      `fillText("Day 1", ${Math.round(line.x)}, ${Math.round(line.y)}) [${line.font} #ffcc00 center]`,
    );
    expect(line.font).toMatch(/system-ui/);
    expect(calls.findIndex((call) => call.startsWith('fillText'))).toBeGreaterThan(calls.findIndex((call) => call.startsWith('stroke(')));
  });

  it('writes markup and symbols as the characters they are, never reading them', () => {
    const { ctx, calls } = recorder();
    drawStillImage(ctx, plan([text('<img src=x onerror=alert(1)> & "quotes"')]));
    expect(calls.find((call) => call.startsWith('fillText'))).toContain(
      'fillText("<img src=x onerror=alert(1)> & \\"quotes\\""',
    );
  });

  it('encodes a PNG through the canvas it is given', async () => {
    const { ctx, calls } = recorder();
    const png = await renderStillImagePng(plan([text('x')]), {
      createCanvas: (width, height) => {
        calls.push(`canvas ${width}x${height}`);
        return { getContext: () => ctx, toPng: () => Promise.resolve(new Blob([new Uint8Array(8)], { type: 'image/png' })) };
      },
    });
    expect(png.type).toBe('image/png');
    expect(calls[0]).toBe('canvas 800x400');
    expect(calls.some((call) => call.startsWith('fillText'))).toBe(true);
  });

  it('is named for what it is: a route alone keeps AV-1009’s name', () => {
    expect(stillImageFileName(plan([]))).toBe('route-overlay-800x400.png');
    expect(stillImageFileName(plan([text('x')]))).toBe('overlay-image-800x400.png');
  });
});
