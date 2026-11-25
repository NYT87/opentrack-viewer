import { ActivityError } from '../domain/errors';
import type { OverlayContext2D, OverlayRenderer } from './renderOverlay';
import { withWebmDuration } from './webmDuration';

/**
 * AV-1007. Burned-in export: the video and the overlay, together, as one file.
 *
 * Each video frame is drawn onto a canvas, the overlay is drawn over it by the
 * same renderer the preview and the frame export use, and the canvas is recorded
 * with `MediaRecorder`. The decision and its evidence are in TD-038. In short:
 * it needs no extra library and works wherever the browser can play the video,
 * at the cost of running at the video's own speed.
 *
 * The source video is only ever read: it plays in a private, off-screen element
 * and is never modified or copied, and the recording is a new file the user
 * saves.
 */

export interface BurnInOptions {
  fps: number;
  width: number;
  height: number;
  startSeconds: number;
  endSeconds: number;
  offsetSeconds: number;
  /** Bits per pixel per frame; `standard` suits most clips, `high` keeps fine detail. */
  quality: BurnInQuality;
  includeAudio: boolean;
}

export type BurnInQuality = 'standard' | 'high';

export const MIN_FPS = 1;
export const MAX_FPS = 60;
export const MIN_SIZE = 16;
/** A canvas this large is drawn and encoded in real time on most machines; past it, frames drop. */
export const MAX_SIZE = 3840;
/** Real-time export: a half-hour clip takes half an hour. Beyond this it is not a sensible job to run in a tab. */
export const MAX_DURATION_SECONDS = 30 * 60;
/** The recording is held in memory until it is saved; this keeps that bounded. */
export const MAX_BYTES = 1024 * 1024 * 1024;

const BITS_PER_PIXEL: Record<BurnInQuality, number> = { standard: 0.09, high: 0.16 };
const MIN_BITRATE = 1_500_000;
const MAX_BITRATE = 40_000_000;
/** Audio is recorded at a fixed, generous rate; it is small beside the picture. */
const AUDIO_BITRATE = 128_000;

export interface RecorderFormat {
  mimeType: string;
  extension: 'webm' | 'mp4';
  /** The recorder was asked for audio in this format as well. */
  withAudio: boolean;
}

/** Formats to try, best first. WebM with VP9 plays almost everywhere; MP4 is what Safari records. */
const CANDIDATES: { mime: (audio: boolean) => string; extension: 'webm' | 'mp4' }[] = [
  { mime: (a) => (a ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9'), extension: 'webm' },
  { mime: (a) => (a ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8'), extension: 'webm' },
  { mime: (a) => (a ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' : 'video/mp4;codecs=avc1.42E01E'), extension: 'mp4' },
  { mime: () => 'video/mp4;codecs=avc1', extension: 'mp4' },
  { mime: () => 'video/webm', extension: 'webm' },
  { mime: () => 'video/mp4', extension: 'mp4' },
];

/** The first format the browser can record, or undefined when it can record none. */
export function pickRecorderFormat(
  isSupported: (mime: string) => boolean,
  withAudio: boolean,
): RecorderFormat | undefined {
  for (const candidate of CANDIDATES) {
    const mimeType = candidate.mime(withAudio);
    if (isSupported(mimeType)) {
      // A generic type carries whatever audio the browser chooses.
      return { mimeType, extension: candidate.extension, withAudio };
    }
  }
  return undefined;
}

export interface BurnInPlan {
  durationSeconds: number;
  videoBitsPerSecond: number;
  /** Rough size of the finished file. */
  estimatedBytes: number;
}

/** The bitrate a size and frame rate call for at a given quality. */
export function bitrateFor(options: Pick<BurnInOptions, 'width' | 'height' | 'fps' | 'quality'>): number {
  const wanted = options.width * options.height * options.fps * BITS_PER_PIXEL[options.quality];
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, wanted)));
}

/** Checks the options and says what the export will cost, before any work is done. */
export function planBurnIn(options: BurnInOptions, videoDuration?: number): BurnInPlan {
  const fail = (
    code: 'invalid_selected_range' | 'overlay_export_too_large',
    message: string,
  ): never => {
    throw new ActivityError(code, message);
  };
  const { fps, width, height, startSeconds, endSeconds, offsetSeconds } = options;

  if (![fps, width, height, startSeconds, endSeconds, offsetSeconds].every(Number.isFinite)) {
    fail('invalid_selected_range', 'Every setting must be a number.');
  }
  if (!Number.isInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) {
    fail('invalid_selected_range', `The frame rate must be a whole number from ${MIN_FPS} to ${MAX_FPS}.`);
  }
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < MIN_SIZE) {
      fail('invalid_selected_range', `The ${name} must be a whole number of at least ${MIN_SIZE} pixels.`);
    }
    if (value > MAX_SIZE) {
      fail('overlay_export_too_large', `The ${name} can be at most ${MAX_SIZE} pixels.`);
    }
  }
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    fail('invalid_selected_range', 'The end of the range must be after its start, and neither can be negative.');
  }
  if (videoDuration !== undefined && Number.isFinite(videoDuration) && endSeconds > videoDuration + 0.05) {
    fail('invalid_selected_range', `The video is only ${videoDuration.toFixed(1)} seconds long.`);
  }

  const durationSeconds = endSeconds - startSeconds;
  if (durationSeconds > MAX_DURATION_SECONDS) {
    fail(
      'overlay_export_too_large',
      `This runs at the video's own speed, so ${Math.round(durationSeconds / 60)} minutes of video takes that long to save. The most one export covers is ${MAX_DURATION_SECONDS / 60} minutes; choose a shorter range.`,
    );
  }

  const videoBitsPerSecond = bitrateFor(options);
  const bits = videoBitsPerSecond + (options.includeAudio ? AUDIO_BITRATE : 0);
  const estimatedBytes = Math.round((bits * durationSeconds) / 8);
  if (estimatedBytes > MAX_BYTES) {
    fail(
      'overlay_export_too_large',
      `The file would be about ${Math.round(estimatedBytes / 1e6).toLocaleString('en-US')} MB; the most one export holds is ${Math.round(MAX_BYTES / 1e6).toLocaleString('en-US')} MB. Choose a shorter range, a smaller size or standard quality.`,
    );
  }
  return { durationSeconds, videoBitsPerSecond, estimatedBytes };
}

