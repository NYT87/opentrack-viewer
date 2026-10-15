import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Activity } from '../domain/activity';
import { formatDuration, type UnitSystem } from '../domain/units';
import { buildOverlay, type OverlayControls as Controls } from '../overlay/presets';
import { buildOverlayTimeline } from '../overlay/timeline';
import type { OverlayVideo } from '../state/overlayStore';
import { OverlayControls } from './OverlayControls';
import { OverlayLayer } from './OverlayLayer';

interface OverlayPreviewProps {
  video: OverlayVideo;
  activity: Activity | undefined;
  offsetSeconds: number;
  onOffsetChange: (seconds: number) => void;
  units: UnitSystem;
  controls: Controls;
  onControlsChange: (patch: Partial<Controls>) => void;
}

const UNAVAILABLE_MESSAGES = {
  no_activity: 'There is no activity to draw yet. Add one to see its telemetry over the video.',
  no_timestamps:
    'This activity has no timestamps, so it cannot be lined up with the video and nothing is drawn.',
} as const;

/**
 * Points the element at a local file through an object URL, revoked when the
 * file changes or the page goes. The element is the external system here, so
 * the URL is written to it directly rather than through state.
 */
function useLocalSource(element: RefObject<HTMLVideoElement | null>, file: File) {
  useEffect(() => {
    const media = element.current;
    if (!media || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file);
    media.setAttribute('src', url);
    return () => {
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
    };
  }, [element, file]);
}

/**
 * AV-1004. The local video with the overlay drawn over it, kept at the video's
 * current time through play, pause, seek and scrub.
 *
 * The video element is the only clock. Its time is read on every event that
 * can move it, and on every painted frame while it plays — through
 * `requestVideoFrameCallback` where the browser has it, which fires per
 * presented frame, else `requestAnimationFrame`. Scrubbing writes the new time
 * to the element *and* to state at once, so the overlay does not wait for the
 * browser to finish the seek. Drawing is a handful of DOM nodes from one
 * binary search, so it does not compete with decoding.
 */
