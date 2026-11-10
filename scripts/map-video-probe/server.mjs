// Serves the map video probe page, MapLibre and Mediabunny from node_modules,
// and generated tiles: a textured raster basemap and Terrarium elevation tiles,
// made per request so nothing is committed and no live provider is needed.
// `?lag=<ms>` on a tile URL delays it by a random 0..ms, seeded by the tile, so
// the slow-network run is itself repeatable; `?fail=<n>` fails one tile in n. Port 8091: WebKit refuses 4190.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, '..', '..');
const port = Number(process.argv[2] ?? process.env.PROBE_PORT ?? 8091);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.map': 'application/json' };

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** An RGB PNG from a pixel function. */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = (a, b, c) => {
  let h = 2166136261 ^ a;
  h = Math.imul(h ^ b, 16777619); h = Math.imul(h ^ c, 16777619);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
};
/** World position of a tile pixel, in Web Mercator units 0..1. */
const world = (z, x, y, px, py) => [(x + px / 256) / 2 ** z, (y + py / 256) / 2 ** z];
const lonOf = (mx) => mx * 360 - 180;
const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

// Hills: smooth bumps in metres, a function of longitude and latitude only, so
// every zoom agrees.
function elevation(lon, lat) {
  return 1200 + 700 * Math.sin(lon * 90) * Math.cos(lat * 70) + 250 * Math.sin(lon * 310 + lat * 170);
}

function rasterTile(z, x, y) {
  const base = hash(z, x, y);
  return png(256, (px, py) => {
    const [mx, my] = world(z, x, y, px, py);
    const lon = lonOf(mx), lat = latOf(my);
    const e = elevation(lon, lat);
    // Fields shaded by height, a fine noise grain, and a coloured grid every
    // 1/512 of the world so motion is visible at every zoom.
    const shade = 90 + ((e - 500) / 1400) * 110;
    const grain = (hash(base, px, py) & 31) - 16;
    const gx = (mx * 4096) % 1, gy = (my * 4096) % 1;
    const line = gx < 0.02 || gy < 0.02;
    if (line) return [230, 200, 80];
    const field = hash(Math.floor(mx * 16384), Math.floor(my * 16384), 7) % 3;
    return [clamp(shade * (field === 0 ? 0.7 : 0.55) + grain), clamp(shade + grain), clamp(shade * (field === 2 ? 0.9 : 0.5) + grain)];
  });
}
function demTile(z, x, y) {
  return png(256, (px, py) => {
    const [mx, my] = world(z, x, y, px + 0.5, py + 0.5);
    const v = elevation(lonOf(mx), latOf(my)) + 32768;
    return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)];
  });
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

const cache = new Map();
let stats = { raster: 0, dem: 0, bytes: 0 };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const tile = /^\/tiles\/(raster|dem)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
  if (tile) {
    const [, kind, z, x, y] = tile.map((v, i) => (i > 1 ? Number(v) : v));
    const key = `${kind}/${z}/${x}/${y}`;
    let body = cache.get(key);
    if (!body) { body = kind === 'raster' ? rasterTile(z, x, y) : demTile(z, x, y); cache.set(key, body); }
    stats[kind]++; stats.bytes += body.length;
    const fail = Number(url.searchParams.get('fail') ?? 0);
    if (fail && hash(z, x, y) % fail === 0) { res.writeHead(500, { 'access-control-allow-origin': '*' }); res.end(); return; }
    const lag = Number(url.searchParams.get('lag') ?? 0);
    const delay = lag ? hash(z, x, y + (kind === 'dem' ? 99991 : 0)) % lag : 0;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(body);
    }, delay);
    return;
  }
  if (url.pathname === '/stats') {
    const body = JSON.stringify(stats);
    if (url.searchParams.has('reset')) stats = { raster: 0, dem: 0, bytes: 0 };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  let file;
  if (url.pathname === '/') file = join(here, 'index.html');
  else if (url.pathname.startsWith('/vendor/maplibre/')) file = join(project, 'node_modules/maplibre-gl/dist', url.pathname.slice('/vendor/maplibre/'.length));
  else if (url.pathname === '/vendor/mediabunny.mjs') file = join(project, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs');
  else file = join(here, url.pathname.replace(/^\//, ''));
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`map video probe on http://localhost:${port}/`));
