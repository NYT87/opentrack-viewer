import { useId } from 'react';
import { OPENFREEMAP_TILE_BUDGET } from '../mapVideo/export/tileBudget';
import {
  INSET_MAPTILER_STYLES,
  INSET_OPENFREEMAP_STYLES,
  MAX_MAP_INSETS,
  ROUTE_INSET_BORDER_MAX,
  ROUTE_INSET_LINE_WIDTH,
  ROUTE_INSET_TRAIL_MINUTES,
  ROUTE_INSET_ZOOM,
  hasInsetMap,
  insetMapStyleOf,
  insetProviderName,
  routeInsetOf,
  type InsetMapProvider,
  type OverlayRouteInsetSetting,
} from '../overlay/routeInset';
import type { OverlayComponent } from '../overlay/template';
import { useMapVideoStore } from '../state/mapVideoStore';
import { ColorField } from './ColorField';
import { PercentField } from './RouteOverlayPanel';

/**
 * AV-1023 (TD-092). The route inset's own settings, in the editor of the canvas: the view (the
 * whole route, or a zoom that follows the position), north up or heading up, the shape, the
 * border, the trail and the route ahead, the line, and the map. Every control is a labelled
 * field of the page's own kind, so it is reachable and named for a screen reader.
 *
 * The map is off by default. Where it is turned on the page says who learns the area shown, and
 * what the privacy trim keeps out of every request (TD-091); a MapTiler map needs the reader's
 * key and is for the videos only (TD-079). Not offered inside the map video's or the map image's
 * canvas, which are maps already (`host`), and not for a third inset: at most two carry a map.
 */

type Patch = (change: (current: OverlayComponent) => OverlayComponent) => void;

const MAP_STYLE_LABELS: Record<string, string> = {
  liberty: 'Liberty (streets, in colour)',
  positron: 'Positron (light)',
  dark: 'Dark',
  bright: 'Bright',
  satellite: 'Satellite',
  hybrid: 'Satellite with labels',
  'outdoor-v2': 'Outdoor',
  'streets-v2': 'Streets',
};

