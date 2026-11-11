import { expect, test, type Page, type Request } from '@playwright/test';
import { join } from 'node:path';
import { countPixelsNear, decodePng, solidPng, withExif } from './helpers/png';
import { tiffBlock } from '../src/test/helpers/exifFixture';

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
  await expect(preview.locator('.map-video-preview__map canvas')).toBeVisible();
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

test('styles the route by elevation with an arrow on route only, asking nothing', async ({ page }) => {
  await page.goto('./#/map-video');
  const requests = recordRequests(page);
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await page.getByRole('radio', { name: /^Route only/ }).check();
  await page.getByRole('combobox', { name: 'Colour' }).selectOption('elevation');
  await page.getByRole('radio', { name: 'An arrow pointing the way' }).check();
  await page.getByRole('slider', { name: 'Position in the video' }).fill('27');

  // The palette's two ends are both on the drawn line: the route climbs from the coolest step to the hottest.
  await expect
    .poll(async () => {
      const shot = await previewShot(page);
      return [countPixelsNear(shot, [0x2c, 0x7b, 0xb6], 30) > 20, countPixelsNear(shot, [0xd7, 0x19, 0x1c], 30) > 20];
    }, { timeout: 5000 })
    .toEqual([true, true]);
  await expect(page.locator('.map-video-preview__attribution')).toHaveCount(0);
  expect(offOrigin(requests)).toEqual([]);
});

