import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { RIDE_PATH, longRideGpx } from './helpers/overlayFixtures';
import { decodePng, type DecodedPng } from './helpers/png';
import { addFirstTrack } from './helpers/routeBuilder';

/** The route line colour from `src/styles`, as drawn by ActivityMap. */
const ROUTE_RGB: [number, number, number] = [0x4a, 0xa3, 0xff];

/**
 * AV-1108. Route Builder end to end: the whole journey from a viewed ride to a
 * planned GPX, the same by keyboard alone from a blank track, the page's
 * accessibility and layout on a desktop and a phone, a long track's edits, and
 * a request-by-request privacy audit over every flow.
 */

const TCX_PATH = 'src/test/fixtures/ride-minimal.tcx';

/** Every request made while the page is used, for the privacy audit. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}

/**
 * Nothing of a route, a file or a draft left the tab: every request was a
 * same-origin GET with no body, and no URL, title or storage names a file.
 */
async function expectNothingSent(page: Page, requests: Request[], fileStems: string[]) {
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    expect(new URL(request.url()).origin, request.url()).toBe(origin);
    expect(request.method(), request.url()).toBe('GET');
    expect(request.postData(), request.url()).toBeNull();
  }
  const pattern = new RegExp(fileStems.join('|'), 'i');
  expect(requests.filter((request) => pattern.test(request.url())).map((r) => r.url())).toEqual([]);
  expect(await page.title()).not.toMatch(pattern);
  expect(
    await page.evaluate(() => [
      ...Object.keys(localStorage).filter((key) => !['opentrack-viewer:theme', 'opentrack-viewer:basemap'].includes(key)),
      ...Object.keys(sessionStorage),
    ]),
  ).toEqual([]);
}

/** The basemap off, so the map fetches no tiles and the audit sees only the app. */
async function routeOnly(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}


/**
 * Moves focus with Tab (or Shift+Tab) until the named button has it, as a
 * keyboard user would, and fails if it is never reached — so a control taken
 * out of the tab order fails the test instead of being focused around.
 */
async function tabTo(page: Page, name: string, { backwards = false, limit = 80 } = {}) {
  const target = page.getByRole('button', { name, exact: true });
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`"${name}" was not reached by ${backwards ? 'Shift+Tab' : 'Tab'}`);
}

/**
 * The leftmost pixel drawn in `rgb`, on the middle one of the rows it is
 * drawn on there — a place on the route line, from the picture alone.
 */
function westmostPixel(png: DecodedPng, [r, g, b]: [number, number, number], tolerance = 40) {
  let minX = png.width;
  const rows: number[] = [];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      if (
        Math.abs(png.pixels[i]! - r) > tolerance ||
        Math.abs(png.pixels[i + 1]! - g) > tolerance ||
        Math.abs(png.pixels[i + 2]! - b) > tolerance
      ) {
        continue;
      }
      if (x < minX) {
        minX = x;
        rows.length = 0;
      }
      if (x === minX) rows.push(y);
      break;
    }
  }
  return rows.length === 0 ? undefined : { x: minX, y: rows[Math.floor(rows.length / 2)]! };
}

const pointsIn = async (page: Page) =>
  Number(/Points\s*(\d+)/.exec((await page.getByRole('region', { name: 'Planned track' }).textContent()) ?? '')![1]);

