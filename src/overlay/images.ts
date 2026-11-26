import {
  IMAGE_KINDS_TEXT,
  IMAGE_MAX_BYTES,
  IMAGES_MAX_TOTAL_PIXELS,
  IMAGE_MAX_PIXELS,
  pngPixels,
  svgViewBoxSize,
  bytesToDataUrl,
  dataUrlBytes,
  imageMime,
  imageSrcProblem,
  sniffImageType,
  svgRasterSize,
  type ImageFit,
  type OverlayImageSetting,
} from './imageSetting';
import { sanitizeLabel, type OverlayComponent } from './template';

/**
 * AV-1030 (TD-102). Image components, read and decoded on this device: a file into a data URL, and a
 * template's data URLs into the `ImageBitmap`s the renderer draws. Nothing is uploaded or kept.
 *
 * An SVG is only ever drawn as an image: loaded through an `<img>` from a `blob:` URL (which runs no
 * script and fetches nothing) and painted to a canvas here, on the page, at the size it will be drawn
 * at. It is never put into the page's DOM, and an export worker never sees one.
 */

export type ImageFileResult =
  | { ok: true; image: OverlayImageSetting; width: number; height: number }
  | { ok: false; reason: string };

/** Reads a file the reader chose: its size, its real type by its bytes, and that it decodes. */
export async function readImageFile(file: File, fit: ImageFit = 'contain'): Promise<ImageFileResult> {
  if (file.size > IMAGE_MAX_BYTES) return { ok: false, reason: `${file.name} is larger than 2 MB.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, reason: `${file.name} is not ${IMAGE_KINDS_TEXT}.` };
  const src = bytesToDataUrl(bytes, type);
  if (imageSrcProblem(src)) return { ok: false, reason: `${file.name} is larger than 2 MB.` };
  try {
    const probe = await decodeImage(src, fit, { w: 1000, h: 1000 });
    const { width, height } = probe;
    probe.close();
    const name = sanitizeLabel(file.name).split('\n')[0]!.slice(0, 80);
    return { ok: true, image: { src, fit, opacity: 1, ...(name ? { name } : {}) }, width, height };
  } catch (error) {
    return { ok: false, reason: `${file.name} could not be read as a picture${error instanceof Error && error.message ? ` (${error.message})` : ''}.` };
  }
}

/**
 * Decodes one data URL to a bitmap. The bytes are checked again by their signature, whatever the URL
 * declares. A raster keeps its own pixels; an SVG is painted at the size `fit` gives it in `box`.
 */
export async function decodeImage(src: string, fit: ImageFit, box: { w: number; h: number }): Promise<ImageBitmap> {
  const problem = imageSrcProblem(src);
  if (problem) throw new Error(problem);
  const { bytes, declared } = dataUrlBytes(src);
  const type = sniffImageType(bytes);
  if (type !== declared) throw new Error('its bytes are not the type it says');
  if (type !== 'svg') {
    // A header that declares too many pixels is refused before the browser allocates them.
    if ((pngPixels(bytes) ?? 0) > IMAGE_MAX_PIXELS) throw new Error('it has too many pixels');
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: imageMime(type) }));
    if (bitmap.width * bitmap.height > IMAGE_MAX_PIXELS) {
      bitmap.close();
      throw new Error('it has too many pixels');
    }
    return bitmap;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageMime('svg') }));
  try {
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    const natural = picture.naturalWidth > 0 && picture.naturalHeight > 0 ? { w: picture.naturalWidth, h: picture.naturalHeight } : svgViewBoxSize(bytes);
    if (!natural) throw new Error('it states no size: give the SVG a width and height, or a viewBox');
    const { width, height } = svgRasterSize(fit, box, natural);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser cannot draw it');
    ctx.drawImage(picture, 0, 0, width, height);
    return canvas.transferToImageBitmap();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface BrokenImage {
  id: string;
  name: string;
  reason: string;
}

export interface DecodedImages {
  images: Map<string, ImageBitmap>;
  broken: BrokenImage[];
}

const nameOf = (component: OverlayComponent) => component.image?.name || 'An image';

/** Why a template's images cannot be drawn, from what is stored alone (no decoding): the first, or undefined. */
export function imageRefusal(components: readonly OverlayComponent[]): string | undefined {
  for (const component of components) {
    if (component.type !== 'image' || !component.visible) continue;
    const problem = imageSrcProblem(component.image?.src ?? '');
    if (problem) return `${nameOf(component)} cannot be drawn: ${problem} Replace or remove it to export.`;
  }
  return undefined;
}

/** The sentence an export gives when decoding failed. */
export const brokenImagesMessage = (broken: readonly BrokenImage[]): string =>
  `${broken.map((entry) => `${entry.name}: ${entry.reason}`).join(' ')} Replace or remove ${broken.length === 1 ? 'it' : 'them'} to export.`;

/**
 * Decodes every visible image component, once, for a frame of this size. A broken one is listed and not
 * drawn; the bitmaps are the caller's to hand on or `closeImages`.
 */
export async function decodeTemplateImages(
  components: readonly OverlayComponent[],
  frame: { width: number; height: number },
): Promise<DecodedImages> {
  const images = new Map<string, ImageBitmap>();
  const broken: BrokenImage[] = [];
  let pixels = 0;
  for (const component of components) {
    if (component.type !== 'image' || !component.image || !component.visible) continue;
    const { src, fit } = component.image;
    try {
      const box = { w: component.rect.width * frame.width, h: component.rect.height * frame.height };
      const made = await decodeImage(src, fit, box);
      if (pixels + made.width * made.height > IMAGES_MAX_TOTAL_PIXELS) {
        made.close();
        throw new Error('the layout’s images together have too many pixels');
      }
      pixels += made.width * made.height;
      images.set(component.id, made);
    } catch (error) {
      broken.push({ id: component.id, name: nameOf(component), reason: error instanceof Error && error.message ? `could not be read (${error.message}).` : 'could not be read.' });
    }
  }
  return { images, broken };
}

export function closeImages(images: Iterable<ImageBitmap> | undefined): void {
  if (images) for (const bitmap of images) bitmap.close();
}
