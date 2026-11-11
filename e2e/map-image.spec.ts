import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { RIDE_PATH } from './helpers/overlayFixtures';
import { TILE_RGB, forbidLiveProviders, serveFixtureTiles } from './helpers/mapVideoTiles';
import { decodePng, type DecodedPng } from './helpers/png';

/**
 * AV-1013. The map image in a real browser, over fixture tiles: each layout
 * saved and its pixels read (the basemap, the route's colour, the panel's
 * colour and its text, the elements placed over the map, the credit), the
 * requests it makes, and route only, which makes none.
 */

test.use({ serviceWorkers: 'block' });

let live: string[] = [];
test.beforeEach(async ({ page }) => {
  live = await forbidLiveProviders(page);
});
test.afterEach(() => expect(live, 'a request reached past the page to a live provider').toEqual([]));

const ROUTE_RGB: [number, number, number] = [0xff, 0x55, 0x33];
const PANEL_RGB: [number, number, number] = [0x20, 0x80, 0x40];

const near = (png: DecodedPng, x: number, y: number, [r, g, b]: [number, number, number], tolerance = 40) => {
  const i = (Math.round(y) * png.width + Math.round(x)) * 4;
  return Math.abs(png.pixels[i]! - r) <= tolerance && Math.abs(png.pixels[i + 1]! - g) <= tolerance && Math.abs(png.pixels[i + 2]! - b) <= tolerance;
};

/** Pixels near a colour in a band of rows. */
function countIn(png: DecodedPng, rows: [number, number], colour: [number, number, number], tolerance = 40): number {
  let count = 0;
  for (let y = Math.max(0, rows[0]); y < Math.min(png.height, rows[1]); y += 1) {
    for (let x = 0; x < png.width; x += 1) if (near(png, x, y, colour, tolerance)) count += 1;
  }
  return count;
}

/** The first row, from the top, where the panel's colour fills the row. */
function panelTop(png: DecodedPng): number {
  for (let y = 0; y < png.height; y += 1) {
    if (near(png, 2, y, PANEL_RGB, 8) && near(png, png.width - 3, y, PANEL_RGB, 8) && near(png, png.width / 2, y, PANEL_RGB, 8)) return y;
  }
  return -1;
}

async function open(page: Page) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-activity-input').setInputFiles(RIDE_PATH);
  await page.getByRole('radio', { name: 'A map image, with the activity’s details' }).check();
  const panel = page.getByRole('region', { name: 'Map image' });
  await expect(panel).toBeVisible();
  return panel;
}

async function save(page: Page, panel: Locator) {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), panel.getByRole('button', { name: 'Save the image' }).click()]);
  await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  return { png: decodePng(readFileSync((await file.path())!)), name: file.suggestedFilename() };
}

test('saves the map with its route above a panel of the chosen colour, with the details and the credit', async ({ page }) => {
  const asked = await serveFixtureTiles(page);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await open(page);
  await panel.getByRole('combobox', { name: 'Size' }).selectOption('square');
  await panel.getByLabel('Panel colour').fill('#208040');
  await expect(page.getByTestId('map-image-preview')).toBeVisible();

  const { png, name } = await save(page, panel);
  expect(name).toBe('map-image.png');
  expect([png.width, png.height]).toEqual([1080, 1080]);

  // The panel: its colour across the image from some row down to the foot, under half the image.
  const top = panelTop(png);
  expect(top).toBeGreaterThan(1080 / 2 - 1);
  expect(top).toBeLessThan(1080 * 0.85);
  for (let y = top; y < png.height; y += 37) expect(near(png, 1, y, PANEL_RGB, 8), `row ${y}`).toBe(true);
  // Its text, in white on the dark green: the name, the date and the figures.
  expect(countIn(png, [top, png.height], [255, 255, 255], 30)).toBeGreaterThan(2000);

  // The map above it: the fixture's tiles, and the route in its colour, inside the margin.
  expect(countIn(png, [0, top], TILE_RGB, 12)).toBeGreaterThan(top * 1080 * 0.5);
  expect(countIn(png, [0, top], ROUTE_RGB, 30)).toBeGreaterThan(500);
  // The credit, on its light box at the map's foot, bottom right.
  expect(countIn(png, [top - 24, top], [230, 232, 234], 40)).toBeGreaterThan(400);

  // Only OpenFreeMap was asked, by GET, and nothing of the activity went with it.
  expect(asked.length).toBeGreaterThan(0);
  const outside = requests.filter((request) => !request.url().startsWith('http://localhost:4173'));
  expect(new Set(outside.map((request) => new URL(request.url()).host))).toEqual(new Set(['tiles.openfreemap.org']));
  for (const request of outside) {
    expect(request.method()).toBe('GET');
    expect(request.postData()).toBeNull();
    expect(request.url()).not.toMatch(/overlay-ride|lat=|lon=/i);
  }
});

