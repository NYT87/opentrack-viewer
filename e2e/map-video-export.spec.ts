import { expect, test, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMp4 } from './helpers/mp4';
import { countPixelsNear, decodePng, solidPng, withExif, type DecodedPng } from './helpers/png';
import { tiffBlock } from '../src/test/helpers/exifFixture';
import { longRideGpx } from './helpers/overlayFixtures';
import { TILE_RGB, forbidLiveProviders, serveFixtureTiles, serveVectorFixture } from './helpers/mapVideoTiles';

/**
 * AV-1209. The map video made into a file, in a real browser with its own
 * encoders (the full Chromium, as the burned-in render's tests use, TD-045):
 * MP4 and WebM, the poster, the reader's sound, a stop that keeps nothing,
 * and a failed map tile that stops the export rather than leave a hole.
 * Route only and stubbed tiles: no live provider is asked.
 */

const ORIGIN = 'http://localhost:4173';
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');
test.use({ serviceWorkers: 'block' });

// AV-1210: no live map provider is ever asked. OpenFreeMap is answered with fixture tiles unless a test
// answers it itself, and any other request leaving the page is stopped, and fails the test.
let live: string[] = [];
test.beforeEach(async ({ page }) => {
  live = await forbidLiveProviders(page);
  await serveFixtureTiles(page);
});
test.afterEach(() => expect(live, 'a request reached past the page to a live provider').toEqual([]));

