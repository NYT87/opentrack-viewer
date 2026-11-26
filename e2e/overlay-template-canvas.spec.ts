import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURE_DIR, fetchBlobBytes, widestGpx } from './helpers/overlayFixtures';
import { decodePng, type DecodedPng } from './helpers/png';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1028 (TD-100). A template opened on the custom canvas in a real browser: the template
 * chosen over the HERO8 clip, its components opened on the canvas, one figure dragged on the
 * preview, and a PNG frame exported with the figure where it was dragged to and nowhere near
 * where the template put it.
 */
const drawnWithin = (png: DecodedPng, box: { x: number; y: number; width: number; height: number }) => {
  let drawn = 0;
  for (let y = Math.floor(box.y * png.height); y < Math.ceil((box.y + box.height) * png.height); y += 1) {
    for (let x = Math.floor(box.x * png.width); x < Math.ceil((box.x + box.width) * png.width); x += 1) {
      if (png.pixels[(y * png.width + x) * 4 + 3]! > 0) drawn += 1;
    }
  }
  return drawn;
};

test('picks a template, opens it on the canvas, drags a figure and exports a frame where it has moved', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  mkdirSync(testInfo.outputDir, { recursive: true });
  const gpx = join(testInfo.outputDir, 'ride.gpx');
  writeFileSync(gpx, widestGpx());
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-file-input').setInputFiles(join(FIXTURE_DIR, 'hero8.mp4'));
  await expect(page.getByRole('group', { name: 'Video', exact: true })).toContainText('hero8.mp4', { timeout: 30_000 });
  await page.getByTestId('overlay-file-input').setInputFiles(gpx);

  const controls = page.getByRole('region', { name: 'Overlay controls' });
  await controls.getByRole('radio', { name: 'Metric strip' }).check();
  await expect(page.getByText('To move or resize the components, open them on the canvas.')).toBeVisible();
  await controls.getByRole('button', { name: 'Move and resize on the canvas' }).click();

  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  // The canvas is the video's size, holding the strip's figures.
  const elements = canvas.getByRole('list', { name: 'Elements on the canvas' });
  await expect(elements).toContainText('Speed');
  await elements.getByRole('button', { name: /Speed/ }).first().click();

  const read = async (label: string) => Number(await canvas.getByLabel(label, { exact: true }).inputValue()) / 100;
  const before = { x: await read('From the left (%)'), y: await read('From the top (%)') };

  // Dragged on the preview from its middle to the top left quarter of the frame.
  const preview = canvas.getByTestId('canvas-preview');
  await preview.scrollIntoViewIfNeeded();
  const frame = (await preview.boundingBox())!;
  const width = await read('Width (%)');
  const height = await read('Height (%)');
  await page.mouse.move(frame.x + (before.x + width / 2) * frame.width, frame.y + (before.y + height / 2) * frame.height);
  await page.mouse.down();
  await page.mouse.move(frame.x + 0.2 * frame.width, frame.y + 0.2 * frame.height, { steps: 8 });
  await page.mouse.up();
  const after = { x: await read('From the left (%)'), y: await read('From the top (%)') };
  expect(after.y).toBeLessThan(before.y - 0.2);

  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-\d+x\d+-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  const png = decodePng(Buffer.from(entries[1]!.data));

  // Drawn where it was dragged to, and not where the template had put it.
  expect(drawnWithin(png, { x: after.x, y: after.y, width, height })).toBeGreaterThan(50);
  expect(drawnWithin(png, { x: before.x, y: before.y, width, height })).toBe(0);
});
