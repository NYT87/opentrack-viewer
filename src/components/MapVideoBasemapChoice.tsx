import { useId } from 'react';
import {
  MAP_VIDEO_LIMITS,
  type MapTilerStyle,
  type MapVideoBasemapSource,
  type MapVideoBasemapStyle,
  type MapVideoSettings,
} from '../mapVideo/project';
import type { MapVideoSettingsPatch } from '../state/mapVideoStore';

const OPENFREEMAP_STYLES: { value: MapVideoBasemapStyle; label: string }[] = [
  { value: 'liberty', label: 'Liberty (streets, in colour)' },
  { value: 'positron', label: 'Positron (light)' },
  { value: 'dark', label: 'Dark' },
  { value: 'bright', label: 'Bright' },
];

const MAPTILER_STYLES: { value: MapTilerStyle; label: string }[] = [
  { value: 'satellite', label: 'Satellite' },
  { value: 'hybrid', label: 'Satellite with labels' },
  { value: 'outdoor-v2', label: 'Outdoor' },
  { value: 'streets-v2', label: 'Streets' },
];

export interface MapVideoBasemapChoiceProps {
  settings: MapVideoSettings;
  onSource: (source: MapVideoBasemapSource) => void;
  onChange: (patch: MapVideoSettingsPatch) => void;
  maptilerKey: string;
  onMaptilerKey: (key: string) => void;
}

/**
 * AV-1202, AV-1205. What the map is drawn on, said before any map exists
 * (TD-065): OpenFreeMap's styles, keyless; MapTiler's, satellite among them,
 * with the reader's own key; or the route alone, which fetches nothing. 3D
 * terrain comes from AWS Terrain Tiles, over a map only. Each choice says
 * who learns what (TD-064).
 */
export function MapVideoBasemapChoice({ settings, onSource, onChange, maptilerKey, onMaptilerKey }: MapVideoBasemapChoiceProps) {
  const source = settings.basemap.source;
  const ids = { style: useId(), maptilerStyle: useId(), key: useId(), exaggeration: useId() };
  return (
    <fieldset className="prose map-video-basemap">
      <legend className="prose__title">Map</legend>
      <label className="overlay-controls__choice">
        <input type="radio" name="map-video-basemap" checked={source === 'online'} onChange={() => onSource('online')} />
        <span>
          Online map. Its tiles come from OpenFreeMap, whose server learns which area the video shows, as
          any online map does. The route itself is never sent.
        </span>
      </label>
      {source === 'online' && (
        <div className="map-video-settings__field map-video-basemap__detail">
          <label htmlFor={ids.style}>Style</label>
          <select id={ids.style} value={settings.basemap.style} onChange={(event) => onChange({ basemap: { style: event.target.value as MapVideoBasemapStyle } })}>
            {OPENFREEMAP_STYLES.map((style) => (
              <option key={style.value} value={style.value}>
                {style.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <label className="overlay-controls__choice">
        <input type="radio" name="map-video-basemap" checked={source === 'maptiler'} onChange={() => onSource('maptiler')} />
        <span>
          MapTiler, with your own key: satellite imagery and other maps. MapTiler learns the area shown and
          counts the use against your key. Its terms allow videos for channels of up to 100,000 subscribers,
          and its free plan is for non-commercial use.
        </span>
      </label>
      {source === 'maptiler' && (
        <div className="map-video-basemap__detail">
          <div className="map-video-settings__field">
            <label htmlFor={ids.key}>MapTiler key</label>
            <input
              id={ids.key}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={maptilerKey}
              onChange={(event) => onMaptilerKey(event.target.value)}
              aria-describedby={`${ids.key}-note`}
            />
          </div>
          <p id={`${ids.key}-note`} className="map-video-settings__hint">
            Kept in this tab only: it is never saved, written into a project file, or sent anywhere but
            MapTiler.
          </p>
          <div className="map-video-settings__field">
            <label htmlFor={ids.maptilerStyle}>Map</label>
            <select
              id={ids.maptilerStyle}
              value={settings.basemap.maptilerStyle}
              onChange={(event) => onChange({ basemap: { maptilerStyle: event.target.value as MapTilerStyle } })}
            >
              {MAPTILER_STYLES.map((style) => (
                <option key={style.value} value={style.value}>
                  {style.label}
                </option>
              ))}
            </select>
          </div>
          {!maptilerKey.trim() && <p className="map-video-settings__hint" role="status">Type your key to see the map; until then the route is drawn alone.</p>}
        </div>
      )}
      <label className="overlay-controls__choice">
        <input type="radio" name="map-video-basemap" checked={source === 'route-only'} onChange={() => onSource('route-only')} />
        <span>Route only. The route is drawn on a plain background, and nothing is fetched.</span>
      </label>

      <div className="map-video-basemap__terrain">
        <label className="overlay-controls__choice">
          <input
            type="checkbox"
            checked={settings.terrain.enabled && source !== 'route-only'}
            disabled={source === 'route-only'}
            onChange={(event) => onChange({ terrain: { enabled: event.target.checked } })}
            aria-describedby={source === 'route-only' ? `${ids.exaggeration}-why` : undefined}
          />
          <span>3D terrain, from AWS Terrain Tiles. It asks Amazon for the hills around the route too.</span>
        </label>
        {source === 'route-only' && (
          <p id={`${ids.exaggeration}-why`} className="map-video-settings__hint">
            Terrain needs a map: route only fetches nothing.
          </p>
        )}
        {settings.terrain.enabled && source !== 'route-only' && (
          <div className="map-video-settings__field">
            <label htmlFor={ids.exaggeration}>Hills exaggerated</label>
            <span className="map-video-settings__input">
              <input
                id={ids.exaggeration}
                type="number"
                min={MAP_VIDEO_LIMITS.exaggeration[0]}
                max={MAP_VIDEO_LIMITS.exaggeration[1]}
                step={0.1}
                value={settings.terrain.exaggeration}
                aria-describedby={`${ids.exaggeration}-unit`}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  const [min, max] = MAP_VIDEO_LIMITS.exaggeration;
                  if (Number.isFinite(value)) onChange({ terrain: { exaggeration: Math.min(max, Math.max(min, value)) } });
                }}
              />
              <span id={`${ids.exaggeration}-unit`}>×</span>
            </span>
          </div>
        )}
      </div>
    </fieldset>
  );
}
