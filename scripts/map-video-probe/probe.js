// AV-1201 map video probe. `?run=<config>` renders one configuration frame by
// frame and leaves its measurements in window.__result; `?run=caps` reports
// what the engine can do. The runner opens a fresh page per configuration.
import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import * as mb from '/vendor/mediabunny.mjs';

const params = new URLSearchParams(location.search);
const logEl = document.getElementById('log');
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); logEl.textContent = s; console.log(s); };
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Configurations --------------------------------------------------------

const LOCAL = 'local', OFM = 'openfreemap';
// Frames are copied through a 2D canvas before they become a VideoFrame:
// WebKit's page crashes after about 130 frames taken straight from WebGL.
const base = { tiles: LOCAL, lag: 0, w: 1920, h: 1080, fps: 30, seconds: 10, pitch: 0, terrain: false, codec: 'avc', settle: 'idle', fade: false, hash: true, frameFrom: 'copy2d' };
const D3 = { pitch: 55, terrain: true };
const CONFIGS = {
  '2d': { ...base },
  '2d-lag': { ...base, lag: 600 },
  '2d-lag-fade': { ...base, lag: 600, fade: true },
  '2d-redraw': { ...base, lag: 600, settle: 'redraw' },
  '2d-cold': { ...base, recheck: true, cold: 600 },
  '3d': { ...base, ...D3 },
  '3d-again': { ...base, ...D3 },
  '3d-lag': { ...base, ...D3, lag: 600 },
  '3d-clamped-cold': { ...base, ...D3, recheck: true, cold: 600 },
  '3d-pure': { ...base, ...D3, elev: 'pure' },
  '3d-pure-cold': { ...base, ...D3, elev: 'pure', recheck: true, cold: 600 },
  '2d-vp9': { ...base, codec: 'vp9' },
  '3d-4k': { ...base, ...D3, elev: 'pure', w: 3840, h: 2160, seconds: 4 },
  '2d-export': { ...base, hash: false, seconds: 20 },
  '3d-export': { ...base, ...D3, elev: 'pure', hash: false, seconds: 20 },
  '2d-webgl-frame': { ...base, hash: false, frameFrom: 'webgl' },
  '2d-noenc': { ...base, hash: false, encode: false },
  '2d-webgl-frame-hash': { ...base, frameFrom: 'webgl' },
  '2d-webgl-noenc': { ...base, hash: false, frameFrom: 'webgl', encode: false },
  '2d-bitmap': { ...base, hash: false, frameFrom: 'bitmap' },
  // One tile in seven answers 500: does 'idle' wait, or settle with a hole?
  '2d-fail': { ...base, fail: 7, allowErrors: true },
  '2d-60': { ...base, hash: false, seconds: 60 },
  '3d-60': { ...base, ...D3, elev: 'pure', hash: false, seconds: 60 },
  // Live: OpenFreeMap's liberty style, and AWS Terrain Tiles for 3D. The
  // route's synthetic hills are not the Alps, so 3D keeps the ground clamp.
  'live-2d': { ...base, tiles: OFM, pitch: 45 },
  'live-2d-again': { ...base, tiles: OFM, pitch: 45 },
  'live-3d': { ...base, tiles: OFM, ...D3 },
};