test('draws terrain from the AWS bucket alone, and credits it in the frame', async ({ page }) => {
  const asked = await stubOpenFreeMap(page);
  const terrain: string[] = [];
  // A flat Terrarium tile: elevation 0 everywhere (red 128, green 0, blue 0).
  const flat = solidPng(256, [128, 0, 0]);
  await page.route('https://elevation-tiles-prod.s3.amazonaws.com/**', (route) => {
    terrain.push(route.request().url());
    return route.fulfill({ contentType: 'image/png', body: flat, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('./#/map-video');
  const requests = recordRequests(page);
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await page.getByRole('checkbox', { name: /3D terrain/ }).check();

  await expect.poll(() => terrain.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(terrain.every((url) => /^https:\/\/elevation-tiles-prod\.s3\.amazonaws\.com\/terrarium\/\d+\/\d+\/\d+\.png$/.test(url))).toBe(true);
  expect(asked.length).toBeGreaterThan(0);
  const hosts = new Set(offOrigin(requests).map((url) => new URL(url).host));
  expect([...hosts].sort()).toEqual(['elevation-tiles-prod.s3.amazonaws.com', 'tiles.openfreemap.org']);
  await expect(page.locator('.map-video-preview__frame .map-video-preview__attribution')).toHaveText(
    /OpenFreeMap © OpenMapTiles Data from OpenStreetMap · Terrain: Mapzen, AWS Open Data/,
  );
});

test('takes a keyframe from a view dragged by hand, and edits one by keyboard', async ({ page }) => {
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await page.getByRole('radio', { name: /^Route only/ }).check();
  await page.getByRole('slider', { name: 'Position in the video' }).fill('12');
  const map = page.locator('.map-video-preview__map canvas');
  await expect(map).toBeVisible();
  // The canvas is no second tab stop: the frame around it takes the keys.
  await expect(map).toHaveAttribute('tabindex', '-1');

  // Drag the map 120 px to the left: the camera moves east of the marker.
  const box = (await map.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Add keyframe here' }).click();

  const keyframes = page.getByRole('region', { name: 'Camera keyframes' });
  const row = keyframes.getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAccessibleName('Keyframe 1, at 0:12.0');
  const east = Number(await row.getByRole('spinbutton', { name: 'East of the marker' }).inputValue());
  expect(east).toBeGreaterThan(10);

  // By keyboard alone: a second keyframe from the computed view, its zoom typed, then undone.
  await page.getByRole('slider', { name: 'Position in the video' }).fill('20');
  await page.getByRole('button', { name: 'Add keyframe here' }).focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveCount(2);
  const zoom = row.nth(1).getByRole('spinbutton', { name: 'Zoom' });
  await zoom.focus();
  await zoom.fill('13');
  await expect(zoom).toHaveValue('13');
  await keyframes.getByRole('button', { name: 'Undo' }).focus();
  await page.keyboard.press('Enter');
  await expect(row.nth(1).getByRole('spinbutton', { name: 'Zoom' })).not.toHaveValue('13');
});

test('draws a figure placed in the editor over the map, and the summary card in the outro', async ({ page }) => {
  await page.goto('./#/map-video');
  const requests = recordRequests(page);
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'overlay-ride.gpx'));
  // A point a second, so a live figure has a value at every moment (a sparser file leaves gaps unfilled, TD-041).
  await page.getByRole('radio', { name: /^Route only/ }).check();
  await page.getByRole('slider', { name: 'Position in the video' }).fill('12');

  /** White pixels, in a share of the frame: figures are white type, and nothing else on route only is. */
  const whiteIn = async (left: number, top: number, right: number, bottom: number) => {
    const shot = await previewShot(page);
    let count = 0;
    for (let y = Math.floor(shot.height * top); y < shot.height * bottom; y += 1) {
      for (let x = Math.floor(shot.width * left); x < shot.width * right; x += 1) {
        const i = (y * shot.width + x) * 4;
        if (shot.pixels[i]! > 230 && shot.pixels[i + 1]! > 230 && shot.pixels[i + 2]! > 230) count += 1;
      }
    }
    return count;
  };
  // From a little inside the corner: the frame's rounded corner shows the light page behind it.
  expect(await whiteIn(0.03, 0.04, 0.3, 0.25)).toBe(0);

  const editor = page.getByRole('region', { name: 'Figures over the map' });
  await editor.getByRole('combobox', { name: 'Add' }).selectOption('metric:heartRate');
  await editor.getByRole('button', { name: 'Add to the canvas' }).click();
  // A new element goes in the top-left, a margin in: its type shows there over the map.
  await expect.poll(() => whiteIn(0.03, 0.04, 0.3, 0.25), { timeout: 5000 }).toBeGreaterThan(30);

  // The outro: the summary card's figures in the middle of the frame.
  // (The marker's and the ends' white edges are there already: the card adds its figures to them.)
  const beforeOutro = await whiteIn(0.25, 0.25, 0.75, 0.75);
  await page.getByRole('slider', { name: 'Position in the video' }).fill('29.5');
  await expect.poll(() => whiteIn(0.25, 0.25, 0.75, 0.75), { timeout: 5000 }).toBeGreaterThan(beforeOutro + 400);
  expect(offOrigin(requests)).toEqual([]);
});

test('places a photo by the time in its EXIF, and shows it while the marker waits', async ({ page }) => {
  await page.goto('./#/map-video');
  const requests = recordRequests(page);
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'overlay-ride.gpx'));
  await page.getByRole('radio', { name: /^Route only/ }).check();
  // The ride runs 10:00:00 to 10:01:00 UTC; a magenta photo taken at 10:00:30, with a place and a time in its EXIF.
  const photo = withExif(solidPng(300, [255, 0, 255]), tiffBlock({ dateTimeOriginal: '2024:01:01 10:00:30', offsetTimeOriginal: '+00:00', lat: 51.503, lon: 0 }));
  await page.getByTestId('map-video-photo-input').setInputFiles({ name: 'IMG_0001.png', mimeType: 'image/png', buffer: photo });

  const row = page.getByRole('region', { name: 'Photos' }).getByRole('listitem', { name: 'IMG_0001.png' });
  await expect(row).toContainText(/Shown at 0:\d\d\.\d/);
  const shownAt = /Shown at 0:(\d\d\.\d)/.exec((await row.textContent()) ?? '')![1]!;

  const magenta = async () => countPixelsNear(await previewShot(page), [255, 0, 255], 20);
  expect(await magenta()).toBe(0);
  await page.getByRole('slider', { name: 'Position in the video' }).fill(String(Number(shownAt) + 1.5));
  await expect.poll(magenta, { timeout: 5000 }).toBeGreaterThan(5000);
  // Gone once the marker moves on.
  await page.getByRole('slider', { name: 'Position in the video' }).fill(String(Number(shownAt) + 6));
  await expect.poll(magenta, { timeout: 5000 }).toBe(0);
  expect(offOrigin(requests)).toEqual([]);
});
