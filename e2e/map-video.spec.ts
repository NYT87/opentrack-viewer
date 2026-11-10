import { expect, test, type Page, type Request } from '@playwright/test';
import { join } from 'node:path';
import { countPixelsNear, decodePng } from './helpers/png';

/**
 * AV-1202. The map video page in a real browser: reached from Tools, opened
 * on its file slot, reading a file, and handed the viewer's activity, with
 * nothing leaving the page before there is a map to draw (TD-064).
 */

const ORIGIN = 'http://localhost:4173';

// The service worker would answer fetches itself, out of sight of `page.route`
// and of the request log: blocked, every request the page makes is seen.
test.use({ serviceWorkers: 'block' });
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}
const offOrigin = (requests: Request[]) => requests.map((request) => request.url()).filter((url) => !url.startsWith(ORIGIN));

/**
 * OpenFreeMap, answered here: a style of a background alone, so the online
 * path runs with no live provider (AV-1210) and every request to it is seen.
 */
async function stubOpenFreeMap(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route('https://tiles.openfreemap.org/**', (route) => {
    asked.push(route.request().url());
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'land', type: 'background', paint: { 'background-color': '#2d4030' } }] }),
    });
  });
  return asked;
}

/**
 * Pixels of the preview as the reader sees it: a screenshot of the frame, not
 * the canvas's own buffer, which can hold a route the page never shows.
 */
async function previewShot(page: Page) {
  return decodePng(await page.locator('.map-video-preview__frame').screenshot());
}

test('opens from Tools on its file slot and reads a route', async ({ page }) => {
  await stubOpenFreeMap(page);
  await page.goto('./');
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Map video' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Map video' })).toBeVisible();
  const slot = page.getByRole('region', { name: 'Activity' });
  await expect(slot.getByText(/drop/i).first()).toBeVisible();
  await expect(page.getByRole('group', { name: 'Map' })).toHaveCount(0);

  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await expect(slot.getByText('route-with-elevation.gpx')).toBeVisible();
  const choice = page.getByRole('group', { name: 'Map' });
  await expect(choice.getByRole('radio', { name: /^Online map/ })).toBeChecked();
  await expect(choice).toContainText('learns which area the video shows');

  // The page's own title, never the file's.
  await expect(page).toHaveTitle(/^Make a map video/);
  expect(await page.title()).not.toContain('route-with-elevation');
});

test('refuses a file without a route, naming it', async ({ page }) => {
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'no-location.gpx'));

  const alert = page.getByRole('region', { name: 'Activity' }).getByRole('alert');
  await expect(alert).toContainText('Could not open no-location.gpx');
  await expect(alert).toContainText('no route to follow');
});

test('takes the viewer\'s activity, and shows the file slot again after a reload', async ({ page }) => {
  // Route only in the viewer, so its map asks no tile server either.
  await page.goto('./#/viewer');
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  const requests = recordRequests(page);
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));

  await page.getByRole('button', { name: 'Make a map video' }).click();

  await expect(page).toHaveURL(/#\/map-video$/);
  const slot = page.getByRole('region', { name: 'Activity' });
  await expect(slot.getByText('route-with-elevation.gpx')).toBeVisible();
  await expect(slot.getByText('From the file viewer.')).toBeVisible();
  // Tiles off in Settings: the map video starts on route only.
  await expect(page.getByRole('radio', { name: /^Route only/ })).toBeChecked();
  expect(offOrigin(requests)).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET')).toEqual([]);

  // The handoff is memory only: a reload is a fresh start, not a crash.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Map video' })).toBeVisible();
  await expect(page.getByTestId('map-video-activity-input')).toBeAttached();
  await expect(slot.getByText('route-with-elevation.gpx')).toHaveCount(0);
});

test('fits a phone screen without sideways scrolling', async ({ page }) => {
  await stubOpenFreeMap(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await expect(page.getByRole('group', { name: 'Map' })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('previews the route only with no request at all, and plays by keyboard', async ({ page }) => {
  const asked = await stubOpenFreeMap(page);
  await page.goto('./#/map-video');
  const requests = recordRequests(page);
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await page.getByRole('radio', { name: /^Route only/ }).check();

  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.locator('canvas')).toBeVisible();
  const time = preview.locator('.map-video-preview__time');
  await expect(time).toHaveText('0:00.0 / 0:30.0');

  // The middle of the route: the camera is on the marker, so the frame's centre is the route's colour.
  await page.getByRole('slider', { name: 'Position in the video' }).fill('15');
  await expect(time).toHaveText('0:15.0 / 0:30.0');
  await expect
    .poll(async () => {
      const shot = await previewShot(page);
      // The map fills the frame, and the route's colour is at its centre, where the marker is.
      const centre = (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4;
      return { orange: countPixelsNear(shot, [0xff, 0x55, 0x33], 30) > 100, centre: [...shot.pixels.subarray(centre, centre + 3)] };
    }, { timeout: 5000 })
    .toEqual({ orange: true, centre: [0xff, 0x55, 0x33] });
  const canvasBox = await page.locator('.map-video-preview__map canvas').boundingBox();
  const frameBox = await page.locator('.map-video-preview__frame').boundingBox();
  expect(Math.round(canvasBox!.height)).toBe(Math.round(frameBox!.height));

  const frame = page.getByRole('group', { name: /^Preview,/ });
  await frame.focus();
  await page.keyboard.press('Home');
  await expect(time).toHaveText('0:00.0 / 0:30.0');
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(time).not.toHaveText('0:00.0 / 0:30.0');
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

  expect(offOrigin(requests)).toEqual([]);
  expect(asked).toEqual([]);
});

test('asks OpenFreeMap for the online map, and nothing else outside the page', async ({ page }) => {
  const asked = await stubOpenFreeMap(page);
  await page.goto('./#/map-video');
  const requests = recordRequests(page);
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));

  await expect(page.locator('.map-video-preview__map canvas')).toBeVisible();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[0]).toBe('https://tiles.openfreemap.org/styles/liberty');
  expect(offOrigin(requests).filter((url) => !url.startsWith('https://tiles.openfreemap.org/'))).toEqual([]);
  // The source's attribution is not folded away.
  await expect(page.locator('.maplibregl-ctrl-attrib.maplibregl-compact')).toHaveCount(0);
});
