import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Map as MapLibreMap,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Activity } from '../domain/activity';
import { formatElevation, formatSpeed, type UnitSystem } from '../domain/units';
import type { MapVideoModel } from '../mapVideo/model';
import { formatVideoTime } from '../mapVideo/timing';
import { clampKeyframe, offsetBetween, type CameraKeyframe } from '../mapVideo/keyframes';
import { MapVideoKeyframes, freshKeyframeId } from './MapVideoKeyframes';
import { createMapVideoFigures, type MapVideoFigures } from '../mapVideo/figures';
import type { MapVideoSettings } from '../mapVideo/project';
import { MARKER_ICON_PIXELS, markerIconImage, sportIcon } from '../mapVideo/markerIcons';
import {
  COLOR_BY_PALETTE,
  TERRAIN_TILES,
  coloredRuns,
  drawnWithColorSteps,
  headingAt,
  mapVideoAttribution,
  routeColors,
  terrainActive,
  trailAt,
} from '../mapVideo/style';

setWorkerUrl(maplibreWorkerUrl);

/** OpenFreeMap's styles, keyless and allowed for video with attribution (TD-064). */
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/';
/** MapTiler's styles, asked for with the reader's own key. */
export const MAPTILER_STYLE_URL = 'https://api.maptiler.com/maps/';

/** The style a map video's basemap is drawn from, or undefined for route only, or MapTiler without a key. */
export function basemapStyleUrl(settings: MapVideoSettings, maptilerKey: string): string | undefined {
  if (settings.basemap.source === 'online') return `${OPENFREEMAP_STYLE_URL}${settings.basemap.style}`;
  if (settings.basemap.source === 'maptiler') {
    const key = maptilerKey.trim();
    return key ? `${MAPTILER_STYLE_URL}${settings.basemap.maptilerStyle}/style.json?key=${encodeURIComponent(key)}` : undefined;
  }
  return undefined;
}

/**
 * Route only: a background and nothing else, so no tile, glyph or sprite is
 * ever asked for. Its colour is the page's, read when the map is made.
 */
function routeOnlyStyle(background: string): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }] };
}

const REST = 'map-video-rest';
const REVEAL = 'map-video-reveal';
const CASING = 'map-video-reveal-casing';
const TRAIL = 'map-video-trail';
const MARKER = 'map-video-marker';
const MARKER_ICON = 'map-video-marker-icon';
const ENDS = 'map-video-ends';
const DEM = 'map-video-dem';
const OWN_SOURCES = [REST, REVEAL, TRAIL, MARKER, ENDS];

/** How far behind the marker its trail reaches, in metres. */
const TRAIL_METERS = 400;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const lineFeature = (coordinates: [number, number][], properties: Record<string, unknown> = {}): Feature<LineString> => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates },
});
const pointFeature = (coordinates: [number, number], properties: Record<string, unknown> = {}): Feature<Point> => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates },
});

/** The drawn line's colour: one, or a step of the palette per run. */
function revealColor(settings: MapVideoSettings, colored: boolean): string | ExpressionSpecification {
  if (!colored) return settings.route.color;
  const steps = COLOR_BY_PALETTE.flatMap((color, bin) => [bin, color]);
  return ['match', ['get', 'bin'], ...steps, settings.route.color] as unknown as ExpressionSpecification;
}

function restData(model: MapVideoModel): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  let line: [number, number][] = [];
  let segment: number | undefined;
  for (const i of model.drawn) {
    const vertex = model.route.vertices[i]!;
    if (segment !== undefined && vertex.segment !== segment && line.length > 0) {
      features.push(lineFeature(line));
      line = [];
    }
    segment = vertex.segment;
    line.push([vertex.lon, vertex.lat]);
  }
  features.push(lineFeature(line));
  return { type: 'FeatureCollection', features };
}

