/**
 * AV-1208. The little of a photo's EXIF a map video uses: when it was taken
 * (the local time the camera wrote, and its offset from UTC where the camera
 * wrote one) and where (its GPS position). Read from the file's bytes, here,
 * and kept in memory only: none of it is written into a project file or a
 * video (TD-071).
 *
 * Read from JPEG (the APP1 segment), PNG (the `eXIf` chunk) and HEIC (its
 * `Exif` item, found by its marker). Anything else, or a file without EXIF,
 * reads as nothing known.
 */
export interface PhotoExif {
  /** The camera's local time, `YYYY-MM-DDTHH:MM:SS`, as written: no zone. */
  localTime?: string;
  /** Minutes the camera's local time is ahead of UTC, where the camera wrote it. */
  utcOffsetMinutes?: number;
  lat?: number;
  lon?: number;
}

const TAG = {
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  dateTimeOriginal: 0x9003,
  offsetTimeOriginal: 0x9011,
  gpsLatitudeRef: 0x0001,
  gpsLatitude: 0x0002,
  gpsLongitudeRef: 0x0003,
  gpsLongitude: 0x0004,
} as const;

/** How many bytes of a HEIC are searched for its EXIF: it sits near the start, in the `meta` box. */
const HEIC_SEARCH_BYTES = 512 * 1024;

/** The TIFF block inside a file's EXIF, or undefined. */
function findTiff(bytes: Uint8Array): DataView | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // JPEG: segments from the start; EXIF is an APP1 segment starting `Exif\0\0`.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(at + 2);
      if (marker === 0xe1 && isExifHeader(bytes, at + 4)) return sliceView(bytes, at + 10, at + 2 + length);
      at += 2 + length;
    }
    return undefined;
  }
  // PNG: chunks after the signature; `eXIf` holds the TIFF block itself.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let at = 8;
    while (at + 8 <= bytes.length) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
      if (type === 'eXIf') return sliceView(bytes, at + 8, at + 8 + length);
      if (type === 'IEND') break;
      at += 12 + length;
    }
    return undefined;
  }
  // HEIC (and other ISO media): the `Exif` item starts with `Exif\0\0` before its TIFF block.
  const end = Math.min(bytes.length, HEIC_SEARCH_BYTES) - 10;
  for (let at = 0; at < end; at += 1) {
    if (isExifHeader(bytes, at) && isTiffHeader(bytes, at + 6)) return sliceView(bytes, at + 6, bytes.length);
  }
  return undefined;
}

const isExifHeader = (bytes: Uint8Array, at: number) =>
  bytes[at] === 0x45 && bytes[at + 1] === 0x78 && bytes[at + 2] === 0x69 && bytes[at + 3] === 0x66 && bytes[at + 4] === 0 && bytes[at + 5] === 0;
const isTiffHeader = (bytes: Uint8Array, at: number) =>
  (bytes[at] === 0x49 && bytes[at + 1] === 0x49 && bytes[at + 2] === 0x2a && bytes[at + 3] === 0) ||
  (bytes[at] === 0x4d && bytes[at + 1] === 0x4d && bytes[at + 2] === 0 && bytes[at + 3] === 0x2a);
const sliceView = (bytes: Uint8Array, from: number, to: number) =>
  from < to && to <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset + from, to - from) : undefined;

interface Entry {
  type: number;
  count: number;
  /** Where the value is: inside the entry when it fits in four bytes, else at an offset. */
  valueAt: number;
}

/** One IFD's entries by tag, or an empty map for one out of bounds. */
function readIfd(tiff: DataView, at: number, little: boolean): Map<number, Entry> {
  const entries = new Map<number, Entry>();
  if (at <= 0 || at + 2 > tiff.byteLength) return entries;
  const count = tiff.getUint16(at, little);
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  for (let i = 0; i < count; i += 1) {
    const entry = at + 2 + i * 12;
    if (entry + 12 > tiff.byteLength) break;
    const type = tiff.getUint16(entry + 2, little);
    const n = tiff.getUint32(entry + 4, little);
    const size = (sizes[type] ?? 1) * n;
    const valueAt = size <= 4 ? entry + 8 : tiff.getUint32(entry + 8, little);
    entries.set(tiff.getUint16(entry, little), { type, count: n, valueAt });
  }
  return entries;
}

