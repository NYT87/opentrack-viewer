/**
 * AV-1012. Gives a recorded WebM the length it lacks. `MediaRecorder` writes
 * its file as it goes, so it cannot know how long the recording will be: the
 * segment's Info has no Duration, and a browser reports the file as
 * `Infinity` (Chromium) or `NaN` (WebKit) seconds long, which editors notice
 * (TD-039). This reads the file's own block timestamps, works out its length,
 * and writes a Duration element into Info.
 *
 * The file is never read into memory whole: it is walked through slices,
 * reading only element headers and the few bytes of each block that hold its
 * timestamp, and the patched file is a Blob made of the original's slices with
 * the changed bytes between them, so a 600 MB recording is never copied.
 *
 * Inserting bytes into Info moves everything after it, so whatever states a
 * position past Info is moved too: a known segment size, every SeekHead
 * position and every cue's cluster position, each rewritten in the width it
 * already had. A file that cannot be patched safely is left exactly as it was.
 */

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTrackPositions: 0xb7,
  cueClusterPosition: 0xf1,
} as const;

/** Elements that sit directly in a segment: one of these ends a cluster of unknown size. */
const SEGMENT_CHILDREN = new Set<number>([
  ID.seekHead,
  ID.info,
  0x1654ae6b, // Tracks
  ID.cluster,
  ID.cues,
  0x1941a469, // Attachments
  0x1043a770, // Chapters
  0x1254c367, // Tags
]);

/** Reads a part of the file. A Blob in the browser; an array in a test. */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

interface Header {
  id: number;
  /** Where the element's header begins. */
  start: number;
  /** Where its data begins. */
  dataStart: number;
  /** The size its header states, or undefined when it says "unknown". */
  size: number | undefined;
  /** The width of its size field, so a size can be rewritten in place. */
  sizeWidth: number;
}

/** Bytes changed in the original: `length` bytes at `offset` become `bytes`. */
export interface WebmEdit {
  offset: number;
  length: number;
  bytes: Uint8Array;
}

export interface WebmDurationPlan {
  /** Ticks of `timecodeScale` nanoseconds from the first block to the end of the last. */
  durationTicks: number;
  durationSeconds: number;
  timecodeScale: number;
  /** Whether the file already stated a usable Duration, so nothing is changed. */
  alreadyStated: boolean;
  edits: WebmEdit[];
}

export class WebmPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebmPatchError';
  }
}

/** A forward reader that fetches the file in large slices and serves small reads from them. */
class Cursor {
  private buffer: Uint8Array = new Uint8Array(0);
  private bufferStart = 0;

  constructor(
    private readonly readAt: ReadAt,
    readonly size: number,
    private readonly chunk = 1 << 20,
  ) {}

  async bytes(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.size);
    if (offset >= this.bufferStart && end <= this.bufferStart + this.buffer.length) {
      return this.buffer.subarray(offset - this.bufferStart, end - this.bufferStart);
    }
    if (end - offset > this.chunk) return this.readAt(offset, end - offset);
    this.bufferStart = offset;
    this.buffer = await this.readAt(offset, Math.min(this.chunk, this.size - offset));
    return this.buffer.subarray(0, end - offset);
  }
}

const vintWidth = (first: number) => {
  for (let width = 1; width <= 8; width += 1) if (first & (0x80 >> (width - 1))) return width;
  return 0;
};

/** An element ID, marker bits kept, as Matroska writes them. */
function readId(bytes: Uint8Array, at: number): { id: number; width: number } | undefined {
  const width = vintWidth(bytes[at] ?? 0);
  if (width === 0 || width > 4 || at + width > bytes.length) return undefined;
  let id = 0;
  for (let i = 0; i < width; i += 1) id = id * 256 + bytes[at + i]!;
  return { id, width };
}

