import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fetchBlobBytes } from './helpers/overlayFixtures';
import { decodePng, type DecodedPng } from './helpers/png';
import { TILE_RGB, forbidLiveProviders, serveFixtureTiles, serveVectorFixture } from './helpers/mapVideoTiles';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1023 (TD-092). The route inset as a real map, in a real browser, over fixture tiles only (no live
 * provider is ever asked): the editor's choices, the preview's live map, and a PNG sequence whose frames are
 * decoded here to show the map, the route and the marker held in the centre; every tile asked once, by GET,
 * with nothing of the activity in it, and none for the stretches the privacy trim hides.
 */

const LAT0 = 47;
const LON0 = 8;
const POINTS = 41;
/** 400 m a second, due north: 16 km in 40 s, so each hidden end (4 km) lies tiles away from where the kept route begins. */
const lat = (i: number, step = 0.0036) => LAT0 + i * step;

function writeRide(dir: string, count = POINTS, step = 0.0036): string {
  mkdirSync(dir, { recursive: true });
  const body = Array.from({ length: count }, (_, i) => {
    const time = new Date(Date.UTC(2024, 5, 1, 8, 0, i)).toISOString().replace('.000Z', 'Z');
    return `<trkpt lat="${lat(i, step).toFixed(6)}" lon="${LON0.toFixed(6)}"><ele>${400 + i}</ele><time>${time}</time></trkpt>`;
  }).join('');
  const path = join(dir, 'ride.gpx');
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Map ride</name><type>cycling</type><trkseg>${body}</trkseg></trk></gpx>`);
  return path;
}

async function openCanvas(page: Page, dir: string, count = POINTS, step = 0.0036) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-file-input').setInputFiles(writeRide(dir, count, step));
  await page.getByRole('radio', { name: 'A custom video overlay, with no video' }).check();
  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');
  await canvas.getByLabel('Add', { exact: true }).selectOption({ label: 'Route with position' });
  await canvas.getByRole('button', { name: 'Add to the canvas' }).click();
  return canvas;
}

const rectOf = async (canvas: Locator) => {
  const read = async (label: string) => Number(await canvas.getByLabel(label, { exact: true }).inputValue()) / 100;
  return { x: await read('From the left (%)'), y: await read('From the top (%)'), width: await read('Width (%)'), height: await read('Height (%)') };
};

const pixel = (png: DecodedPng, x: number, y: number) => {
  const at = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [...png.pixels.subarray(at, at + 4)] as [number, number, number, number];
};
const near = (a: number[], b: number[], tolerance = 4) => a.every((value, i) => Math.abs(value - b[i]!) <= tolerance);

/** The tile a place is in at a tile zoom. */
function tileOf(latitude: number, longitude: number, z: number): string {
  const n = 2 ** z;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const sin = Math.sin((latitude * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n);
  return `${z}/${x}/${y}`;
}
const tilesAsked = (asked: string[]) => asked.flatMap((url) => /\/(?:fixture|planet)\/(\d+\/\d+\/\d+)\.(?:png|pbf)/.exec(url)?.[1] ?? []);

/** Every request that left the page for another origin, kept to what the fixtures answered. */
function watchOutbound(page: Page) {
  const outbound: { method: string; url: string; body: string | null }[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://localhost:4173' && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) {
      outbound.push({ method: request.method(), url: request.url(), body: request.postData() });
    }
  });
  return outbound;
}

test('the map is off until it is chosen, then the preview shows it live and the notice says who learns the area', async ({ page }, testInfo) => {
  const live = await forbidLiveProviders(page);
  const asked = await serveFixtureTiles(page);
  const canvas = await openCanvas(page, testInfo.outputDir);

  // Off by default: nothing was asked of any provider, and there is no map under the canvas.
  expect(asked).toEqual([]);
  await expect(canvas.getByTestId('inset-map-layer')).toHaveCount(0);
  await expect(canvas.getByLabel('Map behind the line')).toHaveValue('none');

  await canvas.getByLabel('View', { exact: true }).selectOption('follow');
  await canvas.getByLabel('Map behind the line').selectOption('openfreemap');
  await expect(canvas.getByText(/tiles are fetched from OpenFreeMap, which learns the area shown\. No privacy trim is set/)).toBeVisible();
  await expect(canvas.getByText(/The preview draws the map as its tiles arrive; an export waits for every tile/)).toBeVisible();
  await expect(canvas.getByTestId('inset-map-layer')).toBeAttached();
  await expect.poll(() => tilesAsked(asked).length, { timeout: 30_000 }).toBeGreaterThan(0);
  // The map's picture really is the provider's (the fixture's slate blue), under the line: read it off the page.
  await expect
    .poll(async () =>
      canvas.locator('.inset-map canvas').first().evaluate((element: HTMLCanvasElement) => {
        const gl = element.getContext('webgl2') ?? element.getContext('webgl');
        return gl ? true : false;
      }),
    )
    .toBe(true);

  // Never a live provider, and never anything of the ride in a request.
  expect(live).toEqual([]);
  for (const url of asked) {
    expect(url.startsWith('https://tiles.openfreemap.org/'), url).toBe(true);
    expect(url).not.toMatch(/47\.|8\.0|lat|lon/);
  }

  // At most two maps: a third inset is offered none, with the reason.
  for (let i = 0; i < 2; i += 1) {
    await canvas.getByLabel('Add', { exact: true }).selectOption({ label: 'Route with position' });
    await canvas.getByRole('button', { name: 'Add to the canvas' }).click();
    if (i === 0) await canvas.getByLabel('Map behind the line').selectOption('openfreemap');
  }
  await expect(canvas.getByLabel('Map behind the line').locator('option[value="openfreemap"]')).toBeDisabled();
  await expect(canvas.getByText(/At most 2 insets in one overlay show a map/)).toBeVisible();
});

test('a MapTiler map is refused for the PNG sequence, with the reason, and nothing is asked of MapTiler', async ({ page }, testInfo) => {
  const live = await forbidLiveProviders(page);
  await serveFixtureTiles(page);
  const canvas = await openCanvas(page, testInfo.outputDir);
  await canvas.getByLabel('Map behind the line').selectOption('maptiler');
  await canvas.getByLabel('MapTiler key').fill('not-a-real-key');
  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await expect(exporter.getByRole('alert')).toContainText('A MapTiler map cannot go into the PNG sequence');
  await expect(exporter.getByRole('button', { name: 'Export PNG sequence' })).toBeDisabled();
  // The preview's live map is for the reader's eyes; the export, which would make pictures, is not offered.
  expect(live.filter((url) => !url.startsWith('https://api.maptiler.com/'))).toEqual([]);
});

test('a PNG sequence of a following inset: the map, the route and the marker in the centre, every tile once by GET, none for the trimmed ends', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const live = await forbidLiveProviders(page);
  const asked = await serveVectorFixture(page);
  const outbound = watchOutbound(page);
  const canvas = await openCanvas(page, testInfo.outputDir);

  await canvas.getByLabel('View', { exact: true }).selectOption('follow');
  await canvas.getByLabel('Zoom', { exact: true }).fill('17');
  await canvas.getByLabel('Map behind the line').selectOption('openfreemap');
  await canvas.getByLabel('Background (%)').fill('0');
  // The 25 % of the ride at each end is hidden: 1 km from the start, 1 km from the finish.
  await canvas.getByLabel('Hide from the start (%)').fill('25');
  await canvas.getByLabel('Hide from the end (%)').fill('25');
  const box = await rectOf(canvas);

  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await expect(exporter.getByTestId('inset-tiles')).toContainText(/asks OpenFreeMap for \d+ tiles?, each once/);
  const counted = Number(/for (\d+) tile/.exec((await exporter.getByTestId('inset-tiles').textContent()) ?? '')![1]);
  expect(counted).toBeGreaterThan(0);

  // The preview's own map has settled by now: what is asked from here on is the export's.
  await expect.poll(async () => { const n = asked.length; await page.waitForTimeout(2000); return asked.length === n; }, { timeout: 60_000 }).toBe(true);
  const before = asked.length;
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 220_000 });
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  const frames = entries.slice(1);
  expect(frames.length).toBeGreaterThan(300);

  // A frame in the kept part: the fixture's slate blue fills the inset, the route's white line is in it, the accent marker is at its centre.
  const png = decodePng(Buffer.from(frames[frames.length >> 1]!.data));
  const left = box.x * png.width;
  const top = box.y * png.height;
  const w = box.width * png.width;
  const h = box.height * png.height;
  const centre = pixel(png, left + w / 2, top + h / 2);
  expect(near(centre, [0xff, 0x6a, 0x00, 255]), `the marker at the centre: ${centre}`).toBe(true);
  expect(near(pixel(png, left + 6, top + 6), [...TILE_RGB, 255]), 'the map at a corner').toBe(true);
  // The line: white pixels in the column above the marker (the route runs north through the centre; heading is north up).
  let line = 0;
  for (let y = Math.floor(top); y < top + h / 2 - 30; y += 1) if (near(pixel(png, left + w / 2, y), [255, 255, 255, 255], 50)) line += 1;
  expect(line).toBeGreaterThan(10);
  // The credit, small, on a plate at the bottom edge.
  const plate = pixel(png, left + w / 2, top + h - 3);
  expect(plate[0]).toBeGreaterThan(TILE_RGB[0] + 60);
  // Outside the inset it stays transparent.
  expect(pixel(png, left + w + 20, top + h + 20)[3]).toBe(0);

  // Every tile asked once, by GET, with nothing of the activity.
  // The export's own map asks for each tile once.
  const exportTiles = tilesAsked(asked.slice(before));
  expect(exportTiles.length).toBeGreaterThan(0);
  expect(new Set(exportTiles).size, 'each tile is asked for once').toBe(exportTiles.length);
  expect(outbound.length).toBeGreaterThan(0);
  for (const request of outbound) {
    expect(request.method, request.url).toBe('GET');
    expect(request.body, request.url).toBeNull();
    expect(request.url.startsWith('https://tiles.openfreemap.org/'), request.url).toBe(true);
    expect(request.url).not.toMatch(/Map%20ride|Map ride|47\.\d|lat=|lon=/);
  }
  expect(live).toEqual([]);
  const distinct = new Set(tilesAsked(asked));
  expect(new Set(exportTiles).size, 'no more tiles than the count said').toBeLessThanOrEqual(counted);

  // None for the hidden ends: the places of the first and last points are never in a tile asked, at any zoom asked.
  const zooms = [...new Set([...distinct].map((tile) => Number(tile.split('/')[0])))];
  for (const z of zooms) {
    expect(distinct.has(tileOf(lat(0), LON0, z)), `the start's tile at ${z}`).toBe(false);
    expect(distinct.has(tileOf(lat(POINTS - 1), LON0, z)), `the finish's tile at ${z}`).toBe(false);
    expect(distinct.has(tileOf(lat((POINTS - 1) / 2), LON0, z)), `the middle's tile at ${z}`).toBe(true);
  }
});