// --- A synthetic ride: a 25 km loop with wiggles and GPS noise ---------------

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R_EARTH = 6371008.8, rad = Math.PI / 180;
function synthRoute() {
  const rnd = mulberry32(42), N = 5000, lon0 = 6.87, lat0 = 45.92, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 * Math.PI;
    const r = 0.03 * (1 + 0.3 * Math.sin(3 * t) + 0.12 * Math.sin(11 * t));
    pts.push([lon0 + (r * Math.cos(t)) / Math.cos(lat0 * rad) + (rnd() - 0.5) * 4e-5, lat0 + r * Math.sin(t) * 0.8 + (rnd() - 0.5) * 3e-5]);
  }
  return pts;
}
function haversine(a, b) {
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
const ROUTE = synthRoute();
const CUM = ROUTE.reduce((acc, p, i) => { acc.push(i ? acc[i - 1] + haversine(ROUTE[i - 1], p) : 0); return acc; }, []);
const TOTAL = CUM[CUM.length - 1];
function indexAt(d) { let lo = 0, hi = CUM.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (CUM[m] <= d) lo = m; else hi = m; } return lo; }
function pointAt(d) {
  d = Math.max(0, Math.min(TOTAL, d)); const i = indexAt(d); const j = Math.min(i + 1, ROUTE.length - 1);
  const f = CUM[j] > CUM[i] ? (d - CUM[i]) / (CUM[j] - CUM[i]) : 0;
  return { i, p: [ROUTE[i][0] + (ROUTE[j][0] - ROUTE[i][0]) * f, ROUTE[i][1] + (ROUTE[j][1] - ROUTE[i][1]) * f] };
}
function bearing(a, b) {
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return Math.atan2(y, x);
}
/** Heading averaged as unit vectors over ±400 m, so noise and hairpins do not spin it. */
function smoothBearing(d) {
  let sx = 0, sy = 0;
  for (let k = -400; k <= 400; k += 50) { const b = bearing(pointAt(d + k - 100).p, pointAt(d + k + 100).p); sx += Math.cos(b); sy += Math.sin(b); }
  return (Math.atan2(sy, sx) / rad + 360) % 360;
}
// The server's hills, standing in for the elevation an activity records: the
// camera's centre height comes from the route, never from loaded tiles.
const hills = ([lon, lat]) => 1200 + 700 * Math.sin(lon * 90) * Math.cos(lat * 70) + 250 * Math.sin(lon * 310 + lat * 170);
const EXAGGERATION = 1.5;
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const lerpAngle = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return a + d * t; };

// --- Rendering --------------------------------------------------------------

function styleFor(cfg, overStyle) {
  const q = new URLSearchParams();
  if (cfg.lag) q.set('lag', cfg.lag);
  if (cfg.fail) q.set('fail', cfg.fail);
  const lag = q.size ? `?${q}` : '';
  const origin = location.origin;
  const style = overStyle ?? {
    version: 8,
    sources: { base: { type: 'raster', tiles: [`${origin}/tiles/raster/{z}/{x}/{y}.png${lag}`], tileSize: 256, maxzoom: 17 } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
  if (cfg.terrain) {
    style.sources.dem = cfg.tiles === LOCAL
      ? { type: 'raster-dem', encoding: 'terrarium', tiles: [`${origin}/tiles/dem/{z}/{x}/{y}.png${lag}`], tileSize: 256, maxzoom: 12 }
      : { type: 'raster-dem', encoding: 'terrarium', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 14 };
    style.terrain = { source: 'dem', exaggeration: EXAGGERATION };
  }
  style.sources.route = { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ROUTE } } };
  style.sources.reveal = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  style.sources.marker = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  style.layers.push(
    { id: 'route-rest', type: 'line', source: 'route', paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 4 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
    { id: 'reveal-casing', type: 'line', source: 'reveal', paint: { 'line-color': '#1a1a1a', 'line-width': 9 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
    { id: 'reveal', type: 'line', source: 'reveal', paint: { 'line-color': '#ff5533', 'line-width': 6 }, layout: { 'line-join': 'round', 'line-cap': 'round' } },
    { id: 'marker', type: 'circle', source: 'marker', paint: { 'circle-radius': 11, 'circle-color': '#ff5533', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 4, 'circle-pitch-alignment': 'map' } },
  );
  if (!cfg.fade) for (const l of style.layers) if (l.type === 'raster') l.paint = { ...l.paint, 'raster-fade-duration': 0 };
  return style;
}

const once = (map, ev) => new Promise((r) => map.once(ev, r));
function withTimeout(p, ms, what) { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); }
const ready = (map) => map.loaded() && map.areTilesLoaded() && (!map.terrain || map.style.sourceCaches?.dem?.loaded?.() !== false);

/** Renders without the animation loop: redraw, wait for data, redraw, until nothing is loading. */
async function settleByRedraw(map) {
  map.redraw();
  for (let k = 0; k < 5000; k++) {
    if (ready(map)) { map.redraw(); if (ready(map)) return k; }
    await Promise.race([once(map, 'data'), sleep(25)]);
    map.redraw();
  }
  throw new Error('redraw settle never finished');
}

function percentiles(xs) {
  const s = [...xs].sort((a, b) => a - b); const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), sum: Math.round(s.reduce((a, b) => a + b, 0)) };
}
function fnv(u32) { let h = 0x811c9dc5; for (let i = 0; i < u32.length; i++) h = Math.imul(h ^ u32[i], 16777619); return (h >>> 0).toString(16).padStart(8, '0'); }
async function sha256(buf) { const d = await crypto.subtle.digest('SHA-256', buf); return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join(''); }

