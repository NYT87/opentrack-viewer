import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Map as MapLibreMap, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, LineString, MultiLineString, Point } from 'geojson';
import type { MapVideoFrame, MapVideoModel } from '../mapVideo/model';
import type { MapVideoSettings } from '../mapVideo/project';

setWorkerUrl(maplibreWorkerUrl);

/** OpenFreeMap's styles, keyless and allowed for video with attribution (TD-064). */
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/';

/**
 * Route only: a background and nothing else, so no tile, glyph or sprite is
 * ever asked for. Its colour is the page's, read when the map is made.
 */
function routeOnlyStyle(background: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }] };
}

const REST = 'map-video-rest';
const REVEAL = 'map-video-reveal';
const MARKER = 'map-video-marker';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

function revealData(frame: MapVideoFrame): FeatureCollection<MultiLineString> {
  // A one-point line draws nothing; MapLibre is given only lines it can draw.
  const lines = frame.reveal.lines.filter((line) => line.length > 1);
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }],
  };
}

function markerData(frame: MapVideoFrame): FeatureCollection<Point> {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: frame.reveal.marker } }] };
}

function restData(model: MapVideoModel): FeatureCollection<LineString> {
  const features: FeatureCollection<LineString>['features'] = [];
  let line: [number, number][] = [];
  let segment: number | undefined;
  for (const i of model.drawn) {
    const vertex = model.route.vertices[i]!;
    if (segment !== undefined && vertex.segment !== segment && line.length > 0) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
      line = [];
    }
    segment = vertex.segment;
    line.push([vertex.lon, vertex.lat]);
  }
  features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
  return { type: 'FeatureCollection', features };
}

/** `0:07.4`: a position in the video to a tenth of a second. */
export function formatVideoTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export interface MapVideoPreviewProps {
  model: MapVideoModel;
  settings: MapVideoSettings;
}

/**
 * AV-1204. The map video played in the page: a MapLibre map at the video's
 * shape, moved through the model's frames (TD-066), with play, pause, a
 * scrubber and a frame at a time, by pointer or keyboard.
 *
 * It keeps up by skipping frames and draws tiles as they arrive, so it is a
 * guide; the export draws every frame, each with all its tiles (TD-064).
 * The framing is the export's: the zoom is offset by how much smaller the
 * preview is than the video, so the same stretch of map is in view.
 *
 * A map is made per basemap: switching between online and route only makes a
 * new one, since MapLibre's `setStyle` stops its worker (ActivityMap, AV-803).
 * The parent keys this component by the basemap.
 */
