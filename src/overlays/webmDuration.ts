/**
 * AV-1007. Writes the length into a WebM file that was recorded without one.
 *
 * `MediaRecorder` writes WebM as a stream: it cannot know how long the
 * recording will be when it writes the header, so it leaves the Duration out.
 * The file plays, but players cannot show a length or seek reliably, and video
 * editors may refuse it. The length is known by the time recording stops, so it
 * is added to the header then.
 *
 * Only the Info element is touched: Duration (11 bytes) is appended to it, its
 * own size field is rewritten, and — when the segment's size is a real number
 * rather than "unknown" — the segment's size is raised by the same amount. Every
 * byte after the Info element is copied unchanged, so no frame is re-encoded.
 *
 * It never makes a file worse: anything it does not fully understand, it
 * returns as it was.
 */

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
} as const;

/** The header is at the start of the file; this much of it is read. */
const HEAD_BYTES = 64 * 1024;
const DURATION_ELEMENT_BYTES = 11;
/** Matroska's default: nanoseconds per timecode tick. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

/** An element ID, with its length-marker bits kept (as IDs are written). */
function readId(bytes: Uint8Array, at: number): { id: number; length: number } | undefined {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23; // leading zeros of the byte, plus one
  if (length < 1 || length > 4 || at + length > bytes.length) return undefined;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + bytes[at + i]!;
  return { id, length };
}

/** A size: its value (undefined when it means "unknown") and how many bytes it takes. */
function readSize(bytes: Uint8Array, at: number): { value: number | undefined; length: number } | undefined {
  const first = bytes[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || at + length > bytes.length) return undefined;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  if (allOnes) return { value: undefined, length };
  return Number.isSafeInteger(value) ? { value, length } : undefined;
}

/** A size written in exactly `length` bytes, or undefined if it does not fit. */
function writeSize(value: number, length: number): Uint8Array<ArrayBuffer> | undefined {
  // The all-ones pattern means "unknown", so the largest usable value is one less.
  if (length < 1 || length > 8 || value >= 2 ** (7 * length) - 1) return undefined;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = out[0]! | (0x80 >> (length - 1));
  return out;
}

function readUint(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + bytes[at + i]!;
  return value;
}

interface Located {
  segmentSizeAt: number;
  segmentSize: { value: number | undefined; length: number };
  infoSizeAt: number;
  infoSize: { value: number; length: number };
  infoDataAt: number;
  hasDuration: boolean;
  timecodeScale: number;
}

/** Finds the pieces to change, or undefined if the file is not shaped as expected. */
function locate(bytes: Uint8Array): Located | undefined {
  const header = readId(bytes, 0);
  if (!header || header.id !== ID.EBML) return undefined;
  const headerSize = readSize(bytes, header.length);
  if (!headerSize || headerSize.value === undefined) return undefined;

  const segmentAt = header.length + headerSize.length + headerSize.value;
  const segment = readId(bytes, segmentAt);
  if (!segment || segment.id !== ID.SEGMENT) return undefined;
  const segmentSizeAt = segmentAt + segment.length;
  const segmentSize = readSize(bytes, segmentSizeAt);
  if (!segmentSize) return undefined;

  let at = segmentSizeAt + segmentSize.length;
  while (at < bytes.length) {
    const child = readId(bytes, at);
    if (!child || child.id === ID.CLUSTER) return undefined; // clusters start: no Info was found
    const size = readSize(bytes, at + child.length);
    if (!size || size.value === undefined) return undefined;
    const dataAt = at + child.length + size.length;

    if (child.id === ID.INFO) {
      let hasDuration = false;
      let timecodeScale = DEFAULT_TIMECODE_SCALE;
      let inner = dataAt;
      const end = dataAt + size.value;
      if (end > bytes.length) return undefined;
      while (inner < end) {
        const field = readId(bytes, inner);
        const fieldSize = field ? readSize(bytes, inner + field.length) : undefined;
        if (!field || !fieldSize || fieldSize.value === undefined) return undefined;
        const fieldData = inner + field.length + fieldSize.length;
        if (field.id === ID.DURATION) hasDuration = true;
        if (field.id === ID.TIMECODE_SCALE && fieldSize.value > 0 && fieldSize.value <= 8) {
          timecodeScale = readUint(bytes, fieldData, fieldSize.value) || DEFAULT_TIMECODE_SCALE;
        }
        inner = fieldData + fieldSize.value;
      }
      return {
        segmentSizeAt,
        segmentSize,
        infoSizeAt: at + child.length,
        infoSize: { value: size.value, length: size.length },
        infoDataAt: dataAt,
        hasDuration,
        timecodeScale,
      };
    }
    at = dataAt + size.value;
  }
  return undefined;
}

/**
 * Returns `blob` with its duration set to `seconds`, or `blob` itself when it is
 * not a WebM, already has a duration, or cannot be safely changed.
 */
export async function withWebmDuration(blob: Blob, seconds: number): Promise<Blob> {
  if (!Number.isFinite(seconds) || seconds <= 0) return blob;
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const found = locate(head);
  if (!found || found.hasDuration) return blob;

  // Duration is a 64-bit float, in ticks of the file's timecode scale.
  const ticks = (seconds * 1e9) / found.timecodeScale;
  const element = new Uint8Array(DURATION_ELEMENT_BYTES);
  element.set([0x44, 0x89, 0x88]);
  new DataView(element.buffer).setFloat64(3, ticks, false);

  // The Info element grows by one element, which may lengthen its own size field.
  const newInfoValue = found.infoSize.value + DURATION_ELEMENT_BYTES;
  let infoSizeLength = found.infoSize.length;
  let newInfoSize = writeSize(newInfoValue, infoSizeLength);
  while (!newInfoSize && infoSizeLength < 8) {
    infoSizeLength += 1;
    newInfoSize = writeSize(newInfoValue, infoSizeLength);
  }
  if (!newInfoSize) return blob;
  const grown = DURATION_ELEMENT_BYTES + (infoSizeLength - found.infoSize.length);

  // A segment of known size must grow too; one of unknown size (a stream) need not.
  let newSegmentSize: Uint8Array<ArrayBuffer> | undefined;
  if (found.segmentSize.value !== undefined) {
    newSegmentSize = writeSize(found.segmentSize.value + grown, found.segmentSize.length);
    if (!newSegmentSize) return blob;
  }

  const infoEnd = found.infoDataAt + found.infoSize.value;
  const pieces: BlobPart[] = [];
  // Up to the segment's size, then (maybe) its new size, then up to the Info's size.
  pieces.push(head.subarray(0, found.segmentSizeAt));
  pieces.push(newSegmentSize ?? head.subarray(found.segmentSizeAt, found.segmentSizeAt + found.segmentSize.length));
  pieces.push(head.subarray(found.segmentSizeAt + found.segmentSize.length, found.infoSizeAt));
  pieces.push(newInfoSize);
  pieces.push(head.subarray(found.infoDataAt, infoEnd));
  pieces.push(element);
  // Everything after the Info element is untouched, frames included.
  pieces.push(blob.slice(infoEnd));
  return new Blob(pieces, { type: blob.type });
}