/** A short, small video of the formula ride on route only: 5 s at 640 × 360, 150 frames. */
async function openSmall(page: Page) {
  // The page opens on the online map until route only is chosen: OpenFreeMap is answered here, never asked.
  await page.route('https://tiles.openfreemap.org/styles/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#2d4030' } }] }) }),
  );
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'overlay-ride.gpx'));
  await page.getByRole('radio', { name: /^Route only/ }).check();
  const video = page.getByRole('region', { name: 'Video settings' });
  await video.getByRole('combobox', { name: 'Size' }).selectOption('Custom');
  await video.getByRole('spinbutton', { name: 'Width', exact: true }).fill('640');
  await video.getByRole('spinbutton', { name: 'Height', exact: true }).fill('360');
  await video.getByRole('spinbutton', { name: 'Length', exact: true }).fill('5');
  await video.getByRole('checkbox', { name: 'Fly in from the whole route' }).uncheck();
  await video.getByRole('checkbox', { name: 'Pull back to the whole route' }).uncheck();
  const panel = page.getByRole('region', { name: 'Make the video' });
  await expect(panel.getByRole('combobox', { name: 'Format' }).or(panel.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot encode here: ${refusal.join(' ')}`);
  return panel;
}

async function fetchBytes(page: Page, href: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, href);
  return Buffer.from(base64, 'base64');
}

/** The export files the page holds in its origin-private file system. */
const storedExports = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.filter((name) => name.startsWith('overlay-export-'));
  });

/** Ten seconds of a 440 Hz tone, as a 16-bit mono WAV: the reader's own sound. */
function toneWav(seconds: number, rate = 44_100): Buffer {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12_000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

test('makes an MP4 of every frame, with the reader\'s sound, named for the activity, uploading nothing', async ({ page }) => {
  test.setTimeout(180_000);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await openSmall(page);
  await expect(panel).toContainText('150 frames at 640 × 360, 30 a second');
  await expect(panel).toContainText('overlay-ride-map-video-640x360.mp4');
  await panel.getByTestId('map-video-audio-input').setInputFiles({ name: 'tune.wav', mimeType: 'audio/wav', buffer: toneWav(10) });

  await panel.getByRole('button', { name: 'Make the video' }).click();
  const link = panel.getByRole('link', { name: /overlay-ride-map-video-640x360\.mp4/ });
  await expect(link).toBeVisible({ timeout: 150_000 });
  await expect(link).toHaveAttribute('download', 'overlay-ride-map-video-640x360.mp4');
  await expect(panel).toContainText('The sound runs longer than the video, so it is cut at 0:05.0 and fades out.');

  const made = await readMp4(await fetchBytes(page, (await link.getAttribute('href'))!));
  const video = made.tracks.find((track) => track.type === 'video')!;
  const audio = made.tracks.find((track) => track.type === 'audio');
  expect(video.codec).toMatch(/^avc1/);
  expect([video.width, video.height]).toEqual([640, 360]);
  expect(video.sampleCount).toBe(150);
  expect(Math.abs(video.durationSeconds - 5)).toBeLessThan(0.1);
  expect(audio, 'the sound was encoded with the video').toBeDefined();
  expect(Math.abs(audio!.durationSeconds - 5)).toBeLessThan(0.2);
  // The file lives in the origin-private file system until it is discarded.
  expect(await storedExports(page)).toHaveLength(1);
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => storedExports(page)).toEqual([]);

  // Only the stubbed style, asked before route only was chosen, ever leaves the page; and nothing is sent.
  const outside = requests.map((request) => request.url()).filter((url) => !/^(blob:|data:)/.test(url) && !url.startsWith(ORIGIN));
  expect(outside.filter((url) => !url.startsWith('https://tiles.openfreemap.org/styles/'))).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET').map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
});

test('makes a WebM where it is chosen', async ({ page }) => {
  test.setTimeout(180_000);
  const panel = await openSmall(page);
  const format = panel.getByRole('combobox', { name: 'Format' });
  test.skip((await format.locator('option[value="webm"]').isDisabled()), 'This browser cannot encode VP9 here.');
  await format.selectOption('webm');
  await panel.getByRole('button', { name: 'Make the video' }).click();
  const link = panel.getByRole('link', { name: /overlay-ride-map-video-640x360\.webm/ });
  await expect(link).toBeVisible({ timeout: 150_000 });
  const bytes = await fetchBytes(page, (await link.getAttribute('href'))!);
  // An EBML document: the WebM's first four bytes.
  expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  expect(bytes.length).toBeGreaterThan(5_000);
});

test('stops on request, and keeps nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const panel = await openSmall(page);
  await page.getByRole('region', { name: 'Video settings' }).getByRole('spinbutton', { name: 'Length', exact: true }).fill('60');
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('progressbar', { name: 'Video progress' })).toBeVisible();
  await expect.poll(async () => Number(await panel.getByRole('progressbar', { name: 'Video progress' }).getAttribute('value')), { timeout: 60_000 }).toBeGreaterThan(10);
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(panel).toContainText('Stopped. Nothing was kept.');
  await expect.poll(() => storedExports(page), { timeout: 10_000 }).toEqual([]);
  await expect(panel.getByRole('link', { name: /\.mp4/ })).toHaveCount(0);
});

test('saves a still of the moment showing, at the video\'s size', async ({ page }) => {
  test.setTimeout(120_000);
  const panel = await openSmall(page);
  await page.getByRole('slider', { name: 'Position in the video' }).fill('2.5');
  const saved = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save a still of 0:02.5 (PNG)' }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe('overlay-ride-map-video-poster-0m2_5s.png');
  const png = decodePng(await import('node:fs').then(({ readFileSync }) => download.path().then((path) => readFileSync(path))));
  expect([png.width, png.height]).toEqual([640, 360]);
  // The route's colour is in it, around the marker at the middle of the frame.
  expect(countPixelsNear(png, [0xff, 0x55, 0x33], 30)).toBeGreaterThan(50);
});

test('stops, saying why, when a map tile will not load, rather than write a frame without it', async ({ page }) => {
  test.setTimeout(120_000);
  const panel = await openSmall(page);
  // OpenFreeMap answered here, after the page's own stub so this one is asked first: a style whose tiles all fail.
  await page.route('https://tiles.openfreemap.org/**', (route) => {
    if (route.request().url().includes('/styles/')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: 8, sources: { land: { type: 'raster', tiles: ['https://tiles.openfreemap.org/broken/{z}/{x}/{y}.png'], tileSize: 256 } }, layers: [{ id: 'land', type: 'raster', source: 'land' }] }),
      });
    }
    return route.fulfill({ status: 500, body: '' });
  });
  await page.getByRole('radio', { name: /^Online map/ }).check();
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('alert')).toContainText('A map tile could not be loaded after 3 tries', { timeout: 60_000 });
  await expect(panel.getByRole('alert')).toContainText('rather than write a frame with part of the map missing');
  await expect.poll(() => storedExports(page), { timeout: 10_000 }).toEqual([]);
});

test('stops, saying why, when part of the map\'s style will not load, rather than draw the map without it (TD-073)', async ({ page }) => {
  test.setTimeout(120_000);
  const panel = await openSmall(page);
  // A style whose sprite is missing: no tile fails, but the map would be drawn without its icons.
  await page.route('https://tiles.openfreemap.org/**', (route) => {
    if (route.request().url().includes('/styles/')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: 8, sprite: 'https://tiles.openfreemap.org/sprites/missing', sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#2d4030' } }] }),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.getByRole('radio', { name: /^Online map/ }).check();
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('alert')).toContainText('Part of the map’s style could not be loaded', { timeout: 60_000 });
  await expect.poll(() => storedExports(page), { timeout: 10_000 }).toEqual([]);
});

test('asks for map tiles at most four at a time (TD-073)', async ({ page }) => {
  test.setTimeout(180_000);
  const panel = await openSmall(page);
  const tile = solidPng(128, [0x2d, 0x40, 0x30]);
  let inFlight = 0;
  let most = 0;
  let answered = 0;
  await page.route('https://tiles.openfreemap.org/**', async (route) => {
    if (route.request().url().includes('/styles/')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ version: 8, sources: { land: { type: 'raster', tiles: ['https://tiles.openfreemap.org/slow/{z}/{x}/{y}.png'], tileSize: 128 } }, layers: [{ id: 'land', type: 'raster', source: 'land' }] }),
      });
    }
    // Only the export's own requests are counted: they come through its queue, a plain fetch that
    // asks for anything, while the preview's map loads its images itself and asks for images.
    const counted = route.request().headers()['accept'] === '*/*';
    if (counted) most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (counted) { inFlight -= 1; answered += 1; }
    return route.fulfill({ contentType: 'image/png', body: tile });
  });
  await page.getByRole('radio', { name: /^Online map/ }).check();
  await expect(panel.getByText(/About [\d,]+ map tiles from OpenFreeMap, asked four at a time\./)).toBeVisible();
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('link', { name: /overlay-ride-map-video-640x360\.mp4/ })).toBeVisible({ timeout: 150_000 });
  expect(answered).toBeGreaterThan(4);
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThanOrEqual(4);
});

/** The frame of a made video showing at `seconds`, decoded by the browser's own player, as pixels. */
async function frameAt(page: Page, href: string, seconds: number): Promise<DecodedPng> {
  const dataUrl = await page.evaluate(
    async ({ href, seconds }) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = href;
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`the browser cannot play the video: ${video.error?.message ?? video.error?.code}`));
      });
      video.currentTime = seconds;
      await new Promise<void>((resolve) => (video.onseeked = () => resolve()));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      return canvas.toDataURL('image/png');
    },
    { href, seconds },
  );
  return decodePng(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

/** Pixels within `tolerance` of `rgb` in a box given as shares of the frame: [left, top, right, bottom]. */
function countIn(png: DecodedPng, rgb: [number, number, number], tolerance: number, [left, top, right, bottom]: [number, number, number, number]) {
  let count = 0;
  for (let y = Math.floor(png.height * top); y < png.height * bottom; y += 1) {
    for (let x = Math.floor(png.width * left); x < png.width * right; x += 1) {
      const i = (y * png.width + x) * 4;
      if (Math.abs(png.pixels[i]! - rgb[0]) <= tolerance && Math.abs(png.pixels[i + 1]! - rgb[1]) <= tolerance && Math.abs(png.pixels[i + 2]! - rgb[2]) <= tolerance) count += 1;
    }
  }
  return count;
}
const WHITE: [number, number, number] = [0xff, 0xff, 0xff];

test('the whole journey: a fixture ride, a size, a style, a figure, a preview, and an MP4 checked at known frames (AV-1210)', async ({ page }) => {
  test.setTimeout(240_000);
  const asked = await serveFixtureTiles(page);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'overlay-ride.gpx'));

  // A size and a style: 640 × 360 for five seconds, OpenFreeMap's Positron, a green marker, nothing of the route ahead.
  const video = page.getByRole('region', { name: 'Video settings' });
  await video.getByRole('combobox', { name: 'Size' }).selectOption('Custom');
  await video.getByRole('spinbutton', { name: 'Width', exact: true }).fill('640');
  await video.getByRole('spinbutton', { name: 'Height', exact: true }).fill('360');
  await video.getByRole('spinbutton', { name: 'Length', exact: true }).fill('5');
  await video.getByRole('checkbox', { name: 'Fly in from the whole route' }).uncheck();
  await video.getByRole('checkbox', { name: 'Pull back to the whole route' }).uncheck();
  await page.getByRole('combobox', { name: 'Style' }).selectOption('positron');
  await video.getByLabel('Marker colour').fill('#33cc33');
  await video.getByRole('checkbox', { name: 'Show the route still to come, dimmed' }).uncheck();
  await expect.poll(() => asked.some((url) => url.endsWith('/styles/positron'))).toBe(true);

  // A figure, placed by the editor: a new element goes in the top-left.
  const editor = page.getByRole('region', { name: 'Figures over the map' });
  await editor.getByRole('combobox', { name: 'Add' }).selectOption('metric:heartRate');
  await editor.getByRole('button', { name: 'Add to the canvas' }).click();

  // Previewed: played, then paused.
  const time = page.getByRole('region', { name: 'Preview' }).locator('.map-video-preview__time');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(time).not.toHaveText('0:00.0 / 0:05.0');
  await page.getByRole('button', { name: 'Pause' }).click();

  const panel = page.getByRole('region', { name: 'Make the video' });
  await expect(panel.getByRole('combobox', { name: 'Format' }).or(panel.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot encode here: ${refusal.join(' ')}`);
  await panel.getByRole('combobox', { name: 'Format' }).selectOption('mp4');
  await panel.getByRole('button', { name: 'Make the video' }).click();
  const link = panel.getByRole('link', { name: /overlay-ride-map-video-640x360\.mp4/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const href = (await link.getAttribute('href'))!;

  // The file: its length, its size, every frame.
  const made = await readMp4(await fetchBytes(page, href));
  const track = made.tracks.find((t) => t.type === 'video')!;
  expect(track.codec).toMatch(/^avc1/);
  expect([track.width, track.height]).toEqual([640, 360]);
  expect(track.sampleCount).toBe(150);
  expect(Math.abs(track.durationSeconds - 5)).toBeLessThan(0.1);

  // Known frames, as the plan puts them: the camera follows the marker, heading up, so the marker is at the
  // centre, the route it has drawn runs down behind it, and nothing of the route is ahead.
  for (const seconds of [1.0, 2.5, 4.0]) {
    const frame = await frameAt(page, href, seconds);
    const at = `at ${seconds} s`;
    expect(countIn(frame, [0x33, 0xcc, 0x33], 45, [0.48, 0.47, 0.52, 0.53]), `the marker is at the centre ${at}`).toBeGreaterThan(20);
    expect(countIn(frame, [0xff, 0x55, 0x33], 45, [0.4, 0.54, 0.6, 0.9]), `the route is drawn behind the marker ${at}`).toBeGreaterThan(40);
    expect(countIn(frame, [0xff, 0x55, 0x33], 45, [0.4, 0.1, 0.6, 0.46]), `nothing of the route is ahead ${at}`).toBeLessThan(5);
    // The map is the fixture's tiles, away from the figure and the credit.
    const box: [number, number, number, number] = [0.65, 0.1, 0.95, 0.3];
    expect(countIn(frame, TILE_RGB, 25, box), `the basemap fills the frame ${at}`).toBeGreaterThan(0.9 * 640 * 0.3 * 360 * 0.2);
    // The figure's type in the top-left, and white nowhere else at the top.
    expect(countIn(frame, WHITE, 60, [0.03, 0.04, 0.3, 0.25]), `the figure is drawn ${at}`).toBeGreaterThan(30);
    expect(countIn(frame, WHITE, 60, [0.65, 0.04, 0.97, 0.25]), `the figure is only where it was placed ${at}`).toBe(0);
  }

  // Only the fixture basemap was asked, and only ever read from.
  const outside = requests.map((request) => request.url()).filter((url) => !/^(blob:|data:)/.test(url) && !url.startsWith(ORIGIN));
  expect(outside.length).toBeGreaterThan(0);
  expect(outside.filter((url) => !url.startsWith('https://tiles.openfreemap.org/'))).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET').map((request) => request.url())).toEqual([]);
});

test('makes a video on route only with no request leaving the page at all, from opening it to the file (AV-1210)', async ({ page }) => {
  test.setTimeout(180_000);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  // Basemap tiles off in Settings first: the page then opens on route only, and never asks for a style either.
  await page.goto('./');
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'overlay-ride.gpx'));
  await expect(page.getByRole('radio', { name: /^Route only/ })).toBeChecked();

  const video = page.getByRole('region', { name: 'Video settings' });
  await video.getByRole('combobox', { name: 'Size' }).selectOption('Custom');
  await video.getByRole('spinbutton', { name: 'Width', exact: true }).fill('640');
  await video.getByRole('spinbutton', { name: 'Height', exact: true }).fill('360');
  await video.getByRole('spinbutton', { name: 'Length', exact: true }).fill('5');
  await video.getByRole('checkbox', { name: 'Fly in from the whole route' }).uncheck();
  await video.getByRole('checkbox', { name: 'Pull back to the whole route' }).uncheck();
  const panel = page.getByRole('region', { name: 'Make the video' });
  await expect(panel.getByRole('combobox', { name: 'Format' }).or(panel.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot encode here: ${refusal.join(' ')}`);
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('link', { name: /overlay-ride-map-video-640x360\.mp4/ })).toBeVisible({ timeout: 150_000 });
  await expect(panel).not.toContainText(/map requests so far/);

  const outside = requests.map((request) => request.url()).filter((url) => !/^(blob:|data:)/.test(url) && !url.startsWith(ORIGIN));
  expect(outside).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET').map((request) => request.url())).toEqual([]);
});

/**
 * AV-1210's privacy check, after AV-1008's for the overlay: the ride, the photo
 * and every file carry a canary, a token found nowhere else, in their names, the
 * activity's name and its coordinates. Every feature is used, and then no
 * request, header, body or outbound browser API may carry any of it.
 */
const CANARY = '5519canary';

test('nothing of the ride, a photo, the project or the video leaves the page; only the chosen map is asked (AV-1210)', async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  const requests: Request[] = [];
  context.on('request', (request) => requests.push(request));
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.addInitScript(() => {
    const sent: { api: string; url: string }[] = [];
    (window as unknown as { __outbound: typeof sent }).__outbound = sent;
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      sent.push({ api: `fetch ${init?.method ?? 'GET'} ${init?.body === undefined ? '' : 'with a body'}`, url: input instanceof Request ? input.url : String(input) });
      return realFetch(input, init);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      sent.push({ api: `xhr ${method}`, url: String(url) });
      return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
    };
    navigator.sendBeacon = (url) => (sent.push({ api: 'beacon', url: String(url) }), false);
  });

  // The ride, moved to a place nobody else's is, and named with the canary.
  const gpx = readFileSync(join(FIXTURE_DIR, 'overlay-ride.gpx'), 'utf8')
    .replace(/<name>[^<]*<\/name>/, `<name>Secret ride ${CANARY}</name>`)
    .replace(/lat="51\.(\d+)" lon="0\.0000000"/g, (_m, rest) => `lat="47.${rest}" lon="8.7731000"`);
  const needles = [CANARY, 'Secret ride', '47.5000', '8.7731', '.gpx', 'IMG_', 'map-video-project', 'ftyp', 'IHDR'];
  expect(gpx).toContain('lat="47.5000000" lon="8.7731000"');

  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles({ name: `${CANARY}-ride.gpx`, mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText(`${CANARY}-ride.gpx`);
  const video = page.getByRole('region', { name: 'Video settings' });
  await video.getByRole('combobox', { name: 'Size' }).selectOption('Custom');
  await video.getByRole('spinbutton', { name: 'Width', exact: true }).fill('640');
  await video.getByRole('spinbutton', { name: 'Height', exact: true }).fill('360');
  await video.getByRole('spinbutton', { name: 'Length', exact: true }).fill('5');
  await video.getByRole('checkbox', { name: 'Fly in from the whole route' }).uncheck();
  await video.getByRole('checkbox', { name: 'Pull back to the whole route' }).uncheck();

  // A photo with the canary in its name, and a time and a place in its EXIF.
  const photo = withExif(solidPng(200, [255, 0, 255]), tiffBlock({ dateTimeOriginal: '2024:01:01 10:00:30', offsetTimeOriginal: '+00:00', lat: 47.501, lon: 8.7731 }));
  await page.getByTestId('map-video-photo-input').setInputFiles({ name: `IMG_${CANARY}.png`, mimeType: 'image/png', buffer: photo });
  await expect(page.getByRole('region', { name: 'Photos' }).getByRole('listitem', { name: `IMG_${CANARY}.png` })).toContainText(/Shown at/);

  // A figure, a keyframe, a project saved and opened again.
  const editor = page.getByRole('region', { name: 'Figures over the map' });
  await editor.getByRole('combobox', { name: 'Add' }).selectOption('metric:heartRate');
  await editor.getByRole('button', { name: 'Add to the canvas' }).click();
  await page.getByRole('slider', { name: 'Position in the video' }).fill('2');
  await page.getByRole('button', { name: 'Add keyframe here' }).click();
  const project = page.getByRole('region', { name: 'Project' });
  const saving = page.waitForEvent('download');
  await project.getByRole('button', { name: 'Save project' }).click();
  const projectPath = testInfo.outputPath('map-video-project.json');
  await (await saving).saveAs(projectPath);
  await page.getByTestId('map-video-project-input').setInputFiles(projectPath);

  // The video and its poster.
  const panel = page.getByRole('region', { name: 'Make the video' });
  await expect(panel.getByRole('combobox', { name: 'Format' }).or(panel.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot encode here: ${refusal.join(' ')}`);
  const posting = page.waitForEvent('download');
  await panel.getByRole('button', { name: /^Save a still/ }).click();
  await posting;
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('link', { name: new RegExp(`${CANARY}-ride-map-video-640x360\\.mp4`) })).toBeVisible({ timeout: 180_000 });

  // 1. Every request was this page's own, or the chosen map's, and the map was asked.
  const hosts = new Set(requests.map((request) => request.url()).filter((url) => !/^(blob:|data:)/.test(url) && !url.startsWith(ORIGIN)).map((url) => new URL(url).host));
  expect([...hosts]).toEqual(['tiles.openfreemap.org']);
  // 2. Nothing was sent: GET only, no body.
  expect(requests.filter((request) => request.method() !== 'GET' || request.postDataBuffer() !== null).map((request) => request.url())).toEqual([]);
  // 3. Nothing of the ride, the photo, the project or the video in any URL, header or body.
  const described = requests.map((request) => [request.method(), request.url(), JSON.stringify(request.headers()), request.postDataBuffer()?.toString('latin1') ?? ''].join('\n')).join('\n');
  for (const needle of needles) expect(described, `a request mentions "${needle}"`).not.toContain(needle);
  // 4. And no API that sends was handed anything but a read of this page or the map.
  const outbound = await page.evaluate(() => (window as unknown as { __outbound: { api: string; url: string }[] }).__outbound);
  expect(outbound.filter(({ api, url }) => !api.startsWith('fetch GET ') || !(url.startsWith(ORIGIN) || /^(blob:|data:)/.test(url) || url.startsWith('https://tiles.openfreemap.org/')))).toEqual([]);
  for (const needle of needles) expect(outbound.map(({ url }) => url).join('\n')).not.toContain(needle);
  expect(sockets).toEqual([]);
  // 5. Nothing of it kept in the page's storage either.
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  for (const needle of [CANARY, '47.5000', '8.7731']) expect(stored).not.toContain(needle);
});

