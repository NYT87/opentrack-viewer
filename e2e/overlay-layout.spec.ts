import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { widestGpx } from './helpers/overlayFixtures';

/**
 * AV-1005. The one check that needs a real layout engine: nothing the overlay
 * draws may be clipped. jsdom has no layout, so the unit tests can only prove
 * the geometry; here every rendered tile is measured against its own content.
 *
 * The clip is the real HERO8 sample (848x480, 17 s), whose container states
 * its own start; the activity is generated to start at that instant, with the
 * widest values the figures show. The frame shape under test is set by what
 * the video element reports, so the wide and portrait cases need no wide or
 * portrait video.
 */
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');
/** Makes the video element report this size, whatever it is playing. */
async function reportVideoSize(page: Page, width: number, height: number) {
  await page.addInitScript(
    ({ w, h }) => {
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => w });
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => h });
    },
    { w: width, h: height },
  );
}

const CASES = [
  { name: 'wide 3:1 on a desktop', video: [1200, 400], viewport: { width: 1280, height: 800 } },
  { name: '16:9 on a desktop', video: [1920, 1080], viewport: { width: 1280, height: 800 } },
  { name: 'portrait 9:16 on a phone', video: [1080, 1920], viewport: { width: 360, height: 740 } },
  { name: '16:9 on a phone', video: [1920, 1080], viewport: { width: 360, height: 740 } },
] as const;

for (const { name, video, viewport } of CASES) {
  test(`no overlay figure is clipped: ${name}, everything on, largest size`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await reportVideoSize(page, video[0], video[1]);
    const gpx = join(testInfo.outputDir, 'widest.gpx');
    mkdirSync(testInfo.outputDir, { recursive: true });
    writeFileSync(gpx, widestGpx());

    await page.goto('./#/overlays');
    await page.getByTestId('overlay-video-input').setInputFiles(join(FIXTURE_DIR, 'hero8.mp4'));
    await expect(page.getByRole('region', { name: 'Video' })).toContainText('hero8.mp4', {
      timeout: 30_000,
    });
    await page.getByTestId('overlay-activity-input').setInputFiles(gpx);

    const controls = page.getByRole('region', { name: 'Overlay controls' });
    await expect(controls).toBeVisible();
    await controls.getByLabel('Size').fill('1.5');

    for (const preset of ['Metric strip', 'Compact HUD', 'Route inset']) {
      await controls.getByRole('radio', { name: new RegExp(preset) }).check();
      // Each template switches different components on by default: put on
      // everything the activity supports, so every one has to fit.
      for (const box of await controls.getByRole('checkbox').all()) {
        if ((await box.isEnabled()) && !(await box.isChecked())) await box.check();
      }
      const expected = await controls.getByRole('checkbox', { checked: true }).count();
      expect(expected, `${preset}: components on`).toBe(10);
      const layer = page.getByTestId('overlay-layer');
      await expect(layer.locator('.overlay-item').first()).toBeVisible();

      const report = await layer.evaluate((root) =>
        [...root.querySelectorAll<HTMLElement>('.overlay-item')].map((item) => ({
          id: item.dataset.component,
          clippedX: item.scrollWidth - item.clientWidth,
          clippedY: item.scrollHeight - item.clientHeight,
          // Text inside must also stay within its own tile.
          text: item.textContent,
        })),
      );
      // Every component that is on is really on screen, so none escapes the check.
      expect(report.map((item) => item.id), `${preset}: components drawn`).toHaveLength(expected);
      for (const item of report) {
        expect(item.clippedX, `${preset} / ${item.id} clipped horizontally (${item.text})`).toBeLessThanOrEqual(1);
        expect(item.clippedY, `${preset} / ${item.id} clipped vertically (${item.text})`).toBeLessThanOrEqual(1);
      }
    }
  });
}