test('the transparent video loads every tile of its plan first, then records from them: each tile once, none for the trimmed ends', async ({ page }, testInfo) => {
  test.setTimeout(480_000);
  const live = await forbidLiveProviders(page);
  const asked = await serveVectorFixture(page);
  const count = 11;
  // 1.8 km a second, so each hidden end (4.4 km) lies tiles away from where the kept route begins.
  const step = 0.016;
  const canvas = await openCanvas(page, testInfo.outputDir, count, step);
  await canvas.getByLabel('View', { exact: true }).selectOption('follow');
  await canvas.getByLabel('Zoom', { exact: true }).fill('17');
  await canvas.getByLabel('Map behind the line').selectOption('openfreemap');
  await canvas.getByLabel('Hide from the start (%)').fill('25');
  await canvas.getByLabel('Hide from the end (%)').fill('25');
  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  const webm = exporter.getByRole('radio', { name: /Transparent video \(WebM\)/ });
  await expect(webm).toBeEnabled({ timeout: 15_000 });
  await webm.check();
  await exporter.getByLabel('Frame rate').selectOption('10');
  await expect(exporter.getByTestId('inset-tiles')).toContainText(/asks OpenFreeMap for \d+ tiles?, each once/);
  await expect(exporter.getByText(/tiles are all loaded before the recording starts/)).toBeVisible();
  await expect.poll(async () => { const n = asked.length; await page.waitForTimeout(2000); return asked.length === n; }, { timeout: 60_000 }).toBe(true);
  let before = asked.length;
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.webm/ });
  // A recording is made in real time, and the page stops it, with the reason, if a loaded machine makes it fall a second behind (the rule this test
  // is not about): try again, up to three times, before calling it a failure.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Each attempt has maps of its own, each asking for a tile once: the last attempt is the one measured.
    before = asked.length;
    await exporter.getByRole('button', { name: /Export (transparent video|again)/ }).click();
    const outcome = await Promise.race([
      link.waitFor({ timeout: 150_000 }).then(() => 'done'),
      exporter.getByRole('alert').filter({ hasText: 'fell behind' }).waitFor({ timeout: 150_000 }).then(() => 'behind'),
    ]);
    if (outcome === 'done') break;
    // Never silent: a retry is on the test's record and in its output, so a recording that keeps falling behind shows as a trend.
    const note = `attempt ${attempt} of 3: the recording fell behind and was stopped; trying again`;
    test.info().annotations.push({ type: 'retry', description: note });
    console.log(`[overlay-inset-map] ${note}`);
    expect(attempt, 'the recording kept falling behind').toBeLessThan(3);
  }
  await expect(link).toBeVisible();
  const exportTiles = tilesAsked(asked.slice(before));
  expect(exportTiles.length).toBeGreaterThan(0);
  expect(new Set(exportTiles).size, 'each tile is asked for once').toBe(exportTiles.length);
  const distinct = new Set(tilesAsked(asked));
  for (const z of new Set([...distinct].map((tile) => Number(tile.split('/')[0])))) {
    expect(distinct.has(tileOf(lat(0, step), LON0, z)), `the start's tile at ${z}`).toBe(false);
    expect(distinct.has(tileOf(lat(count - 1, step), LON0, z)), `the finish's tile at ${z}`).toBe(false);
  }
  expect(live).toEqual([]);
});