// --------------------------------------------------------------- environment

/** What the export needs from the browser, so it can be driven by a test without one. */
export interface BurnInEnvironment {
  isRecordingSupported(): boolean;
  isTypeSupported(mime: string): boolean;
  /** A private, off-screen element to play the video in. */
  createVideo(): HTMLVideoElement;
  createObjectUrl(file: Blob): string;
  revokeObjectUrl(url: string): void;
  createCanvas(width: number, height: number): HTMLCanvasElement;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  /** Routes the video's sound into a track, without playing it aloud. Undefined where that cannot be done. */
  createAudioRoute(video: HTMLVideoElement): AudioRoute | undefined;
  /** Whether the video has any sound, where the browser can say. */
  hasAudio(video: HTMLVideoElement): boolean | undefined;
  isTabHidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  now(): number;
}

export interface AudioRoute {
  track: MediaStreamTrack;
  close(): void;
}

export const browserEnvironment: BurnInEnvironment = {
  isRecordingSupported: () =>
    typeof MediaRecorder !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function',
  isTypeSupported: (mime) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime),
  createVideo: () => {
    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'auto';
    // Deliberately NOT muted. A muted element records silence: the sound is
    // captured by routing it into the recording (see `createAudioRoute`), which
    // also keeps it from playing aloud while the export runs.
    return video;
  },
  createObjectUrl: (file) => URL.createObjectURL(file),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  createRecorder: (stream, options) => new MediaRecorder(stream, options),
  createAudioRoute: (video) => {
    const AudioContextClass =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return undefined;
    try {
      const context = new AudioContextClass();
      const source = context.createMediaElementSource(video);
      const destination = context.createMediaStreamDestination();
      // To the recording only; never to `context.destination`, the speakers.
      source.connect(destination);
      const track = destination.stream.getAudioTracks()[0];
      if (!track) {
        void context.close();
        return undefined;
      }
      void context.resume().catch(() => undefined);
      return {
        track,
        close: () => {
          track.stop();
          void context.close().catch(() => undefined);
        },
      };
    } catch {
      return undefined;
    }
  },
  hasAudio: (video) => {
    const capture = (video as unknown as { captureStream?: () => MediaStream }).captureStream;
    if (typeof capture !== 'function') return undefined;
    try {
      return capture.call(video).getAudioTracks().length > 0;
    } catch {
      return undefined;
    }
  },
  isTabHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  now: () => performance.now(),
};

// -------------------------------------------------------------------- export

