import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToDataUrl, IMAGE_MAX_BYTES } from './imageSetting';
import { brokenImagesMessage, closeImages, decodeImage, decodeTemplateImages, imageRefusal, readImageFile } from './images';
import type { OverlayComponent } from './template';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><script>window.__svgRan = true</script></svg>');

const file = (name: string, content: Uint8Array, size = content.length) =>
  ({ name, size, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }) as unknown as File;

const bitmap = (width = 40, height = 20) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

let created: ImageBitmap[];
beforeEach(() => {
  created = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      const made = bitmap();
      created.push(made);
      return made;
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const image = (id: string, src: string, extra: Partial<OverlayComponent> = {}): OverlayComponent => ({
  id,
  type: 'image',
  visible: true,
  rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  unitMode: 'auto',
  style: {},
  image: { src, fit: 'contain', opacity: 1 },
  ...extra,
});

describe('reading an image file (AV-1030, TD-102)', () => {
  it('takes a PNG that decodes, as a data URL, with its name and its size', async () => {
    const read = await readImageFile(file('logo.png', PNG));
    expect(read).toMatchObject({ ok: true, width: 40, height: 20, image: { fit: 'contain', opacity: 1, name: 'logo.png' } });
    expect(read.ok && read.image.src).toBe(bytesToDataUrl(PNG, 'png'));
    // The probe bitmap is not kept.
    expect(created[0]!.close).toHaveBeenCalled();
  });

  it('refuses a file over 2 MB without reading it', async () => {
    const big = file('big.png', PNG, IMAGE_MAX_BYTES + 1);
    const read = await readImageFile(big);
    expect(read).toEqual({ ok: false, reason: 'big.png is larger than 2 MB.' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('refuses a file of another kind, by its bytes and not its name', async () => {
    const read = await readImageFile(file('photo.png', new TextEncoder().encode('GIF89a not a png')));
    expect(read).toMatchObject({ ok: false, reason: expect.stringMatching(/photo\.png is not a PNG, JPEG, WebP or SVG/) });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('refuses a file that does not decode, with the browser’s reason', async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('The source image could not be decoded.'));
    const read = await readImageFile(file('torn.png', PNG));
    expect(read).toEqual({ ok: false, reason: 'torn.png could not be read as a picture (The source image could not be decoded.).' });
  });

  it('refuses a picture of too many pixels, and lets its bitmap go', async () => {
    const huge = bitmap(10_000, 10_000);
    vi.mocked(createImageBitmap).mockResolvedValueOnce(huge);
    const read = await readImageFile(file('bomb.png', PNG));
    expect(read).toMatchObject({ ok: false, reason: expect.stringMatching(/too many pixels/) });
    expect(huge.close).toHaveBeenCalled();
  });
});

describe('decoding a layout’s images (AV-1030)', () => {
  const src = bytesToDataUrl(PNG, 'png');

  it('decodes each visible image once, by component id, and skips what is not shown', async () => {
    const { images, broken } = await decodeTemplateImages([image('a', src), image('b', src), image('hidden', src, { visible: false })], { width: 1000, height: 500 });
    expect([...images.keys()]).toEqual(['a', 'b']);
    expect(broken).toEqual([]);
    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    closeImages(images.values());
    expect(created.every((made) => vi.mocked(made.close).mock.calls.length === 1)).toBe(true);
  });

  it('lists an image that cannot be decoded, and an empty one, and still decodes the others', async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('bad data'));
    const { images, broken } = await decodeTemplateImages([image('torn', src), image('empty', ''), image('fine', src)], { width: 1000, height: 500 });
    expect([...images.keys()]).toEqual(['fine']);
    expect(broken.map((entry) => entry.id)).toEqual(['torn', 'empty']);
    expect(broken[0]!.reason).toMatch(/bad data/);
    expect(broken[1]!.reason).toMatch(/missing/);
    expect(brokenImagesMessage(broken)).toMatch(/Replace or remove them to export\.$/);
  });

  it('refuses a picture whose bytes are not the type its URL declares', async () => {
    const lie = `data:image/png;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
    await expect(decodeImage(lie, 'contain', { w: 10, h: 10 })).rejects.toThrow(/not the type it says/);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('tells, from what is stored, which image would stop an export', () => {
    expect(imageRefusal([image('a', src)])).toBeUndefined();
    expect(imageRefusal([image('a', src, { visible: false }), image('e', '')])).toMatch(/An image cannot be drawn.*Replace or remove it to export/);
    expect(imageRefusal([image('e', '', { visible: false })])).toBeUndefined();
  });
});

describe('an SVG is only ever drawn as a picture (AV-1030, safe)', () => {
  it('goes through an <img> from a blob: URL, painted to a canvas, and is never put in the page', async () => {
    const revoked: string[] = [];
    const drawn = vi.fn();
    const sources: string[] = [];
    class FakeImage {
      naturalWidth = 100;
      naturalHeight = 50;
      set src(value: string) {
        sources.push(value);
      }
      async decode() {}
    }
    class FakeCanvas {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: drawn };
      }
      transferToImageBitmap() {
        return bitmap(this.width, this.height);
      }
    }
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:svg-1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
    const before = document.documentElement.outerHTML;

    const made = await decodeImage(bytesToDataUrl(SVG, 'svg'), 'contain', { w: 400, h: 200 });

    // Contain of 100 x 50 in 400 x 200 is 400 x 200 on the page's own canvas.
    expect([made.width, made.height]).toEqual([400, 200]);
    expect(sources).toEqual(['blob:svg-1']);
    expect(drawn).toHaveBeenCalledWith(expect.anything(), 0, 0, 400, 200);
    expect(revoked).toEqual(['blob:svg-1']);
    expect(document.documentElement.outerHTML).toBe(before);
    expect((window as unknown as Record<string, unknown>).__svgRan).toBeUndefined();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  const fakeSvgPlatform = (natural: { w: number; h: number }) => {
    class SizedImage {
      naturalWidth = natural.w;
      naturalHeight = natural.h;
      set src(_value: string) {}
      async decode() {}
    }
    class Canvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: vi.fn() };
      }
      transferToImageBitmap() {
        return bitmap(this.width, this.height);
      }
    }
    vi.stubGlobal('Image', SizedImage);
    vi.stubGlobal('OffscreenCanvas', Canvas);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:svg-3');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  };

  it('takes the size of an SVG with only a viewBox from it, and refuses one that states none', async () => {
    fakeSvgPlatform({ w: 0, h: 0 });
    const boxed = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"/>');
    const made = await decodeImage(bytesToDataUrl(boxed, 'svg'), 'contain', { w: 400, h: 400 });
    expect([made.width, made.height]).toEqual([400, 200]);
    await expect(decodeImage(bytesToDataUrl(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg'), 'contain', { w: 4, h: 4 })).rejects.toThrow(/states no size/);
  });

  it('refuses a PNG whose header declares too many pixels before decoding it, and layouts whose images together are too large', async () => {
    const bomb = new Uint8Array(33);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(bomb.buffer).setUint32(16, 16000);
    new DataView(bomb.buffer).setUint32(20, 16000);
    await expect(decodeImage(bytesToDataUrl(bomb, 'png'), 'contain', { w: 1, h: 1 })).rejects.toThrow(/too many pixels/);
    expect(createImageBitmap).not.toHaveBeenCalled();

    const big = () => bitmap(7000, 7000);
    vi.mocked(createImageBitmap).mockImplementation(async () => big());
    const src = bytesToDataUrl(PNG, 'png');
    const { images, broken } = await decodeTemplateImages([image('a', src), image('b', src), image('c', src)], { width: 100, height: 100 });
    expect([...images.keys()]).toEqual(['a', 'b']);
    expect(vi.mocked(createImageBitmap).mock.results).toHaveLength(3);
    expect(broken).toEqual([expect.objectContaining({ id: 'c', reason: expect.stringMatching(/together have too many pixels/) })]);
  });

  it('revokes the blob URL when the SVG does not decode', async () => {
    class BadImage {
      naturalWidth = 0;
      naturalHeight = 0;
      set src(_value: string) {}
      async decode() {
        throw new Error('broken svg');
      }
    }
    vi.stubGlobal('Image', BadImage);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:svg-2');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await expect(decodeImage(bytesToDataUrl(SVG, 'svg'), 'contain', { w: 4, h: 4 })).rejects.toThrow('broken svg');
    expect(revoke).toHaveBeenCalledWith('blob:svg-2');
  });
});
