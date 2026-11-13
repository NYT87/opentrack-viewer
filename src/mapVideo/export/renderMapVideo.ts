import { Map as MapLibreMap, addProtocol, removeProtocol, setWorkerUrl } from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Activity } from '../../domain/activity';
import type { UnitSystem } from '../../domain/units';
import type { ExportOutput } from '../../overlay/export/client';
import { OverlayExportError } from '../../overlay/export/errors';
import { createMapVideoFigures, drawAttribution, type PhotoImage } from '../figures';
import type { PersonalFigures } from '../../overlay/template';
import type { MapVideoModel } from '../model';
import type { MapVideoSettings } from '../project';
import { mapVideoAttribution } from '../style';
import { basemapStyleUrl, drawVideoMap, installVideoLayers, isOwnSource, routeOnlyStyle, styleVideoMap, videoMapColors } from '../videoMap';
import type { MapVideoAudio } from './audio';
import { createQueuedTiles } from './queuedTiles';
import { startMapVideoEncode } from './encodeClient';
import type { MapVideoExportPlan } from './plan';

setWorkerUrl(maplibreWorkerUrl);

/**
 * AV-1209. Draws a map video's frames exactly (TD-064, TD-072): a MapLibre map
 * at the video's own size, off the screen, moved one frame at a time, each
 * frame waiting until every tile is in, then copied with the figures, photos
 * and credit drawn over it. Nothing is recorded in real time.
 */

export interface MapVideoRenderInput {
  activity: Activity;
  model: MapVideoModel;
  settings: MapVideoSettings;
  units: UnitSystem;
  maptilerKey: string;
  photoImages?: ReadonlyMap<string, PhotoImage>;
  /** AV-1018. The reader's own figures for a zones component, from the session; they are drawn with, not stored. */
  personal?: PersonalFigures;
}

/** Why the render is waiting, for the panel to say: tiles still coming, or a hidden tab. */
export type RenderWaiting = 'tiles' | 'hidden' | undefined;

/**
 * The largest video built in memory where no file can be written: its
 * estimated size, with room for the encoder's overshoot, well under what a
 * tab can hold (TD-072).
 */
export const MEMORY_VIDEO_LIMIT_BYTES = 400 * 1024 * 1024;

/** Tries at a tile that failed before the export stops. */
export const TILE_RETRIES = 3;
/** The longest a frame may wait for its map while the tab is in front. */
const FRAME_TIMEOUT_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const cancelled = () => new OverlayExportError('cancelled', 'The export was stopped.');

export interface MapVideoRenderer {
  /** How many map requests this render has made so far. */
  requests: () => number;
  /** The frame at `seconds`, drawn and settled, on the render's canvas (valid until the next call). */
  drawFrame: (seconds: number) => Promise<OffscreenCanvas | HTMLCanvasElement>;
  close: () => void;
}

/** An offscreen map moved by its owner, which waits for every tile before it is read (TD-064). */
export interface ExportMap {
  map: MapLibreMap;
  /**
   * Moves the map with `move`, then waits until it is drawn with every tile
   * in. A tile that failed is asked for again, waiting longer each time; then
   * it throws rather than leave a hole.
   */
  settle: (move: () => void) => Promise<void>;
  /** How many map requests this map has made so far. */
  requests: () => number;
  close: () => void;
}

/**
 * A MapLibre map at `width` × `height`, off the screen, every request it makes
 * sent through the export's queue (four at a time, each tile once). Resolves
 * once its style has loaded; `styleUrl` undefined draws route only and asks
 * for nothing.
 */
