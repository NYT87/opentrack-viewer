import { expect, test, type Locator, type Page } from '@playwright/test';
import { RIDE_PATH, fetchBlobBytes } from './helpers/overlayFixtures';
import { decodePng, solidPng, type DecodedPng } from './helpers/png';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1030 (TD-102). An image component in a real browser: a PNG and an SVG chosen from files, fitted
 * and made translucent, and the overlay exported as a PNG sequence; the frame is decoded here for the
 * pictures' pixels. The SVG carries a script that would set a global: it must never run.
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" onload="window.__svgRan = true">
  <script>window.__svgRan = true; document.title = 'ran';</script>
  <rect width="100" height="100" fill="#00ff00"/>
</svg>`;

async function openCanvas(page: Page) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-file-input').setInputFiles(RIDE_PATH);
  await page.getByRole('radio', { name: 'A custom video overlay, with no video' }).check();
  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  return canvas;
}

async function addImage(canvas: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  await canvas.getByLabel('Add', { exact: true }).selectOption({ label: 'Image from a file' });
  await canvas.getByTestId('canvas-image-input').setInputFiles(file);
  await expect(canvas.getByText(`Added ${file.name}.`)).toBeVisible();
}

async function setField(canvas: Locator, label: string, value: string) {
  const field = canvas.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.blur();
}

const pixel = (png: DecodedPng, x: number, y: number) => {
  const at = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [...png.pixels.subarray(at, at + 4)];
};

test('a PNG and an SVG with a script, fitted and made translucent, are in the exported frames; nothing runs', async ({ page }) => {
  const canvas = await openCanvas(page);
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');

  // A text file is refused, with the reason, and adds nothing.
  await canvas.getByLabel('Add', { exact: true }).selectOption({ label: 'Image from a file' });
  await canvas.getByTestId('canvas-image-input').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not a picture') });
  await expect(canvas.getByRole('alert').filter({ hasText: 'notes.png is not a PNG, JPEG, WebP or SVG' })).toBeVisible();
  await expect(canvas.getByRole('list', { name: 'Elements on the canvas' })).toHaveCount(0);

  // A red square, contained in a wide box: letterboxed, so the box's ends stay clear.
  await addImage(canvas, { name: 'red.png', mimeType: 'image/png', buffer: solidPng(16, [255, 0, 0]) });
  await setField(canvas, 'From the left (%)', '10');
  await setField(canvas, 'From the top (%)', '10');
  await setField(canvas, 'Width (%)', '40');
  await setField(canvas, 'Height (%)', '20');
  await expect(canvas.getByLabel('Fit', { exact: true })).toHaveValue('contain');

  // A green SVG whose script would set a global, half opaque, in a box of its own.
  await addImage(canvas, { name: 'green.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(SVG) });
  await setField(canvas, 'From the left (%)', '60');
  await setField(canvas, 'From the top (%)', '10');
  await setField(canvas, 'Width (%)', '30');
  await setField(canvas, 'Height (%)', '30');
  await setField(canvas, 'Opacity (%)', '50');

  // The preview draws them too (at its own, smaller size).
  const preview = canvas.getByTestId('canvas-preview');
  const drawn = await preview.evaluate((element: HTMLCanvasElement) => {
    const at = (x: number, y: number) => [...element.getContext('2d')!.getImageData(Math.round(element.width * x), Math.round(element.height * y), 1, 1).data];
    return { red: at(0.3, 0.2), green: at(0.75, 0.25) };
  });
  expect(drawn.red).toEqual([255, 0, 0, 255]);
  expect(drawn.green[1]).toBe(255);
  expect(drawn.green[3]).toBeGreaterThan(120);
  expect(drawn.green[3]).toBeLessThan(135);

  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  const frames = entries.slice(1);

  for (const entry of [frames[0]!, frames[frames.length >> 1]!]) {
    const png = decodePng(Buffer.from(entry.data));
    expect([png.width, png.height]).toEqual([1280, 720]);
    // The PNG: red where the contained square is (x 312..456, y 72..216 of the box 128..640), clear in the letterbox.
    expect(pixel(png, 384, 144)).toEqual([255, 0, 0, 255]);
    expect(pixel(png, 140, 144)[3]).toBe(0);
    expect(pixel(png, 620, 144)[3]).toBe(0);
    // The SVG, rasterized on the page at its box and drawn half opaque: green, alpha about 128.
    const green = pixel(png, 960, 180);
    expect(green[0]).toBe(0);
    expect(green[1]).toBe(255);
    expect(Math.abs(green[3]! - 128)).toBeLessThanOrEqual(2);
    // Square, contained in 384 x 216: its sides at x 852 and 1068, clear beyond them.
    expect(pixel(png, 860, 180)[3]).toBeGreaterThan(120);
    expect(pixel(png, 800, 180)[3]).toBe(0);
    // Clear where nothing was placed.
    expect(pixel(png, 4, 716)[3]).toBe(0);
  }

  // The SVG's script never ran: not in the preview, not in the export, and the page's title is its own.
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__svgRan)).toBeUndefined();
  expect(await page.title()).not.toBe('ran');
});
