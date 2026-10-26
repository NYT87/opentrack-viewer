import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { RIDE_PATH } from './helpers/overlayFixtures';
import { decodePng, type DecodedPng } from './helpers/png';

/**
 * AV-1010. The still overlay image with elements placed by the reader, in a
 * real browser: a text and the date added, placed by snap, by the nudges and
 * by dragging on the preview, written to a PNG, and the PNG decoded here to
 * prove each element landed where it was put. Text is drawn by the browser's
 * own canvas, so this is where the real font is measured and drawn.
 */

/** The box around every pixel that is not fully transparent. */
function drawnBox(png: DecodedPng) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.pixels[(y * png.width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

async function download(page: Page, panel: Locator) {
  const [file] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download PNG' }).click()]);
  const path = await file.path();
  return { png: decodePng(readFileSync(path)), name: file.suggestedFilename() };
}

async function open(page: Page) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-activity-input').setInputFiles(RIDE_PATH);
  const panel = page.getByRole('region', { name: 'Overlay image' });
  await expect(panel).toBeVisible();
  return panel;
}

const position = async (panel: Locator) => ({
  x: Number(await panel.getByLabel('From the left (%)').inputValue()),
  y: Number(await panel.getByLabel('From the top (%)').inputValue()),
});

test('places a text by snap, by nudge and by dragging on the preview, and draws it there', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await open(page);

  // The text alone, so every drawn pixel is the text's.
  await panel.getByRole('button', { name: 'Remove Route' }).click();
  await panel.getByLabel('Add', { exact: true }).selectOption('label');
  await panel.getByRole('button', { name: 'Add to the image' }).click();
  await panel.getByLabel('Text', { exact: true }).fill('OpenTrack');

  // Snapped to the top left: drawn within the top-left corner, 4 % in.
  await panel.getByRole('button', { name: 'Snap to top left' }).click();
  const snapped = await download(page, panel);
  expect(snapped.name).toBe('overlay-image-1920x1080.png');
  const atTopLeft = drawnBox(snapped.png);
  expect(atTopLeft.minX).toBeGreaterThanOrEqual(Math.floor(0.04 * 1920) - 2);
  expect(atTopLeft.minX).toBeLessThan(0.04 * 1920 + 20);
  expect(atTopLeft.minY).toBeGreaterThanOrEqual(Math.floor(0.04 * 1080) - 2);
  expect(atTopLeft.maxX).toBeLessThan(1920 / 2);
  expect(atTopLeft.maxY).toBeLessThan(1080 / 2);
  // The background is transparent everywhere else.
  expect(snapped.png.pixels[((1079 * 1920) + 1919) * 4 + 3]).toBe(0);

  // Nudged right ten times: a tenth of the width further right, nothing else moved.
  for (let i = 0; i < 10; i += 1) await panel.getByRole('button', { name: 'Move right' }).click();
  expect((await position(panel)).x).toBeCloseTo(14, 0);
  const nudged = drawnBox((await download(page, panel)).png);
  expect(nudged.minX - atTopLeft.minX).toBeGreaterThan(192 - 3);
  expect(nudged.minX - atTopLeft.minX).toBeLessThan(192 + 3);
  expect(nudged.minY).toBe(atTopLeft.minY);

  // Dragged on the preview to the lower right: drawn there.
  const canvas = panel.getByTestId('route-image-preview');
  await canvas.scrollIntoViewIfNeeded();
  const frame = (await canvas.boundingBox())!;
  const { x, y } = await position(panel);
  await page.mouse.move(frame.x + (x / 100) * frame.width + 6, frame.y + (y / 100) * frame.height + 6);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.7, frame.y + frame.height * 0.75, { steps: 6 });
  await page.mouse.up();
  const dragged = await position(panel);
  expect(dragged.x).toBeGreaterThan(50);
  expect(dragged.y).toBeGreaterThan(50);
  const lowerRight = drawnBox((await download(page, panel)).png);
  expect(lowerRight.minX).toBeGreaterThan(1920 / 2);
  expect(lowerRight.minY).toBeGreaterThan(1080 / 2);
  expect(lowerRight.maxX).toBeLessThan(1920);
  expect(lowerRight.maxY).toBeLessThan(1080);

  // Nothing about the activity or the image left the page.
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    const url = request.url();
    expect(url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:'), url).toBe(true);
    expect(request.method(), url).toBe('GET');
  }
});

test('adds the date, and draws it in the format chosen', async ({ page }) => {
  const panel = await open(page);
  await panel.getByRole('button', { name: 'Remove Route' }).click();
  await panel.getByLabel('Add', { exact: true }).selectOption('date');
  await panel.getByRole('button', { name: 'Add to the image' }).click();

  // This ride's times are in UTC, so the file states no zone of its own.
  await expect(panel.getByRole('radio', { name: /The activity’s/ })).toBeDisabled();
  await expect(panel.getByRole('group', { name: 'Selected: Date' })).toContainText('does not say which time zone');

  await panel.getByLabel('Date format').selectOption({ label: '2026-09-24' });
  const short = drawnBox((await download(page, panel)).png);
  await panel.getByLabel('Date format').selectOption({ label: 'Thursday 24 September 2026' });
  const long = drawnBox((await download(page, panel)).png);
  // The same place, a longer text: wider to the right, from the same left edge.
  expect(Math.abs(long.minX - short.minX)).toBeLessThan(6);
  expect(long.maxX - long.minX).toBeGreaterThan((short.maxX - short.minX) * 1.6);
});

test('saves the layout and opens it again on a fresh page', async ({ page }, testInfo) => {
  const panel = await open(page);
  await panel.getByLabel('Add', { exact: true }).selectOption('distance');
  await panel.getByRole('button', { name: 'Add to the image' }).click();
  await panel.getByRole('button', { name: 'Snap to bottom right' }).click();
  const placed = await position(panel);

  const [file] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Save layout' }).click()]);
  expect(file.suggestedFilename()).toBe('overlay-layout.json');
  const path = testInfo.outputPath('overlay-layout.json');
  await file.saveAs(path);
  const json = readFileSync(path, 'utf-8');
  expect(json).toContain('"kind": "opentrack-overlay-layout"');
  expect(json).not.toMatch(/overlay-ride|"lat"|"lon"/);

  // A fresh page: the files live in memory only, and the still image hides the slots.
  await page.reload();
  const fresh = await open(page);
  await fresh.getByTestId('still-layout-input').setInputFiles(path);
  await expect(fresh.getByRole('status', { name: 'Layout file result' })).toContainText('Opened the layout');
  await fresh.getByRole('list', { name: 'Elements on the image' }).getByRole('button', { name: 'Distance', exact: true }).click();
  const reopened = await position(fresh);
  expect(reopened.x).toBeCloseTo(placed.x, 1);
  expect(reopened.y).toBeCloseTo(placed.y, 1);
});
