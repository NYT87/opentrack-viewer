import { expect, test, type Page, type Request } from '@playwright/test';
import { join } from 'node:path';
import { readMp4 } from './helpers/mp4';
import { countPixelsNear, decodePng } from './helpers/png';

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
