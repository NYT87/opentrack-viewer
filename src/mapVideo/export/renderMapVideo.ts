import { Map as MapLibreMap, addProtocol, setWorkerUrl, type AddProtocolResponseData, type GetResourceResponse } from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Activity } from '../../domain/activity';
import type { UnitSystem } from '../../domain/units';
import type { ExportOutput } from '../../overlay/export/client';
import { OverlayExportError } from '../../overlay/export/errors';
import { createMapVideoFigures, drawAttribution, type PhotoImage } from '../figures';
import type { MapVideoModel } from '../model';
import type { MapVideoSettings } from '../project';
import { mapVideoAttribution } from '../style';
import { basemapStyleUrl, drawVideoMap, installVideoLayers, isOwnSource, routeOnlyStyle, styleVideoMap, videoMapColors } from '../videoMap';
import type { MapVideoAudio } from './audio';
import { startMapVideoEncode } from './encodeClient';
import type { MapVideoExportPlan } from './plan';

setWorkerUrl(maplibreWorkerUrl);

/**
 * The export asks every outside host through this queue, at most four
 * requests at a time: OpenFreeMap's terms allow automated collection only so
 * (TD-064), and no provider is asked faster. The preview, an ordinary map the
 * reader moves, asks as any map does.
 */
const QUEUED = 'map-video-queued';
export const MAX_PARALLEL_REQUESTS = 4;
let running = 0;
const waiting: (() => void)[] = [];
/** Requests the export's map has made, for the panel to show. */
let asked = 0;

type Fetched = GetResourceResponse<AddProtocolResponseData>;

const aborted = () => new DOMException('Aborted', 'AbortError');

/**
 * One request through the queue: it waits for one of the four places, then
 * asks. Aborted while it waits, it leaves the line and asks nothing, so a
 * stopped render leaves nothing behind it to be asked (TD-078).
 */
