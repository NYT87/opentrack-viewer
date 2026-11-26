import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepFont, keepsFonts, listKeptFonts, readKeptFont, removeKeptFont, setKeepsFonts } from './fontStore';
import { KEPT_FONTS_MAX_BYTES } from './fonts';

type Store = Map<string, unknown>;

/** Just enough of IndexedDB for the font store: named databases of object stores, with requests that answer on the next tick. */
function fakeIndexedDB() {
  const databases = new Map<string, Map<string, Store>>();
  const ask = <T,>(work: () => T) => {
    const request: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      try {
        request.result = work();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    });
    return request;
  };
  const open = (name: string) => {
    const request: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
    setTimeout(() => {
      const fresh = !databases.has(name);
      const stores = databases.get(name) ?? new Map<string, Store>();
      databases.set(name, stores);
      const db = {
        createObjectStore: (store: string) => void stores.set(store, new Map()),
        close: () => undefined,
        transaction: (names: string | string[]) => {
          const allowed = new Set([names].flat());
          const transaction: { oncomplete?: () => void; objectStore: (store: string) => unknown } = {
            objectStore: (store) => {
              if (!allowed.has(store)) throw new Error('not in this transaction');
              const rows = stores.get(store)!;
              return {
                get: (key: string) => ask(() => rows.get(key)),
                getAll: () => ask(() => [...rows.values()]),
                put: (value: unknown, key?: string) => ask(() => void rows.set(key ?? (value as { family: string }).family, value)),
                delete: (key: string) => ask(() => void rows.delete(key)),
              };
            },
          };
          setTimeout(() => transaction.oncomplete?.(), 5);
          return transaction;
        },
      };
      request.result = db;
      if (fresh) {
        let aborted = false;
        Object.assign(request, { transaction: { abort: () => (aborted = true) } });
        request.onupgradeneeded?.();
        if (aborted) {
          databases.delete(name);
          (request as { onerror?: () => void; error?: unknown }).error = new Error('aborted');
          (request as { onerror?: () => void }).onerror?.();
          return;
        }
      }
      request.onsuccess?.();
    }, 0);
    return request;
  };
  return { open, databases };
}

let fake: ReturnType<typeof fakeIndexedDB>;
beforeEach(() => {
  fake = fakeIndexedDB();
  vi.stubGlobal('indexedDB', fake);
  setKeepsFonts(false);
});
afterEach(() => vi.unstubAllGlobals());

const bytes = (size: number) => new Uint8Array(size).fill(7).buffer;

describe('fonts kept in this browser (AV-1031, TD-103)', () => {
  it('is off by default and off again on every visit; nothing is written until it is asked for', async () => {
    expect(keepsFonts()).toBe(false);
    expect(fake.databases.size).toBe(0);
    // Looking at what is kept makes no database: nothing is written until a font is kept.
    expect(await listKeptFonts()).toEqual([]);
    expect(await readKeptFont('Anything')).toBeUndefined();
    expect(fake.databases.size).toBe(0);
    setKeepsFonts(true);
    expect(keepsFonts()).toBe(true);
  });

  it('keeps a font in its own database, lists it by name and size, gives its bytes back and removes it', async () => {
    expect(await keepFont('Brand Sans', bytes(2000))).toEqual({ ok: true });
    expect([...fake.databases.keys()]).toEqual(['opentrack-fonts']);
    expect(await listKeptFonts()).toEqual([{ family: 'Brand Sans', size: 2000 }]);
    expect(new Uint8Array((await readKeptFont('Brand Sans'))!)).toHaveLength(2000);
    expect(await readKeptFont('Nothing')).toBeUndefined();
    await removeKeptFont('Brand Sans');
    expect(await listKeptFonts()).toEqual([]);
    expect(await readKeptFont('Brand Sans')).toBeUndefined();
  });

  it('refuses a font that would take the kept fonts past 50 MB, with the reason, and keeps nothing of it', async () => {
    expect(await keepFont('Big', bytes(KEPT_FONTS_MAX_BYTES - 1000))).toEqual({ ok: true });
    expect(await keepFont('Small', bytes(1000))).toEqual({ ok: true });
    expect(await keepFont('One more', bytes(1))).toEqual({ ok: false, reason: 'One more was not kept: the kept fonts would pass 50 MB. Remove one first.' });
    expect((await listKeptFonts()).map((font) => font.family)).toEqual(['Big', 'Small']);
    // Replacing a font counts its new size, not both.
    expect(await keepFont('Small', bytes(900))).toEqual({ ok: true });
  });

  it('says so when the browser keeps nothing between visits, and reads as nothing kept', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await keepFont('A', bytes(10))).toEqual({ ok: false, reason: 'A was not kept: this browser keeps nothing between visits.' });
    expect(await readKeptFont('A')).toBeUndefined();
  });
});
