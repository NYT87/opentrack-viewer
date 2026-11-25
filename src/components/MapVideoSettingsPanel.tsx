import { useId, useState, type ReactNode } from 'react';
import type { UnitSystem } from '../domain/units';
import { shareOfRouteText } from '../overlay/privacyTrim';
import { MAP_VIDEO_LIMITS, outputProblem, type MapVideoColorBy, type MapVideoMarkerShape, type MapVideoSettings } from '../mapVideo/project';
import type { ColorByChoice } from '../mapVideo/style';
import type { MapVideoSettingsPatch } from '../state/mapVideoStore';
import { useNumberDraft } from './useNumberDraft';

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
  /** What the route's colour can show for this activity (AV-1205). */
  colorBy?: ColorByChoice[];
  /** AV-1022. The route's length in metres, so each end of the privacy trim says what share of it it hides. */
  routeMeters?: number;
}

/** A number field that only reports finite values, held to its range. */
function NumberField({
  label,
  value,
  range,
  step,
  unit,
  share,
  onChange,
}: {
  label: string;
  value: number;
  range: readonly [number, number];
  step: number;
  unit?: string;
  /** AV-1022. What the length is as a share of the route, written beside it. */
  share?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const draft = useNumberDraft(value, 2, onChange, range);
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
          aria-describedby={[unit ? `${id}-unit` : '', share ? `${id}-share` : ''].filter(Boolean).join(' ') || undefined}
          {...draft}
        />
        {unit && <span id={`${id}-unit`}>{unit}</span>}
        {share && (
          <span id={`${id}-share`} className="map-video-settings__share">
            — {share}
          </span>
        )}
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
export function MapVideoSettingsPanel({ settings, onChange, units, timingNote, colorBy, routeMeters = 0 }: MapVideoSettingsPanelProps) {
  const ids = { colorBy: useId(), routeColor: useId(), casingColor: useId(), markerColor: useId(), custom: useId() };
  /** Custom chosen while the size still matches a preset: its fields stay open. */
  const [customChosen, setCustomChosen] = useState(false);
  const limits = MAP_VIDEO_LIMITS;
  const { output } = settings;
  const above1080p = output.width * output.height > limits.maxPixelsAt60;
  const maxLength = above1080p ? limits.maxLengthSecondsAbove1080p : limits.maxLengthSeconds;
  const presetIndex = MAP_VIDEO_SIZES.findIndex((size) => size.width === output.width && size.height === output.height);
  const sizeIndex = customChosen ? -1 : presetIndex;
  /** Encoders work in blocks of two pixels, so a custom side is held to an even number. */
  const even = (value: number) => Math.round(value / 2) * 2;
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
              const index = Number(event.target.value);
              // Custom keeps the size, and opens its fields.
              setCustomChosen(index < 0);
              if (index < 0) return;
              const size = MAP_VIDEO_SIZES[index]!;
              const big = size.width * size.height > limits.maxPixelsAt60;
              // A 4K video is held to a minute and 30 frames a second (TD-064).
              onChange({
                output: { width: size.width, height: size.height, fps: big ? 30 : output.fps },
                ...(big && settings.lengthSeconds > limits.maxLengthSecondsAbove1080p ? { lengthSeconds: limits.maxLengthSecondsAbove1080p } : {}),
              });
            }}
          >
            <option value={-1}>{presetIndex < 0 ? `Custom, ${output.width} × ${output.height}` : 'Custom'}</option>
            {MAP_VIDEO_SIZES.map((size, index) => (
              <option key={size.label} value={index}>
                {size.label}
              </option>
            ))}
          </select>
        </label>
        {sizeIndex < 0 && (
          <>
            <NumberField label="Width" unit="px" value={output.width} range={[limits.minSide, limits.maxSide]} step={2} onChange={(width) => onChange({ output: { ...output, width: even(width) } })} />
            <NumberField label="Height" unit="px" value={output.height} range={[limits.minSide, limits.maxSide]} step={2} onChange={(height) => onChange({ output: { ...output, height: even(height) } })} />
            {outputProblem(settings) && (
              <p className="map-video-settings__hint" role="alert" id={ids.custom}>
                {outputProblem(settings)}
              </p>
            )}
          </>
        )}
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

      <label className="overlay-controls__choice">
        <input
          type="checkbox"
          checked={settings.summaryCard.enabled && settings.outro.enabled}
          disabled={!settings.outro.enabled}
          onChange={(event) => onChange({ summaryCard: { enabled: event.target.checked } })}
        />
        <span>
          {settings.outro.enabled
            ? 'Show the totals on a card through the outro'
            : 'Show the totals on a card through the outro (turn the outro on first: the card is shown there)'}
        </span>
      </label>

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

      <Group legend="Route">
        <div className="map-video-settings__field">
          <label htmlFor={ids.colorBy}>Colour</label>
          <select
            id={ids.colorBy}
            value={settings.route.colorBy}
            onChange={(event) => onChange({ route: { colorBy: event.target.value as MapVideoColorBy } })}
          >
            {(colorBy ?? [{ value: 'none', label: 'One colour', available: true }]).map((choice) => (
              <option key={choice.value} value={choice.value} disabled={!choice.available}>
                {choice.available ? choice.label : `${choice.label} (not recorded)`}
              </option>
            ))}
          </select>
        </div>
        {colorBy
          ?.filter((choice) => !choice.available)
          .map((choice) => (
            <p key={choice.value} className="map-video-settings__hint">
              {choice.label}: {choice.reason}
            </p>
          ))}
        <div className="map-video-settings__field">
          <label htmlFor={ids.routeColor}>{settings.route.colorBy === 'none' ? 'Line colour' : 'Colour of the rest'}</label>
          <input id={ids.routeColor} type="color" value={settings.route.color} onChange={(event) => onChange({ route: { color: event.target.value } })} />
        </div>
        <NumberField label="Line width" unit="px" value={settings.route.width} range={limits.routeWidth} step={1} onChange={(width) => onChange({ route: { width } })} />
        <label className="overlay-controls__choice">
          <input type="checkbox" checked={settings.route.casing} onChange={(event) => onChange({ route: { casing: event.target.checked } })} />
          <span>A darker edge along the line</span>
        </label>
        {settings.route.casing && (
          <div className="map-video-settings__field">
            <label htmlFor={ids.casingColor}>Edge colour</label>
            <input id={ids.casingColor} type="color" value={settings.route.casingColor} onChange={(event) => onChange({ route: { casingColor: event.target.value } })} />
          </div>
        )}
        <label className="overlay-controls__choice">
          <input
            type="checkbox"
            checked={settings.route.unrevealed === 'dimmed'}
            onChange={(event) => onChange({ route: { unrevealed: event.target.checked ? 'dimmed' : 'hidden' } })}
          />
          <span>Show the route still to come, dimmed</span>
        </label>
      </Group>

      <Group legend="Marker">
        {(
          [
            ['dot', 'A dot'],
            ['arrow', 'An arrow pointing the way'],
            ['sport', 'The sport’s icon'],
          ] as [MapVideoMarkerShape, string][]
        ).map(([shape, label]) => (
          <label key={shape} className="overlay-controls__choice">
            <input type="radio" name="map-video-marker" checked={settings.marker.shape === shape} onChange={() => onChange({ marker: { shape } })} />
            <span>{label}</span>
          </label>
        ))}
        <NumberField label="Marker size" unit="px" value={settings.marker.size} range={limits.markerSize} step={1} onChange={(size) => onChange({ marker: { size } })} />
        <div className="map-video-settings__field">
          <label htmlFor={ids.markerColor}>Marker colour</label>
          <input id={ids.markerColor} type="color" value={settings.marker.color} onChange={(event) => onChange({ marker: { color: event.target.value } })} />
        </div>
        <label className="overlay-controls__choice">
          <input type="checkbox" checked={settings.marker.trail} onChange={(event) => onChange({ marker: { trail: event.target.checked } })} />
          <span>A fading trail behind it</span>
        </label>
        <label className="overlay-controls__choice">
          <input type="checkbox" checked={settings.endpoints.shown} onChange={(event) => onChange({ endpoints: { shown: event.target.checked } })} />
          <span>Start and finish markers, where the trimmed route begins and ends</span>
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
          share={shareOfRouteText(settings.privacyTrim.startMeters, routeMeters)}
          value={toShown(settings.privacyTrim.startMeters)}
          range={trimRange}
          step={imperial ? 50 : 10}
          onChange={(value) => onChange({ privacyTrim: { startMeters: fromShown(value) } })}
        />
        <NumberField
          label="Hide the last"
          unit={trimUnit}
          share={shareOfRouteText(settings.privacyTrim.endMeters, routeMeters)}
          value={toShown(settings.privacyTrim.endMeters)}
          range={trimRange}
          step={imperial ? 50 : 10}
          onChange={(value) => onChange({ privacyTrim: { endMeters: fromShown(value) } })}
        />
      </Group>
    </section>
  );
}
