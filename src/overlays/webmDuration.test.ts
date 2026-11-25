import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWebmDuration } from './webmDuration';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '../test/fixtures', name)));
const blobOf = (bytes: Uint8Array<ArrayBufferLike>) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'video/webm' });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const hasTool = (name: string) => !spawnSync(name, ['-version']).error;

/** The seconds a tool reads from the file, or undefined when it finds no duration. */
function probeDuration(bytes: Uint8Array): number | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'webm-'));
  try {
    const path = join(dir, 'x.webm');
    writeFileSync(path, bytes);
    const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
    const value = Number(out.stdout.toString().trim());
    return Number.isFinite(value) && out.stdout.toString().trim() !== '' ? value : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function decodes(bytes: Uint8Array): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'webm-'));
  try {
    const path = join(dir, 'x.webm');
    writeFileSync(path, bytes);
    return spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -- a tiny hand-built WebM, so the size arithmetic can be checked exactly ------

const vint = (value: number, length: number) => {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = out[0]! | (0x80 >> (length - 1));
  return out;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const element = (id: number[], data: Uint8Array, sizeLength = 1) => concat(Uint8Array.from(id), vint(data.length, sizeLength), data);
const unknownSize = Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const ebmlHeader = () => element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], new TextEncoder().encode('webm')));
const cluster = () => element([0x1f, 0x43, 0xb6, 0x75], new Uint8Array([1, 2, 3, 4, 5]));

function handBuilt(opts: { knownSegment?: boolean; infoPayloadBytes?: number; segmentSizeLength?: number } = {}) {
  const timecodeScale = element([0x2a, 0xd7, 0xb1], new Uint8Array([0x0f, 0x42, 0x40])); // 1,000,000
  const padding = element([0xec], new Uint8Array(opts.infoPayloadBytes ?? 0)); // a Void inside Info
  const info = element([0x15, 0x49, 0xa9, 0x66], concat(timecodeScale, padding), opts.infoPayloadBytes && opts.infoPayloadBytes > 100 ? 2 : 1);
  const body = concat(info, cluster());
  const segmentHead = Uint8Array.from([0x18, 0x53, 0x80, 0x67]);
  const segment = opts.knownSegment
    ? concat(segmentHead, vint(body.length, opts.segmentSizeLength ?? 4), body)
    : concat(segmentHead, unknownSize, body);
  return { file: concat(ebmlHeader(), segment), info, body };
}

const readDurationFrom = (bytes: Uint8Array): number | undefined => {
  // The Duration element is 44 89 88 + float64, wherever it sits.
  for (let i = 0; i < bytes.length - 10; i += 1) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88) {
      return new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8).getFloat64(0, false);
    }
  }
  return undefined;
};