/** A size, marker bit removed; all ones means unknown. */
function readSize(bytes: Uint8Array, at: number): { size: number | undefined; width: number } | undefined {
  const width = vintWidth(bytes[at] ?? 0);
  if (width === 0 || at + width > bytes.length) return undefined;
  let value = bytes[at]! & (0xff >> width);
  let allOnes = value === 0xff >> width;
  for (let i = 1; i < width; i += 1) {
    value = value * 256 + bytes[at + i]!;
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? undefined : value, width };
}

async function readHeader(cursor: Cursor, at: number): Promise<Header | undefined> {
  const bytes = await cursor.bytes(at, 12);
  const id = readId(bytes, 0);
  if (!id) return undefined;
  const size = readSize(bytes, id.width);
  if (!size) return undefined;
  return { id: id.id, start: at, dataStart: at + id.width + size.width, size: size.size, sizeWidth: size.width };
}

const readUint = (bytes: Uint8Array) => bytes.reduce((value, byte) => value * 256 + byte, 0);

function readFloat(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length === 4) return view.getFloat32(0);
  if (bytes.length === 8) return view.getFloat64(0);
  return Number.NaN;
}

/** A size field of exactly `width` bytes, or undefined when the value does not fit it. */
export function encodeSize(value: number, width: number): Uint8Array | undefined {
  // All ones is reserved for "unknown".
  if (width < 1 || width > 8 || value >= 2 ** (7 * width) - 1) return undefined;
  const bytes = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  bytes[0]! |= 0x80 >> (width - 1);
  return bytes;
}