test('fills the image with the map and draws the canvas’s elements over it', async ({ page }) => {
  await serveFixtureTiles(page);
  const panel = await open(page);
  await panel.getByRole('combobox', { name: 'Size' }).selectOption('link');
  await panel.getByRole('radio', { name: /map filling the image/ }).check();
  const editor = page.getByRole('region', { name: 'Over the map' });
  await expect(editor).toBeVisible();
  // No live figures in a still, and no clock to move.
  await expect(editor.getByRole('slider', { name: 'Canvas time' })).toHaveCount(0);
  await expect(editor.getByLabel('Add', { exact: true }).locator('option', { hasText: 'Speed gauge' })).toHaveCount(0);
  await editor.getByLabel('Add', { exact: true }).selectOption({ label: 'Rectangle' });
  await editor.getByRole('button', { name: /^Add/ }).click();

  const { png } = await save(page, panel);
  expect([png.width, png.height]).toEqual([1200, 630]);
  // No panel: the map's tiles run to the foot of the image.
  expect(near(png, 4, png.height - 40, TILE_RGB, 12)).toBe(true);
  // The rectangle, where the editor put it, darker than the map it lies over; the map beside it untouched.
  const read = async (label: string) => Number(await editor.getByLabel(label).inputValue()) / 100;
  const box = { x: await read('From the left (%)'), y: await read('From the top (%)'), w: await read('Width (%)'), h: await read('Height (%)') };
  const middle = { x: (box.x + box.w / 2) * png.width, y: (box.y + box.h / 2) * png.height };
  expect(near(png, middle.x, middle.y, TILE_RGB, 12)).toBe(false);
  const i = (Math.round(middle.y) * png.width + Math.round(middle.x)) * 4;
  expect(png.pixels[i]! + png.pixels[i + 1]! + png.pixels[i + 2]!).toBeLessThan(TILE_RGB[0] + TILE_RGB[1] + TILE_RGB[2]);
  expect(near(png, (box.x + box.w) * png.width + 20, middle.y, TILE_RGB, 12)).toBe(true);
});

test('route only asks for nothing at all', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await open(page);
  await panel.getByRole('radio', { name: /^Route only/ }).check();
  await panel.getByRole('combobox', { name: 'Size' }).selectOption('square');
  const { png } = await save(page, panel);
  expect(countIn(png, [0, png.height / 2], ROUTE_RGB, 30)).toBeGreaterThan(500);
  const outside = requests.filter((request) => !request.url().startsWith('http://localhost:4173'));
  expect(outside.map((request) => request.url())).toEqual([]);
  // No credit: route only uses no one's map.
  await expect(panel.getByRole('status').filter({ hasText: 'No map was asked for' })).toBeVisible();
});

test('turns and zooms the map by its buttons, and keeps it seen from straight above', async ({ page }) => {
  await serveFixtureTiles(page);
  const panel = await open(page);
  const heading = panel.getByRole('spinbutton', { name: 'Heading' });
  await expect(heading).toHaveValue('0');
  await panel.getByRole('button', { name: 'Turn right' }).click();
  await expect(heading).toHaveValue('15');
  await heading.fill('90');
  await heading.blur();
  await expect(heading).toHaveValue('90');
  await panel.getByRole('button', { name: 'North up' }).click();
  await expect(heading).toHaveValue('0');
  await expect(panel.getByText('It is fitted to the route.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Fit to the route' }).click();
});

test('asks for each tile once at 4K, far inside OpenFreeMap’s 3,000', async ({ page }) => {
  // A 4K image drawn in software beside the other tests takes its time.
  test.setTimeout(90_000);
  await serveFixtureTiles(page);
  // The export asks through its queue with `fetch` (`*/*`); the preview's map asks for images as a browser does.
  const exported: string[] = [];
  await page.route('https://tiles.openfreemap.org/fixture/**', (route) => {
    if (route.request().headers()['accept'] === '*/*') exported.push(route.request().url());
    return route.fallback();
  });
  const panel = await open(page);
  await panel.getByRole('combobox', { name: 'Size' }).selectOption('landscape-4k');
  await panel.getByRole('button', { name: 'Zoom out' }).click();
  await panel.getByRole('button', { name: 'Zoom out' }).click();
  const { png } = await save(page, panel);
  expect([png.width, png.height]).toEqual([3840, 2160]);
  const status = await panel.getByRole('status').filter({ hasText: 'Saved' }).textContent();
  const requests = Number(/took (\d+) requests/.exec(status ?? '')?.[1]);
  // The style and its tiles: 256-pixel tiles here, so four times OpenFreeMap's 512-pixel ones, and still
  // far inside its 3,000, so no count is needed before saving.
  expect(requests).toBeGreaterThan(0);
  expect(requests).toBeLessThan(300);
  expect(exported.length).toBe(requests - 1);
  // The export's own tiles: none of them asked twice.
  expect(exported.length).toBeGreaterThan(0);
  expect(new Set(exported).size).toBe(exported.length);
});
