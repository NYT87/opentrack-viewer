import { describe, expect, it } from 'vitest';
import {
  IMAGE_MAX_SRC_CHARS,
  SVG_MAX_SIDE,
  bytesToDataUrl,
  dataUrlBytes,
  imageRect,
  imageSrcProblem,
  pngPixels,
  svgViewBoxSize,
  sniffImageType,
  svgRasterSize,
} from './imageSetting';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);

describe('what an image file is, by its bytes (AV-1030, TD-102)', () => {
  it('knows a PNG, a JPEG and a WebP by their signature, whatever the file is called', () => {
    expect(sniffImageType(PNG)).toBe('png');
    expect(sniffImageType(JPEG)).toBe('jpeg');
    expect(sniffImageType(WEBP)).toBe('webp');
  });

  it('knows an SVG by its root, after a prolog, comments and a doctype', () => {
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImageType(text('﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"/>'))).toBe('svg');
  });

  it('refuses anything else: other pictures, text, HTML, and an SVG that is not the root', () => {
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeUndefined();
    expect(sniffImageType(text('hello'))).toBeUndefined();
    expect(sniffImageType(text('<html><svg/></html>'))).toBeUndefined();
    expect(sniffImageType(text('<script>alert(1)</script><svg/>'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array(0))).toBeUndefined();
    // A RIFF that is not a WebP (a WAV).
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeUndefined();
  });

  it('writes a data URL that gives the same bytes back, with the type it declares', () => {
    const src = bytesToDataUrl(PNG, 'png');
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
    expect(imageSrcProblem(src)).toBeUndefined();
    const back = dataUrlBytes(src);
    expect([...back.bytes]).toEqual([...PNG]);
    expect(back.declared).toBe('png');
    expect(dataUrlBytes(bytesToDataUrl(text('<svg/>'), 'svg')).declared).toBe('svg');
  });

  it('refuses a stored image that is empty, not a data URL of those types, or over 2 MB', () => {
    expect(imageSrcProblem('')).toMatch(/missing/);
    expect(imageSrcProblem('https://example.com/a.png')).toMatch(/data URL/);
    expect(imageSrcProblem('data:image/gif;base64,R0lG')).toMatch(/data URL/);
    expect(imageSrcProblem('data:text/html;base64,PGI+')).toMatch(/data URL/);
    expect(imageSrcProblem('data:image/png;base64,@@@@')).toMatch(/data URL/);
    expect(imageSrcProblem(`data:image/png;base64,${'A'.repeat(IMAGE_MAX_SRC_CHARS)}`)).toMatch(/2 MB/);
  });
});

