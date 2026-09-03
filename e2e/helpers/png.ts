import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Buffer;
}

/**
 * Minimal decoder for the PNGs Playwright produces: 8-bit RGB/RGBA, no
 * interlacing. Enough to assert on what a WebGL canvas actually drew, which is
 * the only way to prove the route reached the GPU.
 */
export function decodePng(buffer: Buffer): DecodedPng {
  let offset = 8; // Skip the PNG signature.
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Unsupported PNG encoding');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`Unsupported PNG color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let i = 0; i < stride; i += 1) {
      const rawByte = source[i]!;
      const a = i >= channels ? line[i - channels]! : 0;
      const b = previous[i]!;
      const c = i >= channels ? previous[i - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter ${filter}`);
      }
      line[i] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      out[to] = line[from]!;
      out[to + 1] = line[from + 1]!;
      out[to + 2] = line[from + 2]!;
      out[to + 3] = channels === 4 ? line[from + 3]! : 255;
    }
    line.copy(previous);
  }

  return { width, height, pixels: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Counts pixels within `tolerance` of an [r, g, b] colour. */
export function countPixelsNear(
  png: DecodedPng,
  [r, g, b]: [number, number, number],
  tolerance = 40,
): number {
  let count = 0;
  for (let i = 0; i < png.pixels.length; i += 4) {
    if (
      Math.abs(png.pixels[i]! - r) <= tolerance &&
      Math.abs(png.pixels[i + 1]! - g) <= tolerance &&
      Math.abs(png.pixels[i + 2]! - b) <= tolerance
    ) {
      count += 1;
    }
  }
  return count;
}