export async function openExportMap(options: {
  width: number;
  height: number;
  styleUrl: string | undefined;
  /** "a frame", "the image": what is not written with a hole in it. */
  what: string;
  signal?: AbortSignal;
  onWaiting?: (waiting: RenderWaiting) => void;
  /**
   * AV-1023 (TD-092). The picture's pixels to one laid-out pixel: the map is laid out at `width` by `height` and drawn
   * at that times this, so a route inset's map has the labels and the ground of its reference size at any output size.
   */
  pixelRatio?: number;
  /**
   * AV-1023 (TD-092). Where the map starts, so its first draw asks for the tiles of the first frame and not of the
   * world's default view (the whole world's one tile, at the origin of the map).
   */
  camera?: { center: [number, number]; zoom: number; bearing: number };
}): Promise<ExportMap> {
  const { width, height, styleUrl, what, signal, onWaiting, pixelRatio = 1, camera } = options;
  // Laid out at the picture's size, out of sight: WebGL draws it all the same.
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, { position: 'fixed', top: '0', left: `${-(width + 200)}px`, width: `${width}px`, height: `${height}px`, pointerEvents: 'none' });
  document.body.append(container);

  const errors: { sourceId?: string; message: string }[] = [];
  // TD-088: this export's own protocol and cache; another export's requests and tiles are not reached from here.
  const tiles = createQueuedTiles();
  addProtocol(tiles.scheme, tiles.handler);
  const map = new MapLibreMap({
    container,
    style: styleUrl ? tiles.queued(styleUrl).url : routeOnlyStyle(),
    transformRequest: (url) => tiles.queued(url),
    pixelRatio,
    ...(camera ? { center: camera.center, zoom: camera.zoom, bearing: camera.bearing } : {}),
    interactive: false,
    attributionControl: false,
    // TD-064: no fades, which run on the wall clock; the buffer kept, so the frame is read after it settles.
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false },
    centerClampedToGround: true,
  });
  map.on('error', (event) => {
    const sourceId = (event as { sourceId?: string }).sourceId;
    if (isOwnSource(sourceId)) return;
    errors.push({ sourceId, message: event.error?.message ?? 'a request failed' });
  });
  const close = () => {
    map.remove();
    container.remove();
    tiles.forget();
    removeProtocol(tiles.scheme);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      map.once('load', () => resolve());
      const check = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(check);
          reject(cancelled());
        } else if (errors.length > 0 && !map.isStyleLoaded()) {
          clearInterval(check);
          reject(new OverlayExportError('render_failed', `The map could not be loaded (${errors[0]!.message}).`));
        }
      }, 200);
      map.once('load', () => clearInterval(check));
    });
  } catch (error) {
    close();
    throw error;
  }

  /** Waits for `idle`, counting only time with the tab in front; a hidden tab draws nothing (TD-064). */
  const waitIdle = async (idle: Promise<void>) => {
    let resolved = false;
    void idle.then(() => {
      resolved = true;
    });
    let waited = 0;
    while (!resolved) {
      if (signal?.aborted) throw cancelled();
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (hidden) onWaiting?.('hidden');
      else if (waited >= 300) onWaiting?.('tiles');
      await Promise.race([idle, sleep(250)]);
      if (!hidden) waited += 250;
      if (waited > FRAME_TIMEOUT_MS) throw new OverlayExportError('render_failed', `The map did not finish drawing ${what} within two minutes.`);
    }
    onWaiting?.(undefined);
  };
  const nextIdle = () => new Promise<void>((resolve) => map.once('idle', () => resolve()));

  return {
    map,
    close,
    requests: () => tiles.asked(),
    async settle(move) {
      if (signal?.aborted) throw cancelled();
      // Errors are kept from before the first frame too: a map that failed while loading is not drawn as if it had not.
      let idle = nextIdle();
      move();
      await waitIdle(idle);
      for (let attempt = 1; errors.length > 0; attempt += 1) {
        // A sprite, glyph or style that failed belongs to no tile source and cannot be asked for again: stop at once.
        const unfixable = errors.find((error) => !error.sourceId);
        if (unfixable) {
          throw new OverlayExportError(
            'render_failed',
            `Part of the map’s style could not be loaded (${unfixable.message}). The export stopped rather than draw the map without it. Try again, or choose route only.`,
          );
        }
        if (attempt > TILE_RETRIES) {
          throw new OverlayExportError(
            'render_failed',
            `A map tile could not be loaded after ${TILE_RETRIES} tries (${errors[0]!.message}). The export stopped rather than write ${what} with part of the map missing. Try again, or choose route only.`,
          );
        }
        const sources = [...new Set(errors.map((error) => error.sourceId).filter((id): id is string => Boolean(id)))];
        errors.length = 0;
        await sleep(1000 * attempt);
        idle = nextIdle();
        for (const source of sources) map.refreshTiles(source);
        map.triggerRepaint();
        await waitIdle(idle);
      }
    },
  };
}

