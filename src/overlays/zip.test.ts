import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { readZip } from '../test/helpers/zip';
import { MAX_ZIP_ENTRIES, createZipWriter, crc32 } from './zip';

const text = (s: string) => new TextEncoder().encode(s);

describe('zip writer (AV-1006)', () => {
  it('computes the standard CRC-32', () => {
    // The well-known check value for "123456789".
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes an archive that reads back exactly', async () => {
    const zip = createZipWriter(new Date(2024, 4, 17, 13, 45, 30));
    zip.add('a.txt', text('hello'));
    zip.add('folder/b.bin', new Uint8Array([0, 1, 2, 255, 254]));
    zip.add('empty', new Uint8Array(0));
    const files = await readZip(zip.finish());

    expect(files.map((f) => f.name)).toEqual(['a.txt', 'folder/b.bin', 'empty']);
    expect(new TextDecoder().decode(files[0]!.data)).toBe('hello');
    expect([...files[1]!.data]).toEqual([0, 1, 2, 255, 254]);
    expect(files[2]!.data.length).toBe(0);
    for (const f of files) expect(crc32(f.data)).toBe(f.crc);
  });

  it('stamps the time and date it was given', async () => {
    const zip = createZipWriter(new Date(2024, 4, 17, 13, 45, 30));
    zip.add('x', text('x'));
    const [file] = await readZip(zip.finish());
    expect(file!.date).toBe(((2024 - 1980) << 9) | (5 << 5) | 17);
    expect(file!.time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it('is byte-for-byte reproducible for the same input and time', async () => {
    const make = () => {
      const zip = createZipWriter(new Date(2024, 0, 1, 0, 0, 0));
      zip.add('a', text('one'));
      zip.add('b', text('two'));
      return zip.finish();
    };
    expect(new Uint8Array(await make().arrayBuffer())).toEqual(new Uint8Array(await make().arrayBuffer()));
  });

  it('keeps non-ASCII names intact', async () => {
    const zip = createZipWriter();
    zip.add('señal-ñandú.txt', text('x'));
    expect((await readZip(zip.finish()))[0]!.name).toBe('señal-ñandú.txt');
  });

  it('is not changed by the caller reusing its buffer afterwards', async () => {
    const buffer = text('first');
    const zip = createZipWriter();
    zip.add('a', buffer);
    buffer.fill(0);
    const [file] = await readZip(zip.finish());
    expect(new TextDecoder().decode(file!.data)).toBe('first');
  });

  it('reports how much it has written, and how many files', () => {
    const zip = createZipWriter();
    expect(zip.size).toBe(0);
    zip.add('abc', new Uint8Array(100));
    expect(zip.count).toBe(1);
    expect(zip.size).toBe(30 + 3 + 100);
  });

  it('has the type of an archive', () => {
    const zip = createZipWriter();
    zip.add('a', text('a'));
    expect(zip.finish().type).toBe('application/zip');
  });

  it('refuses to be used after it is closed', () => {
    const zip = createZipWriter();
    zip.finish();
    expect(() => zip.add('a', text('a'))).toThrow(/closed/);
    expect(() => zip.finish()).toThrow(/closed/);
  });

  it('refuses more files than an archive can index', () => {
    const zip = createZipWriter();
    const empty = new Uint8Array(0);
    for (let i = 0; i < MAX_ZIP_ENTRIES; i += 1) zip.add(`f${i}`, empty);
    expect(() => zip.add('one-too-many', empty)).toThrow(/Too many files/);
  });

  it('is an empty but valid archive with nothing in it', async () => {
    expect(await readZip(createZipWriter().finish())).toEqual([]);
  });

  it('can be extracted by a real tool', async () => {
    // Uses the system `unzip` when present; skipped, not failed, where it is not.
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    if (spawnSync('unzip', ['-v']).error) return;

    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      const zip = createZipWriter();
      zip.add('one.txt', text('first file'));
      zip.add('two.bin', new Uint8Array([9, 8, 7]));
      writeFileSync(join(dir, 'out.zip'), new Uint8Array(await zip.finish().arrayBuffer()));
      const test = spawnSync('unzip', ['-t', join(dir, 'out.zip')]);
      expect(test.status).toBe(0);
      expect(spawnSync('unzip', ['-o', '-q', join(dir, 'out.zip'), '-d', dir]).status).toBe(0);
      expect(readFileSync(join(dir, 'one.txt'), 'utf8')).toBe('first file');
      expect([...readFileSync(join(dir, 'two.bin'))]).toEqual([9, 8, 7]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `inflateRawSync` is imported to show stored data is NOT deflated: a reader that
  // assumed compression would fail on these bytes.
  it('stores the data as it is, without compression', async () => {
    const zip = createZipWriter();
    const data = text('stored, not deflated');
    zip.add('a', data);
    const [file] = await readZip(zip.finish());
    expect([...file!.data]).toEqual([...data]);
    expect(() => inflateRawSync(Buffer.from(file!.data))).toThrow();
  });
});
