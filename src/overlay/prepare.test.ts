import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsPreparing, prepareExportInputs } from './prepare';
import { canvasTemplate } from './customCanvas';
import type { OverlayComponent } from './template';
import { stubFonts } from '../test/helpers/fonts';

const text = (style: OverlayComponent['style'] = {}): OverlayComponent => ({ id: 'a', type: 'text', visible: true, rect: { x: 0, y: 0, width: 0.2, height: 0.1 }, unitMode: 'auto', style, source: { kind: 'metric', metric: 'speed' } });
const PNG = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\n.....')}`;
const picture: OverlayComponent = { id: 'logo', type: 'image', visible: true, rect: { x: 0, y: 0, width: 0.2, height: 0.2 }, unitMode: 'auto', style: {}, image: { src: PNG, fit: 'contain', opacity: 1 } };

let fonts: ReturnType<typeof stubFonts>;
beforeEach(() => {
  fonts = stubFonts();
});
afterEach(() => fonts.unstub());

describe('what an export needs before its first frame (AV-1030, AV-1031)', () => {
  it('needs nothing for a layout in the system font with no picture', async () => {
    const template = canvasTemplate([text()]);
    expect(needsPreparing(template)).toBe(false);
    expect(await prepareExportInputs(template, { width: 100, height: 100 })).toEqual({ ok: true });
  });

  it('loads the fonts and decodes the pictures together, handing both over', async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const template = canvasTemplate([text({ fontFamily: 'Inter' }), picture]);
    expect(needsPreparing(template)).toBe(true);
    const prepared = await prepareExportInputs(template, { width: 100, height: 100 });
    expect(prepared).toMatchObject({ ok: true, images: { logo: bitmap } });
    expect(prepared.ok && prepared.fonts?.map((face) => [face.family, face.weight])).toEqual([['Inter', 400], ['Inter', 700]]);
  });

  it('gives the reason, and closes what it decoded, when a font is missing', async () => {
    const bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const prepared = await prepareExportInputs(canvasTemplate([text({ fontFamily: 'Brand Sans' }), picture]), { width: 100, height: 100 });
    expect(prepared).toEqual({ ok: false, message: 'This layout uses Brand Sans, which is not loaded here.' });
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
