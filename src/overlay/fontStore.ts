import { KEPT_FONTS_MAX_BYTES } from './fonts';

/**
 * AV-1031 (TD-103). Fonts the reader chose to keep in this browser: their bytes in IndexedDB
 * (`opentrack-fonts`), never anywhere else, at most 50 MB in all. Off by default; nothing is written
 * unless the reader ticked *Keep loaded fonts in this browser*, and each kept font can be removed.
 */

const DB_NAME = 'opentrack-fonts';
const BYTES = 'bytes';
const META = 'meta';

export interface KeptFont {
  family: string;
  size: number;
}

const keptListeners = new Set<() => void>();
/** Told when a font is kept or removed, so every list of them is made again. */
export const subscribeKept = (listener: () => void): (() => void) => {
  keptListeners.add(listener);
  return () => keptListeners.delete(listener);
};
const keptChanged = () => keptListeners.forEach((listener) => listener());

/** `write` false only looks: a database that is not there is not made (the open is aborted in its upgrade). */
function open(write = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('this browser keeps nothing between visits'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!write) {
        request.transaction?.abort();
        return;
      }
      request.result.createObjectStore(BYTES);
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the browser refused to open its store'));
    request.onblocked = () => reject(new Error('the browser store is blocked by another tab'));
  });
}

const done = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('the browser refused the write'));
    transaction.onabort = () => reject(transaction.error ?? new Error('the browser could not keep the font'));
  });

const result = <T,>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** The kept fonts, by name and size; their bytes are not read. */
export async function listKeptFonts(): Promise<KeptFont[]> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return [];
  }
  try {
    const rows = (await result(db.transaction(META).objectStore(META).getAll())) as KeptFont[];
    return rows.sort((a, b) => a.family.localeCompare(b.family));
  } finally {
    db.close();
  }
}

/** The bytes of a kept font, or `undefined` when none is kept under the name or the store is not there. */
export async function readKeptFont(family: string): Promise<ArrayBuffer | undefined> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return undefined;
  }
  try {
    return (await result(db.transaction(BYTES).objectStore(BYTES).get(family))) as ArrayBuffer | undefined;
  } finally {
    db.close();
  }
}

/** Keeps a font; refuses, with the reason, when all the kept fonts would pass 50 MB. */
export async function keepFont(family: string, bytes: ArrayBuffer): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const db = await open(true);
    try {
      const others = (await result(db.transaction(META).objectStore(META).getAll())) as KeptFont[];
      const total = others.filter((entry) => entry.family !== family).reduce((sum, entry) => sum + entry.size, 0) + bytes.byteLength;
      if (total > KEPT_FONTS_MAX_BYTES) {
        return { ok: false, reason: `${family} was not kept: the kept fonts would pass 50 MB. Remove one first.` };
      }
      const transaction = db.transaction([BYTES, META], 'readwrite');
      transaction.objectStore(BYTES).put(bytes, family);
      transaction.objectStore(META).put({ family, size: bytes.byteLength } satisfies KeptFont, family);
      await done(transaction);
      keptChanged();
      return { ok: true };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, reason: `${family} was not kept: ${error instanceof Error ? error.message : 'the browser refused'}.` };
  }
}

export async function removeKeptFont(family: string): Promise<void> {
  const db = await open(true);
  try {
    const transaction = db.transaction([BYTES, META], 'readwrite');
    transaction.objectStore(BYTES).delete(family);
    transaction.objectStore(META).delete(family);
    await done(transaction);
    keptChanged();
  } finally {
    db.close();
  }
}

/** *Keep loaded fonts in this browser*: off until the reader ticks it, and off again on every visit. */
let keeping = false;
export const keepsFonts = (): boolean => keeping;
export const setKeepsFonts = (on: boolean): void => {
  keeping = on;
};