async function render(name, cfg) {
  const out = { name, cfg, ua: navigator.userAgent, route: { points: ROUTE.length, km: +(TOTAL / 1000).toFixed(2) } };
  const el = document.getElementById('map');
  el.style.width = `${cfg.w}px`; el.style.height = `${cfg.h}px`;

  const requests = { total: 0, byType: {}, unique: new Set() };
  // Every map error, and the frames that settled with one: 'idle' counts a
  // failed tile as settled, so a frame can be complete-looking with a hole.
  const mapErrors = [], framesWithErrors = [];
  let overStyle;
  // Counted here, since this fetch does not pass through transformRequest.
  if (cfg.tiles === OFM) { requests.total++; requests.byType.Style = 1; requests.unique.add('liberty'); }
  if (cfg.tiles === OFM) overStyle = await (await fetch('https://tiles.openfreemap.org/styles/liberty', { cache: 'no-store' })).json();
  await fetch('/stats?reset');

  const preserve = cfg.settle !== 'redraw';
  const makeMap = async (lag) => {
    const m = new maplibregl.Map({
    container: el, style: styleFor({ ...cfg, lag }, overStyle), pixelRatio: 1, interactive: false, attributionControl: false,
    fadeDuration: cfg.fade ? 300 : 0,
    centerClampedToGround: cfg.elev !== 'pure',
    canvasContextAttributes: { preserveDrawingBuffer: preserve, antialias: false },
    center: ROUTE[0], zoom: 12, maxTileCacheSize: 400,
    transformRequest: (url, type) => {
      requests.total++; requests.byType[type] = (requests.byType[type] ?? 0) + 1; requests.unique.add(url);
      return { url, cache: 'no-store' };
    },
    });
    m.on('error', (e) => { mapErrors.push(String(e?.error?.message ?? e?.error ?? e).slice(0, 120)); });
    await withTimeout(once(m, 'load'), 60000, 'style load');
    return m;
  };
  let map = await makeMap(cfg.lag);
  let canvas = map.getCanvas();
  out.canvas = { w: canvas.width, h: canvas.height };

  // The camera plan: a 1.5 s intro from the overview, the follow, a 1.5 s outro.
  const F = cfg.seconds * cfg.fps, intro = Math.round(1.5 * cfg.fps), outro = Math.round(1.5 * cfg.fps);
  const lons = ROUTE.map((p) => p[0]), lats = ROUTE.map((p) => p[1]);
  const bounds = [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  const over = map.cameraForBounds(bounds, { padding: Math.round(cfg.h * 0.08) });
  const pure = cfg.elev === 'pure';
  const overview = { center: [over.center.lng, over.center.lat], zoom: over.zoom, bearing: 0, pitch: 0 };
  if (pure) overview.elevation = hills(overview.center) * EXAGGERATION;
  const followZoom = 14.6;
  const follow = (d) => { const { p } = pointAt(d); const cam = { center: p, zoom: followZoom, bearing: smoothBearing(d), pitch: cfg.pitch }; if (pure) cam.elevation = hills(p) * EXAGGERATION; return cam; };
  const blend = (a, b, t) => {
    const cam = { center: [lerp(a.center[0], b.center[0], t), lerp(a.center[1], b.center[1], t)], zoom: lerp(a.zoom, b.zoom, t), bearing: lerpAngle(a.bearing, b.bearing, t), pitch: lerp(a.pitch, b.pitch, t) };
    if (pure) cam.elevation = lerp(a.elevation, b.elevation, t);
    return cam;
  };
  const plan = (f) => {
    const mid = F - intro - outro;
    if (f < intro) return { d: 0, cam: blend(overview, follow(0), ease(f / intro)) };
    if (f >= F - outro) return { d: TOTAL, cam: blend(follow(TOTAL), overview, ease((f - (F - outro)) / outro)) };
    const d = ((f - intro) / (mid - 1)) * TOTAL;
    return { d, cam: follow(d) };
  };

  // Encoder.
  const bitrate = Math.round(cfg.w * cfg.h * cfg.fps * 0.16);
  out.bitrate = bitrate;
  out.canEncode = await mb.canEncodeVideo(cfg.codec, { width: cfg.w, height: cfg.h, bitrate });
  if (!out.canEncode) { out.error = `cannot encode ${cfg.codec} at ${cfg.w}x${cfg.h}`; map.remove(); return out; }
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: cfg.codec === 'avc' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat(), target });
  const source = new mb.VideoSampleSource({ codec: cfg.codec, bitrate, keyFrameInterval: 2, latencyMode: 'quality' });
  output.addVideoTrack(source, { frameRate: cfg.fps });
  await output.start();

  const copyCanvas = cfg.frameFrom === 'copy2d' ? new OffscreenCanvas(cfg.w, cfg.h) : null;
  const copyCtx = copyCanvas?.getContext('2d');
  const hashCanvas = cfg.hash ? Object.assign(document.createElement('canvas'), { width: cfg.w, height: cfg.h }) : null;
  const hctx = hashCanvas?.getContext('2d', { willReadFrequently: true });
  const times = { settle: [], capture: [], encode: [], frame: [] }, hashes = [];
  const heap = []; const redrawPasses = [];
  const RECHECK = cfg.recheck ? Array.from({ length: Math.ceil(F / 15) }, (_, k) => k * 15) : [];
  const kept = new Map();
  async function drawFrame(f) {
    const errorsBefore = mapErrors.length;
    const { d, cam } = plan(f);
    const { i, p } = pointAt(d);
    map.getSource('reveal').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...ROUTE.slice(0, i + 1), p] } });
    map.getSource('marker').setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
    if (cfg.settle === 'idle') {
      const idle = once(map, 'idle');
      map.jumpTo(cam);
      await withTimeout(idle, 120000, `frame ${f} idle`);
    } else {
      map.jumpTo(cam);
      redrawPasses.push(await withTimeout(settleByRedraw(map), 120000, `frame ${f} redraw`));
    }
    if (mapErrors.length > errorsBefore) {
      framesWithErrors.push(f);
      if (!cfg.allowErrors) throw new Error(`frame ${f} settled with a failed request: ${mapErrors.at(-1)}`);
    }
  }
  const t0 = now();
  for (let f = 0; f < F; f++) {
    const tf = now();
    await drawFrame(f);
    const ts = now(); times.settle.push(ts - tf);
    // Captured in the same task as the last draw, which is what lets the
    // redraw path work without preserveDrawingBuffer.
    const stamp = { timestamp: Math.round((f * 1e6) / cfg.fps), duration: Math.round(1e6 / cfg.fps) };
    let frame;
    if (cfg.frameFrom === 'copy2d') { copyCtx.drawImage(canvas, 0, 0); frame = new VideoFrame(copyCanvas, stamp); }
    else if (cfg.frameFrom === 'bitmap') { const bmp = await createImageBitmap(canvas); frame = new VideoFrame(bmp, stamp); bmp.close(); }
    else frame = new VideoFrame(canvas, stamp); // 'webgl'
    if (hctx) {
      hctx.drawImage(canvas, 0, 0);
      const img = hctx.getImageData(0, 0, cfg.w, cfg.h);
      hashes.push(fnv(new Uint32Array(img.data.buffer)));
      if (RECHECK.includes(f)) kept.set(f, img.data);
    }
    const tc = now(); times.capture.push(tc - ts);
    if (cfg.encode !== false) {
      const sample = new mb.VideoSample(frame);
      await source.add(sample);
      sample.close();
    }
    frame.close();
    const te = now(); times.encode.push(te - tc); times.frame.push(te - tf);
    if (f % 30 === 0) { heap.push(performance.memory?.usedJSHeapSize ?? null); log(`${name} frame ${f}/${F} settle ${(ts - tf).toFixed(0)}ms`); }
  }
  await output.finalize();
  out.totalMs = Math.round(now() - t0);
  out.frames = F;
  out.fpsRendered = +((F * 1000) / out.totalMs).toFixed(1);
  out.realtimeFactor = +((cfg.seconds * 1000) / out.totalMs).toFixed(2);
  out.times = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, percentiles(v)]));
  if (redrawPasses.length) out.redrawPasses = percentiles(redrawPasses);
  out.hashes = hashes;
  // Draw the kept frames again, out of order, and compare pixel by pixel.
  if (RECHECK.length) {
    out.recheck = {};
    // With `cold`, each kept frame is drawn on a fresh map with that tile
    // delay: no tile, placement or terrain history, and different timing.
    // Without it, the same map draws them again in reverse order.
    for (const f of cfg.cold != null ? RECHECK : [...RECHECK].reverse()) {
      if (cfg.cold != null) { map.remove(); map = await makeMap(cfg.cold); canvas = map.getCanvas(); }
      await drawFrame(f);
      hctx.drawImage(canvas, 0, 0);
      const a = kept.get(f), b = hctx.getImageData(0, 0, cfg.w, cfg.h).data;
      let n = 0, maxd = 0, x0 = cfg.w, y0 = cfg.h, x1 = -1, y1 = -1;
      for (let k = 0; k < a.length; k += 4) {
        const dd = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
        if (dd) { n++; maxd = Math.max(maxd, dd); const px = (k / 4) % cfg.w, py = Math.floor(k / 4 / cfg.w); x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
      }
      out.recheck[f] = { pixels: n, share: +(n / (cfg.w * cfg.h)).toFixed(5), maxDelta: maxd, box: n ? [x0, y0, x1, y1] : null };
    }
  }
  out.outputBytes = target.buffer.byteLength;
  out.outputSha = await sha256(target.buffer);
  out.mapErrors = { count: mapErrors.length, first: mapErrors.slice(0, 3), framesWithErrors: framesWithErrors.length };
  out.requests = { total: requests.total, unique: requests.unique.size, byType: requests.byType };
  out.server = await (await fetch('/stats')).json();
  const res = performance.getEntriesByType('resource').filter((e) => !e.name.includes('/vendor/') && !e.name.includes('/stats'));
  out.transfer = { entries: res.length, transferBytes: res.reduce((a, e) => a + (e.transferSize || 0), 0), bodyBytes: res.reduce((a, e) => a + (e.encodedBodySize || 0), 0) };
  out.heapMB = heap.filter((x) => x != null).map((x) => Math.round(x / 1048576));
  map.remove();
  return out;
}