export function RouteInsetEditor({
  component,
  components,
  frame,
  host,
  trimmed,
  onChange,
}: {
  component: OverlayComponent;
  components: OverlayComponent[];
  frame: { width: number; height: number };
  /** Inside the map video's or the map image's canvas: the map is not offered, and the view and orientation are. */
  host: boolean;
  /** Whether the overlay has a privacy trim set. */
  trimmed: boolean;
  onChange: Patch;
}) {
  const id = useId();
  const setting = routeInsetOf(component.routeInset);
  const shorter = Math.min(frame.width, frame.height);
  const maptilerKey = useMapVideoStore((state) => state.maptilerKey);
  const setMaptilerKey = useMapVideoStore((state) => state.setMaptilerKey);
  const withInset = (patch: Partial<OverlayRouteInsetSetting>) =>
    onChange((current) => ({ ...current, routeInset: { ...routeInsetOf(current.routeInset), ...patch } }));
  const mapsElsewhere = components.filter((entry) => entry.id !== component.id && entry.type === 'routeInset' && hasInsetMap(entry.routeInset)).length;
  const mapsFull = mapsElsewhere >= MAX_MAP_INSETS;
  const provider = setting.map.provider;
  const chooseProvider = (next: InsetMapProvider) =>
    withInset({ map: { provider: next, style: insetMapStyleOf(next, next === provider ? setting.map.style : undefined) } });
  const styles = provider === 'maptiler' ? INSET_MAPTILER_STYLES : INSET_OPENFREEMAP_STYLES;
  const percent = (value: number) => String(Math.round(value * 10_000) / 100);

  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-view`}>View</label>
        <select id={`${id}-view`} className="select" value={setting.view} onChange={(event) => withInset({ view: event.target.value === 'follow' ? 'follow' : 'whole' })}>
          <option value="whole">The whole route</option>
          <option value="follow">Follow the position</option>
        </select>
      </div>
      {setting.view === 'follow' && (
        <>
          <PercentField
            id={`${id}-zoom`}
            label="Zoom"
            hint={`${ROUTE_INSET_ZOOM.min} to ${ROUTE_INSET_ZOOM.max}: higher shows less ground. The same ground at any picture size.`}
            value={String(setting.zoom)}
            min={ROUTE_INSET_ZOOM.min}
            max={ROUTE_INSET_ZOOM.max}
            step={0.5}
            onCommit={(value) => withInset({ zoom: Math.min(ROUTE_INSET_ZOOM.max, Math.max(ROUTE_INSET_ZOOM.min, Math.round(value * 10) / 10)) })}
          />
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-orientation`}>Orientation</label>
            <select id={`${id}-orientation`} className="select" value={setting.orientation} onChange={(event) => withInset({ orientation: event.target.value === 'heading' ? 'heading' : 'north' })}>
              <option value="north">North up</option>
              <option value="heading">Heading up: the direction of travel up</option>
            </select>
          </div>
          {setting.orientation === 'heading' && <p className="overlay-controls__hint">The heading is smoothed over 3 seconds and held through a stop, so the map does not swing on GPS noise.</p>}
        </>
      )}

      <div className="overlay-controls__field">
        <label htmlFor={`${id}-shape`}>Shape</label>
        <select id={`${id}-shape`} className="select" value={setting.shape} onChange={(event) => withInset({ shape: event.target.value === 'round' ? 'round' : 'square' })}>
          <option value="square">Square (the box)</option>
          <option value="round">Round (a circle in the box)</option>
        </select>
      </div>
      <PercentField
        id={`${id}-border-width`}
        label="Border width (px)"
        hint="0 draws none."
        value={String(Math.round(setting.border.width * shorter * 10) / 10)}
        max={Math.round(ROUTE_INSET_BORDER_MAX * shorter)}
        step={0.5}
        onCommit={(value) => withInset({ border: { ...setting.border, width: Math.min(ROUTE_INSET_BORDER_MAX, Math.max(0, value / shorter)) } })}
      />
      <ColorField id={`${id}-border-colour`} label="Border colour" value={setting.border.color} onChange={(color) => withInset({ border: { ...setting.border, color } })} />

      <div className="overlay-controls__field">
        <label htmlFor={`${id}-trail`}>Trail behind</label>
        <select id={`${id}-trail`} className="select" value={setting.trail === 'all' ? 'all' : 'last'} onChange={(event) => withInset({ trail: event.target.value === 'all' ? 'all' : 10 })}>
          <option value="all">All of it</option>
          <option value="last">The last minutes</option>
        </select>
      </div>
      {setting.trail !== 'all' && (
        <PercentField
          id={`${id}-trail-minutes`}
          label="Trail length (minutes)"
          value={String(setting.trail)}
          min={ROUTE_INSET_TRAIL_MINUTES.min}
          max={ROUTE_INSET_TRAIL_MINUTES.max}
          onCommit={(value) => withInset({ trail: Math.min(ROUTE_INSET_TRAIL_MINUTES.max, Math.max(ROUTE_INSET_TRAIL_MINUTES.min, Math.round(value))) })}
        />
      )}
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-ahead`}>Route ahead</label>
        <select id={`${id}-ahead`} className="select" value={setting.ahead} onChange={(event) => withInset({ ahead: event.target.value as OverlayRouteInsetSetting['ahead'] })}>
          <option value="shown">Shown</option>
          <option value="dimmed">Dimmed</option>
          <option value="hidden">Hidden</option>
        </select>
      </div>
      <PercentField
        id={`${id}-line-width`}
        label="Line width (% of the inset)"
        value={percent(setting.lineWidth)}
        min={ROUTE_INSET_LINE_WIDTH.min * 100}
        max={ROUTE_INSET_LINE_WIDTH.max * 100}
        step={0.5}
        onCommit={(value) => withInset({ lineWidth: Math.min(ROUTE_INSET_LINE_WIDTH.max, Math.max(ROUTE_INSET_LINE_WIDTH.min, value / 100)) })}
      />

      {!host && (
        <fieldset className="overlay-controls__group route-inset__map">
          <legend>Map</legend>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-map`}>Map behind the line</label>
            <select id={`${id}-map`} className="select" value={provider} onChange={(event) => chooseProvider(event.target.value as InsetMapProvider)} aria-describedby={mapsFull ? `${id}-map-full` : undefined}>
              <option value="none">None: the line only</option>
              <option value="openfreemap" disabled={mapsFull && provider === 'none'}>OpenFreeMap</option>
              <option value="maptiler" disabled={mapsFull && provider === 'none'}>MapTiler, with your key (videos only)</option>
            </select>
          </div>
          {mapsFull && provider === 'none' && (
            <p id={`${id}-map-full`} className="overlay-controls__hint">
              At most {MAX_MAP_INSETS} insets in one overlay show a map: each is a map this tab holds open for the export. Turn one off to add another.
            </p>
          )}
          {/* Always mounted, its words changing, so a screen reader announces them when the map is turned on. */}
          <p className="overlay-controls__note" role="status">
            {provider === 'none'
              ? ''
              : trimmed
                ? `The map’s tiles are fetched from ${insetProviderName(provider)}, which learns the area shown. The privacy trim keeps the start and end out of every request.`
                : `The map’s tiles are fetched from ${insetProviderName(provider)}, which learns the area shown. No privacy trim is set, so the start and end are asked for like any other part.`}
          </p>
          {provider !== 'none' && (
            <>
              <div className="overlay-controls__field">
                <label htmlFor={`${id}-map-style`}>Map style</label>
                <select id={`${id}-map-style`} className="select" value={setting.map.style} onChange={(event) => withInset({ map: { provider, style: insetMapStyleOf(provider, event.target.value) } })}>
                  {styles.map((style) => (
                    <option key={style} value={style}>
                      {MAP_STYLE_LABELS[style] ?? style}
                    </option>
                  ))}
                </select>
              </div>
              {provider === 'maptiler' && (
                <>
                  <div className="overlay-controls__field">
                    <label htmlFor={`${id}-map-key`}>MapTiler key</label>
                    <input
                      id={`${id}-map-key`}
                      className="input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={maptilerKey}
                      onChange={(event) => setMaptilerKey(event.target.value)}
                      aria-describedby={`${id}-map-key-note`}
                    />
                  </div>
                  <p id={`${id}-map-key-note`} className="overlay-controls__hint">
                    Kept in this tab only: never saved, written into a layout file, or sent anywhere but MapTiler. MapTiler’s terms allow videos, not
                    pictures of its map, so the transparent video and the video with the overlay drawn in can use it, and the PNG sequence refuses it.
                  </p>
                  {!maptilerKey.trim() && <p className="overlay-controls__hint" role="status">Type your key to see the map; until then the line is drawn alone.</p>}
                </>
              )}
              <p className="overlay-controls__hint">
                A trim keeps out only what it hides: with none set, the start and end are asked for like any other part, and a tile is larger than the view, so a short trim can leave a hidden stretch’s tile in a request.
              </p>
              <p className="overlay-controls__hint">
                The preview draws the map as its tiles arrive; an export waits for every tile. An export asks for at most {OPENFREEMAP_TILE_BUDGET.toLocaleString('en')} OpenFreeMap tiles in all, and
                says how many before it starts.
              </p>
            </>
          )}
        </fieldset>
      )}
    </>
  );
}
