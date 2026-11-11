import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Activity } from '../domain/activity';
import { formatElevation, formatSpeed, type UnitSystem } from '../domain/units';
import type { MapVideoModel } from '../mapVideo/model';
import { formatVideoTime } from '../mapVideo/timing';
import { clampKeyframe, offsetBetween, type CameraKeyframe } from '../mapVideo/keyframes';
import { MapVideoKeyframes, freshKeyframeId } from './MapVideoKeyframes';
import { createMapVideoFigures, type MapVideoFigures, type PhotoImage } from '../mapVideo/figures';
import type { MapVideoSettings } from '../mapVideo/project';
import { COLOR_BY_PALETTE, mapVideoAttribution } from '../mapVideo/style';
import {
  ROUTE_ONLY_BACKGROUND,
  basemapStyleUrl,
  drawVideoMap,
  installVideoLayers,
  isOwnSource,
  routeOnlyStyle,
  styleVideoMap,
  videoMapColors,
} from '../mapVideo/videoMap';

setWorkerUrl(maplibreWorkerUrl);

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
  /** AV-1208. The photos' decoded pixels, by id, shown while the marker waits for each. */
  photoImages?: ReadonlyMap<string, PhotoImage>;
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
  photoImages,
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
  const attribution = mapVideoAttribution(settings);
  const colors = useMemo(
    () => videoMapColors(activity, model, settings),
    // The colours follow the route and what it is coloured by, not every setting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activity, model.route, model.drawn, settings.route.colorBy],
  );

  // What the drawing reads, without making a new map for each change; updated before the effects below run.
  const latest = useRef({ model, settings, seconds, colors, playing, onSnapshot, activity, units, photoImages });
  useLayoutEffect(() => {
    latest.current = { model, settings, seconds, colors, playing, onSnapshot, activity, units, photoImages };
  });

  // Make the map once; the parent makes a new component for another basemap or terrain.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const background = getComputedStyle(container).getPropertyValue('--map-video-background').trim() || ROUTE_ONLY_BACKGROUND;
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
      installVideoLayers(map, latest.current.settings);
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
      if (isOwnSource(sourceId)) return;
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
    const { model: current, settings: now, activity: active, units: shown, photoImages: images } = latest.current;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const key = [current, now.overlay, now.summaryCard.enabled, now.terrain, now.basemap.source, active, shown, images, width, height];
    const cached = figuresCache.current;
    const figures =
      cached && cached.key.every((value, i) => value === key[i])
        ? cached.figures
        : createMapVideoFigures({ activity: active, model: current, settings: now, units: shown, width, height, photoImages: images });
    figuresCache.current = { key, figures };
    ctx.clearRect(0, 0, width, height);
    figures.drawFrame(ctx, at);
  }, []);

  /** Draws the moment `at` of the video: the camera, the line, the trail and the marker. */
  const draw = useCallback((at: number) => {
    const map = mapRef.current;
    if (!map) return;
    const { model: current, settings: now, colors: steps } = latest.current;
    const width = containerRef.current?.clientWidth ?? 0;
    drawVideoMap(map, current, now, steps, at, width > 0 ? Math.log2(width / now.output.width) : 0);
    drawFigures(at);
  }, [drawFigures]);


  // A new model or style: the rest of the route, the ends, the paint, and the frame showing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    styleVideoMap(map, activity, model, settings, colors);
    if (latest.current.seconds > length) setSeconds(length);
    draw(Math.min(latest.current.seconds, length));
  }, [activity, model, settings, colors, ready, draw, length]);

  // A preview resized while paused is drawn again at its new size, so its framing (and a keyframe taken from it) stays the video's.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready || typeof ResizeObserver !== 'function') return;
    let width = container.clientWidth;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === width) return;
      width = container.clientWidth;
      draw(latest.current.seconds);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [ready, draw]);

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