async function caps() {
  const out = { ua: navigator.userAgent, features: {}, encode: {} };
  const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
  out.features.webgl2 = !!gl;
  if (gl) {
    out.features.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    out.features.maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    out.features.maxViewportDims = [...gl.getParameter(gl.MAX_VIEWPORT_DIMS)];
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.features.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }
  out.features.videoEncoder = 'VideoEncoder' in self;
  out.features.videoFrame = 'VideoFrame' in self;
  out.features.offscreenCanvas = 'OffscreenCanvas' in self;
  out.features.offscreenWebgl2 = (() => { try { return !!new OffscreenCanvas(8, 8).getContext('webgl2'); } catch { return false; } })();
  out.features.crossOriginIsolated = self.crossOriginIsolated;
  out.features.opfs = !!navigator.storage?.getDirectory;
  out.features.performanceMemory = !!performance.memory;
  for (const [codec, w, h] of [['avc', 1920, 1080], ['avc', 1080, 1920], ['avc', 3840, 2160], ['vp9', 1920, 1080], ['vp9', 3840, 2160], ['hevc', 1920, 1080], ['av1', 1920, 1080]]) {
    try { out.encode[`${codec} ${w}x${h}`] = await mb.canEncodeVideo(codec, { width: w, height: h, bitrate: 1e7 }); } catch (e) { out.encode[`${codec} ${w}x${h}`] = `error: ${e.message}`; }
  }
  return out;
}

(async () => {
  const run = params.get('run') ?? 'caps';
  try {
    window.__result = run === 'caps' ? await caps() : await render(run, CONFIGS[run]);
  } catch (e) {
    window.__result = { name: run, error: String(e && e.stack ? e.stack : e) };
  }
  log('DONE', run);
  window.__done = true;
})();
