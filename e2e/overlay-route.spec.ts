import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { RIDE_PATH } from './helpers/overlayFixtures';
import { countPixelsNear, decodePng, type DecodedPng } from './helpers/png';

/**
 * AV-1009. The standalone route image, end to end in a real browser: an
 * activity with no video becomes a transparent PNG of its route, from a file
 * chosen on the overlay page and from the viewer's handoff, and the PNG is
 * decoded here to prove what is in it — and what is not.
 */

const ORANGE: [number, number, number] = [0xff, 0x6a, 0x00];
const GREEN: [number, number, number] = [0x22, 0xc5, 0x5e];
const RED: [number, number, number] = [0xef, 0x44, 0x44];

function gpx(points: { lat: number; lon: number }[]): string {
  const body = points
    .map(
      (point, i) =>
        `<trkpt lat="${point.lat}" lon="${point.lon}"><ele>${10 + i}</ele><time>${new Date(
          Date.UTC(2024, 5, 1, 8, 0, i),
        )
          .toISOString()
          .replace('.000Z', 'Z')}</time></trkpt>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Route</name><trkseg>${body}</trkseg></trk></gpx>`;
}

function writeGpx(dir: string, name: string, points: { lat: number; lon: number }[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, gpx(points));
  return path;
}

/** Where anything was drawn: the box around every pixel that is not fully transparent. */
function drawnBox(png: DecodedPng) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let visible = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.pixels[(y * png.width + x) * 4 + 3]! > 0) {
        visible += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY, visible };
}

async function downloadPng(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PNG' }).click(),
  ]);
  const path = await download.path();
  return { png: decodePng(readFileSync(path)), name: download.suggestedFilename(), bytes: readFileSync(path) };
}

async function openOverlaysWith(page: Page, gpxPath: string) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-activity-input').setInputFiles(gpxPath);
  const panel = page.getByRole('region', { name: 'Overlay image' });
  await expect(panel).toBeVisible();
  return panel;
}

test('exports the whole route as a transparent PNG from a chosen GPX, with no video', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await openOverlaysWith(page, RIDE_PATH);

  await expect(panel.getByTestId('route-image-preview')).toBeVisible();
  await expect(panel.getByTestId('route-image-size')).toContainText('1920 × 1080');

  const { png, name, bytes } = await downloadPng(page);
  expect(name).toBe('route-overlay-1920x1080.png');
  expect([png.width, png.height]).toEqual([1920, 1080]);
  // PNG colour type 6: RGBA. A PNG with no alpha channel could not be transparent.
  expect(bytes[25]).toBe(6);

  // Transparent everywhere but the route: the four corners and the middle of every edge.
  const alphaAt = (x: number, y: number) => png.pixels[(y * png.width + x) * 4 + 3]!;
  for (const [x, y] of [
    [0, 0],
    [1919, 0],
    [0, 1079],
    [1919, 1079],
    [960, 0],
    [960, 1079],
    [0, 540],
    [1919, 540],
  ] as const) {
    expect(alphaAt(x, y)).toBe(0);
  }
  const box = drawnBox(png);
  expect(box.visible).toBeGreaterThan(2000);
  // Mostly empty, so not an opaque canvas with a route on it.
  expect(box.visible / (png.width * png.height)).toBeLessThan(0.1);
  // Route colour is the default accent, and the start and end are marked.
  expect(countPixelsNear(png, ORANGE, 12)).toBeGreaterThan(1000);
  expect(countPixelsNear(png, GREEN, 12)).toBeGreaterThan(50);
  expect(countPixelsNear(png, RED, 12)).toBeGreaterThan(50);
  // Not clipped: nothing touches an edge.
  expect(box.minX).toBeGreaterThan(0);
  expect(box.minY).toBeGreaterThan(0);
  expect(box.maxX).toBeLessThan(png.width - 1);
  expect(box.maxY).toBeLessThan(png.height - 1);

  await expect(panel.getByRole('status')).toContainText('Saved route-overlay-1920x1080.png');

  // Nothing left the page: every request is for the app itself.
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    const url = request.url();
    expect(url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')).toBe(true);
    expect(request.method()).toBe('GET');
    expect(request.postData()).toBeNull();
  }
});

test('follows the size, colour, width, padding and markers chosen', async ({ page }) => {
  const panel = await openOverlaysWith(page, RIDE_PATH);
  await panel.getByLabel('Aspect ratio').selectOption('9:16');
  await panel.getByLabel('Route colour').fill('#0000ff');
  await panel.getByLabel('Route width (px)').fill('30');
  await panel.getByLabel(/Padding/).fill('20');
  await panel.getByRole('checkbox', { name: /Mark the start/ }).uncheck();
  await expect(panel.getByTestId('route-image-size')).toContainText('1080 × 1920');

  const { png, name } = await downloadPng(page);
  expect(name).toBe('route-overlay-1080x1920.png');
  expect([png.width, png.height]).toEqual([1080, 1920]);
  expect(countPixelsNear(png, [0, 0, 255], 12)).toBeGreaterThan(1000);
  expect(countPixelsNear(png, ORANGE, 40)).toBe(0);
  expect(countPixelsNear(png, GREEN, 12)).toBe(0);
  expect(countPixelsNear(png, RED, 12)).toBe(0);

  // 20% of the shorter side is 216 px of margin outside the line on every side,
  // and the route fills the padded box in one direction, so the tightest side shows it.
  const box = drawnBox(png);
  const margins = [box.minX, box.minY, 1079 - box.maxX, 1919 - box.maxY];
  expect(Math.min(...margins)).toBeGreaterThanOrEqual(215);
  expect(Math.min(...margins)).toBeLessThanOrEqual(222);
});