function ascii(tiff: DataView, entry: Entry | undefined): string | undefined {
  if (!entry || entry.type !== 2 || entry.valueAt + entry.count > tiff.byteLength) return undefined;
  let text = '';
  for (let i = 0; i < entry.count; i += 1) {
    const code = tiff.getUint8(entry.valueAt + i);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

function rationals(tiff: DataView, entry: Entry | undefined, little: boolean): number[] | undefined {
  if (!entry || entry.type !== 5 || entry.valueAt + entry.count * 8 > tiff.byteLength) return undefined;
  return Array.from({ length: entry.count }, (_, i) => {
    const denominator = tiff.getUint32(entry.valueAt + i * 8 + 4, little);
    return denominator === 0 ? Number.NaN : tiff.getUint32(entry.valueAt + i * 8, little) / denominator;
  });
}

function degrees(tiff: DataView, value: Entry | undefined, ref: Entry | undefined, little: boolean, negative: string): number | undefined {
  const parts = rationals(tiff, value, little);
  if (!parts || parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const magnitude = parts[0]! + parts[1]! / 60 + parts[2]! / 3600;
  return ascii(tiff, ref) === negative ? -magnitude : magnitude;
}

/** `2026:09:24 09:12:33` as `2026-09-24T09:12:33`, or undefined for anything else (including the all-zero "unknown"). */
function readLocalTime(text: string | undefined): string | undefined {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text ?? '');
  if (!match || match[1] === '0000') return undefined;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  // A date that is no date (month 13, 31 February, hour 25) reads as no time at all: it never becomes NaN.
  const parsed = new Date(`${iso}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== iso) return undefined;
  return iso;
}

/** `+09:00` as 540, `-05:30` as -330. */
function readOffset(text: string | undefined): number | undefined {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!match) return undefined;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** What a photo's bytes say of when and where it was taken. Never throws: an unreadable block is nothing known. */
export function readPhotoExif(bytes: Uint8Array): PhotoExif {
  try {
    const tiff = findTiff(bytes);
    if (!tiff || tiff.byteLength < 8) return {};
    const little = tiff.getUint8(0) === 0x49;
    const ifd0 = readIfd(tiff, tiff.getUint32(4, little), little);
    const pointer = (entry: Entry | undefined) => (entry ? tiff.getUint32(entry.valueAt, little) : 0);
    const exif = readIfd(tiff, pointer(ifd0.get(TAG.exifIfd)), little);
    const gps = readIfd(tiff, pointer(ifd0.get(TAG.gpsIfd)), little);
    const result: PhotoExif = {};
    const localTime = readLocalTime(ascii(tiff, exif.get(TAG.dateTimeOriginal)));
    if (localTime) result.localTime = localTime;
    const offset = readOffset(ascii(tiff, exif.get(TAG.offsetTimeOriginal)));
    if (offset !== undefined) result.utcOffsetMinutes = offset;
    const lat = degrees(tiff, gps.get(TAG.gpsLatitude), gps.get(TAG.gpsLatitudeRef), little, 'S');
    const lon = degrees(tiff, gps.get(TAG.gpsLongitude), gps.get(TAG.gpsLongitudeRef), little, 'W');
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      result.lat = lat;
      result.lon = lon;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * When the photo was taken, in UTC milliseconds: its local time less its
 * offset, which is the camera's own where it wrote one, else `fallbackOffsetMinutes`.
 */
export function photoTakenAt(exif: PhotoExif, fallbackOffsetMinutes: number | undefined): number | undefined {
  if (!exif.localTime) return undefined;
  const offset = exif.utcOffsetMinutes ?? fallbackOffsetMinutes;
  if (offset === undefined) return undefined;
  const at = Date.parse(`${exif.localTime}Z`) - offset * 60_000;
  return Number.isFinite(at) ? at : undefined;
}