export function MapVideoPreview({ model, settings }: MapVideoPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | undefined>();
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const scrubberId = useId();
  const length = model.timeline.lengthSeconds;
  const frameSeconds = 1 / settings.output.fps;
  const online = settings.basemap.source === 'online';

  // What the drawing reads, without making a new map for each change.
  // Updated before the effects below run, which draw from it.
  const latest = useRef({ model, settings, seconds });
  useLayoutEffect(() => {
    latest.current = { model, settings, seconds };
  });

  // Make the map once; the parent makes a new component for another basemap.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const background = getComputedStyle(container).getPropertyValue('--map-video-background').trim() || '#11161c';
    const map = new MapLibreMap({
      container,
      style: online ? `${OPENFREEMAP_STYLE_URL}${latest.current.settings.basemap.style}` : routeOnlyStyle(background),
      interactive: false,
      // The source's attribution is always shown on an online map, never folded away (TD-064).
      attributionControl: online ? { compact: false } : false,
      // No fades: a fade runs on the wall clock, and the export has none (TD-064).
      fadeDuration: 0,
    });
    mapRef.current = map;
    map.on('load', () => {
      map.addSource(REST, { type: 'geojson', data: EMPTY });
      map.addSource(REVEAL, { type: 'geojson', data: EMPTY });
      map.addSource(MARKER, { type: 'geojson', data: EMPTY });
      const route = latest.current.settings.route;
      map.addLayer({ id: REST, type: 'line', source: REST, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': route.color, 'line-opacity': 0.35, 'line-width': route.width * 0.6 } });
      map.addLayer({ id: `${REVEAL}-casing`, type: 'line', source: REVEAL, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': route.casingColor, 'line-width': route.width + 3 } });
      map.addLayer({ id: REVEAL, type: 'line', source: REVEAL, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': route.color, 'line-width': route.width } });
      map.addLayer({ id: MARKER, type: 'circle', source: MARKER, paint: { 'circle-radius': route.width + 3, 'circle-color': route.color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } });
      setReady(true);
    });
    map.on('error', (event) => {
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (sourceId === REST || sourceId === REVEAL || sourceId === MARKER) return;
      setMapError(event.error?.message ?? 'The online map could not be loaded.');
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The basemap is fixed for this component's life: see the doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Draws the moment `at` of the video: the camera, the line and the marker. */
  const draw = useCallback((at: number) => {
    const map = mapRef.current;
    if (!map) return;
    const { model: current, settings: now } = latest.current;
    const frame = current.at(at);
    const width = containerRef.current?.clientWidth ?? 0;
    const offset = width > 0 ? Math.log2(width / now.output.width) : 0;
    const { center, zoom, pitch, bearing } = frame.camera;
    map.jumpTo({ center, zoom: zoom + offset, pitch, bearing });
    (map.getSource(REVEAL) as GeoJSONSource | undefined)?.setData(revealData(frame));
    (map.getSource(MARKER) as GeoJSONSource | undefined)?.setData(markerData(frame));
  }, []);

  // A new model (any setting changed): the rest of the route, the style, and the frame showing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(REST) as GeoJSONSource | undefined)?.setData(settings.route.unrevealed === 'hidden' ? EMPTY : restData(model));
    const route = settings.route;
    map.setPaintProperty(REST, 'line-color', route.color);
    map.setPaintProperty(REVEAL, 'line-color', route.color);
    map.setPaintProperty(`${REVEAL}-casing`, 'line-color', route.casingColor);
    map.setPaintProperty(MARKER, 'circle-color', route.color);
    if (latest.current.seconds > length) setSeconds(length);
    draw(Math.min(latest.current.seconds, length));
  }, [model, settings.route, ready, draw, length]);

  // The frame showing, whenever the position moves.
  useEffect(() => {
    if (ready) draw(seconds);
  }, [seconds, ready, draw]);

  // Playing: the position follows the clock, so the preview skips what it cannot draw in time.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last: number | undefined;
    const tick = (now: number) => {
      const step = last === undefined ? 0 : (now - last) / 1000;
      last = now;
      const next = Math.min(length, latest.current.seconds + step);
      setSeconds(next);
      if (next >= length) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, length]);

  const seek = (to: number) => {
    setPlaying(false);
    setSeconds(Math.min(length, Math.max(0, to)));
  };
  const togglePlay = () => {
    if (!playing && seconds >= length) setSeconds(0);
    setPlaying(!playing);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : frameSeconds;
    const keys: Record<string, () => void> = {
      ' ': togglePlay,
      k: togglePlay,
      ArrowLeft: () => seek(seconds - step),
      ArrowRight: () => seek(seconds + step),
      Home: () => seek(0),
      End: () => seek(length),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const phase = model.timeline.at(seconds).phase;

  return (
    <section className="prose map-video-preview" aria-label="Preview">
      <h3 className="prose__title">Preview</h3>
      <div
        className="map-video-preview__frame"
        style={{ aspectRatio: `${settings.output.width} / ${settings.output.height}`, ['--frame-aspect' as string]: settings.output.width / settings.output.height }}
        tabIndex={0}
        role="group"
        aria-label={`Preview, ${settings.output.width} by ${settings.output.height}. Space plays or pauses; the arrow keys step a frame, with Shift a second.`}
        onKeyDown={onKeyDown}
      >
        <div ref={containerRef} className="map-video-preview__map" data-testid="map-video-map" />
      </div>
      <div className="map-video-preview__transport">
        <button type="button" className="button" onClick={togglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="button" aria-label="Back a frame" onClick={() => seek(seconds - frameSeconds)}>
          ‹
        </button>
        <button type="button" className="button" aria-label="Forward a frame" onClick={() => seek(seconds + frameSeconds)}>
          ›
        </button>
        <label className="map-video-preview__scrub" htmlFor={scrubberId}>
          <span className="visually-hidden">Position in the video</span>
          <input
            id={scrubberId}
            type="range"
            min={0}
            max={length}
            step={frameSeconds}
            value={seconds}
            aria-valuetext={`${formatVideoTime(seconds)} of ${formatVideoTime(length)}`}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </label>
        <span className="map-video-preview__time" aria-live="off">
          {formatVideoTime(seconds)} / {formatVideoTime(length)}
        </span>
      </div>
      <p className="map-video-preview__note">
        {phase === 'intro' ? 'Intro. ' : phase === 'outro' ? 'Outro. ' : ''}
        The preview is a guide: it skips frames to keep up, and may show the map before every tile has
        arrived. The export draws every frame, each with all of its map.
      </p>
      {mapError && online && (
        <p className="map-video-preview__note" role="status">
          The online map did not load fully: {mapError}. The route still shows; route only needs no map.
        </p>
      )}
    </section>
  );
}

export default MapVideoPreview;
