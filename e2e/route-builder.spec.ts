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

  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
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
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
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
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => !['opentrack-viewer:theme', 'opentrack-viewer:basemap'].includes(k)))).toEqual([]);
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

  // Appended under the same kind of name, the notice names it too, and must wrap as well.
  await page.getByTestId('route-builder-input').setInputFiles({
    name: 'Evening_Ride_2026_10_19_Export_From_Watch_Full_Resolution_Track_Final_v2.gpx',
    mimeType: 'application/gpx+xml',
    buffer: readFileSync(RIDE_PATH),
  });
  await expect(page.getByRole('status', { name: 'Last track added' })).toContainText('Evening_Ride_2026');

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

test('draws the draft on a map and edits it point by point (AV-1104)', async ({ page }) => {
  await page.goto('./#/route-builder');
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Start a blank track' }).click();

  // The map is there before the first point, ready to be pressed.
  const mapRegion = page.getByRole('region', { name: 'Draft map' });
  await expect(mapRegion.locator('.maplibregl-canvas')).toBeVisible();

  // Two points typed in: a line a little over a kilometre long.
  const add = page.getByRole('form', { name: 'Add a point by coordinates' });
  await add.getByLabel('Latitude').fill('43.00');
  await add.getByLabel('Longitude').fill('-8.00');
  await add.getByRole('button', { name: 'Add point' }).click();
  await add.getByLabel('Latitude').fill('43.01');
  await add.getByLabel('Longitude').fill('-8.00');
  await add.getByRole('button', { name: 'Add point' }).click();

  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText('2');
  await expect(track).toContainText(/1\.1\d? km|1\.1 km/);

  // An impossible place is refused with a word, not a crash, and nothing changes.
  await add.getByLabel('Latitude').fill('95');
  await add.getByRole('button', { name: 'Add point' }).click();
  await expect(page.getByRole('region', { name: 'Edit points' }).getByRole('status')).toContainText(
    /Latitude must be/,
  );
  await expect(track).toContainText(/Points\s*2/);

  // The last point added is selected; removing it leaves one.
  await page.getByRole('button', { name: 'Remove point' }).click();
  await expect(track).toContainText(/Points\s*1/);
});

test('cuts a section out of the track, shows it first, and takes it back (AV-1105)', async ({ page }) => {
  await page.goto('./#/route-builder');
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Start a blank track' }).click();

  const add = page.getByRole('form', { name: 'Add a point by coordinates' });
  for (const lat of ['43.00', '43.01', '43.02', '43.03']) {
    await add.getByLabel('Latitude').fill(lat);
    await add.getByLabel('Longitude').fill('-8.00');
    await add.getByRole('button', { name: 'Add point' }).click();
  }
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText(/Points\s*4/);

  // Points 2 and 3 become the section; it is named before it is cut.
  await page.getByRole('button', { name: 'Deselect' }).click();
  await page.getByRole('button', { name: 'Next point' }).click();
  await page.getByRole('button', { name: 'Next point' }).click();
  await page.getByRole('button', { name: 'Section starts here' }).click();
  await page.getByRole('button', { name: 'Next point' }).click();
  await page.getByRole('button', { name: 'Section ends here' }).click();
  const section = page.getByRole('group', { name: 'Section' });
  await expect(section).toContainText('Section: points 2 to 3 (2 points), shown on the map');

  await page.getByRole('button', { name: 'Discard section' }).click();
  await expect(track).toContainText(/Points\s*2/);
  await expect(track).toContainText(/Stretches\s*1/);
  await expect(page.getByRole('region', { name: 'Edit points' }).getByRole('status')).toContainText(
    /Discarded 2 points/,
  );

  await page.getByRole('button', { name: 'Undo last edit' }).click();
  await expect(track).toContainText(/Points\s*4/);
});