function encodeUint(value: number, width: number): Uint8Array | undefined {
  if (value < 0 || value >= 2 ** (8 * width)) return undefined;
  const bytes = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    bytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

/** A Duration element: its ID, an 8-byte size of 8, and the value as a 64-bit float. */
function durationElement(ticks: number): Uint8Array {
  const bytes = new Uint8Array(3 + 8);
  bytes.set([0x44, 0x89, 0x88]);
  new DataView(bytes.buffer).setFloat64(3, ticks);
  return bytes;
}

interface Located {
  /** Where the value's bytes are, and how many there are. */
  offset: number;
  width: number;
  value: number;
}

/**
 * Walks the file and works out what to change. `frameSeconds` is how long the
 * last frame lasts when the file does not say: one frame at the recording's rate.
 */
export async function planWebmDuration(readAt: ReadAt, size: number, frameSeconds: number): Promise<WebmDurationPlan> {
  const cursor = new Cursor(readAt, size);

  const ebml = await readHeader(cursor, 0);
  if (!ebml || ebml.id !== ID.ebml || ebml.size === undefined) throw new WebmPatchError('This is not a WebM file.');
  const segment = await readHeader(cursor, ebml.dataStart + ebml.size);
  if (!segment || segment.id !== ID.segment) throw new WebmPatchError('The WebM file has no segment.');
  const segmentEnd = segment.size === undefined ? size : Math.min(size, segment.dataStart + segment.size);

  let info: Header | undefined;
  let timecodeScale = 1_000_000;
  let statedDuration: number | undefined;
  let existingDuration: { start: number; end: number } | undefined;
  const positions: Located[] = [];
  let lastTick = Number.NEGATIVE_INFINITY;
  let firstTick = Number.POSITIVE_INFINITY;
  let lastEnd = Number.NEGATIVE_INFINITY;

  /** Reads the elements of a known-size parent completely, calling back for each. */
  const walk = async (start: number, end: number, visit: (header: Header, end: number) => Promise<void>) => {
    let at = start;
    while (at < end) {
      const header = await readHeader(cursor, at);
      if (!header || header.size === undefined) return;
      const elementEnd = Math.min(end, header.dataStart + header.size);
      await visit(header, elementEnd);
      at = header.dataStart + header.size;
    }
  };

  const valueAt = async (header: Header, end: number) => cursor.bytes(header.dataStart, end - header.dataStart);

  /** A block's timestamp: after its track number, a signed 16-bit offset from the cluster's. */
  const blockTick = async (dataStart: number, clusterTick: number) => {
    const head = await cursor.bytes(dataStart, 12);
    const track = readSize(head, 0);
    if (!track || head.length < track.width + 2) return undefined;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return clusterTick + view.getInt16(track.width);
  };

  const seeBlock = (tick: number | undefined, durationTicks: number | undefined) => {
    if (tick === undefined) return;
    firstTick = Math.min(firstTick, tick);
    if (tick >= lastTick) lastTick = tick;
    if (durationTicks !== undefined) lastEnd = Math.max(lastEnd, tick + durationTicks);
  };

  let at = segment.dataStart;
  while (at < segmentEnd) {
    const header = await readHeader(cursor, at);
    if (!header) break;

    if (header.id === ID.cluster) {
      // A recorder writes clusters of unknown size: one ends where the next segment-level element begins.
      const clusterEnd = header.size === undefined ? segmentEnd : Math.min(segmentEnd, header.dataStart + header.size);
      let clusterTick = 0;
      let child = header.dataStart;
      while (child < clusterEnd) {
        const element = await readHeader(cursor, child);
        if (!element || (header.size === undefined && SEGMENT_CHILDREN.has(element.id))) break;
        if (element.size === undefined) break;
        const elementEnd = Math.min(clusterEnd, element.dataStart + element.size);
        if (element.id === ID.timecode) {
          clusterTick = readUint(await valueAt(element, elementEnd));
        } else if (element.id === ID.simpleBlock) {
          seeBlock(await blockTick(element.dataStart, clusterTick), undefined);
        } else if (element.id === ID.blockGroup) {
          let tick: number | undefined;
          let blockDuration: number | undefined;
          await walk(element.dataStart, elementEnd, async (part, partEnd) => {
            if (part.id === ID.block) tick = await blockTick(part.dataStart, clusterTick);
            if (part.id === ID.blockDuration) blockDuration = readUint(await valueAt(part, partEnd));
          });
          seeBlock(tick, blockDuration);
        }
        child = element.dataStart + element.size;
      }
      if (header.size === undefined) {
        at = child;
        continue;
      }
    } else if (header.size === undefined) {
      // Only a cluster may be of unknown size here; anything else cannot be walked past.
      break;
    } else {
      const end = Math.min(segmentEnd, header.dataStart + header.size);
      if (header.id === ID.info) {
        info = header;
        await walk(header.dataStart, end, async (child, childEnd) => {
          if (child.id === ID.timecodeScale) timecodeScale = readUint(await valueAt(child, childEnd)) || 1_000_000;
          if (child.id === ID.duration) {
            statedDuration = readFloat(await valueAt(child, childEnd));
            existingDuration = { start: child.start, end: childEnd };
          }
        });
      } else if (header.id === ID.seekHead) {
        await walk(header.dataStart, end, async (seek, seekEnd) => {
          if (seek.id !== ID.seek) return;
          await walk(seek.dataStart, seekEnd, async (field, fieldEnd) => {
            if (field.id !== ID.seekPosition) return;
            positions.push({ offset: field.dataStart, width: fieldEnd - field.dataStart, value: readUint(await valueAt(field, fieldEnd)) });
          });
        });
      } else if (header.id === ID.cues) {
        await walk(header.dataStart, end, async (point, pointEnd) => {
          if (point.id !== ID.cuePoint) return;
          await walk(point.dataStart, pointEnd, async (track, trackEnd) => {
            if (track.id !== ID.cueTrackPositions) return;
            await walk(track.dataStart, trackEnd, async (field, fieldEnd) => {
              if (field.id !== ID.cueClusterPosition) return;
              positions.push({ offset: field.dataStart, width: fieldEnd - field.dataStart, value: readUint(await valueAt(field, fieldEnd)) });
            });
          });
        });
      }
    }
    at = header.dataStart + header.size;
  }

  if (!info || info.size === undefined) throw new WebmPatchError('The WebM file has no Info to state its length in.');
  if (!Number.isFinite(lastTick)) throw new WebmPatchError('The WebM file holds no frames.');

  const frameTicks = (frameSeconds * 1e9) / timecodeScale;
  const endTick = Math.max(lastTick + frameTicks, lastEnd);
  // A recording starts at its first block; a file that does not start at zero is measured from zero all the same,
  // because a player's timeline does.
  const durationTicks = Math.max(endTick, endTick - Math.min(0, firstTick));
  const durationSeconds = (durationTicks * timecodeScale) / 1e9;

  if (statedDuration !== undefined && Number.isFinite(statedDuration) && statedDuration > 0) {
    return { durationTicks: statedDuration, durationSeconds: (statedDuration * timecodeScale) / 1e9, timecodeScale, alreadyStated: true, edits: [] };
  }

  // Info's children, less a Duration that said nothing usable, plus a new one.
  const infoEnd = info.dataStart + info.size;
  const kept: Uint8Array[] = [];
  if (existingDuration) {
    kept.push(await cursor.bytes(info.dataStart, existingDuration.start - info.dataStart));
    kept.push(await cursor.bytes(existingDuration.end, infoEnd - existingDuration.end));
  } else {
    kept.push(await cursor.bytes(info.dataStart, info.size));
  }
  // Copied out of the reader's buffer, which a later read replaces.
  const children = concat([...kept.map((part) => part.slice()), durationElement(durationTicks)]);
  const infoIdWidth = info.dataStart - info.sizeWidth - info.start;
  const sizeField = encodeSize(children.length, info.sizeWidth) ?? encodeSize(children.length, 8);
  if (!sizeField) throw new WebmPatchError('The WebM file’s Info cannot be grown.');
  const infoId = (await cursor.bytes(info.start, infoIdWidth)).slice();
  const newInfo = concat([infoId, sizeField, children]);
  const delta = newInfo.length - (infoEnd - info.start);

  const edits: WebmEdit[] = [{ offset: info.start, length: infoEnd - info.start, bytes: newInfo }];

  if (segment.size !== undefined) {
    const grown = encodeSize(segment.size + delta, segment.sizeWidth);
    if (!grown) throw new WebmPatchError('The WebM file’s segment cannot be grown.');
    edits.push({ offset: segment.dataStart - segment.sizeWidth, length: segment.sizeWidth, bytes: grown });
  }
  // Positions are counted from the segment's data; those past Info move with it.
  const infoRelative = info.start - segment.dataStart;
  for (const position of positions) {
    if (position.value <= infoRelative) continue;
    const moved = encodeUint(position.value + delta, position.width);
    if (!moved) throw new WebmPatchError('A position in the WebM file cannot be moved.');
    edits.push({ offset: position.offset, length: position.width, bytes: moved });
  }
  edits.sort((a, b) => a.offset - b.offset);

  return { durationTicks, durationSeconds, timecodeScale, alreadyStated: false, edits };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The original, sliced, with the edits between the slices. Nothing is copied but the edits. */
export function applyWebmEdits(file: Blob, edits: WebmEdit[]): Blob {
  if (edits.length === 0) return file;
  const parts: BlobPart[] = [];
  let at = 0;
  for (const edit of edits) {
    if (edit.offset > at) parts.push(file.slice(at, edit.offset));
    parts.push(edit.bytes as Uint8Array<ArrayBuffer>);
    at = edit.offset + edit.length;
  }
  if (at < file.size) parts.push(file.slice(at));
  return new Blob(parts, { type: file.type || 'video/webm' });
}

/**
 * The recorded file with its length stated. A file that cannot be patched is
 * returned as it was, with the reason, so the reader still gets their video.
 */
export async function patchWebmDuration(
  file: Blob,
  frameSeconds: number,
): Promise<{ file: Blob; durationSeconds?: number; problem?: string }> {
  const readAt: ReadAt = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  try {
    const plan = await planWebmDuration(readAt, file.size, frameSeconds);
    return { file: applyWebmEdits(file, plan.edits), durationSeconds: plan.durationSeconds };
  } catch (error) {
    return { file, problem: error instanceof Error ? error.message : 'The WebM file could not be read.' };
  }
}