describe('where an image is drawn in its box (AV-1030)', () => {
  const box = { x: 100, y: 50, w: 400, h: 200 };

  it('contain: the whole picture, letterboxed and centred', () => {
    // A square in a wide box: as tall as the box, centred across.
    expect(imageRect('contain', box, { w: 100, h: 100 })).toEqual({ sx: 0, sy: 0, sw: 100, sh: 100, dx: 200, dy: 50, dw: 200, dh: 200 });
    // A wide picture in a box of the same shape fills it.
    expect(imageRect('contain', box, { w: 800, h: 400 })).toEqual({ sx: 0, sy: 0, sw: 800, sh: 400, dx: 100, dy: 50, dw: 400, dh: 200 });
    // A very wide picture: as wide as the box, centred down.
    expect(imageRect('contain', box, { w: 400, h: 50 })).toEqual({ sx: 0, sy: 0, sw: 400, sh: 50, dx: 100, dy: 125, dw: 400, dh: 50 });
  });

  it('cover: fills the box, cropped from the centre of the picture', () => {
    // A square in a wide box: the full width, the middle half of the height.
    expect(imageRect('cover', box, { w: 100, h: 100 })).toEqual({ sx: 0, sy: 25, sw: 100, sh: 50, dx: 100, dy: 50, dw: 400, dh: 200 });
    // A tall picture: the full height, the middle of the width.
    const tall = imageRect('cover', box, { w: 100, h: 400 })!;
    expect(tall).toMatchObject({ sx: 0, sw: 100, dx: 100, dy: 50, dw: 400, dh: 200 });
    expect(tall.sy).toBeCloseTo(175);
    expect(tall.sh).toBeCloseTo(50);
  });

  it('stretch: the whole picture, to the box, whatever its shape', () => {
    expect(imageRect('stretch', box, { w: 10, h: 300 })).toEqual({ sx: 0, sy: 0, sw: 10, sh: 300, dx: 100, dy: 50, dw: 400, dh: 200 });
  });

  it('original: its own pixels, centred; clipped to the box where it is larger', () => {
    // Smaller than the box: centred, nothing cut.
    expect(imageRect('original', box, { w: 100, h: 50 })).toEqual({ sx: 0, sy: 0, sw: 100, sh: 50, dx: 250, dy: 125, dw: 100, dh: 50 });
    // Larger across only: the middle 400 columns, whole height centred.
    expect(imageRect('original', box, { w: 600, h: 100 })).toEqual({ sx: 100, sy: 0, sw: 400, sh: 100, dx: 100, dy: 100, dw: 400, dh: 100 });
    // Larger both ways: the centre of the picture fills the box 1:1.
    expect(imageRect('original', box, { w: 1000, h: 1000 })).toEqual({ sx: 300, sy: 400, sw: 400, sh: 200, dx: 100, dy: 50, dw: 400, dh: 200 });
  });

  it('draws nothing for a picture or a box with no size', () => {
    expect(imageRect('contain', box, { w: 0, h: 10 })).toBeUndefined();
    expect(imageRect('cover', { x: 0, y: 0, w: 0, h: 10 }, { w: 10, h: 10 })).toBeUndefined();
  });
});

describe('the size an SVG is painted at (AV-1030)', () => {
  const box = { w: 400, h: 200 };
  it('is the fitted size, so the renderer lands on the same rectangle', () => {
    expect(svgRasterSize('contain', box, { w: 100, h: 100 })).toEqual({ width: 200, height: 200 });
    expect(svgRasterSize('cover', box, { w: 100, h: 100 })).toEqual({ width: 400, height: 400 });
    expect(svgRasterSize('stretch', box, { w: 100, h: 100 })).toEqual({ width: 400, height: 200 });
    expect(svgRasterSize('original', box, { w: 100, h: 50 })).toEqual({ width: 100, height: 50 });
  });

  it('is kept within a side the browser can be asked for', () => {
    const huge = svgRasterSize('original', box, { w: 40_000, h: 10_000 });
    expect(huge.width).toBe(SVG_MAX_SIDE);
    expect(huge.height).toBe(SVG_MAX_SIDE / 4);
  });
});

describe('hostile and unsized files (AV-1030)', () => {
  it('reads a long run of comments in linear time, whether or not an <svg root follows', () => {
    const comments = '<!---->'.repeat(580);
    expect(sniffImageType(new TextEncoder().encode(`${comments}x`))).toBeUndefined();
    expect(sniffImageType(new TextEncoder().encode(`${comments}<svg/>`))).toBe('svg');
    expect(sniffImageType(new TextEncoder().encode('<!-- never closed <svg/>'))).toBeUndefined();
  });

  it('reads a PNG’s pixel count from its header, and an SVG’s size from its viewBox', () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 16000);
    new DataView(png.buffer).setUint32(20, 16000);
    expect(pngPixels(png)).toBe(256_000_000);
    expect(pngPixels(new TextEncoder().encode('<svg/>'))).toBeUndefined();
    const svg = (text: string) => svgViewBoxSize(new TextEncoder().encode(text));
    expect(svg('<svg viewBox="0 0 24 12"/>')).toEqual({ w: 24, h: 12 });
    expect(svg("<svg viewBox='-5, -5, 10.5, 20'/>")).toEqual({ w: 10.5, h: 20 });
    expect(svg('<svg/>')).toBeUndefined();
    expect(svg('<svg viewBox="0 0 0 5"/>')).toBeUndefined();
  });
});
