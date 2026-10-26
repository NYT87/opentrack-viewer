import { buildOverlayTimeline } from '../timeline';
import type { ExportJob, ExportOutput } from './client';
import { createOverlayRenderer, type OverlayContext2D } from './drawOverlay';
import { OverlayExportError, isOverlayExportError } from './errors';
import { frameVideoTime, webmBitsPerSecond } from './plan';
import type { ExportRequest } from './protocol';
import { patchWebmDuration } from './webmDuration';
import { WEBM_MIME_TYPE } from './webmSupport';

/**
 * AV-1012. Records the overlay as a transparent VP9 WebM.
 *
 * `MediaRecorder` records a stream, and a canvas gives a stream only on the
 * page — `captureStream()` is on `HTMLCanvasElement`, not on `OffscreenCanvas`
 * — so this runs on the main thread, not in the export worker (TD-044). The
 * recorder stamps each frame with the moment it arrives, so frames are drawn
 * on the clock, one every 1/fps seconds: the recording takes as long as the
 * overlay. A frame drawn late is stamped late, so a tab that is hidden (where
 * timers slow to once a second) or a device that falls well behind stops the
 * recording with the reason, rather than writing a video out of step with
 * the activity.
 *
 * The recorder cannot know its length while it writes, so the finished file
 * is given one (`webmDuration.ts`).
 */

/** The stream track a canvas gives, with the frame-on-request call. */
export interface CanvasTrackLike {
  requestFrame?: () => void;
  stop(): void;
}

export interface RecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface WebmRecordingDeps {
  /** A canvas of this size, its context, and a recorder of its stream. */
  setUp: (
    width: number,
    height: number,
    bitsPerSecond: number,
  ) => { ctx: OverlayContext2D; track: CanvasTrackLike; recorder: RecorderLike; release: () => void };
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** Whether the page is out of sight, where timers are slowed. */
  isHidden: () => boolean;
}

export interface RecordWebmOptions {
  frameCount: number;
  fps: number;
  width: number;
  height: number;
  drawFrame: (ctx: OverlayContext2D, videoTimeSeconds: number) => void;
  signal?: AbortSignal;
  onProgress?: (framesDone: number, frameCount: number) => void;
  deps: WebmRecordingDeps;
}

/** How far behind the clock a frame may be drawn before the recording is given up. */
export const MAX_LAG_MS = 1000;
/** How often the recorder hands over what it has, so nothing waits in it until the end. */
const TIMESLICE_MS = 1000;

const stopped = () => new OverlayExportError('cancelled', 'The export was stopped.');

export async function recordWebm(options: RecordWebmOptions): Promise<{ file: Blob; durationSeconds?: number; problem?: string }> {
  const { frameCount, fps, width, height, signal, onProgress, deps } = options;
  if (signal?.aborted) throw stopped();
  const { ctx, track, recorder, release } = deps.setUp(width, height, webmBitsPerSecond(width, height));

  const parts: Blob[] = [];
  let failure: unknown;
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) parts.push(event.data);
  };
  recorder.onerror = (event) => {
    failure ??= new OverlayExportError('render_failed', 'The browser stopped recording the video.', { cause: event });
  };
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  let recording = false;
  const endRecording = async () => {
    if (recording) {
      recording = false;
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
    }
    track.stop();
    release();
  };

  const interval = 1000 / fps;
  try {
    recorder.start(TIMESLICE_MS);
    recording = true;
    const startedAt = deps.now();
    onProgress?.(0, frameCount);
    // Each frame, and one interval after the last so the last frame lasts as long as the others.
    for (let index = 0; index <= frameCount; index += 1) {
      if (signal?.aborted) throw stopped();
      if (failure) throw failure;
      if (deps.isHidden()) {
        throw new OverlayExportError(
          'render_failed',
          'The recording stopped because this tab was hidden. A video is recorded in real time, so keep the tab open and in front until it finishes.',
        );
      }
      const due = startedAt + index * interval;
      const lag = deps.now() - due;
      if (lag > MAX_LAG_MS) {
        throw new OverlayExportError(
          'render_failed',
          'The recording fell behind and was stopped, so the overlay would not stay in step with the activity. Choose a lower frame rate or a smaller picture, and keep the tab in front.',
        );
      }
      if (lag < 0) await deps.wait(-lag);
      if (index === frameCount) break;
      if (signal?.aborted) throw stopped();
      try {
        options.drawFrame(ctx, frameVideoTime(index, fps));
      } catch (error) {
        throw new OverlayExportError('render_failed', `Frame ${index + 1} of ${frameCount} could not be drawn.`, { cause: error });
      }
      track.requestFrame?.();
      onProgress?.(index + 1, frameCount);
    }
    await endRecording();
  } catch (error) {
    await endRecording().catch(() => undefined);
    parts.length = 0;
    throw error;
  }
  if (failure) throw failure;

  if (parts.length === 0) throw new OverlayExportError('render_failed', 'The browser recorded nothing.');
  return patchWebmDuration(new Blob(parts, { type: 'video/webm' }), 1 / fps);
}

/** The browser's own canvas, recorder and clock. */
export function browserWebmDeps(): WebmRecordingDeps {
  return {
    setUp: (width, height, bitsPerSecond) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new OverlayExportError('unsupported_browser', 'This browser cannot draw the overlay to record it.');
      // Zero: a frame is taken only when one is asked for, so each is stamped when it is drawn.
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0] as (MediaStreamTrack & CanvasTrackLike) | undefined;
      if (!track || typeof track.requestFrame !== 'function') throw new OverlayExportError('unsupported_browser', 'This browser cannot record the overlay.');
      const recorder = new MediaRecorder(stream, { mimeType: WEBM_MIME_TYPE, videoBitsPerSecond: bitsPerSecond });
      return {
        ctx,
        track,
        recorder: recorder as unknown as RecorderLike,
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
    now: () => performance.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isHidden: () => document.visibilityState === 'hidden',
  };
}

/**
 * A WebM export, with the same handle a PNG export gives: progress in frames,
 * a stop, and the finished file. Nothing is stored but the recording in this
 * tab's memory, so letting it go is all a disposal needs.
 */
export function startWebmExport(
  request: Omit<ExportRequest, 'archiveName'>,
  onProgress: (done: number, total: number) => void,
  deps: WebmRecordingDeps = browserWebmDeps(),
): ExportJob {
  const controller = new AbortController();
  const timeline = buildOverlayTimeline(request.activity, {
    video: { durationSeconds: request.videoDurationSeconds, start: request.videoStart },
    offsetSeconds: request.offsetSeconds,
  });
  const renderer = createOverlayRenderer({
    template: request.template,
    timeline,
    activity: request.activity,
    units: request.units,
    width: request.width,
    height: request.height,
  });

  const done = recordWebm({
    frameCount: request.frameCount,
    fps: request.fps,
    width: request.width,
    height: request.height,
    drawFrame: (ctx, videoTime) => renderer.drawFrame(ctx, videoTime),
    signal: controller.signal,
    onProgress,
    deps,
  }).then(
    (result): ExportOutput => ({
      file: result.file,
      bytes: result.file.size,
      frameCount: request.frameCount,
      notes: result.problem
        ? [`The video’s length could not be written into it (${result.problem}), so some players show it as unknown. Editors still read every frame.`]
        : undefined,
      dispose: async () => undefined,
    }),
    (error: unknown) => {
      if (isOverlayExportError(error)) throw error;
      throw new OverlayExportError('render_failed', 'The video could not be recorded.', { cause: error });
    },
  );

  return { cancel: () => controller.abort(), done };
}
