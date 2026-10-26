import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { widestGpx } from './helpers/overlayFixtures';

/**
 * AV-1012. The transparent WebM, end to end in a real browser: the probe, the
 * real-time recording from a canvas, the duration written into the file, and
 * the file played back over magenta to see that what is clear stayed clear.
 */
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

async function openWithFiles(page: Page, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const gpx = join(outputDir, 'ride.gpx');
  writeFileSync(gpx, widestGpx());

  await page.goto('./#/overlays');
  await page.getByTestId('overlay-video-input').setInputFiles(join(FIXTURE_DIR, 'hero8.mp4'));
  await expect(page.getByRole('region', { name: 'Video', exact: true })).toContainText('hero8.mp4', {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-activity-input').setInputFiles(gpx);
  return page.getByRole('region', { name: 'Export overlay' });
}

test('records a transparent WebM of the overlay that states its length', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await openWithFiles(page, testInfo.outputDir);

  const webm = panel.getByRole('radio', { name: /Transparent video \(WebM\)/ });
  await expect(webm).toBeEnabled({ timeout: 10_000 });
  await webm.check();
  await panel.getByLabel('Frame rate').selectOption('15');
  await expect(panel.getByTestId('export-plan')).toContainText('Recorded in real time');
  const plan = (await panel.getByTestId('export-plan').textContent()) ?? '';
  const [, frames, width, height] = /(\d+) frames, (\d+) × (\d+)/.exec(plan)!.map(Number);
  const plannedSeconds = frames! / 15;

  await panel.getByRole('button', { name: 'Export transparent video' }).click();
  const link = panel.getByRole('link', { name: /overlay-\d+x\d+-15fps\.webm/ });
  await expect(link).toBeVisible({ timeout: 90_000 });
  await expect(link).toHaveAttribute('download', /^hero8-overlay-.*\.webm$/);
  await expect(panel).toContainText('VP9 with an alpha channel');
  await expect(panel).not.toContainText('could not be written into it');

  // Play the file the page offers, over magenta, as an editor would composite it.
  const href = (await link.getAttribute('href'))!;
  const read = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const video = document.createElement('video');
    video.muted = true;
    document.body.append(video);
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('The recording could not be played.'));
      video.src = url;
    });
    const duration = video.duration;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = Math.min(1, duration / 2);
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#ff00ff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let magenta = 0;
    let drawn = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const isMagenta = pixels[i]! > 200 && pixels[i + 1]! < 60 && pixels[i + 2]! > 200;
      if (isMagenta) magenta += 1;
      else drawn += 1;
    }
    video.remove();
    return {
      header: [...bytes.slice(0, 4)],
      size: bytes.length,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      corner: [...ctx.getImageData(1, 1, 1, 1).data],
      magenta,
      drawn,
    };
  }, href);

  // An EBML file of the planned size, whose length the browser can read: not Infinity, not NaN.
  expect(read.header).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect([read.width, read.height]).toEqual([width, height]);
  expect(Number.isFinite(read.duration)).toBe(true);
  expect(Math.abs(read.duration - plannedSeconds)).toBeLessThan(0.5);

  // Clear where nothing is drawn: the magenta shows through the corner and most of the frame.
  const [r, g, b] = read.corner;
  expect(r! > 200 && g! < 60 && b! > 200, `corner ${read.corner.join(',')}`).toBe(true);
  expect(read.magenta).toBeGreaterThan((width! * height!) / 2);
  expect(read.drawn).toBeGreaterThan(1000);

  // Nothing left the device.
  expect(
    requests
      .map((request) => request.url())
      .filter((url) => !url.startsWith('http://localhost:4173') && !url.startsWith('blob:')),
  ).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET')).toEqual([]);
});

test('says so, and records nothing, when the tab is hidden mid-recording', async ({ page }, testInfo) => {
  const panel = await openWithFiles(page, testInfo.outputDir);
  const webm = panel.getByRole('radio', { name: /Transparent video \(WebM\)/ });
  await expect(webm).toBeEnabled({ timeout: 10_000 });
  await webm.check();
  await panel.getByRole('button', { name: 'Export transparent video' }).click();
  await expect(panel.getByRole('button', { name: 'Stop export' })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await expect(panel.getByRole('alert')).toContainText('this tab was hidden', { timeout: 10_000 });
  await expect(panel.getByRole('link', { name: /\.webm/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Export transparent video' })).toBeEnabled();
});
