import { ActivityError } from '../../domain/errors';

/**
 * How long to wait after the file has been read in full before concluding it
 * carried no telemetry. Long enough for a payload already parsed to settle,
 * short enough that a reader is not left watching a finished progress bar.
 */
const END_OF_READ_GRACE_MS = 1_500;

/**
 * Timing the container reports alongside the payload: how long the video runs,
 * how long a frame lasts, and when each metadata sample begins.
 */
export interface GpmfTiming {
  videoDurationSeconds: number;
  frameDurationMs: number;
  /** Wall-clock start, where the container states one. */
  start?: Date;
  /** One entry per metadata sample: `cts` is milliseconds from the first frame. */
  samples: { cts: number; duration: number }[];
}

export interface GpmfPayload {
  /** The raw GPMF bytes, still uninterpreted. `AV-904` reads them. */
  rawData: Uint8Array;
  timing: GpmfTiming;
}

export interface ExtractGpmfOptions {
  /** Fraction complete, 0 to 1, as the file is read. */
  onProgress?: (fraction: number) => void;
  /** Aborts the read; the returned promise then rejects. */
  signal?: AbortSignal;
}

/**
 * AV-903. Pulls the raw GPMF payload out of a GoPro MP4/MOV, in the browser.
 *
 * Everything happens on this device. The file is read through the browser's own
 * streaming APIs and nothing is uploaded — not the video, not the payload, not
 * the file's name (plan §5).
 *
 * **Memory.** `gpmf-extract` streams the file with backpressure rather than
 * reading it whole, so peak memory tracks the *metadata* — a few megabytes for
 * a long recording — not the video, which may be gigabytes (TD-025). It does
 * that work in a Web Worker of its own, which is what keeps the UI responsive.
 *
 * The library is loaded on demand: a reader who never opens a video should not
 * download an MP4 demuxer.
 */
export async function extractGpmf(
  file: File | Blob,
  options: ExtractGpmfOptions = {},
): Promise<GpmfPayload> {
  const { onProgress, signal } = options;
  signal?.throwIfAborted();

  const { default: gpmfExtract } = await import('gpmf-extract');

  /*
   * TD-025 records the defect this works around: `gpmf-extract` resolves as
   * soon as it has the samples but never stops the reader, so a multi-gigabyte
   * file keeps streaming afterwards. The token is checked on every chunk, so
   * setting it is what actually ends the read.
   */
  const cancellation = { cancelled: false };
  const abort = () => {
    cancellation.cancelled = true;
  };
  signal?.addEventListener('abort', abort, { once: true });

  /*
   * A second defect, found by feeding the library a file that is not a
   * parseable MP4: it neither resolves nor rejects. It reads to the end,
   * never recognizes a container, and simply stops — which in a UI is a
   * progress bar that fills and then waits forever.
   *
   * The read reaching 100% is the honest signal that nothing more can arrive.
   * A short grace period after it lets a payload that is genuinely in flight
   * settle first, and anything still pending after that had no track to find.
   */
  let finished: (() => void) | undefined;
  const readEnded = new Promise<never>((_, reject) => {
    finished = () => {
      setTimeout(() => {
        reject(
          new ActivityError(
            'no_telemetry_track',
            'This video has no GoPro telemetry track, so there is no activity to read from it.',
          ),
        );
      }, END_OF_READ_GRACE_MS);
    };
  });

  try {
    const extraction = gpmfExtract(file, {
      browserMode: true,
      /*
       * The library's own Web Worker is disabled, and that is a correctness
       * decision rather than a preference: with it enabled, current Chromium
       * reports "Track not found" for a GoPro file that reads perfectly
       * without it. Its README hedges that the worker "seems to crash on some
       * recent browsers", and a browser test caught it doing exactly that.
       *
       * The read still yields: it is chunked through a stream, so the main
       * thread is released between chunks rather than blocked for the length
       * of the file. Moving the whole extraction into a worker of our own
       * stays open, and this API is async precisely so that can happen without
       * touching a caller (AV-903).
       */
      useWorker: false,
      cancellationToken: cancellation,
      // The library reports whole percentages; this API speaks in fractions.
      progress: (percent: number) => {
        onProgress?.(percent / 100);
        if (percent >= 100) finished?.();
      },
    });

    const result = await Promise.race([extraction, readEnded]);
    return { rawData: result.rawData, timing: toTiming(result.timing) };
  } catch (error) {
    throw toExtractionError(error, signal);
  } finally {
    // Stop the read whatever happened, including the successful case: the
    // promise settling is not what ends it.
    cancellation.cancelled = true;
    signal?.removeEventListener('abort', abort);
  }
}

function toTiming(timing: {
  videoDuration: number;
  frameDuration: number;
  start?: Date;
  samples: { cts: number; duration: number }[];
}): GpmfTiming {
  return {
    videoDurationSeconds: timing.videoDuration,
    frameDurationMs: timing.frameDuration,
    ...(timing.start instanceof Date ? { start: timing.start } : {}),
    samples: timing.samples ?? [],
  };
}

/**
 * The library rejects with plain strings. They become typed errors here, so a
 * caller can tell "this video has no telemetry" from "the reader was stopped"
 * without matching on prose.
 */
function toExtractionError(error: unknown, signal?: AbortSignal): ActivityError {
  if (error instanceof ActivityError) return error;

  const message = typeof error === 'string' ? error : ((error as Error)?.message ?? '');

  if (signal?.aborted || /cancel/i.test(message)) {
    return new ActivityError('extraction_cancelled', 'Reading the video was stopped.');
  }
  if (/track not found/i.test(message)) {
    return new ActivityError(
      'no_telemetry_track',
      'This video has no GoPro telemetry track, so there is no activity to read from it.',
    );
  }
  return new ActivityError(
    'gopro_extract_failed',
    'The GoPro telemetry in this video could not be read.',
  );
}
