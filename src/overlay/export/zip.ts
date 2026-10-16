import { OverlayExportError } from './errors';

/**
 * AV-1006 (TD-039). A store-only ZIP writer, streaming.
 *
 * PNG is already compressed, so nothing here compresses: each file is a local
 * header and its bytes, and the central directory follows at the end. That is
 * what lets a long export be written to disk as it is drawn instead of held in
 * memory. The format's 32-bit sizes and 16-bit entry count are respected, not
 * worked around with ZIP64 — `ZipWriter` refuses an entry that would break
 * them, and the export panel offers a lower frame rate beforehand instead.
 */

export interface ZipSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

/** Largest offset, size or end-of-directory position the plain format holds. */
export const ZIP_MAX_BYTES = 0xffffffff;
export const ZIP_MAX_ENTRIES = 0xffff;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** CRC-32 (IEEE), as ZIP stores it. */
export function crc32(data: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = lookup[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is all ZIP has; two-second resolution, from 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
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
  time: number;
  date: number;
}

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private directoryBytes = 0;
  private readonly encoder = new TextEncoder();

  constructor(private readonly sink: ZipSink) {}

  /** Bytes written so far, before the central directory. */
  get bytesWritten(): number {
    return this.offset;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  async add(name: string, data: Uint8Array, modified: Date = new Date()): Promise<void> {
    const nameBytes = this.encoder.encode(name);
    const entryDirectory = CENTRAL_HEADER_BYTES + nameBytes.length;
    const projected =
      this.offset +
      LOCAL_HEADER_BYTES +
      nameBytes.length +
      data.length +
      this.directoryBytes +
      entryDirectory +
      END_RECORD_BYTES;

    if (this.entries.length + 1 > ZIP_MAX_ENTRIES) {
      throw new OverlayExportError(
        'too_large',
        'This export has more files than a ZIP archive can hold. Choose a lower frame rate.',
      );
    }
    if (projected > ZIP_MAX_BYTES || data.length > ZIP_MAX_BYTES) {
      throw new OverlayExportError(
        'too_large',
        'This export is larger than a ZIP archive can hold (4 GB). Choose a lower frame rate or a smaller size.',
      );
    }

    const stamp = dosDateTime(modified);
    const entry: Entry = {
      name: nameBytes,
      crc: crc32(data),
      size: data.length,
      offset: this.offset,
      time: stamp.time,
      date: stamp.date,
    };

    const header = new Uint8Array(LOCAL_HEADER_BYTES + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // flags: names are UTF-8
    view.setUint16(8, 0, true); // method: stored
    view.setUint16(10, entry.time, true);
    view.setUint16(12, entry.date, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.size, true); // compressed size
    view.setUint32(22, entry.size, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra length
    header.set(nameBytes, LOCAL_HEADER_BYTES);

    await this.sink.write(header);
    await this.sink.write(data);
    this.offset += header.length + data.length;
    this.directoryBytes += entryDirectory;
    this.entries.push(entry);
  }

  /** Writes the central directory. The archive is complete after this. */
  async finish(): Promise<{ bytes: number; entries: number }> {
    const directoryStart = this.offset;
    const directory = new Uint8Array(this.directoryBytes + END_RECORD_BYTES);
    const view = new DataView(directory.buffer);
    let at = 0;

    for (const entry of this.entries) {
      view.setUint32(at, 0x02014b50, true);
      view.setUint16(at + 4, 20, true); // version made by
      view.setUint16(at + 6, 20, true); // version needed
      view.setUint16(at + 8, 0x0800, true);
      view.setUint16(at + 10, 0, true);
      view.setUint16(at + 12, entry.time, true);
      view.setUint16(at + 14, entry.date, true);
      view.setUint32(at + 16, entry.crc, true);
      view.setUint32(at + 20, entry.size, true);
      view.setUint32(at + 24, entry.size, true);
      view.setUint16(at + 28, entry.name.length, true);
      // extra, comment, disk number, internal and external attributes: zero.
      view.setUint32(at + 42, entry.offset, true);
      directory.set(entry.name, at + CENTRAL_HEADER_BYTES);
      at += CENTRAL_HEADER_BYTES + entry.name.length;
    }

    view.setUint32(at, 0x06054b50, true);
    view.setUint16(at + 8, this.entries.length, true);
    view.setUint16(at + 10, this.entries.length, true);
    view.setUint32(at + 12, this.directoryBytes, true);
    view.setUint32(at + 16, directoryStart, true);

    await this.sink.write(directory);
    this.offset += directory.length;
    return { bytes: this.offset, entries: this.entries.length };
  }
}
