/**
 * AV-1006. A minimal ZIP writer, for bundling overlay frames.
 *
 * Written here rather than imported because it needs to do one thing: put
 * already-compressed files (PNGs) into an archive that every operating system
 * and video editor opens. That is the *stored* method — no compression — plus
 * the central directory, which is a few dozen lines. A general-purpose library
 * would add weight to a page most visitors never open, for features (deflate,
 * ZIP64, streaming) this has no use for.
 *
 * Limits are enforced rather than hit silently: one archive holds at most
 * 65,535 files and 4 GiB. The exporter splits long sequences into several
 * archives well inside both.
 */

export const MAX_ZIP_ENTRIES = 0xffff;
export const MAX_ZIP_BYTES = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as ZIP defines it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what ZIP stores. Years before 1980 clamp to 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

export interface ZipWriter {
  /** Adds one file. Names are UTF-8; use forward slashes. */
  add(name: string, bytes: Uint8Array): void;
  /** Bytes written so far, excluding the directory that `finish` appends. */
  readonly size: number;
  readonly count: number;
  /** Closes the archive. The writer cannot be used afterwards. */
  finish(): Blob;
}

/** Starts an archive. `now` stamps every file, and is a parameter so output is reproducible. */
export function createZipWriter(now: Date = new Date()): ZipWriter {
  const stamp = dosDateTime(now);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const entries: Entry[] = [];
  let offset = 0;
  let finished = false;

  return {
    add(name, bytes) {
      if (finished) throw new Error('The archive is already closed.');
      if (entries.length >= MAX_ZIP_ENTRIES) throw new Error('Too many files for one archive.');
      const nameBytes = encoder.encode(name);
      if (nameBytes.length > 0xffff) throw new Error('A file name is too long.');
      if (offset + 30 + nameBytes.length + bytes.length > MAX_ZIP_BYTES) {
        throw new Error('The archive would be larger than 4 GiB.');
      }

      const crc = crc32(bytes);
      const header = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true); // local file header
      view.setUint16(4, 20, true); // version needed
      view.setUint16(6, 0x0800, true); // flags: names are UTF-8
      view.setUint16(8, 0, true); // method: stored
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, bytes.length, true); // compressed size
      view.setUint32(22, bytes.length, true); // uncompressed size
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true); // no extra field
      header.set(nameBytes, 30);

      entries.push({ name: nameBytes, crc, size: bytes.length, offset });
      // A copy of the bytes, so a caller reusing its buffer cannot change an
      // entry after it was written.
      parts.push(header, bytes.slice());
      offset += header.length + bytes.length;
    },

    get size() {
      return offset;
    },
    get count() {
      return entries.length;
    },

    finish() {
      if (finished) throw new Error('The archive is already closed.');
      finished = true;

      const directoryStart = offset;
      for (const entry of entries) {
        const record = new Uint8Array(46 + entry.name.length);
        const view = new DataView(record.buffer);
        view.setUint32(0, 0x02014b50, true); // central directory header
        view.setUint16(4, 20, true); // version made by
        view.setUint16(6, 20, true); // version needed
        view.setUint16(8, 0x0800, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, stamp.time, true);
        view.setUint16(14, stamp.date, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.size, true);
        view.setUint32(24, entry.size, true);
        view.setUint16(28, entry.name.length, true);
        view.setUint32(42, entry.offset, true); // where its local header is
        record.set(entry.name, 46);
        parts.push(record);
        offset += record.length;
      }

      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true); // end of central directory
      endView.setUint16(8, entries.length, true);
      endView.setUint16(10, entries.length, true);
      endView.setUint32(12, offset - directoryStart, true);
      endView.setUint32(16, directoryStart, true);
      parts.push(end);

      return new Blob(parts, { type: 'application/zip' });
    },
  };
}