test('the whole journey: viewer, custom track, edit, discard, append, export (AV-1108)', async ({ page }, testInfo) => {
  // Two imports, an append, an export and a read-back: 15 s alone, over 30 s
  // when the whole suite runs in parallel on one machine.
  test.setTimeout(90_000);
  const requests = recordRequests(page);
  await page.goto('./#/viewer');
  await routeOnly(page);

  // A ride in the viewer, copied into Route Builder.
  await page.getByTestId('file-input').setInputFiles(RIDE_PATH);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();
  await page.getByRole('button', { name: 'Create custom track' }).click();
  expect(new URL(page.url()).hash).toBe('#/route-builder');
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText('Copied from a track');
  const copied = await pointsIn(page);

  // A point added by typing, then moved by typing.
  const editor = page.getByRole('region', { name: 'Edit points' });
  const add = editor.getByRole('form', { name: 'Add a point by coordinates' });
  await add.getByLabel('Latitude').fill('51.52');
  await add.getByLabel('Longitude').fill('-0.11');
  await add.getByRole('button', { name: 'Add point' }).click();
  await expect(track).toContainText(new RegExp(`Points\\s*${copied + 1}(?!\\d)`));
  const move = editor.getByRole('form', { name: 'Move the selected point' });
  await move.getByLabel('Latitude').fill('51.53');
  await move.getByRole('button', { name: 'Move point' }).click();
  await expect(move.getByLabel('Latitude')).toHaveValue('51.53');

  // A section of three, marked from the start and discarded.
  await editor.getByRole('button', { name: 'Deselect' }).click();
  await editor.getByRole('button', { name: 'Next point' }).click();
  await editor.getByRole('button', { name: 'Next point' }).click();
  await editor.getByRole('button', { name: 'Section starts here' }).click();
  await editor.getByRole('button', { name: 'Next point' }).click();
  await editor.getByRole('button', { name: 'Next point' }).click();
  await editor.getByRole('button', { name: 'Section ends here' }).click();
  await expect(editor.getByRole('group', { name: 'Section' })).toContainText('Section: points 2 to 4 (3 points)');
  await editor.getByRole('button', { name: 'Discard section' }).click();
  await expect(editor.getByRole('status').first()).toContainText(/Discarded 3 points/);
  expect(await pointsIn(page)).toBe(copied + 1 - 3);

  // Another track appended, far away, joined on request.
  await page.getByTestId('track-input').setInputFiles(TCX_PATH);
  const added = page.getByRole('status', { name: 'Last track added' });
  await expect(added).toContainText('ride-minimal.tcx');
  await expect(track).toContainText(/Stretches\s*2/);
  await page.getByRole('button', { name: 'Edit this track' }).click();
  await added.getByRole('button', { name: 'Select the join' }).click();
  await editor.getByRole('button', { name: 'Join to the point before' }).click();
  await expect(track).toContainText(/Stretches\s*1/);
  const planned = await pointsIn(page);

  // Exported as a planned GPX, read back by the viewer as a route of the same size.
  const exporter = page.getByRole('region', { name: 'Export for a device' });
  const downloading = page.waitForEvent('download');
  await exporter.getByRole('button', { name: /Download .*-planned-track\.gpx/ }).click();
  const saved = await downloading;
  const path = testInfo.outputPath(saved.suggestedFilename());
  await saved.saveAs(path);
  const xml = readFileSync(path, 'utf-8');
  expect(xml.match(/<trkpt /g)).toHaveLength(planned);
  expect(xml).not.toContain('<time>');

  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'File viewer' }).click();
  await page.getByRole('button', { name: 'Close activity' }).click();
  await page.getByTestId('file-input').setInputFiles(path);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();

  await expectNothingSent(page, requests, ['overlay-ride', 'ride-minimal', 'planned-track']);
});