describe('writing a duration into a recorded WebM (AV-1007)', () => {
  describe('a real recording-style file', () => {
    it.runIf(hasTool('ffprobe'))('starts with no length a player can read', () => {
      expect(probeDuration(fixture('no-duration.webm'))).toBeUndefined();
    });

    it.runIf(hasTool('ffprobe') && hasTool('ffmpeg'))('gains the length, and still decodes', async () => {
      const original = fixture('no-duration.webm');
      const patched = await bytesOf(await withWebmDuration(blobOf(original), 4));
      expect(probeDuration(patched)).toBeCloseTo(4, 2);
      expect(decodes(patched)).toBe(true);
      expect(patched.length).toBe(original.length + 11);
    });

    it('changes nothing after the header: every frame is the same bytes', async () => {
      const original = fixture('no-duration.webm');
      const patched = await bytesOf(await withWebmDuration(blobOf(original), 4));
      const tail = (bytes: Uint8Array) => bytes.subarray(bytes.length - 20_000);
      expect([...tail(patched)]).toEqual([...tail(original)]);
    });

    it('leaves a file that already has a length exactly as it was', async () => {
      const original = fixture('sync-test.webm');
      const result = await withWebmDuration(blobOf(original), 99);
      expect([...(await bytesOf(result))]).toEqual([...original]);
    });

    it('is idempotent', async () => {
      const once = await withWebmDuration(blobOf(fixture('no-duration.webm')), 4);
      const twice = await withWebmDuration(once, 7);
      expect([...(await bytesOf(twice))]).toEqual([...(await bytesOf(once))]);
    });
  });

  describe('the arithmetic, on a file small enough to check by hand', () => {
    it('adds 11 bytes and records the duration in timecode ticks', async () => {
      const { file } = handBuilt();
      const out = await bytesOf(await withWebmDuration(blobOf(file), 2.5));
      expect(out.length).toBe(file.length + 11);
      // 2.5 s at 1,000,000 ns per tick is 2,500 ticks.
      expect(readDurationFrom(out)).toBe(2500);
    });

    it('honours a different timecode scale', async () => {
      const { file } = handBuilt();
      // Rewrite the scale to 1,000 ns per tick (0x03E8): the same 2.5 s is 2,500,000 ticks.
      const idx = file.findIndex((_, i) => file[i] === 0x2a && file[i + 1] === 0xd7 && file[i + 2] === 0xb1);
      const edited = file.slice();
      edited.set([0x00, 0x03, 0xe8], idx + 4);
      expect(readDurationFrom(await bytesOf(await withWebmDuration(blobOf(edited), 2.5)))).toBe(2_500_000);
    });

    it('leaves an unknown-size segment unknown', async () => {
      const { file } = handBuilt();
      const out = await bytesOf(await withWebmDuration(blobOf(file), 1));
      const at = out.findIndex((_, i) => out[i] === 0x18 && out[i + 1] === 0x53 && out[i + 2] === 0x80 && out[i + 3] === 0x67);
      expect([...out.subarray(at + 4, at + 12)]).toEqual([...unknownSize]);
    });

    it('raises a known segment size by exactly what was added', async () => {
      const { file, body } = handBuilt({ knownSegment: true });
      const out = await bytesOf(await withWebmDuration(blobOf(file), 1));
      const at = out.findIndex((_, i) => out[i] === 0x18 && out[i + 1] === 0x53 && out[i + 2] === 0x80 && out[i + 3] === 0x67);
      const size = ((out[at + 4]! & 0x0f) << 24) | (out[at + 5]! << 16) | (out[at + 6]! << 8) | out[at + 7]!;
      expect(size).toBe(body.length + 11);
      // And the file is exactly as long as the header says: nothing is cut off or stray.
      expect(at + 8 + size).toBe(out.length);
    });

    it('lengthens the Info size field when the new size no longer fits, and keeps the segment right', async () => {
      // An Info payload of 120 bytes: 1-byte size cannot hold 120 + 11 + the scale element.
      const { file, body } = handBuilt({ knownSegment: true, infoPayloadBytes: 120 });
      const out = await bytesOf(await withWebmDuration(blobOf(file), 1));
      expect(readDurationFrom(out)).toBe(1000);
      const at = out.findIndex((_, i) => out[i] === 0x18 && out[i + 1] === 0x53 && out[i + 2] === 0x80 && out[i + 3] === 0x67);
      const size = ((out[at + 4]! & 0x0f) << 24) | (out[at + 5]! << 16) | (out[at + 6]! << 8) | out[at + 7]!;
      expect(at + 8 + size).toBe(out.length);
      expect(size).toBeGreaterThanOrEqual(body.length + 11);
    });

    it('keeps the cluster after the header intact', async () => {
      const { file } = handBuilt();
      const out = await bytesOf(await withWebmDuration(blobOf(file), 1));
      // The cluster is the last 10 bytes: its id, its size and five bytes of data.
      expect([...out.subarray(out.length - 10)]).toEqual([...file.subarray(file.length - 10)]);
    });
  });

  describe('a file it does not understand is returned as it was', () => {
    const unchanged = async (bytes: Uint8Array, seconds = 3) => {
      const input = blobOf(bytes);
      const result = await withWebmDuration(input, seconds);
      expect([...(await bytesOf(result))]).toEqual([...bytes]);
    };

    it('empty, tiny and random input', async () => {
      await unchanged(new Uint8Array(0));
      await unchanged(new Uint8Array([1, 2, 3]));
      await unchanged(crypto.getRandomValues(new Uint8Array(500)));
    });

    it('an MP4', async () => {
      await unchanged(fixture('plain-video.mp4'));
    });

    it('a WebM cut off in the middle of its header', async () => {
      await unchanged(fixture('no-duration.webm').subarray(0, 40));
      await unchanged(fixture('no-duration.webm').subarray(0, 60));
    });

    it('a WebM with no Info element before its clusters', async () => {
      const file = concat(ebmlHeader(), Uint8Array.from([0x18, 0x53, 0x80, 0x67]), unknownSize, cluster());
      await unchanged(file);
    });

    it('a length that is not usable', async () => {
      const original = fixture('no-duration.webm');
      for (const seconds of [0, -1, NaN, Infinity]) await unchanged(original, seconds);
    });
  });
});
