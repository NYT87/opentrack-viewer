import { describe, expect, it } from 'vitest';
import { OverlayExportError } from './errors';
import { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES, ZipWriter, crc32 } from './zip';
import { concatChunks, readZip } from '../../test/helpers/zipReader';

const bytes = (text: string) => new TextEncoder().encode(text);

function collect() {
  const chunks: Uint8Array[] = [];
  return { chunks, sink: { write: (chunk: Uint8Array) => void chunks.push(chunk.slice()) } };
}

describe('store-only ZIP writer (AV-1006)', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes an archive that reads back entry for entry, stored and unchanged', async () => {
    const { chunks, sink } = collect();
    const zip = new ZipWriter(sink);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    await zip.add('frame_000001.png', png);
    await zip.add('notes.txt', bytes('hello'));
    const finished = await zip.finish();

    const archive = concatChunks(chunks);
    expect(finished).toEqual({ bytes: archive.length, entries: 2 });

    const entries = readZip(archive);
    expect(entries.map((entry) => entry.name)).toEqual(['frame_000001.png', 'notes.txt']);
    expect(entries.every((entry) => entry.method === 0)).toBe(true);
    expect([...entries[0]!.data]).toEqual([...png]);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe('hello');
    expect(entries[1]!.crc).toBe(crc32(bytes('hello')));
  });

  it('marks names as UTF-8 and keeps them intact', async () => {
    const { chunks, sink } = collect();
    const zip = new ZipWriter(sink);
    await zip.add('señal-ü.txt', bytes('x'));
    await zip.finish();
    const [entry] = readZip(concatChunks(chunks));
    expect(entry!.name).toBe('señal-ü.txt');
    expect(entry!.flags & 0x0800).toBe(0x0800);
  });

  it('makes a valid empty archive', async () => {
    const { chunks, sink } = collect();
    await new ZipWriter(sink).finish();
    const archive = concatChunks(chunks);
    expect(archive.length).toBe(22);
    expect(readZip(archive)).toEqual([]);
  });

  it('streams: each entry reaches the sink as it is added, before the directory', async () => {
    const { chunks, sink } = collect();
    const zip = new ZipWriter(sink);
    await zip.add('a', bytes('aaa'));
    const afterOne = chunks.length;
    expect(afterOne).toBeGreaterThan(0);
    expect(zip.bytesWritten).toBe(30 + 1 + 3);
    await zip.add('b', bytes('bbb'));
    expect(chunks.length).toBeGreaterThan(afterOne);
  });

  it('awaits an asynchronous sink in order', async () => {
    const order: string[] = [];
    const zip = new ZipWriter({
      write: async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(String(chunk.length));
      },
    });
    await zip.add('a', bytes('aa'));
    expect(order).toEqual(['31', '2']);
  });

  it('refuses an entry that would exceed the 4 GB the format holds', async () => {
    const zip = new ZipWriter({ write: () => undefined });
    const huge = { length: ZIP_MAX_BYTES } as unknown as Uint8Array;
    await expect(zip.add('big', huge)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('refuses a 65,536th entry, and says what to do', async () => {
    const zip = new ZipWriter({ write: () => undefined });
    const empty = new Uint8Array(0);
    for (let i = 0; i < ZIP_MAX_ENTRIES; i += 1) await zip.add(`f${i}`, empty);
    const failure = await zip.add('one-too-many', empty).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OverlayExportError);
    expect((failure as OverlayExportError).code).toBe('too_large');
    expect((failure as OverlayExportError).message).toMatch(/lower frame rate/i);
  });
});