test('from a blank track, by keyboard alone (AV-1108)', async ({ page }) => {
  // Every control is reached by Tab, one key at a time: slow by design.
  test.setTimeout(90_000);
  const requests = recordRequests(page);
  await page.goto('./');
  await routeOnly(page);

  // Tools, opened and walked from the keyboard.
  await tabTo(page, 'Tools');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  for (let i = 0; i < 6; i += 1) {
    if ((await page.evaluate(() => document.activeElement?.textContent)) === 'Route Builder') break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.getByRole('menuitem', { name: 'Route Builder' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Route Builder' })).toBeVisible();

  // Direct entry: nothing held, a blank track on request, reached by Tab.
  await tabTo(page, 'Start a blank track');
  await page.keyboard.press('Enter');
  const track = page.getByRole('region', { name: 'Planned track' });
  await expect(track).toContainText('A new planned track');

  // Three points typed and submitted with Enter, the fields reached by Tab.
  const add = page.getByRole('form', { name: 'Add a point by coordinates' });
  const latitude = add.getByLabel('Latitude');
  for (const lat of ['43.00', '43.01', '43.02']) {
    for (let i = 0; i < 40 && !(await latitude.evaluate((e) => e === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(latitude).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(lat);
    await page.keyboard.press('Tab');
    await expect(add.getByLabel('Longitude')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-8.00');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
  }
  await expect(track).toContainText(/Points\s*3/);

  // Select, remove and undo, each a control reached by Tab and pressed with Enter.
  const press = async (name: string) => {
    await tabTo(page, name);
    await page.keyboard.press('Enter');
  };
  await press('Previous point');
  await expect(page.getByRole('region', { name: 'Edit points' })).toContainText('Selected: point 2 of 3');
  await press('Remove point');
  await expect(track).toContainText(/Points\s*2/);
  await tabTo(page, 'Undo last edit', { backwards: false });
  await page.keyboard.press('Enter');
  await expect(track).toContainText(/Points\s*3/);

  // A section, marked and discarded by keyboard; controls above are reached going back.
  await tabTo(page, 'Next point', { backwards: true });
  await page.keyboard.press('Enter');
  await tabTo(page, 'Section starts here');
  await page.keyboard.press('Enter');
  await tabTo(page, 'Next point', { backwards: true });
  await page.keyboard.press('Enter');
  await tabTo(page, 'Section ends here');
  await page.keyboard.press('Enter');
  await tabTo(page, 'Discard section');
  await page.keyboard.press('Enter');
  await expect(track).toContainText(/Points\s*1/);

    await expectNothingSent(page, requests, ['planned-track']);
});

test('every control is named, and shows where focus is (AV-1108)', async ({ page }) => {
  // A computed name for every control and a 160-step Tab walk: 15 s alone,
  // over 30 s when the whole suite runs in parallel on one machine.
  test.setTimeout(90_000);
  await page.goto('./#/route-builder');
  await page.getByRole('button', { name: 'Start a blank track' }).click();
  const add = page.getByRole('form', { name: 'Add a point by coordinates' });
  for (const lat of ['43.00', '43.01']) {
    await add.getByLabel('Latitude').fill(lat);
    await add.getByLabel('Longitude').fill('-8');
    await add.getByRole('button', { name: 'Add point' }).click();
  }
  // With a selection and a section mark, so the conditional controls are on the page.
  await page.getByRole('button', { name: 'Section starts here' }).click();
  await expect(page.getByRole('region', { name: 'Export for a device' }).getByRole('button')).toBeVisible();

  // Every interactive element has a computed accessible name — not merely an
  // attribute that could point nowhere or label nothing.
  const controls = page.locator(
    'main button, main input:not([type="file"]), main select, main a[href], header button, header a[href]',
  );
  const total = await controls.count();
  expect(total).toBeGreaterThan(20);
  for (let i = 0; i < total; i += 1) {
    await expect(controls.nth(i), await controls.nth(i).evaluate((e) => e.outerHTML.slice(0, 120))).toHaveAccessibleName(/\S/);
  }

  // Tab through the whole page from the top: every control in the editor and
  // the export that keyboard focus lands on shows a ring, and every button and
  // text field there is landed on — none is out of the tab order.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const visited = new Set<string>();
  for (let i = 0; i < 160; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return undefined;
      const region = element.closest('[aria-label="Edit points"], [aria-label="Export for a device"]');
      if (!region) return undefined;
      const style = getComputedStyle(element);
      const ring =
        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      // The enclosing form is part of the key: the Add and Move forms both have a
      // Latitude and a Longitude, and each must be landed on in its own right.
      const key = `${region.getAttribute('aria-label')}|${element.closest('form')?.getAttribute('aria-label') ?? ''}|${element.tagName}|${(element as HTMLInputElement).type ?? ''}|${element.textContent?.trim() || element.getAttribute('aria-label') || (element as HTMLInputElement).labels?.[0]?.textContent?.trim() || ''}`;
      return { key, ring, html: element.outerHTML.slice(0, 100) };
    });
    if (!focused) continue;
    expect(focused.ring, focused.html).toBe(true);
    visited.add(focused.key);
  }
  const expected = await page.evaluate(() =>
    ['Edit points', 'Export for a device'].flatMap((label) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[aria-label="${label}"] button:not([disabled]), [aria-label="${label}"] input:not([disabled]):not([type="radio"])`,
        ),
      ].map(
        (element) =>
          `${label}|${element.closest('form')?.getAttribute('aria-label') ?? ''}|${element.tagName}|${(element as HTMLInputElement).type ?? ''}|${element.textContent?.trim() || element.getAttribute('aria-label') || (element as HTMLInputElement).labels?.[0]?.textContent?.trim() || ''}`,
      ),
    ),
  );
  for (const key of expected) expect(visited, key).toContain(key);
});

test('Settings is a dialog that opens over the page and gives focus back (AV-1108)', async ({ page }) => {
  await page.goto('./#/route-builder');
  await page.getByRole('button', { name: 'Start a blank track' }).click();
  const settings = page.getByRole('banner').getByRole('button', { name: 'Settings' });
  await tabTo(page, 'Settings');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  await expect(page.getByRole('region', { name: 'Planned track' })).toBeVisible();
});

for (const { name, viewport } of [
  { name: 'a desktop', viewport: { width: 1280, height: 800 } },
  { name: 'a phone', viewport: { width: 360, height: 740 } },
]) {
  test(`lays out on ${name}: no sidebar, no sideways scroll, controls within reach (AV-1108)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./#/route-builder');
    await addFirstTrack(page, RIDE_PATH);

    // The viewer's section sidebar belongs to the viewer; this page has none at any width.
    await expect(page.locator('.section-nav')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Draft map' }).locator('.maplibregl-canvas')).toBeVisible();

    const overflow = await page.evaluate(() => {
      const scroller = document.querySelector('.shell__scroll')!;
      return Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scroller.scrollWidth - scroller.clientWidth,
      );
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // Every editing and export control sits inside the viewport's width.
    const outside = await page.evaluate((width) => {
      const scope = ['Edit points', 'Export for a device'].map((label) => document.querySelector(`[aria-label="${label}"]`));
      return scope
        .flatMap((region) => [...(region?.querySelectorAll<HTMLElement>('button, input, label') ?? [])])
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.left < -1 || box.right > width + 1);
        })
        .map((element) => element.outerHTML.slice(0, 80));
    }, viewport.width);
    expect(outside).toEqual([]);
  });
}

test('a long track stays quick to append, edit, discard and export (AV-1108)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const requests = recordRequests(page);
  // Two hours at one point a second, twice: about 14,400 points in the draft.
  const path = testInfo.outputPath('long-ride.gpx');
  writeFileSync(path, longRideGpx(2));
  await page.goto('./#/route-builder');
  await routeOnly(page);

  const timed = async (action: () => Promise<void>) => {
    const started = Date.now();
    await action();
    return Date.now() - started;
  };
  const track = page.getByRole('region', { name: 'Planned track' });

  const first = await timed(async () => {
    await addFirstTrack(page, path);
    await expect(track).toContainText(/Points\s*7201/, { timeout: 30_000 });
  });
  const append = await timed(async () => {
    await page.getByTestId('track-input').setInputFiles(path);
    await expect(track).toContainText(/Points\s*14402/, { timeout: 30_000 });
  });

  await page.getByRole('button', { name: 'Edit this track' }).click();
  const editor = page.getByRole('region', { name: 'Edit points' });
  const add = editor.getByRole('form', { name: 'Add a point by coordinates' });
  await add.getByLabel('Latitude').fill('51.6');
  await add.getByLabel('Longitude').fill('-0.1');
  // The first edit after a large append also waits out the map's own work on
  // the new geometry; the edits timed are the ones after it.
  await add.getByRole('button', { name: 'Add point' }).click();
  await expect(track).toContainText(/Points\s*14403/, { timeout: 30_000 });
  const edit = await timed(async () => {
    await add.getByRole('button', { name: 'Add point' }).click();
    await expect(track).toContainText(/Points\s*14404/);
  });
  const discard = await timed(async () => {
    await editor.getByRole('button', { name: 'Section starts here' }).click();
    for (let i = 0; i < 3; i += 1) await editor.getByRole('button', { name: 'Previous point' }).click();
    await editor.getByRole('button', { name: 'Section ends here' }).click();
    await editor.getByRole('button', { name: 'Discard section' }).click();
    await expect(track).toContainText(/Points\s*14400/);
  });
  const undo = await timed(async () => {
    await editor.getByRole('button', { name: 'Undo last edit' }).click();
    await expect(track).toContainText(/Points\s*14404/);
  });
  const exported = await timed(async () => {
    const downloading = page.waitForEvent('download');
    await page.getByRole('region', { name: 'Export for a device' }).getByRole('button', { name: /Download/ }).click();
    await downloading;
  });

  testInfo.annotations.push({
    type: 'timings (ms)',
    description: JSON.stringify({ first, append, edit, discard, undo, exported }),
  });
  // Generous, machine-tolerant bounds: an edit is one model operation and one
  // redraw of the preview, never a re-read of the file.
  // Measured at 150–400 ms an edit on a laptop running alone. These bounds are
  // for a parallel run on a busy CI runner, so they catch only a step that has
  // become catastrophically slow (a quadratic, a re-read of the file). The
  // causes of the 1.2 s an edit once took are pinned deterministically by unit
  // tests instead: one preview per edit, and handles only where they matter.
  expect(append).toBeLessThan(30_000);
  expect(edit).toBeLessThan(5_000);
  expect(discard).toBeLessThan(10_000);
  expect(undo).toBeLessThan(5_000);
  expect(exported).toBeLessThan(15_000);

  // Above the handle limit most points have no handle, so a press on the drawn
  // line selects the nearest point instead of adding one (review R1-C1). The
  // ride is a circle, so its westmost pixel is a known place on it, at
  // longitude -0.15 and latitude 51.5 — far from any handle. The real map
  // reports the tile's clipped, simplified geometry under the pointer; the
  // point selected must still be the one at the place pressed.
  const canvas = page.getByRole('region', { name: 'Draft map' }).locator('.maplibregl-canvas');
  // The page has scrolled on past the map by now; the press needs it on screen.
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const png = decodePng(await canvas.screenshot());
  const west = westmostPixel(png, ROUTE_RGB)!;
  expect(west).toBeDefined();
  const scale = png.width / box.width;
  await page.mouse.click(box.x + (west.x + 1) / scale, box.y + west.y / scale);

  await expect(editor).toContainText(/Selected: point \d+ of 14404/);
  const selected = Number(/Selected: point (\d+)/.exec((await editor.textContent()) ?? '')![1]);
  expect(selected).toBeGreaterThan(1);
  expect(selected).toBeLessThan(14_401);
  expect(await pointsIn(page)).toBe(14_404);
  const moveForm = editor.getByRole('form', { name: 'Move the selected point' });
  expect(Math.abs(Number(await moveForm.getByLabel('Longitude').inputValue()) + 0.15)).toBeLessThan(0.001);
  expect(Math.abs(Number(await moveForm.getByLabel('Latitude').inputValue()) - 51.5)).toBeLessThan(0.005);

  // And a section edited from there, then taken back.
  await editor.getByRole('button', { name: 'Section starts here' }).click();
  for (let i = 0; i < 2; i += 1) await editor.getByRole('button', { name: 'Next point' }).click();
  await editor.getByRole('button', { name: 'Section ends here' }).click();
  await editor.getByRole('button', { name: 'Discard section' }).click();
  await expect(track).toContainText(/Points\s*14401/);
  await editor.getByRole('button', { name: 'Undo last edit' }).click();
  await expect(track).toContainText(/Points\s*14404/);

  await expectNothingSent(page, requests, ['long-ride', 'planned-track']);
});
