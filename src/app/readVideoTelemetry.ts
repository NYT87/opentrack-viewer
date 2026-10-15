import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import type { OverlayVideoTiming } from '../state/overlayStore';

/** The container formats a GoPro writes — the one list both video intakes use. */
export const VIDEO_EXTENSIONS = ['mp4', 'mov'];

export interface ReadVideoTelemetryOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface VideoTelemetry {
  /** The container's clock, known whenever a telemetry track was found. */
  timing?: OverlayVideoTiming;
  /** Absent when the video yielded no activity. */
  activity?: Activity;
  /**
   * Why it yielded none: no telemetry track at all, a track with no GPS
   * stream, or GPS with no sample that had a satellite fix. Present exactly
   * when `activity` is absent.
   */
  activityError?: ActivityError;
}

/**
 * Reads the telemetry out of a GoPro video and normalizes it, keeping the
 * container's clock beside the result. Shared by the extraction page (AV-907)
 * and the overlay page (AV-1002), which read the same files for different ends.
 *
 * One decision lives here and nowhere else: which outcomes still leave a
 * video worth keeping. A video that yields no activity — no telemetry track,
 * or one recorded indoors with no fix — is *returned*, with its clock where
 * there was one, because the overlay page can still draw a watch's track over
 * it; the extraction page treats the same result as the failure it is for its
 * purpose. What is *thrown* is a file nothing could be drawn over (not a
 * container, no index, a read that failed) or a stop.
 *
 * Both modules are loaded on demand: a reader who never opens a video should
 * not download an MP4 demuxer to look at a GPX file.
 */
export async function readVideoTelemetry(
  file: File,
  options: ReadVideoTelemetryOptions = {},
): Promise<VideoTelemetry> {
  const [{ extractGpmf }, { parseGopro }] = await Promise.all([
    import('../parsers/gopro/extractGpmf'),
    import('../parsers/gopro/parseGopro'),
  ]);

  let payload;
  try {
    payload = await extractGpmf(file, options);
  } catch (error) {
    const failure = toActivityError(error, 'gopro_extract_failed');
    if (failure.code === 'no_telemetry_track') return { activityError: failure };
    throw failure;
  }
  // The extractor honours the signal; the parser cannot, so a stop that lands
  // during it is honoured here, before anything is handed back.
  throwIfAborted(options.signal);

  const timing: OverlayVideoTiming = {
    durationSeconds: payload.timing.videoDurationSeconds,
    frameIntervalSeconds: payload.timing.frameIntervalSeconds,
    start: payload.timing.start,
  };

  try {
    const activity = await parseGopro(payload, { fileName: file.name, fileSizeBytes: file.size });
    throwIfAborted(options.signal);
    return { timing, activity };
  } catch (error) {
    const failure = toActivityError(error, 'gopro_extract_failed');
    if (failure.code === 'no_telemetry_track' || failure.code === 'no_location_stream') {
      return { timing, activityError: failure };
    }
    throw failure;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ActivityError('extraction_cancelled', 'Reading the video was stopped.');
  }
}
