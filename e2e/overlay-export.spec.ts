import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { CLIP_PATH, RIDE_PATH, fetchBlobBytes, widestGpx } from './helpers/overlayFixtures';
import { decodePng } from './helpers/png';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1006. The overlay-only export, end to end in a real browser: the worker,
 * the OffscreenCanvas, the origin-private file system and the download, with
 * the real HERO8 clip and an activity that lines up with it.
 */
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

async function openWithFiles(page: Page, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const gpx = join(outputDir, 'ride.gpx');
  writeFileSync(gpx, widestGpx());

  await page.goto('./#/overlays');
  await page.getByTestId('overlay-video-input').setInputFiles(join(FIXTURE_DIR, 'hero8.mp4'));
  await expect(page.getByRole('region', { name: 'Video' })).toContainText('hero8.mp4', {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-activity-input').setInputFiles(gpx);
  return page.getByRole('region', { name: 'Export overlay' });
}

/** The stored archives this origin still holds. */
const storedArchives = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    return names.filter((name) => name.startsWith('overlay-export-'));
  });

test('exports a transparent PNG sequence of the overlay, drawn and stored on this device', async ({
  page,
}, testInfo) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await openWithFiles(page, testInfo.outputDir);

  await panel.getByLabel('Frame rate').selectOption('10');
  const plan = (await panel.getByTestId('export-plan').textContent()) ?? '';
  const planned = /(\d+) frames, (\d+) × (\d+)/.exec(plan)!;
  const [frameCount, width, height] = [Number(planned[1]), Number(planned[2]), Number(planned[3])];
  expect(frameCount).toBeGreaterThan(100);

  await panel.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = panel.getByRole('link', { name: /overlay-\d+x\d+-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 90_000 });
  await expect(link).toHaveAttribute('download', /^hero8-overlay-.*\.zip$/);

  // Fetch the archive the page is offering, exactly as the download would.
  const base64 = await page.evaluate(async (href) => {
    const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }, (await link.getAttribute('href'))!);
  const entries = readZip(new Uint8Array(Buffer.from(base64, 'base64')));

  // One metadata file, then one numbered frame per planned frame.
  expect(entries[0]!.name).toBe('overlay-export.json');
  const frames = entries.slice(1);
  expect(frames).toHaveLength(frameCount);
  expect(frames[0]!.name).toBe('frame_000001.png');
  expect(frames.at(-1)!.name).toBe(`frame_${String(frameCount).padStart(6, '0')}.png`);
  expect(entries.every((entry) => entry.method === 0)).toBe(true);

  // Dimensions and duration are what was planned, and stated for the editor.
  const metadata = JSON.parse(new TextDecoder().decode(entries[0]!.data));
  expect(metadata).toMatchObject({ format: 'png-sequence', transparent: true, width, height, frameRate: 10, frameCount });
  expect(Math.abs(metadata.durationSeconds - metadata.videoDurationSeconds)).toBeLessThan(1 / 10);
  expect(JSON.stringify(metadata)).not.toMatch(/hero8|\.mp4|\.gpx/);

  // Every frame is a PNG of the planned size.
  for (const frame of [frames[0]!, frames[frameCount >> 1]!, frames.at(-1)!]) {
    const view = new DataView(frame.data.buffer, frame.data.byteOffset);
    expect(view.getUint32(0)).toBe(0x89504e47);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([width, height]);
  }

  // Transparent where nothing is drawn, opaque-ish where something is.
  const first = decodePng(Buffer.from(frames[0]!.data));
  const alphaAt = (x: number, y: number) => first.pixels[(y * first.width + x) * 4 + 3]!;
  expect([alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(width >> 1, height >> 1)]).toEqual([0, 0, 0]);
  let drawn = 0;
  for (let i = 3; i < first.pixels.length; i += 4) if (first.pixels[i]! > 0) drawn += 1;
  expect(drawn).toBeGreaterThan(1000);
  expect(drawn).toBeLessThan((first.width * first.height) / 2);

  // The overlay moves with the video: a later frame is not the first one.
  expect(Buffer.from(frames[frameCount >> 1]!.data).equals(Buffer.from(frames[0]!.data))).toBe(false);

  // Nothing left the device. A blob: URL is a reference to bytes already in this tab.
  expect(
    requests
      .map((request) => request.url())
      .filter((url) => !url.startsWith('http://localhost:4173') && !url.startsWith('blob:')),
  ).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET')).toEqual([]);

  // The stored archive goes when the reader moves on.
  expect(await storedArchives(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect.poll(() => storedArchives(page)).toEqual([]);
});

test('stops on request, keeps nothing, and can be started again', async ({ page }, testInfo) => {
  const panel = await openWithFiles(page, testInfo.outputDir);
  // The slowest settings offered, so the stop lands mid-export.
  await panel.getByLabel('Frame rate').selectOption('60');
  await panel.getByLabel('Picture size').selectOption('2160');

  await panel.getByRole('button', { name: 'Export PNG sequence' }).click();
  await expect(panel.getByText(/Frame [1-9]\d* of/)).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: 'Stop export' }).click();

  await expect(panel.getByRole('status')).toContainText('Export stopped. Nothing was saved.');
  await expect(panel.getByRole('link')).toHaveCount(0);
  await expect.poll(() => storedArchives(page)).toEqual([]);
  await expect(panel.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
});