test('appends a TCX after a GPX, warns of the far jump, and sends nothing anywhere (AV-1106)', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto('./#/route-builder');
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.getByTestId('route-builder-input').setInputFiles('src/test/fixtures/simple-route.gpx');
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText(/Stretches\s*1/);

  await page.getByTestId('route-builder-input').setInputFiles('src/test/fixtures/ride-minimal.tcx');
  await expect(track).toContainText(/Stretches\s*2/);
  const added = page.getByRole('status', { name: 'Last track added' });
  await expect(added).toContainText('ride-minimal.tcx');
  await expect(added).toContainText(/far apart/);

  // The joined map is a preview until editing is explicitly enabled.
  const preview = await track.textContent();
  await page.getByRole('region', { name: 'Draft map' }).locator('canvas').click();
  await expect(track).toHaveText(preview!);
  await expect(page.getByRole('region', { name: 'Edit points' })).toHaveCount(0);

  // Joined on request: one stretch.
  await page.getByRole('button', { name: 'Edit this track' }).click();
  await added.getByRole('button', { name: 'Select the join' }).click();
  await page.getByRole('button', { name: 'Join to the point before' }).click();
  await expect(track).toContainText(/Stretches\s*1/);

  // A file with no route is refused and the track kept.
  await page.getByTestId('route-builder-input').setInputFiles('src/test/fixtures/treadmill-run.fit');
  await expect(page.getByRole('region', { name: 'Track not imported' }).getByRole('alert')).toContainText(
    /no route to add/,
  );

  // Every request is a same-origin GET with no body: nothing of the files is sent,
  // not even to the app's own host (review R1-C2).
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    expect(new URL(request.url()).origin, request.url()).toBe(origin);
    expect(request.method(), request.url()).toBe('GET');
    expect(request.postData(), request.url()).toBeNull();
  }
  // Nothing of either file reaches a URL, the title, or storage.
  expect(requests.some((r) => /simple-route|ride-minimal|treadmill/.test(r.url()))).toBe(false);
  expect(await page.title()).not.toMatch(/simple-route|ride-minimal/);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((k) => !['opentrack-viewer:theme', 'opentrack-viewer:basemap'].includes(k))),
  ).toEqual([]);
});

test('exports the planned track as a GPX that the viewer reads back as the same route (AV-1107)', async ({ page }, testInfo) => {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto('./#/route-builder');
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByTestId('route-builder-input').setInputFiles(RIDE_PATH);
  await expect(page.getByRole('region', { name: 'Planned track' })).toBeVisible();
  const planned = await page.getByRole('region', { name: 'Planned track' }).textContent();
  const pointCount = Number(/Points\s*(\d+)/.exec(planned ?? '')![1]);

  const exportRegion = page.getByRole('region', { name: 'Export for a device' });
  await expect(exportRegion.getByRole('radio', { name: /^FIT/ })).toBeDisabled();
  await expect(exportRegion.getByRole('radio', { name: /^TCX/ })).toBeDisabled();
  const downloading = page.waitForEvent('download');
  await exportRegion.getByRole('button', { name: /Download .*-planned-track\.gpx/ }).click();
  const saved = await downloading;
  expect(saved.suggestedFilename()).toMatch(/-planned-track\.gpx$/);
  await expect(exportRegion.getByRole('status', { name: 'Planned track written' })).toContainText(
    /says where to go, not when/,
  );

  const path = testInfo.outputPath(saved.suggestedFilename());
  await saved.saveAs(path);
  const xml = readFileSync(path, 'utf-8');
  expect(xml).not.toContain('<time>');
  expect(xml.match(/<trkpt /g)).toHaveLength(pointCount);

  // Read back by the viewer: a route with the same number of points.
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'File viewer' }).click();
  await page.getByTestId('file-input').setInputFiles(path);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();

  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    expect(new URL(request.url()).origin, request.url()).toBe(origin);
    expect(request.method(), request.url()).toBe('GET');
    expect(request.postData(), request.url()).toBeNull();
  }
});