async function fetchQueued(url: string, type: string | undefined, signal?: AbortSignal): Promise<Fetched> {
  if (signal?.aborted) throw aborted();
  if (running >= MAX_PARALLEL_REQUESTS) {
    await new Promise<void>((go, stop) => {
      const turn = () => {
        signal?.removeEventListener('abort', leave);
        go();
      };
      const leave = () => {
        const place = waiting.indexOf(turn);
        if (place >= 0) waiting.splice(place, 1);
        stop(aborted());
      };
      waiting.push(turn);
      signal?.addEventListener('abort', leave, { once: true });
    });
  }
  running += 1;
  asked += 1;
  try {
    const response = await fetch(url, { signal });
    // With its status, as MapLibre's own requests fail: a 404 tile is then no tile there, not an error.
    if (!response.ok) {
      throw Object.assign(new Error(`${response.status} ${response.statusText || 'error'} for ${new URL(response.url).host}`), { status: response.status, url: response.url });
    }
    const data = type === 'json' ? await response.json() : type === 'string' ? await response.text() : await response.arrayBuffer();
    return { data, cacheControl: response.headers.get('Cache-Control'), expires: response.headers.get('Expires') };
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/**
 * TD-064: tiles are kept in memory for the length of a render, so none is
 * asked for twice. MapLibre asks again for a tile it let go of, and for the
 * same zoom-14 tile once for each zoom it is drawn larger at; a provider's
 * caching headers would spare it those in a browser that keeps its HTTP cache,
 * and this spares it in one that does not. A tile on its way is waited for,
 * not asked again, and given up only when everyone waiting for it has given
 * up (TD-078). Nothing is written anywhere, and all of it is let go when the
 * render ends (`forgetKeptTiles`).
 */
interface KeptTile {
  fetched: Promise<Fetched>;
  /** Stops the fetch: once every requester waiting for it has aborted, or the render has ended. */
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
const kept = new Map<string, KeptTile>();
const keptBytes = new Map<string, number>();
let keptTotal = 0;
/** The most kept at once: past it, the tile used longest ago goes first. */
const MAX_KEPT_BYTES = 256 * 1024 * 1024;

function forgetKeptTiles(): void {
  for (const tile of kept.values()) if (!tile.settled) tile.controller.abort();
  kept.clear();
  keptBytes.clear();
  keptTotal = 0;
}

/** `promise`, unless `signal` aborts first: one requester's abort does not stop a fetch others wait for. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => (signal.removeEventListener('abort', abort), resolve(value)),
      (error: unknown) => (signal.removeEventListener('abort', abort), reject(error)),
    );
  });
}

/** A tile, fetched once, its size counted, and the tiles used longest ago let go past the limit. */
function keepTile(url: string, type: string): KeptTile {
  const controller = new AbortController();
  const tile: KeptTile = { fetched: fetchQueued(url, type, controller.signal), controller, waiters: 0, settled: false };
  tile.fetched.then(
    ({ data }) => {
      tile.settled = true;
      if (kept.get(url) !== tile) return;
      const bytes = (data as ArrayBuffer).byteLength;
      keptBytes.set(url, bytes);
      keptTotal += bytes;
      for (const [oldest] of kept) {
        if (keptTotal <= MAX_KEPT_BYTES) break;
        const size = keptBytes.get(oldest);
        // Not yet in, or the one just in: neither is let go.
        if (size === undefined || oldest === url) continue;
        kept.delete(oldest);
        keptBytes.delete(oldest);
        keptTotal -= size;
      }
    },
    // A failure is not kept: asked again, it is fetched again.
    () => {
      if (kept.get(url) === tile) kept.delete(url);
    },
  );
  return tile;
}

addProtocol(QUEUED, async (params, abort) => {
  const url = `https://${params.url.slice(QUEUED.length + 3)}`;
  // A style or a description of a source is asked once anyway; tiles, vector or raster or terrain, are kept.
  if (params.type !== 'arrayBuffer' && params.type !== 'image') return fetchQueued(url, params.type, abort.signal);
  let tile = kept.get(url);
  if (tile) {
    // Used now: it goes to the back of the line to be let go.
    kept.delete(url);
    kept.set(url, tile);
  } else {
    tile = keepTile(url, params.type);
    kept.set(url, tile);
  }
  tile.waiters += 1;
  try {
    const fetched = await unlessAborted(tile.fetched, abort.signal);
    // A copy each time: MapLibre hands a tile's buffer to its worker, and a buffer handed on is gone.
    return { ...fetched, data: (fetched.data as ArrayBuffer).slice(0) };
  } finally {
    tile.waiters -= 1;
    // Nobody waits for it any more, and it is not in: it is not asked for at all, nor kept half-asked.
    if (tile.waiters === 0 && !tile.settled && abort.signal.aborted) {
      tile.controller.abort();
      if (kept.get(url) === tile) kept.delete(url);
    }
  }
});
/** An outside URL, sent through the queue. */
const queued = (url: string) => (url.startsWith('https://') ? { url: `${QUEUED}://${url.slice('https://'.length)}` } : { url });

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

export async function openMapVideoRenderer(
  input: MapVideoRenderInput,
  options: { signal?: AbortSignal; onWaiting?: (waiting: RenderWaiting) => void } = {},
): Promise<MapVideoRenderer> {
  const { activity, model, settings, units, maptilerKey, photoImages } = input;
  const { width, height } = settings.output;
  const { signal, onWaiting } = options;

  // Laid out at the video's size, out of sight: WebGL draws it all the same.
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, { position: 'fixed', top: '0', left: `${-(width + 200)}px`, width: `${width}px`, height: `${height}px`, pointerEvents: 'none' });
  document.body.append(container);

  const errors: { sourceId?: string; message: string }[] = [];
  const startedAsked = asked;
  forgetKeptTiles();
  const styleUrl = basemapStyleUrl(settings, maptilerKey);
  const map = new MapLibreMap({
    container,
    style: styleUrl ? queued(styleUrl).url : routeOnlyStyle(),
    transformRequest: (url) => queued(url),
    pixelRatio: 1,
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
    forgetKeptTiles();
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
  const figures = createMapVideoFigures({ activity, model, settings, units, width, height, photoImages });
  const credit = mapVideoAttribution(settings);

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
      if (waited > FRAME_TIMEOUT_MS) throw new OverlayExportError('render_failed', 'The map did not finish drawing a frame within two minutes.');
    }
    onWaiting?.(undefined);
  };
  const nextIdle = () => new Promise<void>((resolve) => map.once('idle', () => resolve()));

  return {
    close,
    requests: () => asked - startedAsked,
    async drawFrame(seconds) {
      if (signal?.aborted) throw cancelled();
      // Errors are kept from before the first frame too: a map that failed while loading is not drawn as if it had not.
      let idle = nextIdle();
      drawVideoMap(map, model, settings, colors, seconds, 0);
      await waitIdle(idle);
      // A tile that failed is asked for again, waiting longer each time; then the export stops rather than write a hole.
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
            `A map tile could not be loaded after ${TILE_RETRIES} tries (${errors[0]!.message}). The export stopped rather than write a frame with part of the map missing. Try again, or choose route only.`,
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