export interface MapVideoPreviewProps {
  activity: Activity;
  model: MapVideoModel;
  settings: MapVideoSettings;
  /** The reader's MapTiler key, held in memory only. */
  maptilerKey?: string;
  units?: UnitSystem;
  /**
   * Where the preview is in the video, held by the page: read once to start,
   * written as the position moves, so a new map for another basemap carries
   * on from where the last one was.
   */
  positionRef?: { current: number };
  /** AV-1206. The camera keyframes, and how the page keeps them: each change undoable. */
  keyframes?: CameraKeyframe[];
  onEditKeyframes?: (keyframes: CameraKeyframe[]) => void;
  onUndoKeyframes?: () => void;
  canUndoKeyframes?: boolean;
  /**
   * Where the keyframe list is drawn: the page's side column, so the stage
   * stays only the picture and its transport and fits the screen while it
   * sticks (TD-059). Drawn under the preview when absent.
   */
  keyframesTarget?: HTMLElement | null;
  /** AV-1207. Told where the preview rests when paused, for the figures editor's clock. */
  onPausedAt?: (seconds: number) => void;
  /** A moment to go to, asked by the figures editor; `request` changes for each ask. */
  seek?: { seconds: number; request: number };
  /** Told a picture of the map as it settles while paused, for the figures editor to place over. */
  onSnapshot?: (url: string) => void;
}