export async function openMapVideoRenderer(
  input: MapVideoRenderInput,
  options: { signal?: AbortSignal; onWaiting?: (waiting: RenderWaiting) => void } = {},
): Promise<MapVideoRenderer> {
  const { activity, model, settings, units, maptilerKey, photoImages, personal } = input;
  const { width, height } = settings.output;
  const exportMap = await openExportMap({ width, height, styleUrl: basemapStyleUrl(settings, maptilerKey), what: 'a frame', ...options });
  const { map, close } = exportMap;
  installVideoLayers(map, settings);
  const colors = videoMapColors(activity, model, settings);
  styleVideoMap(map, activity, model, settings, colors);

  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) {
    close();
    throw new OverlayExportError('unsupported_browser', 'This browser cannot draw the video’s frames.');
  }
  const figures = createMapVideoFigures({ activity, model, settings, units, width, height, photoImages, personal });
  const credit = mapVideoAttribution(settings);

  return {
    close,
    requests: exportMap.requests,
    async drawFrame(seconds) {
      await exportMap.settle(() => drawVideoMap(map, model, settings, colors, seconds, 0));
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(map.getCanvas(), 0, 0, width, height);
      figures.drawFrame(ctx, seconds);
      if (credit) drawAttribution(ctx, credit, width, height);
      return canvas;
    },
  };
}

export interface MapVideoExportProgress {
  done: number;
  total: number;
  /** Map requests so far: tiles, and the style's own files. */
  requests: number;
  /** Seconds left at the rate so far, once there is a rate. */
  secondsLeft?: number;
  waiting: RenderWaiting;
}

/** Draws every frame and encodes it; resolves with the finished file in the origin-private file system. */
export async function runMapVideoExport(
  input: MapVideoRenderInput,
  plan: MapVideoExportPlan,
  options: { audio?: MapVideoAudio; signal: AbortSignal; onProgress: (progress: MapVideoExportProgress) => void },
): Promise<ExportOutput> {
  const { signal, onProgress, audio } = options;
  const encoder = startMapVideoEncode({
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    bitrate: plan.bitrate,
    format: plan.format,
    allowMemory: plan.estimatedBytes <= MEMORY_VIDEO_LIMIT_BYTES,
    ...(audio ? { audio: { sampleRate: audio.sampleRate, channels: audio.channels } } : {}),
  });
  const stop = () => encoder.cancel();
  signal.addEventListener('abort', stop, { once: true });
  let waiting: RenderWaiting;
  let done = 0;
  const started = performance.now();
  const report = () =>
    onProgress({
      done,
      total: plan.frameCount,
      ...(done > 0 ? { secondsLeft: ((performance.now() - started) / 1000 / done) * (plan.frameCount - done) } : {}),
      requests: renderer?.requests() ?? 0,
      waiting,
    });
  let renderer: MapVideoRenderer | undefined;
  try {
    renderer = await openMapVideoRenderer(input, {
      signal,
      onWaiting: (next) => {
        if (next === waiting) return;
        waiting = next;
        report();
      },
    });
    await encoder.ready;
    report();
    for (let index = 0; index < plan.frameCount; index += 1) {
      if (signal.aborted) throw cancelled();
      const canvas = await renderer.drawFrame(input.model.timeline.frameSeconds(index, plan.frameCount));
      const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / plan.fps), duration: Math.round(1e6 / plan.fps) });
      await encoder.addFrame(frame);
      done = index + 1;
      report();
    }
    return await encoder.finish();
  } catch (error) {
    encoder.cancel();
    throw signal.aborted ? cancelled() : error;
  } finally {
    signal.removeEventListener('abort', stop);
    renderer?.close();
  }
}

/** One frame at the video's size, as a PNG: the poster. */
export async function renderPoster(input: MapVideoRenderInput, seconds: number): Promise<Blob> {
  const renderer = await openMapVideoRenderer(input);
  try {
    const canvas = await renderer.drawFrame(seconds);
    if ('convertToBlob' in canvas) return await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new OverlayExportError('render_failed', 'The still could not be made.'))), 'image/png'),
    );
  } finally {
    renderer.close();
  }
}