/** The browser's processes together, resident, in megabytes: the browser, its GPU process and its pages, as TD-064 measured. */
async function browserMegabytes(page: Page): Promise<number> {
  const cdp = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { id: number }[] };
  await cdp.detach();
  const pids = processInfo.map((process) => process.id).filter((id) => id > 0);
  const kilobytes = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
    .split('\n')
    .map((line) => Number(line.trim()) || 0);
  return kilobytes.reduce((sum, value) => sum + value, 0) / 1024;
}

test('makes a 60-second 1080p video in steady memory (AV-1210)', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  // An hour round a 22 km circle, a point a second: the camera crosses fresh map all the way.
  const ride = testInfo.outputPath('long-ride.gpx');
  writeFileSync(ride, longRideGpx(1));
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(ride);
  // The default size, 1920 × 1080 at 30 fps, over the fixture basemap: 1,800 frames, with the intro and outro.
  const video = page.getByRole('region', { name: 'Video settings' });
  await expect(video.getByRole('combobox', { name: 'Size' }).locator('option:checked')).toHaveText(/1920 × 1080/);
  await video.getByRole('spinbutton', { name: 'Length', exact: true }).fill('60');
  const panel = page.getByRole('region', { name: 'Make the video' });
  await expect(panel).toContainText('1800 frames at 1920 × 1080');
  await expect(panel.getByRole('combobox', { name: 'Format' }).or(panel.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot encode here: ${refusal.join(' ')}`);

  const before = await browserMegabytes(page);
  const samples: number[] = [];
  const started = Date.now();
  await panel.getByRole('button', { name: 'Make the video' }).click();
  const link = panel.getByRole('link', { name: /long-ride-map-video-1920x1080\.mp4/ });
  while (!(await link.isVisible())) {
    samples.push(await browserMegabytes(page));
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(Date.now() - started, 'the export finished').toBeLessThan(420_000);
  }
  const seconds = (Date.now() - started) / 1000;
  const peak = Math.max(...samples);
  const third = Math.floor(samples.length / 3);
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = mean(samples.slice(third, 2 * third));
  const last = mean(samples.slice(2 * third));
  testInfo.annotations.push({ type: 'memory (MB)', description: JSON.stringify({ before: Math.round(before), peak: Math.round(peak), middle: Math.round(middle), last: Math.round(last), seconds: Math.round(seconds) }) });
  // Measured on an M1, alone: 860 MB before, a peak of 1,010 MB, 940 MB through the middle third and 943 MB
  // through the last, in 150 s. A frame or a tile kept per frame would climb by megabytes a second.
  expect(peak - before, 'what the export adds').toBeLessThan(1024);
  expect(last - middle, 'no climb from the middle third to the last').toBeLessThan(200);
});

/**
 * #12 and #13: what an export asks of OpenFreeMap, counted. The ride, at 1080p for 10 s, with the tilt and
 * zoom given; returns the panel's estimate before it starts and every tile URL asked while it runs.
 */
async function countTiles(page: Page, ride: string, { pitch, zoom }: { pitch: number; zoom: number }) {
  const asked = await serveVectorFixture(page);
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(ride);
  const video = page.getByRole('region', { name: 'Video settings' });
  await video.getByRole('spinbutton', { name: 'Length', exact: true }).fill('10');
  for (const [name, value] of [['Tilt', pitch], ['Zoom', zoom]] as const) {
    await video.getByRole('spinbutton', { name, exact: true }).fill(String(value));
    await video.getByRole('spinbutton', { name, exact: true }).blur();
  }
  const panel = page.getByRole('region', { name: 'Make the video' });
  await expect(panel.getByRole('combobox', { name: 'Format' }).or(panel.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot encode here: ${refusal.join(' ')}`);
  await expect(panel).toContainText(/About [\d,]+ map tiles from OpenFreeMap/);
  const estimate = Number(/About ([\d,]+) map tiles/.exec((await panel.textContent())!)![1]!.replace(/,/g, ''));
  // The preview's own map has settled: from here, what is asked is the export's.
  await page.waitForTimeout(1500);
  const from = asked.length;
  await panel.getByRole('button', { name: 'Make the video' }).click();
  await expect(panel.getByRole('link', { name: /\.mp4/ })).toBeVisible({ timeout: 180_000 });
  return { estimate, tiles: asked.slice(from) };
}

for (const pitch of [0, 30, 45, 60]) {
  test(`estimates at least the OpenFreeMap tiles an export asks for, at a ${pitch}° tilt (#13)`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    // An hour round a 22 km circle, at zoom 14, where OpenFreeMap's tiles are finest: the most a frame asks.
    const ride = testInfo.outputPath('long-ride.gpx');
    writeFileSync(ride, longRideGpx(1));
    const { estimate, tiles } = await countTiles(page, ride, { pitch, zoom: 14 });
    const unique = new Set(tiles).size;
    testInfo.annotations.push({ type: 'tiles', description: JSON.stringify({ pitch, estimate, unique }) });
    expect(unique).toBeGreaterThan(30);
    expect(estimate).toBeGreaterThanOrEqual(unique);
    // Generous, not wildly so: measured at 1.3 to 1.7 times.
    expect(estimate).toBeLessThan(unique * 2.5);
  });
}

test('asks for each OpenFreeMap tile once, on a route that comes back on itself and drawn past zoom 14 (#12)', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  // 4 km north and back the same way, steeply tilted at zoom 16: MapLibre asks for the same zoom-14 tile for
  // each zoom it draws it at, and again on the way back; measured at 567 requests for 54 tiles before.
  const out = Array.from({ length: 801 }, (_, i) => i);
  const points = [...out, ...out.slice(0, -1).reverse()].map((step, i) =>
    `<trkpt lat="${(51.5 + step * 0.000045).toFixed(6)}" lon="-0.12"><time>${new Date(Date.UTC(2024, 5, 1, 8, 0, i)).toISOString().replace('.000Z', 'Z')}</time></trkpt>`,
  );
  const ride = testInfo.outputPath('out-and-back.gpx');
  writeFileSync(ride, `<?xml version="1.0"?><gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`);
  const { estimate, tiles } = await countTiles(page, ride, { pitch: 60, zoom: 16 });
  const unique = new Set(tiles).size;
  expect(unique).toBeGreaterThan(10);
  expect(tiles.filter((url, index) => tiles.indexOf(url) !== index)).toEqual([]);
  expect(estimate).toBeGreaterThanOrEqual(unique);
});

