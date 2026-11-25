/**
 * Test support: reads back what `ZipWriter` wrote, so tests assert on the
 * archive's actual structure rather than on the writer's own bookkeeping.
 */
export interface ReadEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  data: Uint8Array;
}

export function readZip(bytes: Uint8Array): ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) throw new Error('no end record');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (directoryOffset + directorySize !== end) throw new Error('directory does not meet the end record');

  const entries: ReadEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central header');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('bad local header');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtra;
    entries.push({ name, method, flags, crc, data: bytes.subarray(start, start + size) });
    at += 46 + nameLength;
  }
  return entries;
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
