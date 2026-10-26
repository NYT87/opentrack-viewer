import { describe, expect, it } from 'vitest';
import { applyWebmEdits, encodeSize, patchWebmDuration, planWebmDuration, type ReadAt } from './webmDuration';

/**
 * AV-1012. WebM files built byte by byte, in the shapes a recorder writes:
 * an EBML header, a segment, Info without a Duration, clusters of unknown size
 * holding SimpleBlocks or BlockGroups, and, in the second shape, a SeekHead and
 * Cues whose positions must move when Info grows.
 */

const UNKNOWN = Symbol('unknown');

const idBytes = (id: number) => {
  const out: number[] = [];
  for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) out.unshift(rest % 256);
  return out;
};

function sizeBytes(size: number | typeof UNKNOWN, width?: number): number[] {
  if (size === UNKNOWN) return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  let w = width ?? 1;
  while (!width && size >= 2 ** (7 * w) - 1) w += 1;
  return [...encodeSize(size, w)!];
}

function el(id: number, body: number[], options: { size?: typeof UNKNOWN; sizeWidth?: number } = {}): number[] {
  return [...idBytes(id), ...sizeBytes(options.size ?? body.length, options.sizeWidth), ...body];
}

const uint = (value: number, width: number) => {
  const out: number[] = [];
  for (let i = 0, rest = value; i < width; i += 1, rest = Math.floor(rest / 256)) out.unshift(rest % 256);
  return out;
};

/** A SimpleBlock on track 1 at a signed offset from its cluster. */
const simpleBlock = (offset: number) => el(0xa3, [0x81, ...uint(offset & 0xffff, 2), 0x80, 0x00, 0x00]);
/** A BlockGroup: a Block, and a BlockDuration when given. */
const blockGroup = (offset: number, duration?: number) =>
  el(0xa0, [...el(0xa1, [0x81, ...uint(offset & 0xffff, 2), 0x00, 0x00]), ...(duration ? el(0x9b, uint(duration, 2)) : [])]);
const cluster = (timecode: number, blocks: number[][], size?: typeof UNKNOWN) =>
  el(0x1f43b675, [...el(0xe7, uint(timecode, 2)), ...blocks.flat()], { size });

const EBML_HEADER = el(0x1a45dfa3, [...el(0x4282, [...new TextEncoder().encode('webm')])]);
const info = (extra: number[] = []) => el(0x1549a966, [...el(0x2ad7b1, uint(1_000_000, 3)), ...extra]);
const TRACKS = el(0x1654ae6b, [...el(0xae, [...el(0xd7, [1])])]);

const readerOf = (bytes: Uint8Array): ReadAt => async (offset, length) => bytes.slice(offset, offset + length);

/** Every top-level child of the segment, with where its data starts relative to the segment's data. */
function segmentChildren(bytes: Uint8Array) {
  const vint = (at: number) => {
    let width = 1;
    while (!(bytes[at]! & (0x80 >> (width - 1)))) width += 1;
    let value = bytes[at]! & (0xff >> width);
    let unknown = value === 0xff >> width;
    for (let i = 1; i < width; i += 1) {
      value = value * 256 + bytes[at + i]!;
      if (bytes[at + i] !== 0xff) unknown = false;
    }
    return { width, value: unknown ? undefined : value };
  };
  const idAt = (at: number) => {
    const width = vint(at).width;
    let id = 0;
    for (let i = 0; i < width; i += 1) id = id * 256 + bytes[at + i]!;
    return { id, width };
  };
  const ebmlId = idAt(0);
  const ebmlSize = vint(ebmlId.width);
  const segmentAt = ebmlId.width + ebmlSize.width + ebmlSize.value!;
  const segmentId = idAt(segmentAt);
  const segmentSize = vint(segmentAt + segmentId.width);
  const dataStart = segmentAt + segmentId.width + segmentSize.width;
  const children: { id: number; offset: number; at: number; size: number | undefined; dataStart: number }[] = [];
  let at = dataStart;
  while (at < bytes.length) {
    const id = idAt(at);
    const size = vint(at + id.width);
    const childData = at + id.width + size.width;
    children.push({ id: id.id, offset: at - dataStart, at, size: size.value, dataStart: childData });
    if (size.value === undefined) {
      // Unknown size: a cluster runs to the next top-level element; in these files, the next cluster or the end.
      let next = childData;
      while (next < bytes.length && !(bytes[next] === 0x1f && bytes[next + 1] === 0x43)) {
        const inner = idAt(next);
        const innerSize = vint(next + inner.width);
        next += inner.width + innerSize.width + innerSize.value!;
      }
      at = next;
    } else {
      at = childData + size.value;
    }
  }
  return { children, segmentSize: segmentSize.value, dataStart };
}

