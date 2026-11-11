import { expect, test, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { forbidLiveProviders, serveFixtureTiles } from './helpers/mapVideoTiles';

/**
 * AV-1210. The map video page's accessibility and layout: every control named
 * and reached by Tab with a visible ring, in the page's own order; the
 * timeline and the keyframes by keyboard alone; a desktop and a phone; the
 * preview after the window is resized; and a service worker that keeps no
 * map tile. The export's own checks (a whole journey with its frames, route
 * only, privacy, memory) need the encoders, and are in map-video-export.spec.
 */

const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');
test.use({ serviceWorkers: 'block' });

let live: string[] = [];
test.beforeEach(async ({ page }) => {
  live = await forbidLiveProviders(page);
  await serveFixtureTiles(page);
});
test.afterEach(() => expect(live, 'a request reached past the page to a live provider').toEqual([]));

/** The regions of the page. */
const REGIONS = ['Activity', 'Preview', 'Video settings', 'Camera keyframes', 'Figures over the map', 'Photos', 'Make the video', 'Project'];

/** The regions in the order a reader sees them: column by column, left to right, each from the top. */
const visualOrder = (page: Page) =>
  page.evaluate((regions) => {
    const boxes = regions.map((name) => ({ name, box: document.querySelector(`section[aria-label="${name}"]`)!.getBoundingClientRect() }));
    return boxes.sort((a, b) => (Math.abs(a.box.left - b.box.left) > 40 ? a.box.left - b.box.left : a.box.top - b.box.top)).map(({ name }) => name);
  }, REGIONS);

async function openRide(page: Page) {
  await page.goto('./#/map-video');
  await page.getByTestId('map-video-activity-input').setInputFiles(join(FIXTURE_DIR, 'overlay-ride.gpx'));
  await expect(page.locator('.map-video-preview__map canvas')).toBeVisible();
}

/** Tab (or Shift+Tab) until `target` has focus, as a keyboard user would; fails if it is never reached. */
async function tabTo(page: Page, target: Locator, { backwards = false, limit = 400 } = {}) {
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`${String(target)} was not reached by ${backwards ? 'Shift+Tab' : 'Tab'}`);
}

test('every control is named, reached by Tab with a visible ring, region by region in the order they are seen (AV-1210)', async ({ page }) => {
  // A computed name for every control and a long Tab walk: slow by design.
  test.setTimeout(120_000);
  await openRide(page);
  // A keyframe, so its controls are on the page too.
  await page.getByRole('slider', { name: 'Position in the video' }).fill('12');
  await page.getByRole('button', { name: 'Add keyframe here' }).click();
  await expect(page.getByRole('region', { name: 'Camera keyframes' }).getByRole('listitem')).toHaveCount(1);
  for (const name of REGIONS) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();

  const controls = page.locator('main button, main input:not([type="file"]), main select, main textarea, main a[href], main [tabindex="0"]');
  const total = await controls.count();
  expect(total).toBeGreaterThan(40);
  for (let i = 0; i < total; i += 1) {
    await expect(controls.nth(i), await controls.nth(i).evaluate((e) => e.outerHTML.slice(0, 120))).toHaveAccessibleName(/\S/);
  }

  // The whole page from the top, by Tab: each control landed on shows a ring, every enabled one is landed on,
  // and the regions are reached in the order the page gives them.
  const expectedOrder = await visualOrder(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const regionsReached: string[] = [];
  const visited = new Set<string>();
  for (let i = 0; i < 600; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate((regions) => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return undefined;
      const region = element.closest('section[aria-label]');
      const name = region?.getAttribute('aria-label') ?? '';
      if (!regions.includes(name)) return { region: undefined };
      const style = getComputedStyle(element);
      const ring = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      return { region: name, ring, html: element.outerHTML.slice(0, 120), id: element.dataset.walk };
    }, REGIONS);
    if (!focused?.region) continue;
    if (regionsReached[regionsReached.length - 1] !== focused.region) {
      // Round the page once: past the last region, the walk is over.
      if (regionsReached.length === expectedOrder.length) break;
      regionsReached.push(focused.region);
    }
    expect(focused.ring, focused.html).toBe(true);
    if (focused.id) visited.add(focused.id);
    // Each control is marked when first landed on, so the check below can ask which were never reached.
    await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      element.dataset.walk ??= String(Math.random());
    });
  }
  expect(regionsReached).toEqual(expectedOrder);
  const missed = await page.evaluate((regions) =>
    regions.flatMap((name) =>
      [...document.querySelectorAll<HTMLElement>(`section[aria-label="${name}"] :is(button, input, select, textarea):not([disabled]):not([type="file"]):not([type="radio"])`)]
        .filter((element) => element.closest('section[aria-label]')?.getAttribute('aria-label') === name && element.getClientRects().length > 0 && !element.dataset.walk)
        .map((element) => `${name}: ${element.outerHTML.slice(0, 100)}`),
    ), REGIONS);
  expect(missed).toEqual([]);
});

