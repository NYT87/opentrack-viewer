import { expect, test, type Locator, type Page } from '@playwright/test';
import { CLIP_PATH, CLIP_SECONDS, RIDE_PATH, longRideGpx, ride } from './helpers/overlayFixtures';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AV-1008. Opening the overlay page and previewing the overlay, in a real
 * browser, with a real video that really plays: the committed synthetic clip
 * and the committed ride, whose every value at every second is a formula.
 */

async function openOverlays(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Overlays' }).click();
  await expect(page.getByRole('heading', { name: 'Overlays' })).toBeVisible();
}

async function chooseFiles(page: Page, ridePath = RIDE_PATH) {
  await page.getByTestId('overlay-video-input').setInputFiles(CLIP_PATH);
  await expect(page.getByRole('region', { name: 'Video' })).toContainText('overlay-test-clip.mp4', {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-activity-input').setInputFiles(ridePath);
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  // The browser has read the clip: its length is known and the scrubber is live.
  await expect(page.getByRole('slider', { name: 'Video position' })).toBeEnabled({ timeout: 30_000 });
}

const layer = (page: Page) => page.getByTestId('overlay-layer');
const item = (page: Page, key: string): Locator => layer(page).locator(`[data-component="${key}"]`);
const valueOf = async (page: Page, key: string) =>
  (await item(page, key).locator('.overlay-item__value').textContent()) ?? '';
const videoTime = (page: Page) =>
  page.getByTestId('overlay-video').evaluate((video) => (video as HTMLVideoElement).currentTime);

/** Moves the scrubber the way a reader does: by setting its value. */
async function scrubTo(page: Page, seconds: number) {
  await page.getByRole('slider', { name: 'Video position' }).evaluate((input, value) => {
    const slider = input as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(slider, String(value));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, seconds);
}

test('opens from Tools, reads the clip and the ride, and draws the overlay at the start', async ({ page }) => {
  await openOverlays(page);
  // Nothing of the viewer: no map, no charts, before or after there is something to draw over.
  await expect(page.getByRole('region', { name: 'Route map' })).toHaveCount(0);
  await chooseFiles(page);
  await expect(page.getByRole('region', { name: 'Route map' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity charts' })).toHaveCount(0);

  // The clip is a real video: the browser reports its size and length.
  const media = await page.getByTestId('overlay-video').evaluate((video) => {
    const v = video as HTMLVideoElement;
    return { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
  });
  expect(media).toMatchObject({ width: 256, height: 144 });
  expect(media.duration).toBeCloseTo(CLIP_SECONDS, 0);

  // At t = 0 the overlay states the ride's first second.
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(0).toFixed(1)} km/h`);
  await expect(item(page, 'elevation')).toContainText(`${ride.elevation(0)} m`);
  await expect(item(page, 'heartRate')).toContainText(`${ride.heartRate(0)} bpm`);
  await expect(item(page, 'elapsed')).toContainText('0:00');
  await expect(item(page, 'route').locator('polyline')).toHaveCount(1);
  await expect(item(page, 'route').locator('circle')).toHaveCount(1);
  await expect(page.getByRole('timer', { name: 'Current time' })).toContainText('0:00 / 0:06');
});

test('follows the scrubber to exactly the values of that moment, and interpolates between seconds', async ({
  page,
}) => {
  await openOverlays(page);
  await chooseFiles(page);

  await scrubTo(page, 5);
  expect(await videoTime(page)).toBeCloseTo(5, 1);
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(5).toFixed(1)} km/h`); // 18.0
  await expect(item(page, 'heartRate')).toContainText(`${ride.heartRate(5)} bpm`);
  await expect(item(page, 'elevation')).toContainText(`${ride.elevation(5)} m`);
  await expect(item(page, 'distance')).toContainText(`${Math.round(ride.distance(5))} m`);
  await expect(item(page, 'elapsed')).toContainText('0:05');

  // Between two seconds, linearly: 2.5 s is the midpoint of 2 s and 3 s.
  await scrubTo(page, 2.5);
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(2.5).toFixed(1)} km/h`); // 16.2
  await expect(item(page, 'heartRate')).toContainText('103 bpm'); // 102.5 rounds up

  // The progress bar moved with it. It runs by distance, which grows faster than
  // time in this accelerating ride: the midpoint of 2 s and 3 s over the whole ride.
  const bar = item(page, 'progress').locator('.overlay-item__bar');
  const width = await bar.evaluate((el) => parseFloat((el as HTMLElement).style.width));
  const expected = (((ride.distance(2) + ride.distance(3)) / 2) / ride.distance(60)) * 100;
  expect(width).toBeCloseTo(expected, 1);
});

test('stays aligned with the picture through real playback, and stops where the video stops', async ({
  page,
}) => {
  await openOverlays(page);
  await chooseFiles(page);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect.poll(() => videoTime(page), { timeout: 15_000 }).toBeGreaterThan(1.5);

  // Values seen *while it plays* change from frame to frame.
  const seen = new Set<string>();
  for (let i = 0; i < 6; i += 1) {
    seen.add(await valueOf(page, 'speed'));
    await page.waitForTimeout(120);
  }
  expect(seen.size).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  // Paused: the overlay is exactly what the ride says at the moment the video stopped.
  const stoppedAt = await videoTime(page);
  const shown = parseFloat(await valueOf(page, 'speed'));
  expect(Math.abs(shown - ride.speedKmh(stoppedAt))).toBeLessThan(0.06);
  const heartRate = parseInt(await valueOf(page, 'heartRate'), 10);
  expect(Math.abs(heartRate - ride.heartRate(stoppedAt))).toBeLessThanOrEqual(0.5);

  // Let it run to the end: it stops there, with the last frame's values.
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => videoTime(page)).toBeGreaterThan(CLIP_SECONDS - 0.2);
  const last = parseFloat(await valueOf(page, 'speed'));
  expect(Math.abs(last - ride.speedKmh(await videoTime(page)))).toBeLessThan(0.1);
});

test('an offset shifts the telemetry against the picture, and a gap in the telemetry is said, not filled', async ({
  page,
}) => {
  await openOverlays(page);
  await chooseFiles(page);
  await scrubTo(page, 5);
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(5).toFixed(1)} km/h`);

  // Delay the telemetry by two seconds: at 5 s of video, the ride as it was at 3 s.
  const offset = page.getByRole('group', { name: 'Telemetry offset' });
  await offset.getByRole('button', { name: '+1 s' }).click();
  await offset.getByRole('button', { name: '+1 s' }).click();
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(3).toFixed(1)} km/h`);
  await expect(item(page, 'heartRate')).toContainText(`${ride.heartRate(3)} bpm`);

  // Typed offsets work too, and negative ones bring the ride forward.
  await offset.getByRole('spinbutton').fill('-1.5');
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(6.5).toFixed(1)} km/h`);

  // Far enough that the ride has not begun: nothing is drawn, and the page says why.
  await offset.getByRole('spinbutton').fill('30');
  await expect(layer(page).locator('.overlay-item')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Preview' }).getByRole('status')).toContainText(
    /no telemetry for this moment/i,
  );

  await offset.getByRole('button', { name: 'Reset' }).click();
  await expect(item(page, 'speed')).toContainText(`${ride.speedKmh(5).toFixed(1)} km/h`);
});

test('templates and components change what is drawn, and the session remembers them', async ({ page }) => {
  await openOverlays(page);
  await chooseFiles(page);
  await scrubTo(page, 2);
  const controls = page.getByRole('region', { name: 'Overlay controls' });

  await controls.getByRole('radio', { name: /Compact HUD/ }).check();
  await expect(item(page, 'route')).toHaveCount(0);
  await expect(item(page, 'speed')).toBeVisible();

  await controls.getByRole('checkbox', { name: 'Power' }).check();
  await expect(item(page, 'power')).toContainText(`${ride.power(2)} W`);

  await controls.getByRole('radio', { name: /Route inset/ }).check();
  await expect(item(page, 'route')).toBeVisible();
  // The reader's choice of power is kept across templates.
  await expect(item(page, 'power')).toContainText(`${ride.power(2)} W`);

  // Imperial units: 4.4 m/s is 9.8 mph.
  await controls.getByLabel('Units').selectOption('imperial');
  await expect(item(page, 'speed')).toContainText('9.8 mph');
});

test('says what the activity cannot supply instead of drawing a gap', async ({ page }, testInfo) => {
  // The same ride with the heart-rate readings taken out.
  mkdirSync(testInfo.outputDir, { recursive: true });
  const withoutHeartRate = join(testInfo.outputDir, 'ride-without-heart-rate.gpx');
  writeFileSync(withoutHeartRate, readFileSync(RIDE_PATH, 'utf8').replace(/<gpxtpx:hr>\d+<\/gpxtpx:hr>/g, ''));

  await openOverlays(page);
  await chooseFiles(page, withoutHeartRate);

  await expect(page.getByRole('list', { name: 'Overlay warnings' })).toContainText(
    'Heart rate is not in this activity, so it is not shown.',
  );
  await expect(item(page, 'heartRate')).toHaveCount(0);
  await expect(item(page, 'speed')).toBeVisible();
  // A component the activity has no data for at all cannot be turned on.
  await expect(
    page.getByRole('region', { name: 'Overlay controls' }).getByRole('checkbox', { name: /Running cadence/ }),
  ).toBeDisabled();
});

test('stays responsive with a four-hour activity, and draws its route thinned to what the box can show', async ({
  page,
}, testInfo) => {
  mkdirSync(testInfo.outputDir, { recursive: true });
  const longRide = join(testInfo.outputDir, 'four-hours.gpx');
  writeFileSync(longRide, longRideGpx(4)); // 14,401 points, over two megabytes, never committed

  await openOverlays(page);
  await page.getByTestId('overlay-video-input').setInputFiles(CLIP_PATH);
  await expect(page.getByRole('region', { name: 'Video' })).toContainText('overlay-test-clip.mp4', {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-activity-input').setInputFiles(longRide);
  await expect(page.getByRole('slider', { name: 'Video position' })).toBeEnabled({ timeout: 60_000 });
  await expect(item(page, 'speed')).toBeVisible({ timeout: 60_000 });

  // The whole four hours are on the route inset, in a few thousand points, not fourteen thousand.
  const drawn = await item(page, 'route')
    .locator('polyline')
    .evaluateAll((lines) => lines.reduce((sum, line) => sum + (line.getAttribute('points') ?? '').split(' ').length, 0));
  expect(drawn).toBeGreaterThan(50);
  expect(drawn).toBeLessThanOrEqual(3010);

  // Scrubbing is fast: 150 jumps about the clip, each waiting for the next painted frame.
  const elapsed = await page.getByRole('slider', { name: 'Video position' }).evaluate(async (input, seconds) => {
    const slider = input as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const started = performance.now();
    for (let i = 0; i < 150; i += 1) {
      set.call(slider, String(((i * 37) % 600) / 100 + 0.01 * (seconds > 0 ? 1 : 0)));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return performance.now() - started;
  }, CLIP_SECONDS);
  expect(elapsed).toBeLessThan(6000);

  // And playback does not stall the page: no task holds the main thread for half a second.
  const longest = await page.evaluate(async () => {
    let worst = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) worst = Math.max(worst, entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
    (document.querySelector('[data-testid="overlay-video"]') as HTMLVideoElement).currentTime = 0;
    await (document.querySelector('[data-testid="overlay-video"]') as HTMLVideoElement).play();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    observer.disconnect();
    return worst;
  });
  expect(longest).toBeLessThan(500);
});
