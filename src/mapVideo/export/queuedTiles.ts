import type { AddProtocolResponseData, GetResourceResponse } from 'maplibre-gl';

/**
 * The export asks every outside host through this queue, at most four
 * requests at a time: OpenFreeMap's terms allow automated collection only so
 * (TD-064), and no provider is asked faster. The preview, an ordinary map the
 * reader moves, asks as any map does. The queue is shared by every export
 * map, so two at once still ask four at a time between them; what is kept is
 * not shared (TD-088).
 */
export const MAX_PARALLEL_REQUESTS = 4;
let running = 0;
const waiting: (() => void)[] = [];

type Fetched = GetResourceResponse<AddProtocolResponseData>;

const aborted = () => new DOMException('Aborted', 'AbortError');

/**
 * One request through the queue: it waits for one of the four places, then
 * asks. Aborted while it waits, it leaves the line and asks nothing, so a
 * stopped render leaves nothing behind it to be asked (TD-078).
 */
async function fetchQueued(url: string, type: string | undefined, signal: AbortSignal | undefined, onAsked: () => void): Promise<Fetched> {
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
  onAsked();
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
 * render ends (`forget`).
 *
 * TD-088. One cache to each export map, with its own protocol, so closing one
 * export lets go of its tiles and aborts its pending fetches and no other's.
 */
interface KeptTile {
  fetched: Promise<Fetched>;
  /** Stops the fetch: once every requester waiting for it has aborted, or the render has ended. */
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

/** The most kept at once: past it, the tile used longest ago goes first. */
const MAX_KEPT_BYTES = 256 * 1024 * 1024;

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

export interface QueuedTiles {
  /** The scheme this export map's requests go out under; register `handler` for it. */
  scheme: string;
  handler: (params: { url: string; type?: string }, abort: AbortController) => Promise<Fetched>;
  /** An outside URL, sent through this cache's queue. */
  queued: (url: string) => { url: string };
  /** How many requests this cache has put to the network. */
  asked: () => number;
  /** Aborts what is still on its way and lets go of what is kept. */
  forget: () => void;
}

let schemes = 0;

export function createQueuedTiles(): QueuedTiles {
  schemes += 1;
  const scheme = `map-video-queued-${schemes}`;
  const kept = new Map<string, KeptTile>();
  const keptBytes = new Map<string, number>();
  let keptTotal = 0;
  let asked = 0;
  const onAsked = () => {
    asked += 1;
  };

  /** A tile, fetched once, its size counted, and the tiles used longest ago let go past the limit. */
  const keepTile = (url: string, type: string): KeptTile => {
    const controller = new AbortController();
    const tile: KeptTile = { fetched: fetchQueued(url, type, controller.signal, onAsked), controller, waiters: 0, settled: false };
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
  };

  return {
    scheme,
    asked: () => asked,
    queued: (url) => (url.startsWith('https://') ? { url: `${scheme}://${url.slice('https://'.length)}` } : { url }),
    forget() {
      for (const tile of kept.values()) if (!tile.settled) tile.controller.abort();
      kept.clear();
      keptBytes.clear();
      keptTotal = 0;
    },
    async handler(params, abort) {
      const url = `https://${params.url.slice(scheme.length + 3)}`;
      // A style or a description of a source is asked once anyway; tiles, vector or raster or terrain, are kept.
      if (params.type !== 'arrayBuffer' && params.type !== 'image') return fetchQueued(url, params.type, abort.signal, onAsked);
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
    },
  };
}