test('exports a custom size', async ({ page }) => {
  const panel = await openOverlaysWith(page, RIDE_PATH);
  await panel.getByLabel(/Width/).fill('640');
  await panel.getByLabel(/Height/).fill('480');
  await expect(panel.getByLabel('Aspect ratio')).toHaveValue('custom');
  const { png } = await downloadPng(page);
  expect([png.width, png.height]).toEqual([640, 480]);
});

test('refuses an unusable size and offers no download', async ({ page }) => {
  const panel = await openOverlaysWith(page, RIDE_PATH);
  await panel.getByLabel(/Width/).fill('100000');
  await expect(panel.getByRole('alert')).toContainText(/between 16 and 8192/);
  await expect(panel.getByRole('button', { name: 'Download PNG' })).toBeDisabled();
  await expect(panel.getByTestId('route-image-preview')).toHaveCount(0);
});

test('draws a route across the antimeridian as one line, not across the whole picture', async ({ page }, testInfo) => {
  const east = Array.from({ length: 11 }, (_, i) => {
    const lon = 179.95 + i * 0.01;
    return { lat: 10 + i * 0.002, lon: lon > 180 ? lon - 360 : lon };
  });
  const path = writeGpx(testInfo.outputDir, 'antimeridian.gpx', east);
  // The same route moved to the Greenwich meridian: nothing crosses anything.
  const reference = writeGpx(
    testInfo.outputDir,
    'reference.gpx',
    east.map((point, i) => ({ lat: point.lat, lon: -0.05 + i * 0.01 })),
  );

  await openOverlaysWith(page, path);
  const crossing = (await downloadPng(page)).png;
  const crossingBox = drawnBox(crossing);

  await page.goto('./#/overlays');
  await page.getByRole('button', { name: 'Start over' }).click();
  await openOverlaysWith(page, reference);
  const elsewhere = (await downloadPng(page)).png;
  const elsewhereBox = drawnBox(elsewhere);

  // Same drawing as anywhere else: the same box, to the pixel or nearly.
  for (const key of ['minX', 'maxX', 'minY', 'maxY'] as const) {
    expect(Math.abs(crossingBox[key] - elsewhereBox[key])).toBeLessThanOrEqual(2);
  }
  // And a whole route, not a hairline squeezed from a world-wide span.
  expect(crossingBox.maxX - crossingBox.minX).toBeGreaterThan(crossing.width * 0.3);
});

test('draws a single place as a dot, and says so', async ({ page }, testInfo) => {
  const path = writeGpx(testInfo.outputDir, 'one.gpx', [{ lat: 10, lon: 20 }]);
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-activity-input').setInputFiles(path);
  const panel = page.getByRole('region', { name: 'Overlay image' });
  // A one-point file may be refused at intake; if it is read, it must be drawn as a dot.
  const refused = page.getByRole('region', { name: 'File not read' });
  await expect(panel.or(refused)).toBeVisible();
  test.skip(await refused.isVisible(), 'the GPX reader refuses a one-point file before the overlay sees it');

  await expect(panel).toContainText(/single place/);
  const { png } = await downloadPng(page);
  const box = drawnBox(png);
  expect(Math.abs((box.minX + box.maxX) / 2 - png.width / 2)).toBeLessThan(2);
  expect(Math.abs((box.minY + box.maxY) / 2 - png.height / 2)).toBeLessThan(2);
  expect(box.maxX - box.minX).toBeLessThan(60);
});

test('takes the activity from the viewer, whole by default and the focused section on request', async ({ page }) => {
  await page.goto('./#/viewer');
  await page.getByTestId('file-input').setInputFiles(RIDE_PATH);
  const create = page.getByRole('button', { name: 'Create route overlay' });
  await expect(create).toBeVisible();
  await create.click();

  await expect(page).toHaveURL(/#\/overlays$/);
  const panel = page.getByRole('region', { name: 'Overlay image' });
  await expect(panel).toContainText('whole activity');
  await expect(panel.getByTestId('route-image-preview')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Activity' })).toContainText('overlay-ride.gpx');

  const { png, name } = await downloadPng(page);
  expect(name).toBe('route-overlay-1920x1080.png');
  expect(drawnBox(png).visible).toBeGreaterThan(2000);
});
