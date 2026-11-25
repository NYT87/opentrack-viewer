import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_SINK_LIMIT_BYTES,
  createArchiveSink,
  opfsAvailable,
  probeArchiveStorage,
  storageLimitBytes,
} from './archiveSink';
import { ZIP_MAX_BYTES } from './zip';
import { ZipWriter } from './zip';
import { readZip } from '../../test/helpers/zipReader';

describe('the archive sink (AV-1006)', () => {
  it('falls back to memory where the origin-private file system is missing', async () => {
    expect(opfsAvailable()).toBe(false);
    const archive = await createArchiveSink('overlay-export-test.zip');
    expect(archive.storage).toBe('memory');

    const zip = new ZipWriter(archive.sink);
    await zip.add('a.txt', new TextEncoder().encode('hello'));
    await zip.finish();
    const blob = await archive.finish();
    expect(blob.type).toBe('application/zip');
    const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt']);
  });

  it('cannot write at a position in memory, which is what keeps a video out of it', async () => {
    const archive = await createArchiveSink('x.zip');
    expect(archive.writeAt).toBeUndefined();
  });

  it('copies what it is given, since the writer reuses its buffers', async () => {
    const archive = await createArchiveSink('x.zip');
    const buffer = new Uint8Array([1, 2, 3]);
    archive.sink.write(buffer);
    buffer.fill(9);
    const blob = await archive.finish();
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('refuses to hold more than a tab can, and says to choose less', async () => {
    const archive = await createArchiveSink('x.zip');
    const big = { length: MEMORY_SINK_LIMIT_BYTES + 1 } as unknown as Uint8Array;
    expect(() => archive.sink.write(big)).toThrowError(/lower frame rate or a smaller size/);
    try {
      archive.sink.write(big);
    } catch (error) {
      expect(error).toMatchObject({ code: 'storage_failed' });
    }
  });

  it('discards what was written when aborted', async () => {
    const archive = await createArchiveSink('x.zip');
    archive.sink.write(new Uint8Array([1, 2, 3]));
    await archive.abort();
    const blob = await archive.finish();
    expect(blob.size).toBe(0);
  });
});

/** The origin-private file system, as far as the sink touches it. */
function fakeOpfs(options: { accessFails?: boolean; shortWrite?: boolean } = {}) {
  const writes: { bytes: number[]; at: number }[] = [];
  const events: string[] = [];
  const file = new File(['finished'], 'a.zip');
  const access = {
    write: vi.fn((chunk: Uint8Array, { at }: { at: number }) => {
      writes.push({ bytes: [...chunk], at });
      return options.shortWrite ? chunk.length - 1 : chunk.length;
    }),
    flush: vi.fn(() => events.push('flush')),
    close: vi.fn(() => events.push('close')),
  };
  const handle = {
    createSyncAccessHandle: vi.fn(async () => {
      if (options.accessFails) throw new Error('locked');
      return access;
    }),
    getFile: vi.fn(async () => file),
  };
  const root = {
    getFileHandle: vi.fn(async () => handle),
    removeEntry: vi.fn(async () => undefined),
  };
  vi.stubGlobal('FileSystemFileHandle', class { createSyncAccessHandle() {} });
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => root },
  });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {} });
  return { root, handle, access, writes, events, file };
}

describe('the archive sink on the origin-private file system (AV-1006)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'storage');
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('writes through a sync access handle at running offsets, and returns the stored file', async () => {
    const fake = fakeOpfs();
    const archive = await createArchiveSink('overlay-export-a.zip');
    expect(archive.storage).toBe('opfs');
    archive.sink.write(new Uint8Array([1, 2, 3]));
    archive.sink.write(new Uint8Array([4, 5]));
    expect(fake.writes).toEqual([
      { bytes: [1, 2, 3], at: 0 },
      { bytes: [4, 5], at: 3 },
    ]);
    expect(await archive.finish()).toBe(fake.file);
    expect(fake.events).toEqual(['flush', 'close']);
    expect(fake.root.removeEntry).not.toHaveBeenCalled();
  });

  it('also writes at an absolute position, for a format that goes back to patch its header', async () => {
    const fake = fakeOpfs();
    const archive = await createArchiveSink('overlay-export-a.zip');
    archive.writeAt!(new Uint8Array([7, 7]), 100);
    archive.writeAt!(new Uint8Array([1]), 0);
    expect(fake.writes).toEqual([
      { bytes: [7, 7], at: 100 },
      { bytes: [1], at: 0 },
    ]);
    // Sequential writes carry on from where they were, unaffected.
    archive.sink.write(new Uint8Array([5]));
    expect(fake.writes.at(-1)).toEqual({ bytes: [5], at: 0 });
  });

  it('treats a short write as a full disk, rather than truncating quietly', async () => {
    fakeOpfs({ shortWrite: true });
    const archive = await createArchiveSink('overlay-export-a.zip');
    expect(() => archive.sink.write(new Uint8Array([1, 2, 3]))).toThrowError(/enough free space/);
  });

  it('plans against the ZIP limit for a file and the memory limit for memory', () => {
    expect(storageLimitBytes('opfs')).toBe(ZIP_MAX_BYTES);
    expect(storageLimitBytes('memory')).toBe(MEMORY_SINK_LIMIT_BYTES);
  });

  describe('probing what the worker can really write to', () => {
    it('reports a file where the access handle opens, and leaves nothing behind', async () => {
      const fake = fakeOpfs();
      await expect(probeArchiveStorage('overlay-export-probe.zip')).resolves.toBe('opfs');
      expect(fake.events).toEqual(['flush', 'close']);
      expect(fake.root.removeEntry).toHaveBeenCalledWith('overlay-export-probe.zip');
    });

    it('reports memory where the file system exists but refuses the access handle', async () => {
      const fake = fakeOpfs({ accessFails: true });
      await expect(probeArchiveStorage('overlay-export-probe.zip')).resolves.toBe('memory');
      // The file it tried to make is removed, as in a real export.
      expect(fake.root.removeEntry).toHaveBeenCalledWith('overlay-export-probe.zip');
    });

    it('reports memory where the file system is absent, or lacks the access handle', async () => {
      await expect(probeArchiveStorage('p.zip')).resolves.toBe('memory');
      // getDirectory exists, but nothing exposes createSyncAccessHandle.
      Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({}) } });
      await expect(probeArchiveStorage('p.zip')).resolves.toBe('memory');
    });
  });

  it('closes the handle and deletes the file when aborted', async () => {
    const fake = fakeOpfs();
    const archive = await createArchiveSink('overlay-export-a.zip');
    archive.sink.write(new Uint8Array([1]));
    await archive.abort();
    expect(fake.events).toEqual(['flush', 'close']);
    expect(fake.root.removeEntry).toHaveBeenCalledWith('overlay-export-a.zip');
    // A second abort is harmless.
    await archive.abort();
  });

  it('removes the file it created when the access handle cannot be opened, and falls back to memory', async () => {
    const fake = fakeOpfs({ accessFails: true });
    const archive = await createArchiveSink('overlay-export-a.zip');
    expect(archive.storage).toBe('memory');
    expect(fake.root.getFileHandle).toHaveBeenCalled();
    expect(fake.root.removeEntry).toHaveBeenCalledWith('overlay-export-a.zip');
  });
});
