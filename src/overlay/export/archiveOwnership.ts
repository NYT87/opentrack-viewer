/** Locks belong to the document, so they outlive a finished worker and end on tab closure. */
export const archiveLockName = (name: string): string => `opentrack-viewer:archive:${name}`;

export async function ownArchive(name: string): Promise<() => void> {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => undefined;
  return new Promise((resolve, reject) => {
    void navigator.locks.request(archiveLockName(name), async () => {
      await new Promise<void>((release) => resolve(release));
    }).catch(reject);
  });
}
