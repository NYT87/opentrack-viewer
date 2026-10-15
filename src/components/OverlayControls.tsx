import { useId } from 'react';
import {
  BACKGROUND_OPACITY_RANGE,
  DEFAULT_OVERLAY_CONTROLS,
  OVERLAY_PRESETS,
  SCALE_RANGE,
  isEntryAvailable,
  isEntryEnabled,
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
}

/**
 * AV-1005. Template, component, layout and style controls — deliberately not
 * a design editor: three templates, a checkbox per component, where it sits,
 * how big it is, and three style choices.
 */
export function OverlayControls({ controls, timeline, onChange }: OverlayControlsProps) {
  const id = useId();
  const catalog = overlayCatalog(timeline);

  return (
    <section className="prose overlay-controls" aria-label="Overlay controls">
      <h3 className="prose__title">Overlay</h3>

      <fieldset className="overlay-controls__group">
        <legend>Template</legend>
        {OVERLAY_PRESETS.map((preset) => (
          <label key={preset.id} className="overlay-controls__choice">
            <input
              type="radio"
              name={`${id}-preset`}
              checked={controls.presetId === preset.id}
              onChange={() => onChange({ presetId: preset.id })}
            />
            <span>
              {preset.name}
              <span className="overlay-controls__hint"> — {preset.description}</span>
            </span>
          </label>
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
                  onChange({ enabled: { ...controls.enabled, [entry.key]: event.target.checked } })
                }
              />
              <span>
                {entry.label}
                {!available && <span className="overlay-controls__hint"> — not in this activity</span>}
              </span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="overlay-controls__group">
        <legend>Layout</legend>
        <label className="overlay-controls__field">
          Position
          <select
            value={controls.position}
            onChange={(event) => onChange({ position: event.target.value as OverlayPosition })}
          >
            <option value="bottom">Bottom</option>
            <option value="top">Top</option>
          </select>
        </label>
        <label className="overlay-controls__field">
          Size
          <input
            type="range"
            min={SCALE_RANGE.min}
            max={SCALE_RANGE.max}
            step={0.05}
            value={controls.scale}
            onChange={(event) => onChange({ scale: Number(event.target.value) })}
          />
        </label>
      </fieldset>

      <fieldset className="overlay-controls__group">
        <legend>Style</legend>
        <label className="overlay-controls__field">
          Accent colour
          <input
            type="color"
            value={controls.accentColor}
            onChange={(event) => onChange({ accentColor: event.target.value })}
          />
        </label>
        <label className="overlay-controls__field">
          Background
          <input
            type="range"
            min={BACKGROUND_OPACITY_RANGE.min}
            max={BACKGROUND_OPACITY_RANGE.max}
            step={0.05}
            value={controls.backgroundOpacity}
            onChange={(event) => onChange({ backgroundOpacity: Number(event.target.value) })}
          />
        </label>
        <label className="overlay-controls__field">
          Units
          <select
            value={controls.unitMode}
            onChange={(event) => onChange({ unitMode: event.target.value as OverlayUnitMode })}
          >
            <option value="auto">Follow Settings</option>
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
          </select>
        </label>
      </fieldset>

      <p>
        <button type="button" className="button" onClick={() => onChange(DEFAULT_OVERLAY_CONTROLS)}>
          Reset overlay settings
        </button>
      </p>
    </section>
  );
}
