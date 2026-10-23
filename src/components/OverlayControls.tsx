import { useId, useState } from 'react';
import {
  BACKGROUND_OPACITY_RANGE,
  DEFAULT_OVERLAY_CONTROLS,
  OVERLAY_PRESETS,
  SCALE_RANGE,
  isEntryAvailable,
  isEntryEnabled,
  metricStripCapacity,
  overlayCatalog,
  type OverlayControls as Controls,
  type OverlayPosition,
} from '../overlay/presets';
import type { OverlayUnitMode } from '../overlay/template';
import type { OverlayTimeline } from '../overlay/timeline';

interface OverlayControlsProps {
  controls: Controls;
  /** For what the activity has: unsupported components are disabled, not hidden. */
  timeline: OverlayTimeline;
  onChange: (patch: Partial<Controls>) => void;
  /** The picture's shape, width over height: how much a strip along its edge holds. */
  frameAspect?: number;
}

/**
 * AV-1005. Template, component, layout and style controls — deliberately not
 * a design editor: three templates, a checkbox per component, where it sits,
 * how big it is, and three style choices.
 */
export function OverlayControls({ controls, timeline, onChange, frameAspect = 16 / 9 }: OverlayControlsProps) {
  const id = useId();
  const catalog = overlayCatalog(timeline);
  // TD-059. Past what one row holds at a readable size the strip wraps over the
  // picture, and the reader is told rather than left to find the second row.
  const shown = catalog.filter((entry) => isEntryAvailable(entry, timeline) && isEntryEnabled(entry, controls));
  const figures = shown.filter((entry) => entry.kind === 'metric' || entry.kind === 'sensor').length;
  const stripHolds = metricStripCapacity(
    controls.scale,
    frameAspect,
    shown.some((entry) => entry.kind === 'route'),
  );
  const stripFull = controls.presetId === 'metric-strip' && figures > stripHolds;
  /** The settings a reset replaced, until they are put back or changed again. */
  const [beforeReset, setBeforeReset] = useState<Controls | undefined>();
  const change = (patch: Partial<Controls>) => {
    setBeforeReset(undefined);
    onChange(patch);
  };

  return (
    <section className="prose overlay-controls" aria-label="Overlay controls">
      <h3 className="prose__title">Overlay</h3>

      <fieldset className="overlay-controls__group">
        <legend>Template</legend>
        {OVERLAY_PRESETS.map((preset) => (
          // Named by the template alone, described by its sentence: the whole
          // sentence as the name was what a screen reader said for each choice.
          <div key={preset.id} className="overlay-controls__choice">
            <input
              type="radio"
              id={`${id}-preset-${preset.id}`}
              name={`${id}-preset`}
              checked={controls.presetId === preset.id}
              aria-describedby={`${id}-preset-${preset.id}-about`}
              onChange={() => change({ presetId: preset.id })}
            />
            <span>
              <label htmlFor={`${id}-preset-${preset.id}`}>{preset.name}</label>
              <span id={`${id}-preset-${preset.id}-about`} className="overlay-controls__hint">
                {' '}
                {preset.description}
              </span>
            </span>
          </div>
        ))}
      </fieldset>

      <fieldset className="overlay-controls__group">
        <legend>Show</legend>
        {catalog.map((entry) => {
          const available = isEntryAvailable(entry, timeline);
          const enabled = isEntryEnabled(entry, controls);
          return (
            <label key={entry.key} className="overlay-controls__choice">
              <input
                type="checkbox"
                // The reader's choice is shown as made. An unsupported component is
                // never drawn, but one that is on can still be turned off, which is
                // how its warning is cleared; one that is off cannot be turned on.
                checked={enabled}
                disabled={!available && !enabled}
                onChange={(event) =>
                  change({ enabled: { ...controls.enabled, [entry.key]: event.target.checked } })
                }
              />
              <span>
                {entry.label}
                {!available && <span className="overlay-controls__hint"> — not in this activity</span>}
              </span>
            </label>
          );
        })}
        {stripFull && (
          <p className="overlay-controls__note" role="status">
            The metric strip holds {stripHolds} figures in one row at this size, so the other{' '}
            {figures - stripHolds} go on a second row over the picture. Turn some off, make the
            overlay smaller, or choose Compact HUD.
          </p>
        )}
      </fieldset>

      {/*
        Each field's label is its own element, tied to it by id: a label that
        wrapped its select also gave it the options' text as its name
        ("Position Bottom Top"), and a slider's name its value.
      */}
      <fieldset className="overlay-controls__group">
        <legend>Layout</legend>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-position`}>Position</label>
          <select
            id={`${id}-position`}
            className="select"
            value={controls.position}
            onChange={(event) => change({ position: event.target.value as OverlayPosition })}
          >
            <option value="bottom">Bottom</option>
            <option value="top">Top</option>
          </select>
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-size`}>Size</label>
          <input
            id={`${id}-size`}
            type="range"
            min={SCALE_RANGE.min}
            max={SCALE_RANGE.max}
            step={0.05}
            value={controls.scale}
            aria-valuetext={`${Math.round(controls.scale * 100)}%`}
            onChange={(event) => change({ scale: Number(event.target.value) })}
          />
          <span className="overlay-controls__value" aria-hidden="true">
            {Math.round(controls.scale * 100)}%
          </span>
        </div>
      </fieldset>

      <fieldset className="overlay-controls__group">
        <legend>Style</legend>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-accent`}>Accent colour</label>
          <input
            id={`${id}-accent`}
            type="color"
            value={controls.accentColor}
            onChange={(event) => change({ accentColor: event.target.value })}
          />
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-background`}>Background</label>
          <input
            id={`${id}-background`}
            type="range"
            min={BACKGROUND_OPACITY_RANGE.min}
            max={BACKGROUND_OPACITY_RANGE.max}
            step={0.05}
            value={controls.backgroundOpacity}
            aria-valuetext={`${Math.round(controls.backgroundOpacity * 100)}% opaque`}
            onChange={(event) => change({ backgroundOpacity: Number(event.target.value) })}
          />
          <span className="overlay-controls__value" aria-hidden="true">
            {Math.round(controls.backgroundOpacity * 100)}%
          </span>
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-units`}>Units</label>
          <select
            id={`${id}-units`}
            className="select"
            value={controls.unitMode}
            onChange={(event) => change({ unitMode: event.target.value as OverlayUnitMode })}
          >
            <option value="auto">Follow Settings</option>
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
          </select>
        </div>
      </fieldset>

      <p className="overlay-controls__reset">
        {/* One button that changes its word, so focus stays on it through a reset and its undo. */}
        <button
          type="button"
          className="button"
          onClick={() => {
            if (beforeReset) {
              onChange(beforeReset);
              setBeforeReset(undefined);
            } else {
              setBeforeReset(controls);
              onChange(DEFAULT_OVERLAY_CONTROLS);
            }
          }}
        >
          {beforeReset ? 'Undo reset' : 'Reset overlay settings'}
        </button>
        {beforeReset && <span role="status">Overlay settings reset.</span>}
      </p>
    </section>
  );
}
