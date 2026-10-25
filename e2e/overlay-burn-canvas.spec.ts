import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_DIR, widestGpx } from './helpers/overlayFixtures';

/**
 * AV-1011. The custom canvas over a video, in the browser with an H.264
 * encoder (the `chromium-codecs` project): the HERO8 clip and an activity that
 * begins at its first frame. The preview plays over the video, both exporters
 * are offered, and the burned-in render refuses a canvas of another shape.
 */
async function openCanvas(page: Page, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const gpx = join(outputDir, 'ride.gpx');
  writeFileSync(gpx, widestGpx());
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-video-input').setInputFiles(join(FIXTURE_DIR, 'hero8.mp4'));
  await expect(page.getByRole('region', { name: 'Video', exact: true })).toContainText('hero8.mp4', { timeout: 30_000 });
  await page.getByTestId('overlay-activity-input').setInputFiles(gpx);
  await page.getByRole('radio', { name: 'A custom canvas over the video' }).check();
  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  return canvas;
}

test('with a video: the preview plays over it, and the burned-in render needs the video’s shape', async ({ page }, testInfo) => {
  const canvas = await openCanvas(page, testInfo.outputDir);
  await expect(canvas.getByTestId('canvas-video')).toBeAttached();
  await canvas.getByLabel('Add', { exact: true }).selectOption({ label: 'Speed' });
  await canvas.getByRole('button', { name: 'Add to the canvas' }).click();
  await expect(canvas.getByRole('list', { name: 'Elements on the canvas' })).toContainText('Speed');

  // The preview follows the video's clock: playing moves the canvas time on.
  const shown = canvas.getByRole('timer', { name: 'Canvas time shown' });
  const start = await shown.textContent();
  await canvas.getByRole('button', { name: 'Play' }).click();
  await expect(shown).not.toHaveText(start ?? '', { timeout: 10_000 });
  await canvas.getByRole('button', { name: 'Pause' }).click();

  // Something is drawn on the preview over the video.
  const drawn = await canvas.getByTestId('canvas-preview').evaluate((element: HTMLCanvasElement) => {
    const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) count += 1;
    return count;
  });
  expect(drawn).toBeGreaterThan(100);

  // Both exporters are offered; the burned-in one refuses a square canvas over a wide video.
  await expect(canvas.getByRole('region', { name: 'Export overlay' })).toBeVisible();
  const burn = canvas.getByRole('region', { name: 'Export video with the overlay' });
  await expect(burn).toBeVisible();
  await canvas.getByLabel('Size', { exact: true }).selectOption({ label: 'Same as the video (848 × 480)' });
  await expect(burn.getByTestId('burn-plan').or(burn.getByRole('alert')).first()).toBeVisible({ timeout: 30_000 });
  const refusal = await burn.getByRole('alert').allTextContents();
  test.skip(refusal.length > 0, `This machine cannot render here: ${refusal.join(' ')}`);
  await canvas.getByLabel('Size', { exact: true }).selectOption('1080x1080');
  await expect(burn).toContainText('which is not the video’s shape');
  await expect(burn.getByRole('button', { name: 'Render video with overlay' })).toBeDisabled();
  // 848 × 480 is not quite 16:9, so even 1280 × 720 is another shape; the video's own size is offered.
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');
  await expect(burn).toContainText('which is not the video’s shape');
  await canvas.getByLabel('Size', { exact: true }).selectOption({ label: 'Same as the video (848 × 480)' });
  await expect(burn).not.toContainText('which is not the video’s shape');
  await expect(burn.getByRole('button', { name: 'Render video with overlay' })).toBeEnabled();
});
