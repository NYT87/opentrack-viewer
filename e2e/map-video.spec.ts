import { expect, test, type Page, type Request } from '@playwright/test';
import { join } from 'node:path';

/**
 * AV-1202. The map video page in a real browser: reached from Tools, opened
 * on its file slot, reading a file, and handed the viewer's activity, with
 * nothing leaving the page before there is a map to draw (TD-064).
 */

const ORIGIN = 'http://localhost:4173';
const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}
const offOrigin = (requests: Request[]) => requests.map((request) => request.url()).filter((url) => !url.startsWith(ORIGIN));

test('opens from Tools on its file slot, reads a route, and fetches nothing', async ({ page }) => {
  const requests = recordRequests(page);
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

  // The basemap is on, but there is no map yet: nothing may have left the page.
  await page.waitForTimeout(1000);
  expect(offOrigin(requests)).toEqual([]);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await expect(page.getByRole('group', { name: 'Map' })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
