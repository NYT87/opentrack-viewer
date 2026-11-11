import { Map as MapLibreMap, addProtocol, setWorkerUrl } from 'maplibre-gl';
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
addProtocol(QUEUED, async (params, abort) => {
  if (running >= MAX_PARALLEL_REQUESTS) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  asked += 1;
  try {
    const response = await fetch(`https://${params.url.slice(QUEUED.length + 3)}`, { signal: abort.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'error'} for ${new URL(response.url).host}`);
    const data = params.type === 'json' ? await response.json() : params.type === 'string' ? await response.text() : await response.arrayBuffer();
    return { data, cacheControl: response.headers.get('Cache-Control'), expires: response.headers.get('Expires') };
  } finally {
    running -= 1;
    waiting.shift()?.();
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