test('says so, and offers no export, in a browser without an offscreen canvas', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'OffscreenCanvas');
  });
  const panel = await openWithFiles(page, testInfo.outputDir);

  await expect(panel.getByRole('alert')).toContainText(/cannot draw and encode images/);
  await expect(panel.getByRole('button', { name: 'Export PNG sequence' })).toHaveCount(0);
  // The preview and its controls still work.
  await expect(page.getByRole('region', { name: 'Overlay controls' })).toBeVisible();
});

test('reports an export engine that cannot start, instead of waiting on it', async ({ page }, testInfo) => {
  // A page whose policy refuses workers: `Worker` exists, constructing one throws.
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error('Worker blocked by policy');
      }
    } as unknown as typeof Worker;
  });
  const panel = await openWithFiles(page, testInfo.outputDir);

  await expect(panel.getByRole('alert')).toContainText('The export engine could not be started');
  await expect(panel.getByRole('alert')).toContainText('Worker blocked by policy');
  await expect(panel.getByRole('button', { name: 'Export PNG sequence' })).toHaveCount(0);
  await expect(panel.getByText(/Checking how this browser/)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Overlay controls' })).toBeVisible();
});

test('exports a short overlay-only asset from the committed clip and ride, fast and exactly sized', async ({ page }) => {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-video-input').setInputFiles(CLIP_PATH);
  await expect(page.getByRole('region', { name: 'Video' })).toContainText('overlay-test-clip.mp4', {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-activity-input').setInputFiles(RIDE_PATH);
  const panel = page.getByRole('region', { name: 'Export overlay' });
  await panel.getByLabel('Frame rate').selectOption('10');
  await expect(panel.getByTestId('export-plan')).toContainText('60 frames, 256 × 144');

  await panel.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = panel.getByRole('link', { name: /overlay-test-clip-overlay-256x144-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 30_000 });

  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  expect(entries).toHaveLength(61); // metadata + 6 s at 10 fps
  expect(JSON.parse(new TextDecoder().decode(entries[0]!.data))).toMatchObject({
    format: 'png-sequence',
    transparent: true,
    width: 256,
    height: 144,
    frameRate: 10,
    frameCount: 60,
    durationSeconds: 6,
    videoDurationSeconds: 6,
  });

  // Every frame is a 256×144 PNG; the first is transparent at the corners and drawn on somewhere.
  for (const frame of entries.slice(1)) {
    const view = new DataView(frame.data.buffer, frame.data.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([256, 144]);
  }
  const first = decodePng(Buffer.from(entries[1]!.data));
  const alpha = (x: number, y: number) => first.pixels[(y * first.width + x) * 4 + 3]!;
  expect([alpha(0, 0), alpha(255, 0), alpha(128, 72)]).toEqual([0, 0, 0]);
  let drawn = 0;
  for (let i = 3; i < first.pixels.length; i += 4) if (first.pixels[i]! > 0) drawn += 1;
  expect(drawn).toBeGreaterThan(100);
  // The overlay moves with the ride: the last frame is not the first.
  expect(Buffer.from(entries.at(-1)!.data).equals(Buffer.from(entries[1]!.data))).toBe(false);
});
