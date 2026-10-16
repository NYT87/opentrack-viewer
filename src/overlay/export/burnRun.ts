import type * as Mediabunny from 'mediabunny';
import { buildOverlayTimeline } from '../timeline';
import { createOverlayRenderer } from './drawOverlay';
import { OverlayExportError } from './errors';
import type { BurnRequest, BurnSourceInfo } from './protocol';

/**
 * AV-1007. The burned-in render, on Mediabunny's conversion pipeline: it
 * demuxes the video, decodes it with WebCodecs, hands each frame to us, encodes
 * what we return with an H.264 encoder (hardware asked for), copies the audio through, and
 * muxes MP4 into a file in the origin-private file system. What is ours is the
 * one thing in the middle: draw the overlay over the frame.
 *
 * Mediabunny is passed in rather than imported, so the loop is testable with a
 * stand-in, and so the worker loads the library only when a render is asked for.
 */
export type MediabunnyModule = typeof Mediabunny;

const CANCELLED = () => new OverlayExportError('cancelled', 'The export was stopped.');

/** A container this app reads: MP4 and QuickTime, which is what cameras write. */
function openInput(mb: MediabunnyModule, file: Blob) {
  return new mb.Input({ source: new mb.BlobSource(file), formats: [mb.MP4, mb.QTFF] });
}

/**
 * What is in the video, and whether this browser can work with it — from the
 * container's index and the codec registry, without reading any picture.
 */
export async function inspectSource(
  mb: MediabunnyModule,
  file: Blob,
  target: { width: number; height: number; bitrate: number; frameRate?: number },
): Promise<BurnSourceInfo> {
  const input = openInput(mb, file);
  try {
    const [video, audio] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]).catch(() => {
      throw new OverlayExportError(
        'render_failed',
        'This file is not a video this export can read. It needs to be an MP4 or MOV.',
      );
    });
    const [videoCanDecode, audioCanDecode, canEncode] = await Promise.all([
      video ? video.canDecode() : Promise.resolve(false),
      audio ? audio.canDecode() : Promise.resolve(false),
      // Hardware is asked for, but `prefer-hardware` is a hint: a browser says
      // whether it can encode this at all, never which encoder it will use.
      mb.canEncodeVideo('avc', {
        width: target.width,
        height: target.height,
        quality: new mb.Quality({ bitrate: target.bitrate }),
        frameRate: target.frameRate,
        hardwareAcceleration: 'prefer-hardware',
      }),
    ]);
    return {
      video: video
        ? {
            codec: video.codec,
            width: video.displayWidth,
            height: video.displayHeight,
            canDecode: videoCanDecode,
          }
        : undefined,
      audio: audio ? { codec: audio.codec, canDecode: audioCanDecode } : undefined,
      canEncode,
    };
  } finally {
    input.dispose();
  }
}

export interface BurnRunOptions {
  mb: MediabunnyModule;
  request: BurnRequest;
  /** Writes at an absolute position in the output file. */
  writeAt: (chunk: Uint8Array, position: number) => void;
  signal?: AbortSignal;
  onProgress?: (fraction: number, processedSeconds: number) => void;
}

export interface BurnRunResult {
  frameCount: number;
  notes: string[];
}

export async function runBurn(options: BurnRunOptions): Promise<BurnRunResult> {
  const { mb, request, writeAt, signal } = options;
  if (signal?.aborted) throw CANCELLED();

  const canvas = new OffscreenCanvas(request.width, request.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new OverlayExportError('unsupported_browser', 'This browser cannot draw on an offscreen canvas.');
  }
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

  const input = openInput(mb, request.file);
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: false }),
    target: new mb.StreamTarget(
      new WritableStream({
        write(chunk: Mediabunny.StreamTargetChunk) {
          writeAt(chunk.data, chunk.position);
        },
      }),
    ),
  });

  let frames = 0;
  try {
    const conversion = await mb.Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: {
        codec: 'avc',
        quality: new mb.Quality({ bitrate: request.bitrate }),
        hardwareAcceleration: 'prefer-hardware',
        width: request.width,
        height: request.height,
        fit: 'fill',
        frameRate: request.frameRate,
        processedWidth: request.width,
        processedHeight: request.height,
        // The one thing that is ours: the frame, then the overlay over it. The
        // video is only ever read here, never written back.
        process: (sample) => {
          frames += 1;
          sample.draw(ctx, 0, 0, request.width, request.height);
          renderer.drawFrame(ctx, Math.max(0, sample.timestamp), { clear: false });
          return canvas;
        },
      },
      // Audio is left to the library's default: AAC in, AAC out is copied
      // packet for packet; anything else is converted where the browser can.
    });

    if (!conversion.isValid) throw invalidConversion(conversion);
    const notes: string[] = [];
    if (conversion.discardedTracks.some((entry) => entry.track.isAudioTrack())) {
      notes.push('The sound could not be carried over, so the rendered video has none.');
    }

    conversion.onProgress = (fraction, processedSeconds) =>
      options.onProgress?.(Math.min(1, Math.max(0, fraction)), processedSeconds);
    const stop = () => void conversion.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();

    try {
      await conversion.execute();
    } catch (error) {
      if (error instanceof mb.ConversionCanceledError || signal?.aborted) throw CANCELLED();
      throw error instanceof OverlayExportError
        ? error
        : new OverlayExportError('render_failed', 'The video could not be rendered.', { cause: error });
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    options.onProgress?.(1, request.videoDurationSeconds);
    return { frameCount: frames, notes };
  } finally {
    input.dispose();
  }
}

/** Why a conversion cannot run, in words the reader can act on. */
function invalidConversion(conversion: Mediabunny.Conversion): OverlayExportError {
  const reasons = new Set(
    conversion.discardedTracks
      .filter((entry) => entry.track.isVideoTrack())
      .map((entry) => entry.reason),
  );
  if (reasons.has('undecodable_source_codec') || reasons.has('unknown_source_codec')) {
    return new OverlayExportError(
      'unsupported_browser',
      'This browser cannot decode this video, so it cannot be rendered here. The overlay-only export still works.',
    );
  }
  if (reasons.has('no_encodable_target_codec')) {
    return new OverlayExportError(
      'unsupported_browser',
      'This browser has no H.264 encoder it can use for this size. The overlay-only export still works.',
    );
  }
  return new OverlayExportError('unsupported_browser', 'This video cannot be rendered in this browser.');
}