export function OverlayPreview({
  video,
  activity,
  offsetSeconds,
  onOffsetChange,
  units,
  controls,
  onControlsChange,
}: OverlayPreviewProps) {
  const element = useRef<HTMLVideoElement>(null);
  useLocalSource(element, video.file);
  const [time, setTime] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frameAspect, setFrameAspect] = useState(16 / 9);

  const durationSeconds = video.timing?.durationSeconds ?? elementDuration;

  const timeline = useMemo(
    () =>
      buildOverlayTimeline(activity, {
        video: { durationSeconds, start: video.timing?.start },
        offsetSeconds,
      }),
    [activity, durationSeconds, video.timing?.start, offsetSeconds],
  );
  const sample = timeline.sampleAt(time);
  // The template follows the controls and what the activity has. With no
  // usable timeline the status line already says why, and listing every
  // component as "not in this activity" on top of it would be misleading.
  const built = useMemo(
    () => buildOverlay(controls, timeline, frameAspect),
    [controls, timeline, frameAspect],
  );
  const warnings = timeline.unavailable ? [] : built.unsupported;

  const readClock = useCallback(() => {
    const media = element.current;
    if (!media) return;
    setTime(media.currentTime);
    if (Number.isFinite(media.duration)) setElementDuration(media.duration);
    if (media.videoWidth > 0 && media.videoHeight > 0) {
      setFrameAspect(media.videoWidth / media.videoHeight);
    }
  }, []);

  // Events that can move the clock, plus a per-frame loop while it runs.
  useEffect(() => {
    const media = element.current;
    if (!media) return;
    let stopped = false;
    let handle: number | undefined;
    // Older browsers lack it, whatever the DOM typings say.
    const frameCallback: {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    } = media;

    const tick = () => {
      if (stopped) return;
      readClock();
      schedule();
    };
    const schedule = () => {
      handle = frameCallback.requestVideoFrameCallback
        ? frameCallback.requestVideoFrameCallback(tick)
        : requestAnimationFrame(tick);
    };
    const cancel = () => {
      if (handle === undefined) return;
      if (frameCallback.cancelVideoFrameCallback && frameCallback.requestVideoFrameCallback) {
        frameCallback.cancelVideoFrameCallback(handle);
      } else cancelAnimationFrame(handle);
      handle = undefined;
    };
    const onPlay = () => {
      setPlaying(true);
      cancel();
      schedule();
    };
    const onStop = () => {
      setPlaying(false);
      cancel();
      readClock();
    };

    const clockEvents = ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'durationchange'];
    clockEvents.forEach((name) => media.addEventListener(name, readClock));
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', onStop);
    media.addEventListener('ended', onStop);
    if (!media.paused) onPlay();
    readClock();

    return () => {
      stopped = true;
      cancel();
      clockEvents.forEach((name) => media.removeEventListener(name, readClock));
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onStop);
      media.removeEventListener('ended', onStop);
    };
  }, [readClock]);

  const togglePlay = () => {
    const media = element.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => setPlaying(false));
    else media.pause();
  };

  const scrubTo = (seconds: number) => {
    const media = element.current;
    if (!media || !Number.isFinite(seconds)) return;
    media.currentTime = seconds;
    setTime(seconds);
  };

  const unavailable = timeline.unavailable;
  const outsideRecording = !unavailable && activity !== undefined && sample === undefined;

  return (
    <section className="prose overlay-preview" aria-label="Preview">
      <h3 className="prose__title">Preview</h3>
      {/* The frame takes the video's own shape, so the layer covers exactly the picture. */}
      <div
        className="overlay-preview__frame"
        style={{ ['--frame-aspect' as string]: frameAspect }}
      >
        <video
          ref={element}
          className="overlay-preview__video"
          playsInline
          preload="metadata"
          data-testid="overlay-video"
        />
        {activity && !unavailable && (
          <OverlayLayer
            template={built.template}
            timeline={timeline}
            sample={sample}
            activity={activity}
            units={units}
            frameAspect={frameAspect}
          />
        )}
      </div>

      <div className="overlay-preview__controls">
        <button type="button" className="button" onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="overlay-preview__scrub"
          aria-label="Video position"
          min={0}
          max={durationSeconds || 0}
          step="any"
          value={Math.min(time, durationSeconds || 0)}
          disabled={!(durationSeconds > 0)}
          onChange={(event) => scrubTo(Number(event.target.value))}
        />
        {/* Not an <output>: its implicit live region would announce every frame. */}
        <span className="overlay-preview__time" role="timer" aria-label="Current time">
          {formatDuration(time)} / {formatDuration(durationSeconds)}
        </span>
      </div>

      {activity && !unavailable && (
        <OffsetControl offsetSeconds={offsetSeconds} onChange={onOffsetChange} />
      )}

      {activity && !unavailable && (
        <OverlayControls controls={controls} timeline={timeline} onChange={onControlsChange} />
      )}

      {unavailable && <p role="status">{UNAVAILABLE_MESSAGES[unavailable]}</p>}
      {outsideRecording && (
        <p role="status">
          The activity has no telemetry for this moment of the video. If it should, adjust the
          offset.
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="overlay-preview__warnings" aria-label="Overlay warnings">
          {warnings.map((warning) => (
            <li key={warning.key}>{warning.message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OffsetControl({
  offsetSeconds,
  onChange,
}: {
  offsetSeconds: number;
  onChange: (seconds: number) => void;
}) {
  // What the reader is typing, until they leave the field: "-" or "1." is not
  // yet a number, and must not be rewritten under them.
  const [draft, setDraft] = useState<string | null>(null);
  const nudge = (delta: number) => {
    setDraft(null);
    onChange(Math.round((offsetSeconds + delta) * 1000) / 1000);
  };
  return (
    <fieldset className="overlay-preview__offset">
      <legend>Telemetry offset</legend>
      <p className="overlay-preview__hint">
        Positive values delay the telemetry. Use it when the overlay runs ahead of the picture;
        use a negative value when it lags behind.
      </p>
      <button type="button" className="button" onClick={() => nudge(-1)}>
        −1 s
      </button>
      <button type="button" className="button" onClick={() => nudge(-0.1)}>
        −0.1 s
      </button>
      <label>
        Seconds{' '}
        <input
          type="number"
          step="0.1"
          value={draft ?? String(offsetSeconds)}
          onChange={(event) => {
            setDraft(event.target.value);
            const parsed = parseFloat(event.target.value);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={() => setDraft(null)}
        />
      </label>
      <button type="button" className="button" onClick={() => nudge(0.1)}>
        +0.1 s
      </button>
      <button type="button" className="button" onClick={() => nudge(1)}>
        +1 s
      </button>
      <button
        type="button"
        className="button"
        onClick={() => {
          setDraft(null);
          onChange(0);
        }}
        disabled={offsetSeconds === 0}
      >
        Reset
      </button>
    </fieldset>
  );
}