test('plays, steps and seeks the timeline by keyboard alone (AV-1210)', async ({ page }) => {
  await openRide(page);
  const time = page.locator('.map-video-preview__time');
  const frame = page.getByRole('group', { name: /^Preview,/ });
  await tabTo(page, frame);
  await expect(time).toHaveText('0:00.0 / 0:30.0');
  // A frame is a thirtieth of a second; Shift takes a second at a time.
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  await expect(time).toHaveText('0:00.1 / 0:30.0');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(time).toHaveText('0:02.1 / 0:30.0');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(time).toHaveText('0:01.1 / 0:30.0');
  await page.keyboard.press('End');
  await expect(time).toHaveText('0:30.0 / 0:30.0');
  await page.keyboard.press('Home');
  await expect(time).toHaveText('0:00.0 / 0:30.0');
  await page.keyboard.press(' ');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(time).not.toHaveText('0:00.0 / 0:30.0');
  await page.keyboard.press('k');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

  // The slider is a second way, with the arrow keys a browser gives it.
  const slider = page.getByRole('slider', { name: 'Position in the video' });
  await tabTo(page, slider);
  await page.keyboard.press('Home');
  await expect(time).toHaveText('0:00.0 / 0:30.0');
  // A frame an arrow, as the frame's own keys.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight');
  await expect(time).toHaveText('0:00.2 / 0:30.0');
  // And the frame's own buttons, reached by Tab and pressed with Enter.
  await page.keyboard.press('Home');
  await tabTo(page, page.getByRole('button', { name: 'Forward a frame' }));
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Enter');
  await expect(time).toHaveText('0:00.1 / 0:30.0');
});

test('adds, edits, moves to, undoes and deletes a keyframe by keyboard alone (AV-1210)', async ({ page }) => {
  test.setTimeout(90_000);
  await openRide(page);
  const keyframes = page.getByRole('region', { name: 'Camera keyframes' });
  const rows = keyframes.getByRole('listitem');
  const time = page.locator('.map-video-preview__time');

  // To 0:05 by the frame's keys, then the keyframe added with Enter.
  await tabTo(page, page.getByRole('group', { name: /^Preview,/ }));
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await expect(time).toHaveText('0:05.0 / 0:30.0');
  await tabTo(page, page.getByRole('button', { name: 'Add keyframe here' }));
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAccessibleName('Keyframe 1, at 0:05.0');

  // Its zoom typed, its time typed: each field reached by Tab.
  const zoom = rows.first().getByRole('spinbutton', { name: 'Zoom' });
  await tabTo(page, zoom);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('12');
  await page.keyboard.press('Tab');
  await expect(zoom).toHaveValue('12');
  const at = rows.first().getByRole('spinbutton', { name: 'At' });
  await tabTo(page, at, { backwards: true });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('8');
  await page.keyboard.press('Tab');
  await expect(rows.first()).toHaveAccessibleName('Keyframe 1, at 0:08.0');

  // Go to it; undo the last edit with the keyboard shortcut; delete it.
  await tabTo(page, rows.first().getByRole('button', { name: 'Go to' }));
  await page.keyboard.press('Enter');
  await expect(time).toHaveText('0:08.0 / 0:30.0');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(rows.first()).toHaveAccessibleName('Keyframe 1, at 0:05.0');
  await tabTo(page, rows.first().getByRole('button', { name: 'Delete' }));
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(0);
});

for (const { name, viewport } of [
  { name: 'a desktop', viewport: { width: 1280, height: 800 } },
  { name: 'a phone', viewport: { width: 360, height: 740 } },
]) {
  test(`lays out on ${name}: no sideways scroll, every control within reach, the frame its video's shape (AV-1210)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openRide(page);
    const overflow = await page.evaluate(() => {
      const scroller = document.querySelector('.shell__scroll');
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, scroller ? scroller.scrollWidth - scroller.clientWidth : 0);
    });
    expect(overflow).toBeLessThanOrEqual(0);

    const outside = await page.evaluate(
      ({ width, regions }) =>
        regions
          .flatMap((name) => [...(document.querySelector(`section[aria-label="${name}"]`)?.querySelectorAll<HTMLElement>('button, input, select, label') ?? [])])
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && (box.left < -1 || box.right > width + 1);
          })
          .map((element) => element.outerHTML.slice(0, 80)),
      { width: viewport.width, regions: REGIONS },
    );
    expect(outside).toEqual([]);

    // The preview frame fits the width, at the video's 16:9.
    const box = (await page.locator('.map-video-preview__frame').boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
  });
}

test('takes a keyframe at the right zoom after the window is resized while paused (AV-1210, TD-073)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRide(page);
  await page.getByRole('slider', { name: 'Position in the video' }).fill('12');
  const frame = page.locator('.map-video-preview__frame');
  const wide = (await frame.boundingBox())!.width;
  // Narrower, paused: the preview is drawn again at its new width, so its view still frames what the video does.
  await page.setViewportSize({ width: 700, height: 800 });
  await expect.poll(async () => (await frame.boundingBox())!.width).toBeLessThan(wide - 50);
  await page.getByRole('button', { name: 'Add keyframe here' }).click();
  const zoom = page.getByRole('region', { name: 'Camera keyframes' }).getByRole('listitem').first().getByRole('spinbutton', { name: 'Zoom' });
  const camera = page.getByRole('region', { name: 'Video settings' }).getByRole('spinbutton', { name: 'Zoom', exact: true });
  // Taken from the computed view, untouched: the camera's own zoom, not one off by the old width's offset.
  expect(Math.abs(Number(await zoom.inputValue()) - Number(await camera.inputValue()))).toBeLessThan(0.05);
});

test('the service worker caches the app alone: no runtime caching, so no map tile is kept (AV-1210, TD-064)', async ({ request }) => {
  const worker = await (await request.get('./sw.js')).text();
  expect(worker).toContain('precacheAndRoute');
  // One route: the app's own pages, answered from the precache.
  expect(worker.match(/registerRoute\(/g)).toHaveLength(1);
  expect(worker).toMatch(/registerRoute\(new \w+\.NavigationRoute\(/);
  for (const strategy of ['CacheFirst', 'NetworkFirst', 'StaleWhileRevalidate', 'openfreemap', 'maptiler', 'amazonaws']) {
    expect(worker, `the service worker mentions ${strategy}`).not.toContain(strategy);
  }
});