/** MapLibre's pointer and touch handlers: on while paused, so the reader can frame a keyframe; off while playing. */
const HANDLERS = ['dragPan', 'scrollZoom', 'boxZoom', 'dragRotate', 'touchZoomRotate', 'touchPitch', 'doubleClickZoom'] as const;
function setInteractive(map: MapLibreMap, on: boolean) {
  for (const name of HANDLERS) {
    const handler = (map as unknown as Record<string, { enable?: () => void; disable?: () => void } | undefined>)[name];
    if (on) handler?.enable?.();
    else handler?.disable?.();
  }
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
 * AV-1205. Styled as the export will be: the route in one colour or by a
 * recorded value, with or without a casing, the rest dimmed or hidden; the
 * marker a dot, an arrow along the heading or the sport's icon, with a
 * fading trail; start and finish markers; 3D terrain; and the map's credit
 * drawn in the frame, where no setting removes it.
 *
 * A map is made per basemap and terrain: switching makes a new one, since
 * MapLibre's `setStyle` stops its worker (ActivityMap, AV-803), and whether
 * the camera follows the ground is fixed when a map is made. The parent keys
 * this component by them.
 */
export function MapVideoPreview({
  activity,
  model,
  settings,
  maptilerKey = '',
  units = 'metric',
  positionRef,
  keyframes = [],
  onEditKeyframes,
  onUndoKeyframes,
  canUndoKeyframes = false,
  keyframesTarget,
  onPausedAt,
  seek: seekRequest,
  onSnapshot,
}: MapVideoPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const figuresRef = useRef<HTMLCanvasElement>(null);
  /** The figures, made again only when what they draw from or the canvas's size changes. */
  const figuresCache = useRef<{ key: unknown[]; figures: MapVideoFigures } | undefined>(undefined);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | undefined>();
  const [keyframeNote, setKeyframeNote] = useState<string | undefined>();
  const ticksId = useId();
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const scrubberId = useId();
  const length = model.timeline.lengthSeconds;
  const frameSeconds = 1 / settings.output.fps;
  const styleUrl = basemapStyleUrl(settings, maptilerKey);
  const terrain = terrainActive(settings);
  const attribution = mapVideoAttribution(settings);
  const colors = useMemo(() => {
    const steps = routeColors(activity, model.route, settings.route.colorBy);
    return steps && { ...steps, drawn: drawnWithColorSteps(model.drawn, steps) };
  }, [activity, model.route, model.drawn, settings.route.colorBy]);
  const sport = sportIcon(activity.metadata.sport);

  // What the drawing reads, without making a new map for each change; updated before the effects below run.
  const latest = useRef({ model, settings, seconds, colors, playing, onSnapshot, activity, units });
  useLayoutEffect(() => {
    latest.current = { model, settings, seconds, colors, playing, onSnapshot, activity, units };
  });

  // Make the map once; the parent makes a new component for another basemap or terrain.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const background = getComputedStyle(container).getPropertyValue('--map-video-background').trim() || '#11161c';
    const now = latest.current.settings;
    const map = new MapLibreMap({
      container,
      style: styleUrl ?? routeOnlyStyle(background),
      // Moved by hand while paused, to frame a keyframe (AV-1206). The keys stay the preview's own.
      interactive: true,
      keyboard: false,
      // The credit is drawn in the frame below, as the export draws it, so the control is not needed.
      attributionControl: false,
      // No fades: a fade runs on the wall clock, and the export has none (TD-064).
      fadeDuration: 0,
      // Kept after drawing, so a settled view can be pictured for the figures editor (AV-1207).
      canvasContextAttributes: { preserveDrawingBuffer: true },
      // Over terrain the centre is held to the ground, as MapLibre does by default (TD-068).
      centerClampedToGround: true,
    });
    mapRef.current = map;
    // The frame around it takes the keys; the canvas is not a second stop for Tab.
    map.getCanvas?.()?.setAttribute('tabindex', '-1');
    map.on('load', () => {
      for (const id of OWN_SOURCES) map.addSource(id, { type: 'geojson', data: EMPTY, ...(id === TRAIL ? { lineMetrics: true } : {}) });
      if (terrain) {
        map.addSource(DEM, { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
        map.setTerrain({ source: DEM, exaggeration: now.terrain.exaggeration });
      }
      const round = { 'line-join': 'round', 'line-cap': 'round' } as const;
      map.addLayer({ id: REST, type: 'line', source: REST, layout: round, paint: { 'line-opacity': 0.35 } });
      map.addLayer({ id: CASING, type: 'line', source: REVEAL, layout: round, paint: {} });
      map.addLayer({ id: REVEAL, type: 'line', source: REVEAL, layout: round, paint: {} });
      map.addLayer({ id: TRAIL, type: 'line', source: TRAIL, layout: round, paint: {} });
      map.addLayer({
        id: ENDS,
        type: 'circle',
        source: ENDS,
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'end'], 'start', '#2fbf71', '#1a1a1a'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
          'circle-pitch-alignment': 'map',
        },
      });
      map.addLayer({ id: MARKER, type: 'circle', source: MARKER, paint: { 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } });
      map.addLayer({
        id: MARKER_ICON,
        type: 'symbol',
        source: MARKER,
        layout: {
          'icon-image': MARKER_ICON,
          'icon-rotate': ['get', 'rotate'],
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
      setReady(true);
    });
    // Settled and still: a picture of the map for the figures editor to place elements over.
    map.on('idle', () => {
      if (latest.current.playing) return;
      try {
        const url = map.getCanvas?.()?.toDataURL('image/jpeg', 0.8);
        if (url) latest.current.onSnapshot?.(url);
      } catch {
        // A canvas the browser will not read (it never is here: the tiles come with CORS): no picture, no harm.
      }
    });
    map.on('error', (event) => {
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (sourceId && OWN_SOURCES.includes(sourceId)) return;
      setMapError(event.error?.message ?? 'The online map could not be loaded.');
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The basemap and terrain are fixed for this component's life: see the doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The figures and the summary card over the map, by the export's renderer, at the preview's own pixels. */
  const drawFigures = useCallback((at: number) => {
    const canvas = figuresRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { model: current, settings: now, activity: active, units: shown } = latest.current;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const key = [current, now.overlay, now.summaryCard.enabled, now.terrain, now.basemap.source, active, shown, width, height];
    const cached = figuresCache.current;
    const figures =
      cached && cached.key.every((value, i) => value === key[i])
        ? cached.figures
        : createMapVideoFigures({ activity: active, model: current, settings: now, units: shown, width, height });
    figuresCache.current = { key, figures };
    ctx.clearRect(0, 0, width, height);
    figures.drawFrame(ctx, at);
  }, []);

  /** Draws the moment `at` of the video: the camera, the line, the trail and the marker. */
  const draw = useCallback((at: number) => {
    const map = mapRef.current;
    if (!map) return;
    const { model: current, settings: now, colors: steps } = latest.current;
    const frame = current.at(at);
    const width = containerRef.current?.clientWidth ?? 0;
    const offset = width > 0 ? Math.log2(width / now.output.width) : 0;
    const { center, zoom, pitch, bearing } = frame.camera;
    map.jumpTo({ center, zoom: zoom + offset, pitch, bearing });
    const distance = frame.sample.distance;
    const revealed: FeatureCollection<LineString> = steps
      ? {
          type: 'FeatureCollection',
          features: coloredRuns(current.route, distance, steps.drawn, steps)
            .filter((run) => run.line.length > 1)
            .map((run) => lineFeature(run.line, { bin: run.bin })),
        }
      : { type: 'FeatureCollection', features: frame.reveal.lines.filter((line) => line.length > 1).map((line) => lineFeature(line)) };
    (map.getSource(REVEAL) as GeoJSONSource | undefined)?.setData(revealed);
    const trail = now.marker.trail ? trailAt(current.route, distance, TRAIL_METERS) : [];
    (map.getSource(TRAIL) as GeoJSONSource | undefined)?.setData(trail.length > 1 ? { type: 'FeatureCollection', features: [lineFeature(trail)] } : EMPTY);
    (map.getSource(MARKER) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [pointFeature(frame.reveal.marker, { rotate: now.marker.shape === 'arrow' ? headingAt(current.route, distance) : 0 })],
    });
    drawFigures(at);
  }, [drawFigures]);


  // A new model or style: the rest of the route, the ends, the paint, and the frame showing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const { route, marker, endpoints, terrain: relief } = settings;
    (map.getSource(REST) as GeoJSONSource | undefined)?.setData(route.unrevealed === 'hidden' ? EMPTY : restData(model));
    const first = model.route.vertices[0]!;
    const last = model.route.vertices[model.route.vertices.length - 1]!;
    (map.getSource(ENDS) as GeoJSONSource | undefined)?.setData(
      endpoints.shown
        ? { type: 'FeatureCollection', features: [pointFeature([first.lon, first.lat], { end: 'start' }), pointFeature([last.lon, last.lat], { end: 'finish' })] }
        : EMPTY,
    );
    map.setPaintProperty(REST, 'line-color', route.color);
    map.setPaintProperty(REST, 'line-width', Math.max(1, route.width * 0.6));
    map.setPaintProperty(REVEAL, 'line-color', revealColor(settings, colors !== undefined));
    map.setPaintProperty(REVEAL, 'line-width', route.width);
    map.setPaintProperty(CASING, 'line-color', route.casingColor);
    map.setPaintProperty(CASING, 'line-width', route.width + 4);
    map.setLayoutProperty(CASING, 'visibility', route.casing ? 'visible' : 'none');
    map.setPaintProperty(TRAIL, 'line-width', route.width * 1.8);
    map.setPaintProperty(TRAIL, 'line-gradient', ['interpolate', ['linear'], ['line-progress'], 0, `${marker.color}00`, 1, `${marker.color}cc`]);
    map.setPaintProperty(MARKER, 'circle-color', marker.color);
    map.setPaintProperty(MARKER, 'circle-radius', marker.size / 2);
    const icon = markerIconImage(marker.shape, sport, marker.color);
    if (map.hasImage(MARKER_ICON)) map.removeImage(MARKER_ICON);
    if (icon) map.addImage(MARKER_ICON, icon, { pixelRatio: 1 });
    map.setLayoutProperty(MARKER, 'visibility', marker.shape === 'dot' || !icon ? 'visible' : 'none');
    map.setLayoutProperty(MARKER_ICON, 'visibility', marker.shape !== 'dot' && icon ? 'visible' : 'none');
    map.setLayoutProperty(MARKER_ICON, 'icon-size', marker.size / MARKER_ICON_PIXELS);
    if (terrain) map.setTerrain({ source: DEM, exaggeration: relief.exaggeration });
    if (latest.current.seconds > length) setSeconds(length);
    draw(Math.min(latest.current.seconds, length));
  }, [model, settings, colors, sport, ready, draw, length, terrain]);

  // A new map carries on from where the last one was.
  useEffect(() => {
    const start = positionRef?.current ?? 0;
    if (start > 0) setSeconds(Math.min(start, latest.current.model.timeline.lengthSeconds));
    // Once, when this map's preview starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The frame showing, whenever the position moves.
  useEffect(() => {
    if (ready) draw(seconds);
    if (positionRef) positionRef.current = seconds;
  }, [seconds, ready, draw, positionRef]);

  // Where the preview rests, for the figures editor: told when paused, not on every frame of play.
  useEffect(() => {
    if (!playing) onPausedAt?.(seconds);
  }, [seconds, playing, onPausedAt]);

  // The figures editor asks for a moment: go there.
  useEffect(() => {
    if (seekRequest) setSeconds(Math.min(latest.current.model.timeline.lengthSeconds, Math.max(0, seekRequest.seconds)));
  }, [seekRequest]);

  // The map can be moved by hand only while paused: playing, the frames move it.
  useEffect(() => {
    const map = mapRef.current;
    if (map && ready) setInteractive(map, !playing);
  }, [playing, ready]);

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
  const keyframeContext = { timeline: model.timeline, route: model.route, viewport: { width: settings.output.width, height: settings.output.height } };
  /** Each keyframe held to its limits; says so when one had to be brought closer to the marker. */
  const editKeyframes = (next: CameraKeyframe[]) => {
    if (!onEditKeyframes) return;
    let moved = false;
    const held = next.map((keyframe) => {
      const clamped = clampKeyframe(keyframe, keyframeContext);
      if (Math.hypot(clamped.offset.east - keyframe.offset.east, clamped.offset.north - keyframe.offset.north) > 0.5) moved = true;
      return clamped;
    });
    setKeyframeNote(moved ? 'Brought closer to the marker, so the marker stays in the frame.' : undefined);
    onEditKeyframes(held);
  };
  /** The view on the map now, as a keyframe at this moment of the follow. */
  const addKeyframe = () => {
    const map = mapRef.current;
    if (!map) return;
    const width = containerRef.current?.clientWidth ?? 0;
    const zoomOffset = width > 0 ? Math.log2(width / settings.output.width) : 0;
    const center = map.getCenter();
    const marker = model.at(seconds).reveal.marker;
    const keyframe: CameraKeyframe = {
      id: freshKeyframeId(keyframes),
      seconds,
      mode: 'follow',
      offset: offsetBetween(marker, [center.lng, center.lat]),
      zoom: map.getZoom() - zoomOffset,
      pitch: map.getPitch(),
      bearing: ((map.getBearing() % 360) + 360) % 360,
    };
    const outside = phase !== 'follow';
    editKeyframes([...keyframes, keyframe]);
    if (outside) setKeyframeNote('Keyframes are for the route itself, so this one was put where the route starts or ends.');
  };

  const keyframeList = (
    <MapVideoKeyframes
      keyframes={keyframes}
      frameSeconds={frameSeconds}
      onChange={editKeyframes}
      onSeek={seek}
      onUndo={() => {
        setKeyframeNote(undefined);
        onUndoKeyframes?.();
      }}
      canUndo={canUndoKeyframes}
      note={keyframeNote}
    />
  );

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
        {/* The figures over the map (AV-1207): drawn as the export draws them, never in the way of the hand. */}
        <canvas ref={figuresRef} className="map-video-preview__figures" aria-hidden="true" data-testid="map-video-figures" />
        {/* In the frame, as the export draws it, and never turned off (TD-064). */}
        {attribution && <p className="map-video-preview__attribution">{attribution}</p>}
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
            list={keyframes.length > 0 ? ticksId : undefined}
            onChange={(event) => seek(Number(event.target.value))}
          />
          {keyframes.length > 0 && (
            <datalist id={ticksId}>
              {keyframes.map((keyframe) => (
                <option key={keyframe.id} value={keyframe.seconds} />
              ))}
            </datalist>
          )}
        </label>
        {onEditKeyframes && !playing && (
          <>
            <button type="button" className="button" onClick={addKeyframe}>
              Add keyframe here
            </button>
            <button type="button" className="button" onClick={() => draw(seconds)}>
              Reset view
            </button>
          </>
        )}
        <span className="map-video-preview__time" aria-live="off">
          {formatVideoTime(seconds)} / {formatVideoTime(length)}
        </span>
      </div>
      <p className="map-video-preview__note">
        {phase === 'intro' ? 'Intro. ' : phase === 'outro' ? 'Outro. ' : ''}
        The preview is a guide: it skips frames to keep up, and may show the map before every tile has
        arrived. The export draws every frame, each with all of its map.
      </p>
      {colors && (
        <p className="map-video-preview__legend" aria-label="Route colours">
          <span>{formatLegend(settings.route.colorBy, colors.low, units)}</span>
          <span className="map-video-preview__ramp" style={{ background: `linear-gradient(to right, ${COLOR_BY_PALETTE.join(', ')})` }} />
          <span>{formatLegend(settings.route.colorBy, colors.high, units)}</span>
        </p>
      )}
      {onEditKeyframes && (keyframesTarget ? createPortal(keyframeList, keyframesTarget) : keyframeList)}
      {mapError && styleUrl && (
        <p className="map-video-preview__note" role="status">
          The map did not load fully: {mapError}. The route still shows; route only needs no map.
        </p>
      )}
    </section>
  );
}

/** A legend end, in the reader's units. */
function formatLegend(by: MapVideoSettings['route']['colorBy'], value: number, units: UnitSystem): string {
  if (by === 'speed') return formatSpeed(value, units);
  if (by === 'elevation') return formatElevation(value, units);
  return `${Math.round(value)} bpm`;
}

export default MapVideoPreview;
