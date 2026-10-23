import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { readMp4 } from './helpers/mp4';
import { widestGpx } from './helpers/overlayFixtures';

/**
 * AV-1007. Burned-in video export, end to end in a real browser: the real HERO8
 * clip (848×480 H.264 with AAC sound) is decoded, the overlay is drawn over
 * every frame, and the result is encoded to a new MP4 — which is then opened
 * and its pictures compared with the source's.
 */
const FIXTURE = join(process.cwd(), 'src/test/fixtures/hero8.mp4');

async function openWithFiles(page: Page, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const gpx = join(outputDir, 'ride.gpx');
  writeFileSync(gpx, widestGpx());
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-video-input').setInputFiles(FIXTURE);
  await expect(page.getByRole('region', { name: 'Video', exact: true })).toContainText('hero8.mp4', {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-activity-input').setInputFiles(gpx);
  return page.getByRole('region', { name: 'Export video with the overlay' });
}

const storedArchives = (page: Page) =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.filter((name) => name.startsWith('overlay-export-'));
  });

test('renders the video with the overlay burned in, keeps the sound, and uploads nothing', async ({
  page,
}, testInfo) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  const panel = await openWithFiles(page, testInfo.outputDir);

  const render = panel.getByRole('button', { name: 'Render video with overlay' });
  await expect(panel.getByTestId('burn-plan')).toBeVisible({ timeout: 30_000 });
  const refusal = await panel.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot render here: ${refusal.join(' ')}`);
  await expect(panel.getByRole('list', { name: 'About this render' })).toContainText(
    'The sound is copied from your video unchanged.',
  );
  await expect(panel.getByTestId('burn-plan')).toContainText('848 × 480, H.264');

  await render.click();
  const link = panel.getByRole('link', { name: /hero8-with-overlay\.mp4/ });
  await expect(link).toBeVisible({ timeout: 120_000 });
  await expect(link).toHaveAttribute('download', 'hero8-with-overlay.mp4');

  const base64 = await page.evaluate(async (href) => {
    const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }, (await link.getAttribute('href'))!);
  const output = Buffer.from(base64, 'base64');
  const source = readFileSync(FIXTURE);

  // A new MP4: H.264 at the source's size and length, with the sound carried over.
  const [made, original] = await Promise.all([readMp4(output), readMp4(source)]);
  const video = made.tracks.find((track) => track.type === 'video')!;
  const audio = made.tracks.find((track) => track.type === 'audio')!;
  const sourceVideo = original.tracks.find((track) => track.type === 'video')!;
  const sourceAudio = original.tracks.find((track) => track.type === 'audio')!;
  expect(video.codec).toMatch(/^avc1/);
  expect([video.width, video.height]).toEqual([848, 480]);
  expect(Math.abs(made.durationSeconds - original.durationSeconds)).toBeLessThan(0.5);
  expect(Math.abs(video.sampleCount - sourceVideo.sampleCount)).toBeLessThanOrEqual(2);
  expect(audio.codec).toBe(sourceAudio.codec);
  expect(audio.sampleCount).toBe(sourceAudio.sampleCount);
  expect(output.equals(source)).toBe(false);

  // The picture has the overlay in it: the strip along the bottom, where the
  // figures are, differs from the source far more than the untouched top does.
  // Frames are decoded with WebCodecs, as the app itself does: Chromium's own
  // <video> has no H.264, but its decoder does.
  const mediabunny = readFileSync(
    join(process.cwd(), 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'),
    'utf8',
  );
  const compared = await page.evaluate(
    async ({ madeB64, sourceB64, library }) => {
      const mb = await import(URL.createObjectURL(new Blob([library], { type: 'text/javascript' })));
      const frameAt = async (b64: string, time: number) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const input = new mb.Input({ source: new mb.BlobSource(new Blob([bytes])), formats: [mb.MP4] });
        const track = await input.getPrimaryVideoTrack();
        const sample = await new mb.VideoSampleSink(track).getSample(time);
        const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
        const ctx = canvas.getContext('2d')!;
        sample.draw(ctx, 0, 0);
        sample.close();
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };
      const a = await frameAt(madeB64, 3);
      const b = await frameAt(sourceB64, 3);
      const meanDiff = (from: number, to: number) => {
        let sum = 0;
        let count = 0;
        for (let y = from; y < to; y += 1) {
          for (let x = 0; x < a.width; x += 1) {
            const i = (y * a.width + x) * 4;
            sum +=
              Math.abs(a.data[i]! - b.data[i]!) +
              Math.abs(a.data[i + 1]! - b.data[i + 1]!) +
              Math.abs(a.data[i + 2]! - b.data[i + 2]!);
            count += 3;
          }
        }
        return sum / count;
      };
      const h = a.height;
      return { top: meanDiff(0, Math.floor(h * 0.5)), bottom: meanDiff(Math.floor(h * 0.8), h) };
    },
    { madeB64: base64, sourceB64: source.toString('base64'), library: mediabunny },
  );
  expect(compared.bottom).toBeGreaterThan(compared.top * 3);
  expect(compared.bottom).toBeGreaterThan(8);

  // Nothing left the device.
  expect(
    requests.map((r) => r.url()).filter((url) => !url.startsWith('http://localhost:4173') && !url.startsWith('blob:')),
  ).toEqual([]);
  expect(requests.filter((r) => r.method() !== 'GET')).toEqual([]);

  // The stored render goes when the reader moves on.
  expect(await storedArchives(page)).toHaveLength(1);
  await page.getByRole('button', { name: 'Start over' }).click();
  // A finished export is waiting, so Start over asks first (TD-059).
  await page.getByRole('button', { name: 'Start over anyway' }).click();
  await expect.poll(() => storedArchives(page)).toEqual([]);
});

test('stops on request, keeps nothing, and can be started again', async ({ page }, testInfo) => {
  const panel = await openWithFiles(page, testInfo.outputDir);
  const render = panel.getByRole('button', { name: 'Render video with overlay' });
  await expect(panel.getByTestId('burn-plan')).toBeVisible({ timeout: 30_000 });
  test.skip((await panel.getByRole('alert').count()) > 0, 'This machine cannot render here.');

  // The slowest size offered, so the stop lands in the middle of the render.
  await panel.getByLabel('Picture size').selectOption('2160');
  await expect(panel.getByTestId('burn-plan')).toContainText('3816 × 2160');
  await expect(render).toBeEnabled({ timeout: 30_000 });
  await render.click();
  await expect(panel.getByRole('progressbar', { name: 'Render progress' })).toBeVisible();
  await expect(panel.getByText(/^\s*[1-9]\d?% —/)).toBeVisible({ timeout: 60_000 });

  await panel.getByRole('button', { name: 'Stop render' }).click();
  await expect(panel.getByRole('status')).toContainText('Render stopped. Nothing was saved.');
  await expect(panel.getByRole('link')).toHaveCount(0);
  await expect.poll(() => storedArchives(page)).toEqual([]);
  await expect(render).toBeEnabled();
});

test('says so, and offers no render, in a browser without WebCodecs', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'VideoEncoder');
  });
  const panel = await openWithFiles(page, testInfo.outputDir);

  await expect(panel.getByRole('alert')).toContainText(/no video encoder and decoder/);
  await expect(panel.getByRole('button', { name: 'Render video with overlay' })).toHaveCount(0);
  // The overlay-only export is unaffected.
  await expect(page.getByRole('region', { name: 'Export overlay' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

  test('is declared desktop-only, and points to the overlay-only export', async ({ page }, testInfo) => {
    const panel = await openWithFiles(page, testInfo.outputDir);
    await expect(panel.getByRole('alert')).toContainText('desktop browsers only');
    await expect(panel.getByRole('alert')).toContainText('The overlay-only export still works.');
    await expect(panel.getByRole('button', { name: 'Render video with overlay' })).toHaveCount(0);
  });
});
