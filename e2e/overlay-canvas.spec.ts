import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { RIDE_PATH, fetchBlobBytes } from './helpers/overlayFixtures';
import { decodePng, type DecodedPng } from './helpers/png';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1011. The custom canvas in a real browser: a resolution chosen, a shape
 * and a text added, placed by snap and by dragging on the preview, the shape
 * styled, and the overlay exported as a PNG sequence across the activity with
 * no video. The frames are decoded here to prove each element is drawn where
 * it was put, in the colour it was given. The canvas over a video is in
 * `overlay-burn-canvas.spec.ts`, which needs a browser with an H.264 encoder.
 */

async function openCanvas(page: Page) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-activity-input').setInputFiles(RIDE_PATH);
  await page.getByRole('radio', { name: 'A custom video overlay, with no video' }).check();
  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  return canvas;
}

async function add(canvas: Locator, label: string) {
  await canvas.getByLabel('Add', { exact: true }).selectOption({ label });
  await canvas.getByRole('button', { name: 'Add to the canvas' }).click();
}

const rectOf = async (canvas: Locator) => {
  const read = async (label: string) => Number(await canvas.getByLabel(label, { exact: true }).inputValue()) / 100;
  return { x: await read('From the left (%)'), y: await read('From the top (%)'), width: await read('Width (%)'), height: await read('Height (%)') };
};

const pixel = (png: DecodedPng, x: number, y: number) => {
  const at = (Math.round(y) * png.width + Math.round(x)) * 4;
  return [...png.pixels.subarray(at, at + 4)];
};

/** Whether anything is drawn inside a box of the frame. */
function drawnWithin(png: DecodedPng, box: { x: number; y: number; width: number; height: number }) {
  let drawn = 0;
  for (let y = Math.floor(box.y * png.height); y < Math.ceil((box.y + box.height) * png.height); y += 1) {
    for (let x = Math.floor(box.x * png.width); x < Math.ceil((box.x + box.width) * png.width); x += 1) {
      if (png.pixels[(y * png.width + x) * 4 + 3]! > 0) drawn += 1;
    }
  }
  return drawn;
}

test('without a video: a chosen size, a shape and a text placed and styled, exported across the activity', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const canvas = await openCanvas(page);

  // The resolution, by preset: the preview takes its shape.
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');
  await expect(canvas.getByRole('group', { name: /^Canvas preview, 1280 by 720 pixels/ })).toBeVisible();

  // A rounded rectangle, solid red, snapped to the top left.
  await add(canvas, 'Rounded rectangle');
  await canvas.getByLabel('Fill colour').fill('#ff0000');
  await canvas.getByLabel('Fill opacity (%)').fill('100');
  await canvas.getByRole('button', { name: 'Snap to top left' }).click();

  // Dragged on the preview to the middle of the frame.
  const preview = canvas.getByTestId('canvas-preview');
  await preview.scrollIntoViewIfNeeded();
  const frame = (await preview.boundingBox())!;
  const before = await rectOf(canvas);
  await page.mouse.move(frame.x + (before.x + before.width / 2) * frame.width, frame.y + (before.y + before.height / 2) * frame.height);
  await page.mouse.down();
  await page.mouse.move(frame.x + 0.5 * frame.width, frame.y + 0.5 * frame.height, { steps: 8 });
  await page.mouse.up();
  const card = await rectOf(canvas);
  expect(card.x + card.width / 2).toBeCloseTo(0.5, 1);
  expect(card.y + card.height / 2).toBeCloseTo(0.5, 1);

  // The preview draws it red, there.
  const centre = await preview.evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext('2d')!.getImageData(element.width >> 1, element.height >> 1, 1, 1).data;
    return [...data];
  });
  expect(centre).toEqual([255, 0, 0, 255]);

  // A text, snapped to the bottom right.
  await add(canvas, 'Text');
  await canvas.getByLabel('Text', { exact: true }).fill('OpenTrack');
  await canvas.getByRole('button', { name: 'Snap to bottom right' }).click();
  // A text is as large as it is drawn, so it has no size fields: its corner of the frame, clear of the card.
  const textBox = { x: 0.7, y: 0.8, width: 0.3, height: 0.2 };

  // Exported at the canvas's size, across the whole activity, at 10 fps.
  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  const plan = (await exporter.getByTestId('export-plan').textContent()) ?? '';
  const planned = /(\d+) frames, (\d+) × (\d+)/.exec(plan)!;
  expect([Number(planned[2]), Number(planned[3])]).toEqual([1280, 720]);
  // The ride lasts a minute: about 600 frames at 10 fps.
  expect(Number(planned[1])).toBeGreaterThan(590);
  expect(Number(planned[1])).toBeLessThan(612);

  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  await expect(link).toHaveAttribute('download', 'overlay-ride-overlay-1280x720-10fps.zip');
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  const frames = entries.slice(1);
  expect(frames).toHaveLength(Number(planned[1]));

  for (const entry of [frames[0]!, frames[frames.length >> 1]!]) {
    const png = decodePng(Buffer.from(entry.data));
    expect([png.width, png.height]).toEqual([1280, 720]);
    // The shape: solid red at its centre, where it was dragged.
    expect(pixel(png, (card.x + card.width / 2) * 1280, (card.y + card.height / 2) * 720)).toEqual([255, 0, 0, 255]);
    // The text: drawn in its box at the bottom right.
    expect(drawnWithin(png, textBox)).toBeGreaterThan(50);
    // Transparent where nothing was placed.
    expect(pixel(png, 4, 716)[3]).toBe(0);
    expect(pixel(png, 1276, 4)[3]).toBe(0);
  }

  // Nothing left the page.
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    const url = request.url();
    expect(url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:'), url).toBe(true);
    expect(request.method(), url).toBe('GET');
  }
});
