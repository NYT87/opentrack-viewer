import { useId, type ReactNode } from 'react';
import type { UnitSystem } from '../domain/units';
import { MAP_VIDEO_LIMITS, type MapVideoSettings } from '../mapVideo/project';
import type { MapVideoSettingsPatch } from '../state/mapVideoStore';

const FEET_PER_METER = 3.280839895;

/** The custom canvas's sizes (TD-062); any other size is AV-1205's. */
export const MAP_VIDEO_SIZES = [
  { width: 1920, height: 1080, label: 'Landscape, 1920 × 1080' },
  { width: 1080, height: 1920, label: 'Portrait, 1080 × 1920' },
  { width: 1080, height: 1080, label: 'Square, 1080 × 1080' },
  { width: 3840, height: 2160, label: '4K, 3840 × 2160' },
] as const;

export interface MapVideoSettingsPanelProps {
  settings: MapVideoSettings;
  onChange: (patch: MapVideoSettingsPatch) => void;
  units: UnitSystem;
  /** Why the chosen timing could not be used, from the model. */
  timingNote?: string;
}

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

/** A number field that only reports finite values, held to its range. */
function NumberField({
  label,
  value,
  range,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  // The label names the field and the unit describes it, so "Length" is found as "Length".
  return (
    <div className="map-video-settings__field">
      <label htmlFor={id}>{label}</label>
      <span className="map-video-settings__input">
        <input
          id={id}
          type="number"
          min={range[0]}
          max={range[1]}
          step={step}
          value={Number(value.toFixed(2))}
          aria-describedby={unit ? `${id}-unit` : undefined}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(clamp(next, range));
          }}
        />
        {unit && <span id={`${id}-unit`}>{unit}</span>}
      </span>
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="map-video-settings__group">
      <legend className="summary__label">{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * AV-1204. The settings the preview shows at once: size, length, timing,
 * intro and outro, camera, and the privacy trim. The basemap, terrain and
 * styles are AV-1205's. Every value is held to TD-064's limits as it is
 * typed, so the model never sees one it would refuse.
 */
export function MapVideoSettingsPanel({ settings, onChange, units, timingNote }: MapVideoSettingsPanelProps) {
  const limits = MAP_VIDEO_LIMITS;
  const { output } = settings;
  const above1080p = output.width * output.height > limits.maxPixelsAt60;
  const maxLength = above1080p ? limits.maxLengthSecondsAbove1080p : limits.maxLengthSeconds;
  const sizeIndex = MAP_VIDEO_SIZES.findIndex((size) => size.width === output.width && size.height === output.height);
  const imperial = units === 'imperial';
  const trimUnit = imperial ? 'ft' : 'm';
  const toShown = (meters: number) => (imperial ? meters * FEET_PER_METER : meters);
  const fromShown = (value: number) => (imperial ? value / FEET_PER_METER : value);
  const trimRange = [0, toShown(limits.trimMeters[1])] as const;

  return (
    <section className="prose map-video-settings" aria-label="Video settings">
      <h3 className="prose__title">Video</h3>

      <Group legend="Size and length">
        <label className="map-video-settings__field">
          <span>Size</span>
          <select
            value={sizeIndex}
            onChange={(event) => {
              const size = MAP_VIDEO_SIZES[Number(event.target.value)]!;
              const big = size.width * size.height > limits.maxPixelsAt60;
              // A 4K video is held to a minute and 30 frames a second (TD-064).
              onChange({
                output: { width: size.width, height: size.height, fps: big ? 30 : output.fps },
                ...(big && settings.lengthSeconds > limits.maxLengthSecondsAbove1080p ? { lengthSeconds: limits.maxLengthSecondsAbove1080p } : {}),
              });
            }}
          >
            {sizeIndex < 0 && <option value={-1}>{`${output.width} × ${output.height}`}</option>}
            {MAP_VIDEO_SIZES.map((size, index) => (
              <option key={size.label} value={index}>
                {size.label}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="Length"
          unit="s"
          value={settings.lengthSeconds}
          range={[limits.minLengthSeconds, maxLength]}
          step={1}
          onChange={(lengthSeconds) => onChange({ lengthSeconds })}
        />
        <label className="map-video-settings__field">
          <span>Frame rate</span>
          <select value={output.fps} onChange={(event) => onChange({ output: { ...output, fps: Number(event.target.value) } })}>
            <option value={30}>30 a second</option>
            <option value={60} disabled={above1080p}>
              {above1080p ? '60 a second (up to 1080p)' : '60 a second'}
            </option>
          </select>
        </label>
        {above1080p && <p className="map-video-settings__hint">At 4K a video is held to a minute, and takes longer to export.</p>}
      </Group>

      <Group legend="Pace along the route">
        <label className="overlay-controls__choice">
          <input type="radio" name="map-video-timing" checked={settings.timing.mode === 'distance'} onChange={() => onChange({ timing: { mode: 'distance' } })} />
          <span>Even pace: the same distance every second.</span>
        </label>
        <label className="overlay-controls__choice">
          <input type="radio" name="map-video-timing" checked={settings.timing.mode === 'time'} onChange={() => onChange({ timing: { mode: 'time' } })} />
          <span>As recorded, with stops of a minute or more shortened.</span>
        </label>
        {settings.timing.mode === 'time' && (
          <NumberField
            label="Each long stop takes"
            unit="s"
            value={settings.timing.pauseBeatSeconds}
            range={limits.pauseBeatSeconds}
            step={0.1}
            onChange={(pauseBeatSeconds) => onChange({ timing: { pauseBeatSeconds } })}
          />
        )}
        {timingNote && <p className="map-video-settings__hint" role="status">{timingNote}</p>}
      </Group>

      <Group legend="Intro and outro">
        {(['intro', 'outro'] as const).map((phase) => (
          <div key={phase} className="map-video-settings__row">
            <label className="overlay-controls__choice">
              <input type="checkbox" checked={settings[phase].enabled} onChange={(event) => onChange({ [phase]: { enabled: event.target.checked } })} />
              <span>{phase === 'intro' ? 'Fly in from the whole route' : 'Pull back to the whole route'}</span>
            </label>
            {settings[phase].enabled && (
              <NumberField
                label={phase === 'intro' ? 'Intro' : 'Outro'}
                unit="s"
                value={settings[phase].seconds}
                range={limits.phaseSeconds}
                step={0.5}
                onChange={(seconds) => onChange({ [phase]: { seconds } })}
              />
            )}
          </div>
        ))}
      </Group>

      <Group legend="Camera">
        <NumberField label="Zoom" value={settings.camera.zoom} range={limits.zoom} step={0.1} onChange={(zoom) => onChange({ camera: { zoom } })} />
        <NumberField label="Tilt" unit="°" value={settings.camera.pitch} range={limits.pitch} step={1} onChange={(pitch) => onChange({ camera: { pitch } })} />
        <label className="overlay-controls__choice">
          <input
            type="checkbox"
            checked={settings.camera.bearing === 'north'}
            onChange={(event) => onChange({ camera: { bearing: event.target.checked ? 'north' : 'follow' } })}
          />
          <span>Keep north up, rather than turning with the route</span>
        </label>
      </Group>

      <Group legend="Privacy trim">
        <p className="map-video-settings__hint">
          Hides the start and the end of the route from the whole video (the line, the marker, the camera
          and the figures), so it need not show where you live.
        </p>
        <NumberField
          label="Hide the first"
          unit={trimUnit}
          value={toShown(settings.privacyTrim.startMeters)}
          range={trimRange}
          step={imperial ? 50 : 10}
          onChange={(value) => onChange({ privacyTrim: { startMeters: fromShown(value) } })}
        />
        <NumberField
          label="Hide the last"
          unit={trimUnit}
          value={toShown(settings.privacyTrim.endMeters)}
          range={trimRange}
          step={imperial ? 50 : 10}
          onChange={(value) => onChange({ privacyTrim: { endMeters: fromShown(value) } })}
        />
      </Group>
    </section>
  );
}
