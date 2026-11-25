/**
 * AV-1208. EXIF blocks built by hand for tests, as a camera writes them: a
 * TIFF structure with a time taken, its offset, and a GPS position. Written
 * here rather than by a library, so the reader and the writer cannot share a
 * mistake (as the FIT and GoPro fixtures are, TD-046).
 */
export interface ExifFixture {
  /** `2026:09:24 09:12:33`, the camera's way. */
  dateTimeOriginal?: string;
  /** `+09:00`. */
  offsetTimeOriginal?: string;
  lat?: number;
  lon?: number;
  littleEndian?: boolean;
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** The value's bytes; four or fewer go inside the entry. */
  bytes: number[];
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0)).concat(0);

/** The TIFF block of an EXIF segment: IFD0 pointing to an EXIF IFD and a GPS IFD. */
export function tiffBlock(fixture: ExifFixture): Uint8Array<ArrayBuffer> {
  const little = fixture.littleEndian ?? true;
  const u16 = (value: number) => (little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) => {
    const bytes = [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    return little ? bytes.reverse() : bytes;
  };
  const rational = (value: number) => [...u32(Math.round(value * 1_000_000)), ...u32(1_000_000)];
  const dms = (value: number) => {
    const abs = Math.abs(value);
    const d = Math.floor(abs);
    const m = Math.floor((abs - d) * 60);
    const s = (abs - d - m / 60) * 3600;
    return [...u32(d), ...u32(1), ...u32(m), ...u32(1), ...rational(s)];
  };

  const exif: IfdEntry[] = [];
  if (fixture.dateTimeOriginal) exif.push({ tag: 0x9003, type: 2, count: fixture.dateTimeOriginal.length + 1, bytes: ascii(fixture.dateTimeOriginal) });
  if (fixture.offsetTimeOriginal) exif.push({ tag: 0x9011, type: 2, count: fixture.offsetTimeOriginal.length + 1, bytes: ascii(fixture.offsetTimeOriginal) });
  const gps: IfdEntry[] = [];
  if (fixture.lat !== undefined && fixture.lon !== undefined) {
    gps.push(
      { tag: 1, type: 2, count: 2, bytes: ascii(fixture.lat < 0 ? 'S' : 'N') },
      { tag: 2, type: 5, count: 3, bytes: dms(fixture.lat) },
      { tag: 3, type: 2, count: 2, bytes: ascii(fixture.lon < 0 ? 'W' : 'E') },
      { tag: 4, type: 5, count: 3, bytes: dms(fixture.lon) },
    );
  }

  // Laid out: header (8), IFD0, the EXIF IFD, the GPS IFD, each followed by the values too long for its entries.
  const ifdSize = (entries: IfdEntry[]) => 2 + entries.length * 12 + 4 + entries.reduce((sum, entry) => sum + (entry.bytes.length > 4 ? entry.bytes.length : 0), 0);
  const ifd0At = 8;
  const ifd0: IfdEntry[] = [
    { tag: 0x8769, type: 4, count: 1, bytes: [] },
    { tag: 0x8825, type: 4, count: 1, bytes: [] },
  ];
  const exifAt = ifd0At + ifdSize(ifd0);
  const gpsAt = exifAt + ifdSize(exif);
  ifd0[0]!.bytes = u32(exifAt);
  ifd0[1]!.bytes = u32(gpsAt);

  const write = (entries: IfdEntry[], at: number): number[] => {
    const out = [...u16(entries.length)];
    let data = at + 2 + entries.length * 12 + 4;
    const tail: number[] = [];
    for (const entry of entries) {
      out.push(...u16(entry.tag), ...u16(entry.type), ...u32(entry.count));
      if (entry.bytes.length <= 4) out.push(...entry.bytes, ...Array(4 - entry.bytes.length).fill(0));
      else {
        out.push(...u32(data));
        tail.push(...entry.bytes);
        data += entry.bytes.length;
      }
    }
    return [...out, ...u32(0), ...tail];
  };

  return new Uint8Array([...(little ? [0x49, 0x49, 0x2a, 0] : [0x4d, 0x4d, 0, 0x2a]), ...u32(ifd0At), ...write(ifd0, ifd0At), ...write(exif, exifAt), ...write(gps, gpsAt)]);
}

/** A JPEG's head with an EXIF APP1 segment: enough to be read, not to be decoded. */
export function jpegWithExif(fixture: ExifFixture): Uint8Array<ArrayBuffer> {
  const tiff = tiffBlock(fixture);
  const length = tiff.length + 8;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...ascii('Exif'), 0, ...tiff, 0xff, 0xd9]);
}

/** HEIC's way: an `Exif` item somewhere in the container, its TIFF block after `Exif\0\0`. */
export function heicLikeWithExif(fixture: ExifFixture): Uint8Array<ArrayBuffer> {
  const head = [0, 0, 0, 24, ...ascii('ftypheic').slice(0, 8), 0, 0, 0, 0, ...ascii('mif1heic').slice(0, 8)];
  return new Uint8Array([...head, ...Array(37).fill(7), ...ascii('Exif'), 0, ...tiffBlock(fixture)]);
}
