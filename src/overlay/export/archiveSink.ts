import { OverlayExportError } from './errors';
import { ARCHIVE_NAME_PREFIX, type ArchiveStorage } from './protocol';
import { ZIP_MAX_BYTES, type ZipSink } from './zip';

/**
 * AV-1006 (TD-039). Where the archive goes while it is being written.
 *
 * A ten-minute export is gigabytes, so it is written to a file in the
 * origin-private file system as it is drawn, through a synchronous access
 * handle — the one write path every engine offers a worker. Where that is
 * missing the chunks are kept in memory, up to a limit, and the export is
 * refused beyond it rather than taking the tab down with it.
 *
 * Nothing here leaves the device: the origin-private file system is private
 * to this origin and this browser profile.
 */

/** What a tab can hold without being killed, with room to spare. */
export const MEMORY_SINK_LIMIT_BYTES = 1_000_000_000;

/**
 * The most an export may be, given where the worker can really put it: a file
 * is limited by the ZIP format, memory by what a tab can hold. The page plans
 * against this before any frame is drawn, so a job that cannot be stored is
 * refused up front instead of failing after minutes of drawing.
 */
export function storageLimitBytes(storage: ArchiveStorage): number {
  return storage === 'opfs' ? ZIP_MAX_BYTES : MEMORY_SINK_LIMIT_BYTES;
}

export interface ArchiveSink {
  sink: ZipSink;
  storage: ArchiveStorage;
  /** Closes the archive and hands back the finished file. */
  finish(): Promise<Blob>;
  /** Discards everything written. Safe to call after `finish` fails. */
  abort(): Promise<void>;
}

interface SyncHandle {
  write(buffer: Uint8Array, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

export function opfsAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof (globalThis as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle
      ?.prototype === 'object' &&
    'createSyncAccessHandle' in
      (globalThis as unknown as { FileSystemFileHandle: { prototype: object } })
        .FileSystemFileHandle.prototype
  );
}

async function createOpfsSink(archiveName: string): Promise<ArchiveSink> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(archiveName, { create: true });
  let access: SyncHandle;
  try {
    access = (await (
      handle as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }
    ).createSyncAccessHandle()) as SyncHandle;
  } catch (error) {
    // The file now exists but will never be written: it must not outlive the
    // attempt, because the caller is about to fall back to memory and forget it.
    await root.removeEntry(archiveName).catch(() => undefined);
    throw error;
  }
  let position = 0;
  let open = true;

  const close = () => {
    if (!open) return;
    open = false;
    try {
      access.flush();
    } finally {
      access.close();
    }
  };

  return {
    storage: 'opfs',
    sink: {
      write(chunk) {
        const written = access.write(chunk, { at: position });
        // A short write is a full disk or an exhausted quota: say so, do not truncate.
        if (written !== chunk.length) {
          throw new OverlayExportError(
            'storage_failed',
            'This browser could not store the export — there may not be enough free space.',
          );
        }
        position += written;
      },
    },
    async finish() {
      close();
      return handle.getFile();
    },
    async abort() {
      try {
        close();
      } catch {
        // already closed, or never opened for writing
      }
      await root.removeEntry(archiveName).catch(() => undefined);
    },
  };
}

function createMemorySink(): ArchiveSink {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  return {
    storage: 'memory',
    sink: {
      write(chunk) {
        bytes += chunk.length;
        if (bytes > MEMORY_SINK_LIMIT_BYTES) {
          throw new OverlayExportError(
            'storage_failed',
            'This browser cannot write an export this large to disk. Choose a lower frame rate or a smaller size.',
          );
        }
        // Copied: the caller reuses its buffers.
        parts.push(chunk.slice());
      },
    },
    async finish() {
      return new Blob(parts as BlobPart[], { type: 'application/zip' });
    },
    async abort() {
      parts.length = 0;
    },
  };
}

export async function createArchiveSink(archiveName: string): Promise<ArchiveSink> {
  if (opfsAvailable()) {
    try {
      return await createOpfsSink(archiveName);
    } catch {
      // Private browsing and some policies refuse the file system: fall through.
    }
  }
  return createMemorySink();
}

/**
 * Which storage a real export would get *in the worker*: tries to open exactly
 * what the export opens — a file and its synchronous access handle — and
 * removes it again. Only the worker can say, because only the worker is given
 * the access handle, and a browser can have the file system and still refuse it.
 */
export async function probeArchiveStorage(archiveName: string): Promise<ArchiveStorage> {
  const archive = await createArchiveSink(archiveName);
  await archive.abort();
  return archive.storage;
}

/** Removes leftovers from an export that was interrupted by a crash or a closed tab. */
export async function removeStaleArchives(except?: string): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith(ARCHIVE_NAME_PREFIX) && name !== except) names.push(name);
    }
    // A file another tab is writing is locked and refuses removal: leave it.
    await Promise.all(names.map((name) => root.removeEntry(name).catch(() => undefined)));
  } catch {
    // Housekeeping only.
  }
}

export async function removeArchive(archiveName: string): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(archiveName);
  } catch {
    // Already gone, or never written to the file system.
  }
}