/** The Duration in Info, as a float, or undefined. */
function statedDuration(bytes: Uint8Array): number | undefined {
  const infoAt = segmentChildren(bytes).children.find((child) => child.id === 0x1549a966)!;
  for (let at = infoAt.dataStart; at < infoAt.dataStart + infoAt.size!; ) {
    const isDuration = bytes[at] === 0x44 && bytes[at + 1] === 0x89;
    const idWidth = bytes[at]! >= 0x80 ? 1 : bytes[at]! >= 0x40 ? 2 : 3;
    const size = bytes[at + idWidth]! & 0x7f;
    if (isDuration) return new DataView(bytes.buffer, bytes.byteOffset + at + idWidth + 1, size).getFloat64(0);
    at += idWidth + 1 + size;
  }
  return undefined;
}

async function patched(bytes: Uint8Array, frameSeconds: number): Promise<Uint8Array> {
  const result = await patchWebmDuration(new Blob([bytes as Uint8Array<ArrayBuffer>]), frameSeconds);
  expect(result.problem).toBeUndefined();
  return new Uint8Array(await result.file.arrayBuffer());
}

describe('the duration a recorder leaves out (AV-1012)', () => {
  it('states the length of a recording made of unknown-size clusters: the last frame plus one frame', async () => {
    // As Chromium writes it: an unknown-size segment, Info with no Duration, clusters of unknown size.
    const file = new Uint8Array([
      ...EBML_HEADER,
      ...el(0x18538067, [
        ...info(),
        ...TRACKS,
        ...cluster(0, [simpleBlock(0), simpleBlock(33), simpleBlock(67)], UNKNOWN),
        ...cluster(100, [simpleBlock(0), simpleBlock(33)], UNKNOWN),
      ], { size: UNKNOWN }),
    ]);

    const out = await patched(file, 1 / 30);
    // Last block at 133 ms, lasting a frame: 133 + 33.3 ms.
    expect(statedDuration(out)).toBeCloseTo(133 + 1000 / 30, 6);
    // Everything after Info is unchanged, byte for byte.
    const before = segmentChildren(file).children;
    const after = segmentChildren(out).children;
    expect(after.map((child) => child.id)).toEqual(before.map((child) => child.id));
    const tail = (bytes: Uint8Array, children: typeof before) => bytes.slice(children[1]!.at);
    expect(tail(out, after)).toEqual(tail(file, before));
  });

  it('takes a BlockGroup’s own duration for its end when it says one', async () => {
    const file = new Uint8Array([
      ...EBML_HEADER,
      ...el(0x18538067, [...info(), ...TRACKS, ...cluster(0, [simpleBlock(0), blockGroup(40, 500)], UNKNOWN)], {
        size: UNKNOWN,
      }),
    ]);
    expect(statedDuration(await patched(file, 1 / 30))).toBeCloseTo(540, 6);
  });

  it('moves the segment size, every SeekHead position and every cue past Info by what Info grew', async () => {
    const seekHead = (cuesAt: number, clusterAt: number, infoAt: number) =>
      el(0x114d9b74, [
        ...el(0x4dbb, [...el(0x53ab, idBytes(0x1549a966)), ...el(0x53ac, uint(infoAt, 4))]),
        ...el(0x4dbb, [...el(0x53ab, idBytes(0x1f43b675)), ...el(0x53ac, uint(clusterAt, 4))]),
        ...el(0x4dbb, [...el(0x53ab, idBytes(0x1c53bb6b)), ...el(0x53ac, uint(cuesAt, 4))]),
      ]);
    const cues = (clusterAt: number) =>
      el(0x1c53bb6b, [...el(0xbb, [...el(0xb3, [0]), ...el(0xb7, [...el(0xf7, [1]), ...el(0xf1, uint(clusterAt, 4))])])]);
    const body = (cuesAt: number, clusterAt: number, infoAt: number) => [
      ...seekHead(cuesAt, clusterAt, infoAt),
      ...info(),
      ...TRACKS,
      ...cluster(0, [simpleBlock(0), simpleBlock(500)]),
      ...cues(clusterAt),
    ];
    // Lay it out once to learn where things are, then write the real positions.
    const draft = body(0, 0, 0);
    const seekLength = seekHead(0, 0, 0).length;
    const infoAt = seekLength;
    const clusterAt = seekLength + info().length + TRACKS.length;
    const cuesAt = clusterAt + cluster(0, [simpleBlock(0), simpleBlock(500)]).length;
    const segmentBody = body(cuesAt, clusterAt, infoAt);
    expect(segmentBody.length).toBe(draft.length);
    const file = new Uint8Array([...EBML_HEADER, ...el(0x18538067, segmentBody, { sizeWidth: 8 })]);

    const plan = await planWebmDuration(readerOf(file), file.length, 1 / 25);
    expect(plan.alreadyStated).toBe(false);
    expect(plan.durationSeconds).toBeCloseTo(0.54, 9);
    const out = new Uint8Array(await applyWebmEdits(new Blob([file]), plan.edits).arrayBuffer());

    const { children, segmentSize } = segmentChildren(out);
    const grown = out.length - file.length;
    expect(grown).toBe(11);
    expect(segmentSize).toBe(segmentBody.length + grown);
    const offsetOf = (id: number) => children.find((child) => child.id === id)!.offset;

    // Each stated position now names the element it named before.
    const seekPositions: number[] = [];
    const seek = children.find((child) => child.id === 0x114d9b74)!;
    for (let at = seek.dataStart; at < seek.dataStart + seek.size!; at += 1) {
      if (out[at] === 0x53 && out[at + 1] === 0xac) seekPositions.push(readUintAt(out, at + 3, 4));
    }
    expect(seekPositions).toEqual([offsetOf(0x1549a966), offsetOf(0x1f43b675), offsetOf(0x1c53bb6b)]);
    const cueEntry = children.find((child) => child.id === 0x1c53bb6b)!;
    const cuePosition = out.indexOf(0xf1, cueEntry.dataStart);
    expect(readUintAt(out, cuePosition + 2, 4)).toBe(offsetOf(0x1f43b675));
    expect(statedDuration(out)).toBeCloseTo(540, 6);
  });

  it('replaces a Duration of zero, and leaves a usable one alone', async () => {
    const zero = new DataView(new ArrayBuffer(8));
    zero.setFloat64(0, 0);
    const withZero = new Uint8Array([
      ...EBML_HEADER,
      ...el(0x18538067, [...info(el(0x4489, [...new Uint8Array(zero.buffer)])), ...cluster(0, [simpleBlock(0), simpleBlock(200)], UNKNOWN)], {
        size: UNKNOWN,
      }),
    ]);
    expect(statedDuration(await patched(withZero, 0.1))).toBeCloseTo(300, 6);

    const stated = new DataView(new ArrayBuffer(8));
    stated.setFloat64(0, 1234);
    const withDuration = new Uint8Array([
      ...EBML_HEADER,
      ...el(0x18538067, [...info(el(0x4489, [...new Uint8Array(stated.buffer)])), ...cluster(0, [simpleBlock(0)], UNKNOWN)], {
        size: UNKNOWN,
      }),
    ]);
    const plan = await planWebmDuration(readerOf(withDuration), withDuration.length, 0.1);
    expect(plan).toMatchObject({ alreadyStated: true, edits: [] });
    expect(plan.durationSeconds).toBeCloseTo(1.234, 9);
  });

  it('reads the file in slices, never whole', async () => {
    const blocks = Array.from({ length: 200 }, (_, i) => simpleBlock(i));
    const file = new Uint8Array([
      ...EBML_HEADER,
      ...el(0x18538067, [...info(), ...TRACKS, ...cluster(0, blocks, UNKNOWN)], { size: UNKNOWN }),
    ]);
    const reads: number[] = [];
    const reader: ReadAt = async (offset, length) => {
      reads.push(length);
      return file.slice(offset, offset + length);
    };
    const plan = await planWebmDuration(reader, file.length, 0.01);
    expect(plan.durationSeconds).toBeCloseTo(0.209, 9);
    // The default slice is a megabyte: this file is read in one, then only the edits' bytes.
    expect(reads.length).toBeLessThan(5);
  });

  it('gives back the file it was given, with the reason, when it is not a WebM it can patch', async () => {
    const notWebm = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const result = await patchWebmDuration(notWebm, 1 / 30);
    expect(result.file).toBe(notWebm);
    expect(result.problem).toBe('This is not a WebM file.');

    const noFrames = new Blob([new Uint8Array([...EBML_HEADER, ...el(0x18538067, [...info(), ...TRACKS], { size: UNKNOWN })])]);
    const empty = await patchWebmDuration(noFrames, 1 / 30);
    expect(empty.file).toBe(noFrames);
    expect(empty.problem).toBe('The WebM file holds no frames.');
  });
});

function readUintAt(bytes: Uint8Array, at: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) value = value * 256 + bytes[at + i]!;
  return value;
}

describe('encodeSize', () => {
  it('writes a size in the width asked for, and refuses one that does not fit or would read as unknown', () => {
    expect([...encodeSize(5, 1)!]).toEqual([0x85]);
    expect([...encodeSize(5, 8)!]).toEqual([0x01, 0, 0, 0, 0, 0, 0, 5]);
    expect(encodeSize(127, 1)).toBeUndefined();
    expect([...encodeSize(126, 1)!]).toEqual([0xfe]);
  });
});
