import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../domain/units';
import type { OverlayRenderer } from '../overlays/renderOverlay';

export interface OverlayVideoPreviewProps {
  file: File;
  renderer: OverlayRenderer;
  /** Seconds the telemetry is shifted against the video. */
  offsetSeconds: number;
  onOffsetChange: (seconds: number) => void;
  /** Locks the preview while something else is playing the video (an export). */
  disabled?: boolean;
  /** Reported once the browser knows the video's length and size. */
  onMetadata?: (info: { duration?: number; width: number; height: number }) => void;
}

/** Offsets beyond this are nearly always a typo, not a camera clock error. */
const MAX_OFFSET_SECONDS = 24 * 3600;

/**
 * AV-1004. Plays a local video with the overlay drawn over it, in step.
 *
 * The overlay is a canvas laid over the `<video>` and redrawn from the video's
 * own clock: every animation frame while it plays, and again on any seek, so
 * scrubbing, pausing and stepping all show the values for the frame you are
 * looking at. The canvas takes the video's native size, so an overlay is drawn
 * at the resolution it would be exported at and scales down with the picture.
 *
 * The video is read through an object URL for this tab only. It is never
 * uploaded, and the URL is revoked when the preview closes.
 */
export function OverlayVideoPreview({
  file,
  renderer,
  offsetSeconds,
  onOffsetChange,
  onMetadata,
  disabled = false,
}: OverlayVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Read through refs so the draw loop always sees the latest, without
  // restarting every time the offset or template changes.
  const rendererRef = useRef(renderer);
  const offsetRef = useRef(offsetSeconds);
  useEffect(() => {
    rendererRef.current = renderer;
    offsetRef.current = offsetSeconds;
  }, [renderer, offsetSeconds]);

  const drawFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    // Assigning a size clears the canvas, so only do it when it changes.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    rendererRef.current.render(context, width, height, video.currentTime, offsetRef.current);
  }, []);

  // Attach the file, and let go of it when the preview goes away.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const url = URL.createObjectURL(file);
    video.src = url;
    return () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // An export is playing its own copy of the video; this one steps aside.
  useEffect(() => {
    if (disabled) videoRef.current?.pause();
  }, [disabled]);

  // Redraw whenever what is drawn changes while paused.
  useEffect(() => {
    drawFrame();
  }, [renderer, offsetSeconds, drawFrame]);

  // While playing, follow the video every frame.
  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const tick = () => {
      drawFrame();
      const video = videoRef.current;
      if (video) setTime(video.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, drawFrame]);

  const syncFromVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    setTime(video.currentTime);
    drawFrame();
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => setError('The video could not be played.'));
    } else {
      video.pause();
    }
  };

  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration || seconds, seconds));
    syncFromVideo();
  };

  const setOffset = (value: number) => {
    if (!Number.isFinite(value)) return;
    onOffsetChange(Math.max(-MAX_OFFSET_SECONDS, Math.min(MAX_OFFSET_SECONDS, value)));
  };

  return (
    <div className="overlay-video">
      <div className="overlay-video__stage">
        <video
          ref={videoRef}
          className="overlay-video__video"
          data-testid="overlay-video"
          muted
          playsInline
          preload="auto"
          aria-label="Video preview"
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration);
            setError(undefined);
            const { duration: length, videoWidth, videoHeight } = event.currentTarget;
            onMetadata?.({
              ...(Number.isFinite(length) ? { duration: length } : {}),
              // The size the overlay is drawn at: the picture's own, or the
              // preview's fallback when the browser reports none.
              width: videoWidth || 1280,
              height: videoHeight || 720,
            });
            syncFromVideo();
          }}
          onSeeked={syncFromVideo}
          onTimeUpdate={syncFromVideo}
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            setIsPlaying(false);
            syncFromVideo();
          }}
          onEnded={() => setIsPlaying(false)}
          onError={() =>
            setError(
              'This browser cannot play that video. Some cameras record in a format browsers do not decode — try a different browser, or an H.264 version of the file.',
            )
          }
        />
        <canvas
          ref={canvasRef}
          className="overlay-video__canvas"
          data-testid="overlay-video-canvas"
          aria-hidden="true"
        />
      </div>

      {error && (
        <p role="alert" className="route-tools__notice">
          {error}
        </p>
      )}

      <div className="route-tools__row">
        <button type="button" className="button" onClick={togglePlay} disabled={Boolean(error) || disabled}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="overlay-video__scrub"
          aria-label="Video position"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(time, duration || 0)}
          disabled={!duration || disabled}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="route-tools__status" aria-live="off">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
      </div>

      <div className="route-tools__row" role="group" aria-label="Line up the telemetry">
        {/* A positive offset shows later telemetry sooner, so "earlier" adds. */}
        <button type="button" className="button" onClick={() => setOffset(offsetSeconds + 1)}>
          Telemetry earlier 1 s
        </button>
        <label className="export__label">
          Offset (seconds){' '}
          <input
            className="input"
            type="number"
            step={0.1}
            value={Number.isFinite(offsetSeconds) ? offsetSeconds : 0}
            onChange={(event) => setOffset(Number(event.target.value))}
          />
        </label>
        <button type="button" className="button" onClick={() => setOffset(offsetSeconds - 1)}>
          Telemetry later 1 s
        </button>
      </div>
    </div>
  );
}