export interface BurnInProgress {
  /** Seconds of the range recorded so far. */
  recordedSeconds: number;
  durationSeconds: number;
  /** Bytes the recorder has produced so far. */
  bytes: number;
  elapsedMs: number;
  remainingMs: number;
  /** The export is waiting for the tab to be visible again. */
  paused: boolean;
}

export interface BurnInRun {
  file: Blob;
  options: BurnInOptions;
  renderer: OverlayRenderer;
  signal?: AbortSignal;
  onProgress?: (progress: BurnInProgress) => void;
  env?: BurnInEnvironment;
}

export interface BurnInResult {
  blob: Blob;
  mimeType: string;
  extension: 'webm' | 'mp4';
  durationSeconds: number;
  bytes: number;
  /** Whether the file carries the video's sound. */
  hasAudio: boolean;
}

const cancelled = () => new ActivityError('overlay_export_cancelled', 'The export was stopped.');

/** How long the picture may fail to advance, while playing and visible, before giving up. */
const STALL_MS = 8_000;

/**
 * Records the video with the overlay burned in. Resolves with the file, and
 * rejects with a typed error if the options or browser cannot do it, the video
 * cannot be played, the signal aborts, or the recording fails.
 */
export async function exportBurnedIn(run: BurnInRun): Promise<BurnInResult> {
  const env = run.env ?? browserEnvironment;
  const { options, renderer, signal, onProgress } = run;

  if (signal?.aborted) throw cancelled();
  if (!env.isRecordingSupported()) {
    throw new ActivityError(
      'overlay_export_unsupported',
      'This browser cannot record video from a page.',
    );
  }

  // Everything created below is released on every path out, including failures.
  const cleanups: (() => void)[] = [];
  const cleanup = () => {
    for (const undo of cleanups.reverse()) {
      try {
        undo();
      } catch {
        /* releasing must never hide the real error */
      }
    }
  };

  try {
    const url = env.createObjectUrl(run.file);
    cleanups.push(() => env.revokeObjectUrl(url));
    const video = env.createVideo();
    video.muted = false;
    video.src = url;
    cleanups.push(() => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    });

    await waitFor(video, 'loadedmetadata', signal, () =>
      new ActivityError(
        'overlay_export_unsupported',
        'This browser cannot play that video, so it cannot be recorded. Some cameras record in a format browsers do not decode.',
      ),
    );

    const plan = planBurnIn(options, video.duration);
    const audioPresent = options.includeAudio ? env.hasAudio(video) : false;
    const wantAudio = options.includeAudio && audioPresent !== false;

    const canvas = env.createCanvas(options.width, options.height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new ActivityError('overlay_export_unsupported', 'This browser cannot draw images for the overlay.');
    }
    const draw = context as unknown as OverlayContext2D & CanvasRenderingContext2D;

    const stream = canvas.captureStream(options.fps);
    cleanups.push(() => stream.getTracks().forEach((track) => track.stop()));

    let audioRoute: AudioRoute | undefined;
    if (wantAudio) {
      audioRoute = env.createAudioRoute(video);
      if (audioRoute) {
        stream.addTrack(audioRoute.track);
        const route = audioRoute;
        cleanups.push(() => route.close());
      }
    }

    const format = pickRecorderFormat((mime) => env.isTypeSupported(mime), Boolean(audioRoute));
    if (!format) {
      throw new ActivityError(
        'overlay_export_unsupported',
        'This browser cannot record video in a format it can save.',
      );
    }

    const recorder = env.createRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: plan.videoBitsPerSecond,
      ...(audioRoute ? { audioBitsPerSecond: AUDIO_BITRATE } : {}),
    });

    const chunks: Blob[] = [];
    let bytes = 0;
    let tooLarge = false;
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (bytes > MAX_BYTES) tooLarge = true;
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    // Start from the beginning of the range.
    if (options.startSeconds > 0) {
      video.currentTime = options.startSeconds;
      await waitFor(video, 'seeked', signal, () => new ActivityError('overlay_export_failed', 'The video could not be moved to the start of the range.'));
    }

    const drawFrame = (seconds: number) => {
      draw.drawImage(video, 0, 0, options.width, options.height);
      // Over the picture, not instead of it: no clear.
      renderer.render(draw, options.width, options.height, seconds, options.offsetSeconds, { clear: false });
    };
    drawFrame(options.startSeconds);

    // ---- record, at the video's own speed
    const startedAt = env.now();
    let paused = false;
    let finished = false;
    let lastAdvance = env.now();
    let lastTime = video.currentTime;
    let failure: ActivityError | undefined;

    const report = (seconds: number) => {
      const recorded = Math.max(0, Math.min(plan.durationSeconds, seconds - options.startSeconds));
      onProgress?.({
        recordedSeconds: recorded,
        durationSeconds: plan.durationSeconds,
        bytes,
        elapsedMs: env.now() - startedAt,
        remainingMs: Math.max(0, (plan.durationSeconds - recorded) * 1000),
        paused,
      });
    };

    const done = new Promise<void>((resolve) => {
      const finish = (error?: ActivityError) => {
        if (finished) return;
        finished = true;
        if (error) failure = error;
        resolve();
      };

      const frame = (_now?: number, metadata?: { mediaTime?: number }) => {
        if (finished) return;
        if (signal?.aborted) return finish(cancelled());
        if (tooLarge) {
          return finish(
            new ActivityError('overlay_export_too_large', 'The recording grew past the size one export can hold, so it was stopped.'),
          );
        }
        const seconds = metadata?.mediaTime ?? video.currentTime;
        if (seconds >= options.endSeconds - 0.5 / options.fps || video.ended) {
          drawFrame(Math.min(seconds, options.endSeconds));
          report(options.endSeconds);
          return finish();
        }
        if (!paused) {
          drawFrame(seconds);
          report(seconds);
          if (seconds !== lastTime) {
            lastTime = seconds;
            lastAdvance = env.now();
          } else if (env.now() - lastAdvance > STALL_MS) {
            return finish(new ActivityError('overlay_export_failed', 'The video stopped advancing, so the export was stopped.'));
          }
        } else {
          lastAdvance = env.now();
        }
        schedule();
      };

      const schedule = () => {
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(frame);
        else requestAnimationFrame(() => frame());
      };

      video.onerror = () =>
        finish(new ActivityError('overlay_export_failed', 'The video could not be played all the way through.'));
      video.onended = () => frame();
      signal?.addEventListener('abort', () => finish(cancelled()), { once: true });

      // A hidden tab is throttled by the browser, which would drop frames: wait
      // for it to come back instead.
      const unsubscribe = env.onVisibilityChange(() => {
        if (finished) return;
        if (env.isTabHidden() && !paused) {
          paused = true;
          video.pause();
          if (recorder.state === 'recording') recorder.pause();
          report(video.currentTime);
        } else if (!env.isTabHidden() && paused) {
          paused = false;
          if (recorder.state === 'paused') recorder.resume();
          void video.play().catch(() => undefined);
        }
      });
      cleanups.push(unsubscribe);

      recorder.start(1000);
      video.play().then(schedule, () =>
        finish(new ActivityError('overlay_export_failed', 'The video could not be started. Click the page and try again.')),
      );
    });

    await done;
    video.pause();
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;

    if (failure) throw failure;
    if (signal?.aborted) throw cancelled();
    if (chunks.length === 0) {
      throw new ActivityError('overlay_export_failed', 'The recording came out empty.');
    }

    const mimeType = recorder.mimeType || format.mimeType;
    let blob = new Blob(chunks, { type: mimeType });
    // MediaRecorder's WebM has no length: write it in, so players can seek.
    if (format.extension === 'webm') blob = await withWebmDuration(blob, plan.durationSeconds);

    return {
      blob,
      mimeType,
      extension: format.extension,
      durationSeconds: plan.durationSeconds,
      bytes: blob.size,
      hasAudio: Boolean(audioRoute),
    };
  } catch (error) {
    if (error instanceof ActivityError) throw error;
    throw new ActivityError('overlay_export_failed', 'The video could not be recorded.', { cause: error });
  } finally {
    cleanup();
  }
}

/** Resolves when `video` fires `type`; rejects with `onError()` if it errors, or the signal aborts. */
function waitFor(
  video: HTMLVideoElement,
  type: 'loadedmetadata' | 'seeked',
  signal: AbortSignal | undefined,
  onError: () => ActivityError,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (type === 'loadedmetadata' && video.readyState >= 1) return resolve();
    const detach = () => {
      video.removeEventListener(type, ok);
      video.removeEventListener('error', bad);
      signal?.removeEventListener('abort', stop);
    };
    const ok = () => {
      detach();
      resolve();
    };
    const bad = () => {
      detach();
      reject(onError());
    };
    const stop = () => {
      detach();
      reject(cancelled());
    };
    video.addEventListener(type, ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    signal?.addEventListener('abort', stop, { once: true });
  });
}
