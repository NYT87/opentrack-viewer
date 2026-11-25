import { expect } from 'vitest';

/** Reads an archive back by its central directory, the way an unzip tool does. */
export async function readZip(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();

  // The end record is the last 22 bytes (there is no comment).
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const directoryEnd = at + view.getUint32(end + 12, true);

  const files: { name: string; data: Uint8Array; crc: number; time: number; date: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(method).toBe(0);

    // Follow the pointer to the local header, and check it agrees.
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 22, true)).toBe(size);
    const localName = view.getUint16(local + 26, true);
    const dataStart = local + 30 + localName + view.getUint16(local + 28, true);
    files.push({
      name,
      data: bytes.subarray(dataStart, dataStart + size),
      crc,
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
    });
    at += 46 + nameLength;
  }
  expect(at).toBe(directoryEnd);
  return files;
}


