import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoReadProgressState } from '../components/VideoReadProgress';
import { readVideoTelemetry, type VideoTelemetry } from './readVideoTelemetry';

/**
 * Owns one video read at a time: the abort controller, the progress, and the
 * stop. Shared by the extraction page and the overlay page so the cancel path
 * exists once.
 *
 * Leaving the page aborts the read. The alternative — a read that outlives
 * its page and writes its result into a store minutes later — would be a
 * surprise nobody asked for, and for a multi-gigabyte file it is minutes.
 */
export function useVideoTelemetryRead() {
  const [reading, setReading] = useState<VideoReadProgressState | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  const read = useCallback(async (file: File): Promise<VideoTelemetry> => {
    // A new read supersedes one in flight, which is stopped rather than raced.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setReading({ fileName: file.name, fraction: 0 });

    try {
      return await readVideoTelemetry(file, {
        signal: controller.signal,
        onProgress: (fraction) =>
          setReading((current) =>
            // A superseded read's late progress must not touch the new one's.
            current && abortRef.current === controller ? { ...current, fraction } : current,
          ),
      });
    } finally {
      // Only the read that still owns the controller clears the panel: the
      // superseded one rejects a microtask later and must not wipe its
      // successor's progress.
      if (abortRef.current === controller) {
        abortRef.current = undefined;
        setReading(undefined);
      }
    }
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return { reading, read, cancel };
}
