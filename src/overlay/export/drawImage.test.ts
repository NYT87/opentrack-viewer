import { describe, expect, it } from 'vitest';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { buildOverlayTimeline } from '../timeline';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayComponent, type OverlayTemplate } from '../template';
import type { ImageFit } from '../imageSetting';
import { makeActivity } from '../../test/helpers/activity';

/** AV-1030 (TD-102). What the renderer asks of the canvas for an image: the rectangles, the alpha, the clip. */
function spyContext() {
  const calls: { op: string; args: unknown[]; alpha: number }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, font: '10px sans-serif' };
  const stack: number[] = [];
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key === 'save') return () => void stack.push(target.globalAlpha as number);
      if (key === 'restore') return () => void (target.globalAlpha = stack.pop() ?? 1);
      if (key in target) return target[key];
      return (...args: unknown[]) => void calls.push({ op: key, args, alpha: target.globalAlpha as number });
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as OverlayContext2D;
  return { ctx, ops: (name: string) => calls.filter((call) => call.op === name) };
}

const activity = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: new Date(i * 1000), lat: 10 + i * 0.001, lon: 20, distanceMeters: i * 10, speedMetersPerSecond: i })));
const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 10 } });

const image = (extra: Partial<OverlayComponent> = {}, fit: ImageFit = 'contain', opacity = 1): OverlayComponent => ({
  id: 'logo',
  type: 'image',
  visible: true,
  rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  unitMode: 'auto',
  style: {},
  image: { src: 'data:image/png;base64,AAAA', fit, opacity },
  ...extra,
});
const template = (...components: OverlayComponent[]): OverlayTemplate => ({ version: OVERLAY_TEMPLATE_VERSION, name: 't', style: DEFAULT_OVERLAY_STYLE, components });
const picture = (width: number, height: number) => ({ width, height }) as unknown as CanvasImageSource;

function draw(components: OverlayComponent[], options: { at?: number; width?: number; height?: number; images?: Map<string, CanvasImageSource>; frameWidth?: number; placeholders?: ReadonlySet<string>; ghostHidden?: boolean } = {}) {
  const { width = 400, height = 200 } = options;
  const renderer = createOverlayRenderer({ template: template(...components), timeline, activity, units: 'metric', width, height, images: options.images, frameWidth: options.frameWidth });
  const spy = spyContext();
  renderer.drawFrame(spy.ctx, options.at ?? 5, { placeholders: options.placeholders, ghostHidden: options.ghostHidden });
  return spy;
}

describe('drawing an image component (AV-1030, TD-102)', () => {
  it('draws the picture fitted in its box, clipped to it, with no background or halo', () => {
    const source = picture(100, 100);
    const { ops } = draw([image()], { images: new Map([['logo', source]]) });
    // Box 200 x 100 at (100, 50): a square contained is 100 x 100, centred across.
    expect(ops('drawImage')).toHaveLength(1);
    expect(ops('drawImage')[0]!.args).toEqual([source, 0, 0, 100, 100, 150, 50, 100, 100]);
    expect(ops('rect')[0]!.args).toEqual([100, 50, 200, 100]);
    expect(ops('clip')).toHaveLength(1);
    expect(ops('fill')).toEqual([]);
    expect(ops('fillRect')).toEqual([]);
    expect(ops('fillText')).toEqual([]);
  });

  it('uses each fit: cover crops the source, stretch fills, original is natural size clipped', () => {
    const at = (fit: ImageFit, width: number, height: number) => draw([image({}, fit)], { images: new Map([['logo', picture(width, height)]]) }).ops('drawImage')[0]!.args.slice(1);
    expect(at('cover', 100, 100)).toEqual([0, 25, 100, 50, 100, 50, 200, 100]);
    expect(at('stretch', 10, 300)).toEqual([0, 0, 10, 300, 100, 50, 200, 100]);
    expect(at('original', 400, 100)).toEqual([100, 0, 200, 100, 100, 50, 200, 100]);
  });

  it('draws “Original size” at the output frame’s pixels: a preview scales them by its share of the frame', () => {
    // The preview is 400 wide for a 1600-wide frame: a 400 x 100 picture is 100 x 25 there.
    const args = draw([image({}, 'original')], { images: new Map([['logo', picture(400, 100)]]), frameWidth: 1600 }).ops('drawImage')[0]!.args;
    expect(args.slice(1)).toEqual([0, 0, 400, 100, 150, 87.5, 100, 25]);
  });

  it('multiplies the image’s opacity into the alpha it is drawn with', () => {
    const { ops } = draw([image({}, 'contain', 0.4)], { images: new Map([['logo', picture(10, 10)]]) });
    expect(ops('drawImage')[0]!.alpha).toBeCloseTo(0.4);
  });

  it('multiplies it into a fade (AV-1029): half way in, at 60 % opacity, is 30 %', () => {
    const faded = image({ visibility: { from: 4, to: 8, fadeIn: 2 } }, 'contain', 0.6);
    const { ops } = draw([faded], { at: 5, images: new Map([['logo', picture(10, 10)]]) });
    expect(ops('drawImage')[0]!.alpha).toBeCloseTo(0.3);
    // Outside the window nothing is drawn; the editor's ghost is the one place it is, faded.
    expect(draw([faded], { at: 9, images: new Map([['logo', picture(10, 10)]]) }).ops('drawImage')).toEqual([]);
    expect(draw([faded], { at: 9, ghostHidden: true, images: new Map([['logo', picture(10, 10)]]) }).ops('drawImage')[0]!.alpha).toBeCloseTo(0.3 * 0.6);
  });

  it('draws it whether or not the activity reaches this moment, and not when switched off', () => {
    const images = new Map([['logo', picture(10, 10)]]);
    expect(draw([image()], { at: 99, images }).ops('drawImage')).toHaveLength(1);
    expect(draw([image({ visible: false })], { images }).ops('drawImage')).toEqual([]);
  });

  it('draws nothing when it has no decoded picture, and a box that says so in a preview alone', () => {
    expect(draw([image()]).ops('drawImage')).toEqual([]);
    expect(draw([image()]).ops('fillText')).toEqual([]);
    // One still decoding is not one known to be unreadable.
    expect(draw([image()], { placeholders: new Set(['other']) }).ops('fillText')).toEqual([]);
    const preview = draw([image()], { placeholders: new Set(['logo']) });
    expect(preview.ops('fillText')[0]!.args[0]).toBe('Image could not be read');
    expect(preview.ops('drawImage')).toEqual([]);
  });

  it('draws in layer order with the other components', () => {
    const shape: OverlayComponent = { id: 'card', type: 'shape', visible: true, rect: { x: 0, y: 0, width: 1, height: 1 }, unitMode: 'auto', style: {}, shape: { kind: 'rect', fill: '#000000', fillOpacity: 1, stroke: '#ffffff', strokeOpacity: 0, strokeWidth: 0, radius: 0 } };
    const { ops } = draw([shape, image()], { images: new Map([['logo', picture(10, 10)]]) });
    expect(ops('fillRect').length + ops('fill').length).toBeGreaterThan(0);
    expect(ops('drawImage')).toHaveLength(1);
  });
});
