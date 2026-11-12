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
  await page.getByTestId('overlay-file-input').setInputFiles(RIDE_PATH);
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

test('a figure’s label and value in their own colours, and a halo of its own or none, read from an exported frame (AV-1015)', async ({ page }) => {
  const canvas = await openCanvas(page);
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');
  await expect(canvas.getByRole('group', { name: /^Canvas preview, 1280 by 720 pixels/ })).toBeVisible();

  /** A figure with a green value, a red label, both large, on a clear background, and a blue halo of the given strength. */
  const style = async (haloPercent: string) => {
    await canvas.getByLabel('Background (%)').fill('0');
    await canvas.getByLabel('Value colour').fill('#00ff00');
    await canvas.getByLabel('Label colour').fill('#ff0000');
    await canvas.getByLabel('Label size (%)').fill('300');
    await canvas.getByLabel('Value size (%)').fill('300');
    await canvas.getByLabel('Halo colour').fill('#0000ff');
    await canvas.getByLabel('Halo (%)').fill(haloPercent);
  };
  await add(canvas, 'Speed');
  await style('100');
  await canvas.getByRole('button', { name: 'Snap to top left' }).click();
  const haloed = await rectOf(canvas);
  await add(canvas, 'Distance');
  await style('0');
  await canvas.getByRole('button', { name: 'Snap to bottom right' }).click();
  const bare = await rectOf(canvas);
  // The box grew to hold the larger text, and stayed in the frame.
  expect(haloed.width).toBeGreaterThan(0.1);
  expect(bare.x + bare.width).toBeLessThanOrEqual(1 + 1e-9);
  expect(bare.y + bare.height).toBeLessThanOrEqual(1 + 1e-9);

  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const frames = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!))).slice(1);
  const png = decodePng(Buffer.from(frames[frames.length >> 1]!.data));

  /** Counts, within a box: the value's green, the label's red at about 75 %, and the halo's blue where the type is not. */
  const read = (box: { x: number; y: number; width: number; height: number }) => {
    const found = { value: 0, label: 0, halo: 0 };
    for (let y = Math.floor(box.y * png.height); y < Math.ceil((box.y + box.height) * png.height); y += 1) {
      for (let x = Math.floor(box.x * png.width); x < Math.ceil((box.x + box.width) * png.width); x += 1) {
        const [r, g, b, a] = pixel(png, x, y) as [number, number, number, number];
        if (r === 0 && g === 255 && b === 0 && a === 255) found.value += 1;
        // The label is red at 75 %; over the halo's blue it is a little less red and a little more opaque.
        else if (r > 200 && g === 0 && b < 60 && a >= 185 && a < 235) found.label += 1;
        else if (b > 200 && r < 40 && g < 40 && a > 0) found.halo += 1;
      }
    }
    return found;
  };
  const withHalo = read(haloed);
  const withoutHalo = read(bare);
  expect(withHalo.value).toBeGreaterThan(50);
  expect(withHalo.label).toBeGreaterThan(10);
  expect(withHalo.halo).toBeGreaterThan(30);
  expect(withoutHalo.value).toBeGreaterThan(50);
  expect(withoutHalo.label).toBeGreaterThan(10);
  expect(withoutHalo.halo).toBe(0);
  // Nothing is drawn where nothing was placed.
  expect(pixel(png, 640, 360)[3]).toBe(0);
});

test('a predefined power figure averaged over 3 s reads, in an exported frame, as the plain figure did 1.5 s earlier (AV-1016)', async ({ page }) => {
  const canvas = await openCanvas(page);
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');
  await expect(canvas.getByRole('group', { name: /^Canvas preview, 1280 by 720 pixels/ })).toBeVisible();

  // The registry's entry is in the Add list, under Cycling, with its default 3 s window.
  await add(canvas, 'Power, 3 s average');
  await expect(canvas.getByLabel('Smoothing (s)')).toHaveValue('3');
  await expect(canvas.getByLabel('Smoothing (s)')).toHaveAccessibleDescription('0 turns it off');

  /** The same look for both figures, in boxes of whole pixels: 256 × 108 at (128, 72) and at (768, 432). */
  const place = async (left: string, top: string) => {
    await canvas.getByLabel('Label', { exact: true }).fill('Power 3s');
    await canvas.getByLabel('Width (%)').fill('20');
    await canvas.getByLabel('Height (%)').fill('15');
    await canvas.getByLabel('From the left (%)').fill(left);
    await canvas.getByLabel('From the top (%)').fill(top);
  };
  await place('10', '10');
  // The plain figure of the same power, to be read where the average was.
  await add(canvas, 'Power');
  await place('60', '60');
  await expect(canvas.getByLabel('Smoothing (s)')).toHaveValue('0');

  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const frames = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!))).slice(1);
  const frameAt = (seconds: number) => decodePng(Buffer.from(frames[Math.round(seconds * 10)]!.data));
  const crop = (png: DecodedPng, x: number, y: number) => {
    const rows: Buffer[] = [];
    for (let row = 0; row < 108; row += 1) rows.push(Buffer.from(png.pixels.subarray(((y + row) * png.width + x) * 4, ((y + row) * png.width + x + 256) * 4)));
    return Buffer.concat(rows);
  };
  const smoothed = (seconds: number) => crop(frameAt(seconds), 128, 72);
  const plain = (seconds: number) => crop(frameAt(seconds), 768, 432);

  // The ride's power is 150 + 2 t W: the 3 s average at 30 s is the plain value at 28.5 s (207 W).
  expect(drawnWithin(frameAt(30), { x: 0.1, y: 0.1, width: 0.2, height: 0.15 })).toBeGreaterThan(50);
  expect(smoothed(30).equals(plain(28.5))).toBe(true);
  // And it is not the plain value at that moment (210 W), nor the one of the second before (205 W).
  expect(smoothed(30).equals(plain(30))).toBe(false);
  expect(smoothed(30).equals(plain(27.5))).toBe(false);
  // The same elsewhere in the ride, and the frame before it is the average a tenth earlier.
  expect(smoothed(45).equals(plain(43.5))).toBe(true);
  expect(smoothed(20).equals(plain(18.5))).toBe(true);
});
