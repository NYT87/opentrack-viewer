/**
 * AV-1030 (TD-102). What an image component is: the picture as a data URL, how it fits its box and
 * how opaque it is. Pure: the checks, the type sniffing and the geometry, with no browser in them;
 * `images.ts` decodes.
 */

export type ImageFit = 'contain' | 'cover' | 'stretch' | 'original';
export const IMAGE_FITS: readonly ImageFit[] = ['contain', 'cover', 'stretch', 'original'];

export interface OverlayImageSetting {
  /** A `data:image/(png|jpeg|webp|svg+xml);base64,` URL; empty when the layout's could not be read. */
  src: string;
  fit: ImageFit;
  /** 0..1, multiplied into the component's own alpha (a fade, the editor's ghost). */
  opacity: number;
  /** The file's name, for the editor's list. Plain text. */
  name?: string;
}

/** A file of at most this many bytes is taken; its data URL is at most `IMAGE_MAX_SRC_CHARS` characters. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_SRC_CHARS = 2_800_000;
/** The images of one layout (or map video project) together, so the file that carries them can be opened again. */
export const LAYOUT_IMAGES_MAX_CHARS = 11_000_000;
/** A decoded picture of more pixels than this is refused: a small file can unpack to a huge one. */
export const IMAGE_MAX_PIXELS = 50_000_000;
/** All the decoded images of one export or preview together, in pixels: they are held at once. */
export const IMAGES_MAX_TOTAL_PIXELS = 100_000_000;
/** The longest side an SVG is rasterized to, so a huge box or natural size cannot ask for a huge bitmap. */
export const SVG_MAX_SIDE = 4096;

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg';
export const IMAGE_KINDS_TEXT = 'a PNG, JPEG, WebP or SVG image of at most 2 MB';

export type ImageType = 'png' | 'jpeg' | 'webp' | 'svg';
const MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
export const imageMime = (type: ImageType): string => MIME[type];

const DATA_URL = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]*={0,2}$/;

/** Why a stored `src` is not usable, or undefined. */
export function imageSrcProblem(src: string): string | undefined {
  if (src === '') return `The image is missing from the layout, or was not ${IMAGE_KINDS_TEXT}.`;
  if (src.length > IMAGE_MAX_SRC_CHARS) return `The image is larger than 2 MB.`;
  if (!DATA_URL.test(src)) return `The image is not a PNG, JPEG, WebP or SVG data URL.`;
  return undefined;
}

const startsWith = (bytes: Uint8Array, at: number, values: readonly number[]) => values.every((value, i) => bytes[at + i] === value);

/**
 * SVG: after an optional BOM, whitespace, an XML prolog, comments and a doctype, an `<svg` root. Skipped with
 * `indexOf`, not a regex: nested optional comment groups backtrack exponentially on a run of comments.
 */
function startsWithSvgRoot(head: string): boolean {
  let at = head.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (at < head.length && /\s/.test(head[at]!)) at += 1;
    const skip = (open: string, close: string) => {
      if (head.slice(at, at + open.length).toLowerCase() !== open.toLowerCase()) return false;
      const end = head.indexOf(close, at + open.length);
      at = end < 0 ? head.length : end + close.length;
      return true;
    };
    if (skip('<?xml', '?>') || skip('<!--', '-->') || skip('<!DOCTYPE', '>')) continue;
    return /^<svg[\s>/]/i.test(head.slice(at, at + 5));
  }
}

/** What the bytes are, by their own signature and never the file's name or declared type. */
export function sniffImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  // Only the head is read as text: a root comes first or the file is not an SVG.
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
  return startsWithSvgRoot(head) ? 'svg' : undefined;
}

export function bytesToDataUrl(bytes: Uint8Array, type: ImageType): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${MIME[type]};base64,${btoa(binary)}`;
}

/** The bytes of a data URL accepted by `imageSrcProblem`, and the type it declares. */
export function dataUrlBytes(src: string): { bytes: Uint8Array; declared: ImageType } {
  const comma = src.indexOf(',');
  const declared = (src.slice('data:image/'.length, src.indexOf(';')) === 'svg+xml' ? 'svg' : src.slice('data:image/'.length, src.indexOf(';'))) as ImageType;
  const binary = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, declared };
}

export interface ImageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ImageRects {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** The scale a fit puts a picture at, before any clipping; `stretch` has two. */
function fitScale(fit: Exclude<ImageFit, 'stretch'>, box: ImageBox, natural: { w: number; h: number }): number {
  if (fit === 'original') return 1;
  const across = box.w / natural.w;
  const down = box.h / natural.h;
  return fit === 'contain' ? Math.min(across, down) : Math.max(across, down);
}

/**
 * The source and destination rectangles of `drawImage` for a picture of `natural` size in `box`:
 * contain (letterboxed, centred), cover (the centre, cropped), stretch, and original (natural size,
 * centred, clipped to the box). One path: the picture is scaled, centred, then cut to the box.
 */
export function imageRect(fit: ImageFit, box: ImageBox, natural: { w: number; h: number }): ImageRects | undefined {
  if (!(natural.w > 0 && natural.h > 0 && box.w > 0 && box.h > 0)) return undefined;
  if (fit === 'stretch') return { sx: 0, sy: 0, sw: natural.w, sh: natural.h, dx: box.x, dy: box.y, dw: box.w, dh: box.h };
  const scale = fitScale(fit, box, natural);
  const dw = natural.w * scale;
  const dh = natural.h * scale;
  const left = box.x + (box.w - dw) / 2;
  const top = box.y + (box.h - dh) / 2;
  const dx = Math.max(box.x, left);
  const dy = Math.max(box.y, top);
  const right = Math.min(box.x + box.w, left + dw);
  const bottom = Math.min(box.y + box.h, top + dh);
  return { sx: (dx - left) / scale, sy: (dy - top) / scale, sw: (right - dx) / scale, sh: (bottom - dy) / scale, dx, dy, dw: right - dx, dh: bottom - dy };
}

/**
 * The size an SVG is rasterized at, in output pixels, so the renderer's own fit math lands on it:
 * the fitted size for contain and cover (cover is cut by the renderer), the box for stretch, the
 * natural size for original; each side within `SVG_MAX_SIDE`.
 */
export function svgRasterSize(fit: ImageFit, box: { w: number; h: number }, natural: { w: number; h: number }): { width: number; height: number } {
  const size =
    fit === 'stretch' ? { w: box.w, h: box.h } : (() => {
      const scale = fitScale(fit, { x: 0, y: 0, ...box }, natural);
      return { w: natural.w * scale, h: natural.h * scale };
    })();
  const shrink = Math.min(1, SVG_MAX_SIDE / size.w, SVG_MAX_SIDE / size.h);
  return { width: Math.max(1, Math.round(size.w * shrink)), height: Math.max(1, Math.round(size.h * shrink)) };
}

/** A PNG's pixel count from its header, so a bomb is refused before it is decoded; undefined for other types. */
export function pngPixels(bytes: Uint8Array): number | undefined {
  if (bytes.length < 24 || sniffImageType(bytes) !== 'png') return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

/** An SVG's size from its `viewBox`, where the browser reports none (a logo with no width and height). */
export function svgViewBoxSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));
  const match = /\bviewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/.exec(head);
  const w = Number(match?.[1]);
  const h = Number(match?.[2]);
  return w > 0 && h > 0 ? { w, h } : undefined;
}
