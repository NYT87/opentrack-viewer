import { expect, test, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { RIDE_PATH } from './helpers/overlayFixtures';

/**
 * AV-1102. The Route Builder page in a real browser: reached from Tools, an
 * honest empty state after a reload, a blank or imported track in memory, and
 * the app's own header, Settings and metadata around it.
 */

test('opens from the Tools menu, on a page of its own with nothing of the viewer', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Route Builder' }).click();

  await expect(page.getByRole('heading', { name: 'Route Builder' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/route-builder');
  await expect(page.getByRole('region', { name: 'Nothing planned yet' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Route map' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity charts' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Export activity' })).toHaveCount(0);
  await expect(page).toHaveTitle(/Plan a route/);
});

test('starts a blank track, and a reload leaves the empty state rather than a crash', async ({ page }) => {
  await page.goto('./#/route-builder');
  await page.getByRole('button', { name: 'Start a blank track' }).click();
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText('A new planned track');
  await expect(track).toContainText(/no points yet/i);

  // The draft lives in memory only: a reload loses it and says how to begin again.
  await page.reload();
  const empty = page.getByRole('region', { name: 'Nothing planned yet' });
  await expect(empty).toContainText(/does not survive a reload/i);
  await expect(empty.getByRole('button', { name: 'Start a blank track' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Planned track' })).toHaveCount(0);
});

test('imports a GPX route into a planned track, in this tab, and adds another after it', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto('./#/route-builder');

  await page.getByTestId('route-builder-input').setInputFiles(RIDE_PATH);
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText('Copied from a track');
  await expect(track).toContainText(/overlay-ride\.gpx: \d+ of \d+ points used/);
  await expect(track).toContainText('Distance');

  await page.getByTestId('route-builder-input').setInputFiles(RIDE_PATH);
  await expect(track.getByText('Stretches').locator('xpath=following-sibling::dd')).toHaveText('2');

  // Nothing about the track left the page, and none of it is in the metadata.
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    const url = request.url();
    expect(url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')).toBe(true);
    expect(request.method()).toBe('GET');
    expect(request.postData()).toBeNull();
    expect(url).not.toContain('overlay-ride');
  }
  expect(await page.title()).not.toContain('overlay-ride');
});

test('explains a file it cannot read, and keeps the track it has', async ({ page }) => {
  await page.goto('./#/route-builder');
  await page.getByRole('button', { name: 'Start a blank track' }).click();
  await page.getByTestId('route-builder-input').setInputFiles({
    name: 'broken.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from('<gpx><not closed'),
  });
  await expect(page.getByRole('region', { name: 'Track not imported' }).getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Try another file' }).click();
  await expect(page.getByRole('region', { name: 'Planned track' })).toBeVisible();
});

test('has the app’s header and Settings, which opens over the page without leaving it', async ({ page }) => {
  await page.goto('./#/route-builder');
  await page.getByRole('button', { name: 'Start a blank track' }).click();

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/route-builder');
  await dialog.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Planned track' })).toBeVisible();
});

test('copies the viewed route into Route Builder, and the viewer keeps its activity (AV-1103)', async ({
  page,
}) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto('./#/viewer');
  // Route-only basemap, so the viewer's map fetches no tiles and the request
  // list below measures the handoff alone.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('file-input').setInputFiles(RIDE_PATH);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();

  await page.getByRole('button', { name: 'Create custom track' }).click();

  expect(new URL(page.url()).hash).toBe('#/route-builder');
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText('Copied from a track');
  await expect(track).toContainText(/of \d+ points used/);

  // Back in the viewer, the activity is still open, untouched by the copy.
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'File viewer' }).click();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create custom track' })).toBeEnabled();

  // The handoff is memory only: nothing left the origin, and nothing was stored.
  expect(requests.map((r) => r.url()).filter((url) => !url.startsWith(new URL(page.url()).origin))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'opentrack-viewer:theme'))).toEqual([]);
});

test('fits a phone screen without a sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('./#/route-builder');
  // A file named the way a device names them: long, and with nothing a line
  // can break at. Its name is listed beside the draft, where it has to wrap.
  await page.getByTestId('route-builder-input').setInputFiles({
    name: 'Morning_Ride_2026_10_19_Export_From_Watch_Full_Resolution_Track_Final_v2.gpx',
    mimeType: 'application/gpx+xml',
    buffer: readFileSync(RIDE_PATH),
  });
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toBeVisible();
  await expect(track).toContainText('Morning_Ride_2026');

  // The page scrolls inside `.shell__scroll`, not the document, so measuring
  // the document alone would miss an overflow that lives in there.
  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector('.shell__scroll')!;
    return Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scroller.scrollWidth - scroller.clientWidth,
    );
  });
  expect(overflow).toBeLessThanOrEqual(0);
});
