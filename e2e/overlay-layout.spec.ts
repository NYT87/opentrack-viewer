import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

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
const HERO8_START = '2019-11-18T15:41:25Z';

function widestGpx(): string {
  const start = Date.parse(HERO8_START);
  const points = Array.from({ length: 21 }, (_, i) => {
    const time = new Date(start + i * 1000).toISOString().replace('.000Z', 'Z');
    return `<trkpt lat="${(51.5 + i * 0.0003).toFixed(5)}" lon="${(0.001 * i).toFixed(5)}">
        <ele>${1000 + i}</ele><time>${time}</time>
        <extensions><speed>27.8</speed><gpxtpx:TrackPointExtension>
          <gpxtpx:hr>${188 + (i % 3)}</gpxtpx:hr><gpxtpx:cad>${88 + (i % 3)}</gpxtpx:cad>
          <power>${999 + (i % 2)}</power></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Widest values</name><type>cycling</type><trkseg>${points.join('')}</trkseg></trk>
</gpx>`;
}

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
