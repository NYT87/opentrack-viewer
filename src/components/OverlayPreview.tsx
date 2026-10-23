import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Activity } from '../domain/activity';
import { formatDateTime, formatDuration, type UnitSystem } from '../domain/units';
import { buildOverlay, type OverlayControls as Controls } from '../overlay/presets';
import { buildOverlayTimeline, type OverlayAlignment } from '../overlay/timeline';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';
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
  /** Told the picture's size and length once the browser has read them. */
  onMediaInfo?: (media: OverlayMedia) => void;
  /**
   * TD-059. The page draws the overlay controls itself, in the workspace's
   * side column beside the preview, so the preview leaves them out.
   */
  controlsElsewhere?: boolean;
  /**
   * TD-059. Where the sync panel (the full sync line, its bar and trace, the
   * offset) is drawn: the workspace's side column, so the sticky stage holds
   * only the picture, its transport and a one-line summary. Without one it is
   * drawn under the stage.
   */
  syncTarget?: HTMLElement | null;
}

/** A signed duration: "-1:30", "0:12", "23:00". */
export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  if (total < 60) return `${sign}${Math.round(total * 1000) / 1000}`;
  const minutes = Math.floor(total / 60);
  const rest = Math.round((total - minutes * 60) * 10) / 10;
  const hours = Math.floor(minutes / 60);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const body = hours > 0 ? `${hours}:${pad(minutes % 60)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
  return `${sign}${body}`;
}

/**
 * Reads an offset as typed: plain seconds ("12.5", "-90") or clock time
 * ("-23:00", "1:02:03"). Undefined for anything else, which is left unapplied
 * rather than read as zero.
 */
export function parseOffset(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const negative = trimmed.startsWith('-') || trimmed.startsWith('−');
  const body = negative ? trimmed.slice(1) : trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  const parts = body.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d*\.?\d+$|^\d+\.?$/.test(part))) return undefined;
  // Minutes and seconds after a colon are under sixty: "9:99" is a slip, not 10:39.
  if (parts.slice(1).some((part) => Number(part) >= 60)) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? (negative ? -seconds : seconds) : undefined;
}

const signedDuration = (seconds: number) =>
  `${seconds < 0 ? '−' : ''}${formatDuration(Math.abs(seconds))}`;

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
  onMediaInfo,
  controlsElsewhere = false,
  syncTarget,
}: OverlayPreviewProps) {
  const element = useRef<HTMLVideoElement>(null);
  useLocalSource(element, video.file);
  const [time, setTime] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frameAspect, setFrameAspect] = useState(16 / 9);
  const keysId = useId();

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
      if (Number.isFinite(media.duration)) {
        onMediaInfo?.({
          width: media.videoWidth,
          height: media.videoHeight,
          durationSeconds: media.duration,
        });
      }
    }
  }, [onMediaInfo]);

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
    const clamped = Math.min(Math.max(0, seconds), durationSeconds || seconds);
    media.currentTime = clamped;
    setTime(clamped);
  };

  // One frame of this video: what the scrubber's arrows and the frame keys step.
  const frameSeconds = video.timing?.frameIntervalSeconds ?? 1 / 30;

  /*
   * TD-059. The transport an editor's hands expect, anywhere in the stage:
   * Space or K plays and pauses, J and L skip five seconds, comma and full stop
   * step one frame. A key typed into a field is that field's, and Space on a
   * button presses the button.
   */
  const handleTransportKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const media = element.current;
    if (!media || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input:not([type="range"]), textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key === ' ' && target.closest('button')) return;
    if (key === ' ' || key === 'k') togglePlay();
    else if (key === 'j') scrubTo(media.currentTime - 5);
    else if (key === 'l') scrubTo(media.currentTime + 5);
    else if (key === ',') {
      media.pause();
      scrubTo(media.currentTime - frameSeconds);
    } else if (key === '.') {
      media.pause();
      scrubTo(media.currentTime + frameSeconds);
    } else return;
    event.preventDefault();
  };

  const unavailable = timeline.unavailable;
  const outsideRecording = !unavailable && activity !== undefined && sample === undefined;

  const alignment = activity && !unavailable ? timeline.alignment : undefined;
  const summary =
    alignment?.overlaps
      ? alignment.anchoredBy === 'videoClock'
        ? "Lined up by the camera's clock."
        : "Lined up at the activity's start."
      : undefined;

  /*
   * TD-059. Sync is set as where the video starts in the activity, which is how
   * a creator says it ("the clip starts 1:30 into the ride"); the timeline takes
   * it as an offset from the anchor, so it is turned into one here.
   */
  const setVideoStart = (start: number) => {
    if (!alignment || !Number.isFinite(start)) return;
    onOffsetChange(Math.round((alignment.anchorSeconds - start) * 1000) / 1000);
  };
  // Steps, keys and drags are held to where the video still touches the
  // activity, so they cannot push it off into a span the bar does not show. A
  // typed time is taken as typed: it says what the reader meant, and is
  // answered by the no-overlap notice rather than quietly changed.
  const stepVideoStart = (start: number) => {
    if (!alignment) return;
    setVideoStart(Math.min(Math.max(start, -durationSeconds), alignment.activitySpanSeconds));
  };

  const stage = (
    // The transport keys answer anywhere in the stage, not only on the picture.
    <section className="prose overlay-preview" aria-label="Preview" onKeyDown={handleTransportKey}>
      <h3 className="prose__title">Preview</h3>
      {/* The frame takes the video's own shape, so the layer covers exactly the picture. */}
      <div
        className="overlay-preview__frame"
        style={{ ['--frame-aspect' as string]: frameAspect }}
        tabIndex={0}
        role="group"
        aria-label="Picture"
        aria-describedby={keysId}
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
          step={frameSeconds}
          value={Math.min(time, durationSeconds || 0)}
          disabled={!(durationSeconds > 0)}
          onChange={(event) => scrubTo(Number(event.target.value))}
          onKeyDown={(event) => {
            // One frame per arrow press, a second with Shift, as an editor's
            // scrubber steps: the browser's own step is not held to the frame.
            const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
            if (!direction) return;
            event.preventDefault();
            scrubTo(time + direction * (event.shiftKey ? 1 : frameSeconds));
          }}
        />
        {/* Not an <output>: its implicit live region would announce every frame. */}
        <span className="overlay-preview__time" role="timer" aria-label="Current time">
          {formatDuration(time)} / {formatDuration(durationSeconds)}
        </span>
      </div>
      {/* Always shown, in one line, so a mouse reader learns them too and nothing moves when they appear. */}
      <p id={keysId} className="overlay-preview__keys">
        Space or K plays · J and L skip 5 s · comma and full stop step a frame
      </p>

      {alignment && (
        <SyncBar
          alignment={alignment}
          videoTime={time}
          videoDuration={durationSeconds}
          onVideoStart={stepVideoStart}
          onSeek={scrubTo}
        />
      )}
      {summary && <p className="overlay-preview__summary">{summary}</p>}
      {/*
        TD-059. Off the activity is said in the stage at every width, under the
        bar that put it there, with the one-press way back. The Sync panel
        says the longer why, and is the one that announces it.
      */}
      {alignment && !alignment.overlaps && (
        <div className="overlay-preview__off">
          <p>The video and the activity do not overlap, so nothing is drawn.</p>
          <button
            type="button"
            className="button"
            onClick={() => onOffsetChange(Math.round(alignment.anchorSeconds * 1000) / 1000)}
          >
            Line up at the activity's start
          </button>
        </div>
      )}
      {unavailable && <p role="status">{UNAVAILABLE_MESSAGES[unavailable]}</p>}
      {outsideRecording && (
        <p role="status">
          The activity has no telemetry for this moment of the video. If it should, change where the
          video starts.
        </p>
      )}
    </section>
  );

  const syncPanel = activity && alignment && (
    <section className="prose overlay-sync-panel" aria-label="Sync">
      <h3 className="prose__title">Sync</h3>
      <SyncStatus alignment={alignment} />
      <VideoStartControl
        alignment={alignment}
        offsetSeconds={offsetSeconds}
        onVideoStart={setVideoStart}
        onStep={stepVideoStart}
        onReset={() => onOffsetChange(0)}
        videoTime={time}
      />
      {warnings.length > 0 && (
        <ul className="overlay-preview__warnings" aria-label="Overlay warnings">
          {warnings.map((warning) => (
            <li key={warning.key}>{warning.message}</li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      {stage}
      {syncTarget ? createPortal(syncPanel, syncTarget) : !controlsElsewhere && syncPanel}
      {!controlsElsewhere && activity && !unavailable && (
        <OverlayControls controls={controls} timeline={timeline} onChange={onControlsChange} frameAspect={frameAspect} />
      )}
    </>
  );
}

/** A day: past this, two clocks that disagree are told as two dates, not as an hour count. */
const FAR_APART_SECONDS = 86_400;

/** The bar's scale: from whichever starts first to whichever ends last. */
function syncGeometry(alignment: OverlayAlignment) {
  const { videoStartInActivity: start, videoEndInActivity: end, activitySpanSeconds: span } = alignment;
  const low = Math.min(0, start);
  const high = Math.max(span, end, low + 1);
  // Two clocks days apart: the bar would squash both spans to slivers, and an
  // hour count of thousands says nothing; the dates say what happened.
  const farApart = Math.abs(start) > FAR_APART_SECONDS || Math.abs(end - span) > FAR_APART_SECONDS;
  const drawable = !farApart && high - low <= 100 * Math.max(span, end - start, 1);
  return { low, high, farApart, drawable };
}

/**
 * TD-059. How the video was laid against the activity, said in a line. A video
 * with no clock of its own is laid at the activity's start, and that used to
 * happen in silence.
 */
function SyncStatus({ alignment }: { alignment: OverlayAlignment }) {
  const { videoStartInActivity: start, videoEndInActivity: end, activitySpanSeconds: span } = alignment;
  const { farApart } = syncGeometry(alignment);
  return (
    <div className="overlay-sync">
      <p className="overlay-sync__line">
        {alignment.anchoredBy === 'videoClock'
          ? "The camera's clock placed the video in the activity."
          : "This video states no clock of its own, so it was placed at the activity's start."}{' '}
        {alignment.overlaps &&
          `It covers ${signedDuration(start)} to ${signedDuration(end)} of the activity's ${formatDuration(span)}.`}
      </p>
      {!alignment.overlaps && (
        // A status, not an alert: it holds while a time is typed, and an alert
        // would be said again at every key.
        <div className="overlay-sync__warning" role="status">
          <p>
            {farApart
              ? `The video and the activity are from different times: the activity starts ${formatDateTime(alignment.activityStart)}${
                  alignment.videoStart ? `, and the video ${formatDateTime(alignment.videoStart)}` : ''
                }. Check they are from the same outing.`
              : `The video and the activity do not overlap in time: the video falls at ${signedDuration(start)} to ${signedDuration(end)} of an activity ${formatDuration(span)} long.`}{' '}
            Nothing would be drawn, so the exports wait until they do. Line up at the activity's
            start under the picture, or set where the video starts below.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * TD-059. Where the video falls in the activity, under the picture it
 * describes: the activity's span with its speed or elevation traced over it,
 * the video's span, and the playhead. It is a control as well as a picture.
 * Dragging slides the video along the activity, the way a sprint or a climb is
 * lined up by eye; a click inside the video shows that moment; the arrow keys
 * move the video a second at a time, ten with Shift, a minute with Page Up and
 * Page Down.
 */
function SyncBar({
  alignment,
  videoTime,
  videoDuration,
  onVideoStart,
  onSeek,
}: {
  alignment: OverlayAlignment;
  videoTime: number;
  videoDuration: number;
  onVideoStart: (start: number) => void;
  onSeek: (videoSeconds: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  /** The press being dragged, with the scale it began on, so the bar does not rescale under the pointer. */
  const drag = useRef<{ x: number; start: number; low: number; high: number; moved: boolean } | null>(null);
  const { videoStartInActivity: start, videoEndInActivity: end, activitySpanSeconds: span } = alignment;
  const { low, high, drawable } = syncGeometry(alignment);
  if (!drawable) return null;

  const at = (seconds: number) => `${((seconds - low) / (high - low)) * 100}%`;
  const width = (seconds: number) => `${(seconds / (high - low)) * 100}%`;
  const barWidth = () => bar.current?.getBoundingClientRect().width || 1;

  // The trace over the activity's own span, in the bar's coordinates.
  const trace = alignment.trace;
  const finite = trace?.values.filter((value): value is number => value !== undefined) ?? [];
  const lowest = finite.length ? Math.min(...finite) : 0;
  const highest = finite.length ? Math.max(...finite) : 1;
  const left = ((0 - low) / (high - low)) * 100;
  const spanWidth = (span / (high - low)) * 100;
  const points = trace?.values
    .map((value, i) =>
      value === undefined
        ? undefined
        : `${(left + (spanWidth * i) / (trace.values.length - 1)).toFixed(2)},${(
            22 - ((value - lowest) / (highest - lowest || 1)) * 20
          ).toFixed(2)}`,
    )
    .filter(Boolean)
    .join(' ');

  const keySteps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -60, PageUp: 60 };

  return (
    <div className="overlay-sync__track">
      <div
        ref={bar}
        className="overlay-sync__scale"
        role="slider"
        tabIndex={0}
        aria-label="Where the video starts in the activity"
        aria-valuemin={Math.floor(-videoDuration)}
        aria-valuemax={Math.ceil(span)}
        aria-valuenow={Math.round(Math.min(Math.max(start, -videoDuration), span) * 10) / 10}
        aria-valuetext={`Video at ${signedDuration(start)} to ${signedDuration(end)} of ${formatDuration(span)}`}
        onKeyDown={(event) => {
          const step = keySteps[event.key];
          if (event.key === 'Home') onVideoStart(0);
          else if (step !== undefined) onVideoStart(start + (Math.abs(step) === 1 && event.shiftKey ? step * 10 : step));
          else return;
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = { x: event.clientX, start, low, high, moved: false };
        }}
        onPointerMove={(event) => {
          const press = drag.current;
          if (!press) return;
          const dx = event.clientX - press.x;
          if (!press.moved && Math.abs(dx) < 4) return;
          press.moved = true;
          const shift = Math.round(((dx / barWidth()) * (press.high - press.low)) * 10) / 10;
          onVideoStart(press.start + shift);
        }}
        onPointerUp={(event) => {
          const press = drag.current;
          drag.current = null;
          if (!press || press.moved) return;
          // A click: the video's frame at that moment of the activity, if it has one.
          const rect = event.currentTarget.getBoundingClientRect();
          const moment = press.low + ((event.clientX - rect.left) / (rect.width || 1)) * (press.high - press.low);
          const seconds = moment - start;
          if (seconds >= 0 && seconds <= videoDuration) onSeek(seconds);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {points && (
          <svg className="overlay-sync__trace" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={points} />
          </svg>
        )}
        <div className="overlay-sync__bar">
          <span className="overlay-sync__activity" style={{ left: at(0), width: width(span) }} />
          <span className="overlay-sync__video" style={{ left: at(start), width: width(end - start) }} />
          <span className="overlay-sync__playhead" style={{ left: at(start + videoTime) }} />
        </div>
      </div>
      <p className="overlay-sync__legend" aria-hidden="true">
        <span className="overlay-sync__key overlay-sync__key--activity" /> Activity{' '}
        <span className="overlay-sync__key overlay-sync__key--video" /> Video
        {trace && (
          <>
            {' '}
            <span className="overlay-sync__key overlay-sync__key--trace" /> {trace.label}
          </>
        )}
        <span className="overlay-sync__how">Drag to slide the video · click to see that moment</span>
      </p>
    </div>
  );
}

/**
 * TD-059. Where the video starts in the activity, typed or stepped, with what
 * that is against the camera's clock said beside it, and a way to line the
 * frame on screen up with a known moment of the activity.
 */
function VideoStartControl({
  alignment,
  offsetSeconds,
  onVideoStart,
  onStep,
  onReset,
  videoTime,
}: {
  alignment: OverlayAlignment;
  offsetSeconds: number;
  onVideoStart: (start: number) => void;
  onStep: (start: number) => void;
  onReset: () => void;
  videoTime: number;
}) {
  // What the reader is typing, until they leave the field: "-" or "1:" is not
  // yet a time, and must not be rewritten under them. Something that is not a
  // time stays as typed, with the reason, rather than reverting silently. It is
  // kept with the start it was typed against, so a start set anywhere else (the
  // bar, a step, Line up) replaces it instead of leaving a stale error showing.
  const [typed, setTyped] = useState<{ text: string; start: number } | null>(null);
  const [lineUp, setLineUp] = useState('');
  const formatId = useId();
  const fieldId = useId();
  const lineUpId = useId();
  const lineUpHintId = useId();
  const start = alignment.videoStartInActivity;
  const span = alignment.activitySpanSeconds;
  const byClock = alignment.anchoredBy === 'videoClock';
  const draft = typed && Math.abs(typed.start - start) < 0.001 ? typed.text : null;
  const setDraft = (text: string | null) => setTyped(text === null ? null : { text, start });

  const move = (delta: number) => {
    setDraft(null);
    onStep(start + delta);
  };
  const step = (delta: number, label: string, direction: string) => (
    <button type="button" className="button" aria-label={`${label}, ${direction}`} onClick={() => move(delta)}>
      {label}
    </button>
  );
  const invalid = draft !== null && draft.trim() !== '' && parseOffset(draft) === undefined;

  /*
   * TD-059. "This frame is that moment of the activity": the start that puts
   * the activity's time `target` under the video's current time. Simpler than
   * working out a difference of clocks by hand, and how alignment is done.
   */
  const lineUpTarget = parseOffset(lineUp);
  const lineUpProblem =
    lineUp.trim() === ''
      ? undefined
      : lineUpTarget === undefined
        ? `"${lineUp}" is not a time. Use minutes and seconds, as 1:30.`
        : lineUpTarget < 0
          ? 'A moment of the activity is not before its start.'
          : lineUpTarget > span
            ? `The activity is ${formatDuration(span)} long, so it has no ${formatDuration(lineUpTarget)}.`
            : undefined;
  const applyLineUp = () => {
    if (lineUpTarget === undefined || lineUpProblem) return;
    setDraft(null);
    onVideoStart(lineUpTarget - videoTime);
    setLineUp('');
  };

  // What the start is against the anchor: only a camera's clock is worth comparing to.
  const against = byClock
    ? offsetSeconds === 0
      ? "Where the camera's clock puts it."
      : `${formatDuration(Math.abs(offsetSeconds))} ${offsetSeconds > 0 ? 'earlier' : 'later'} than the camera's clock puts it.`
    : undefined;

  return (
    <fieldset className="overlay-preview__offset">
      <legend>Video start</legend>
      <div className="overlay-preview__steps">
        <span className="overlay-preview__field">
          <label htmlFor={fieldId}>Video starts at</label>
          <input
            id={fieldId}
            className="input"
            type="text"
            inputMode="decimal"
            aria-describedby={formatId}
            aria-invalid={invalid || undefined}
            value={draft ?? formatOffset(start)}
            onChange={(event) => {
              const parsed = parseOffset(event.target.value);
              setTyped({ text: event.target.value, start: parsed ?? start });
              if (parsed !== undefined) onVideoStart(parsed);
            }}
            onKeyDown={(event) => {
              const steps: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 60, PageDown: -60 };
              const delta = steps[event.key];
              if (delta === undefined) return;
              event.preventDefault();
              move(Math.abs(delta) === 1 ? delta * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1) : delta);
            }}
            onBlur={() => {
              if (!invalid) setDraft(null);
            }}
          />
          <span>of the activity</span>
        </span>
        <span className="overlay-preview__nudges" role="group" aria-label="Move the video start">
          {step(-1, '−1 s', 'earlier')}
          {step(-0.1, '−0.1 s', 'earlier')}
          {step(0.1, '+0.1 s', 'later')}
          {step(1, '+1 s', 'later')}
        </span>
      </div>
      <p id={formatId} className={invalid ? 'overlay-preview__hint is-invalid' : 'overlay-preview__hint'}>
        {invalid
          ? `"${draft}" is not a time, so the video still starts at ${formatOffset(start)}. Use minutes and seconds, or seconds: 1:30 or 90.`
          : 'Minutes and seconds, or seconds; negative starts before the activity. If the numbers run ahead of the picture, start the video earlier. The arrow keys step a second, ten with Shift.'}
      </p>
      {against && (
        <p className="overlay-preview__against">
          {against}{' '}
          {offsetSeconds !== 0 && (
            <button type="button" className="button" onClick={onReset}>
              Back to the camera's clock
            </button>
          )}
        </p>
      )}
      {!byClock && offsetSeconds !== 0 && (
        <p className="overlay-preview__against">
          <button type="button" className="button" onClick={onReset}>
            Back to the activity's start
          </button>
        </p>
      )}
      <form
        className="overlay-preview__lineup"
        aria-label="Line up this frame"
        onSubmit={(event) => {
          event.preventDefault();
          applyLineUp();
        }}
      >
        <label htmlFor={lineUpId}>This frame is at</label>
        <input
          id={lineUpId}
          className="input"
          type="text"
          inputMode="decimal"
          placeholder="m:ss"
          aria-invalid={lineUpProblem ? true : undefined}
          aria-describedby={lineUpProblem ? lineUpHintId : undefined}
          value={lineUp}
          onChange={(event) => setLineUp(event.target.value)}
        />
        <span>of the activity.</span>
        <button type="submit" className="button" disabled={lineUpTarget === undefined || Boolean(lineUpProblem)}>
          Line up
        </button>
        {lineUpProblem && (
          <span id={lineUpHintId} className="overlay-preview__hint is-invalid">
            {lineUpProblem}
          </span>
        )}
      </form>
    </fieldset>
  );
}
