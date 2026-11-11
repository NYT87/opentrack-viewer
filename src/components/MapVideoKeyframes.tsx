import { useId, type KeyboardEvent } from 'react';
import type { CameraKeyframe } from '../mapVideo/keyframes';
import { formatVideoTime } from '../mapVideo/timing';

export interface MapVideoKeyframesProps {
  keyframes: CameraKeyframe[];
  /** Video seconds of one frame, the step for a keyframe's time. */
  frameSeconds: number;
  /** Replaces the list, as one undoable edit; the caller holds each keyframe to its limits. */
  onChange: (keyframes: CameraKeyframe[]) => void;
  onSeek: (seconds: number) => void;
  onUndo: () => void;
  canUndo: boolean;
  /** Said once after a keyframe was moved toward the marker to keep it in frame. */
  note?: string;
}

function Field({ label, value, step, onChange, unit }: { label: string; value: number; step: number; onChange: (value: number) => void; unit?: string }) {
  const id = useId();
  return (
    <span className="map-video-keyframe__field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        step={step}
        value={Number(value.toFixed(3))}
        aria-describedby={unit ? `${id}-unit` : undefined}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {unit && <span id={`${id}-unit`}>{unit}</span>}
    </span>
  );
}

/**
 * AV-1206. The camera keyframes as a list, one row each, by the time they
 * play: each moved by its time, edited by its numbers, or deleted, and every
 * change undoable. Keyframes are added from the preview's view.
 */
export function MapVideoKeyframes({ keyframes, frameSeconds, onChange, onSeek, onUndo, canUndo, note }: MapVideoKeyframesProps) {
  const sorted = [...keyframes].sort((a, b) => a.seconds - b.seconds);
  const update = (id: string, patch: Partial<CameraKeyframe>) =>
    onChange(keyframes.map((keyframe) => (keyframe.id === id ? { ...keyframe, ...patch } : keyframe)));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'z' && (event.metaKey || event.ctrlKey) && !event.shiftKey && canUndo) {
      event.preventDefault();
      onUndo();
    }
  };

  return (
    <section className="prose map-video-keyframes" aria-label="Camera keyframes" onKeyDown={onKeyDown}>
      <h3 className="prose__title">Camera keyframes</h3>
      <p className="map-video-settings__hint">
        Pause, move the preview with the mouse or a finger (drag to pan, scroll or pinch to zoom, right-drag
        or two fingers to turn and tilt), then add a keyframe. Between keyframes the camera eases in and
        out; before the first and after the last, it eases from and back to the automatic camera.
        <strong> Follows the marker</strong> keeps the marker in the frame; <strong>stays put</strong> holds
        the camera where it is, and the marker may leave the frame.
      </p>
      {note && (
        <p className="map-video-settings__hint" role="status">
          {note}
        </p>
      )}
      {sorted.length === 0 ? (
        <p>No keyframes: the camera follows the marker on its own.</p>
      ) : (
        <ol className="map-video-keyframes__list">
          {sorted.map((keyframe, index) => (
            <li key={keyframe.id} className="map-video-keyframe" aria-label={`Keyframe ${index + 1}, at ${formatVideoTime(keyframe.seconds)}`}>
              <div className="map-video-keyframe__head">
                <Field label="At" unit="s" step={frameSeconds} value={keyframe.seconds} onChange={(seconds) => update(keyframe.id, { seconds })} />
                <button type="button" className="button" onClick={() => onSeek(keyframe.seconds)}>
                  Go to
                </button>
                <button type="button" className="button" onClick={() => onChange(keyframes.filter((other) => other.id !== keyframe.id))}>
                  Delete
                </button>
              </div>
              <div className="map-video-keyframe__fields">
                <label className="overlay-controls__choice">
                  <input
                    type="radio"
                    name={`keyframe-mode-${keyframe.id}`}
                    checked={keyframe.mode === 'follow'}
                    onChange={() => update(keyframe.id, { mode: 'follow' })}
                  />
                  <span>Follows the marker</span>
                </label>
                <label className="overlay-controls__choice">
                  <input
                    type="radio"
                    name={`keyframe-mode-${keyframe.id}`}
                    checked={keyframe.mode === 'fixed'}
                    onChange={() => update(keyframe.id, { mode: 'fixed' })}
                  />
                  <span>Stays put</span>
                </label>
                <Field label="Zoom" step={0.1} value={keyframe.zoom} onChange={(zoom) => update(keyframe.id, { zoom })} />
                <Field label="Tilt" unit="°" step={1} value={keyframe.pitch} onChange={(pitch) => update(keyframe.id, { pitch })} />
                <label className="overlay-controls__choice">
                  <input
                    type="checkbox"
                    checked={keyframe.bearing === null}
                    onChange={(event) => update(keyframe.id, { bearing: event.target.checked ? null : 0 })}
                  />
                  <span>Turns with the route</span>
                </label>
                {keyframe.bearing !== null && (
                  <Field label="Heading" unit="°" step={1} value={keyframe.bearing} onChange={(bearing) => update(keyframe.id, { bearing })} />
                )}
                <Field label="East of the marker" unit="m" step={10} value={keyframe.offset.east} onChange={(east) => update(keyframe.id, { offset: { ...keyframe.offset, east } })} />
                <Field label="North of the marker" unit="m" step={10} value={keyframe.offset.north} onChange={(north) => update(keyframe.id, { offset: { ...keyframe.offset, north } })} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="overlay-slot__actions">
        <button type="button" className="button" onClick={onUndo} disabled={!canUndo}>
          Undo
        </button>
      </p>
    </section>
  );
}

/** A keyframe id not in the list yet: `kf-1`, `kf-2`, … */
export function freshKeyframeId(keyframes: CameraKeyframe[]): string {
  const taken = new Set(keyframes.map((keyframe) => keyframe.id));
  for (let n = 1; ; n += 1) if (!taken.has(`kf-${n}`)) return `kf-${n}`;
}
