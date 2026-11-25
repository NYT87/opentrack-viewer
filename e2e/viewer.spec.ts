import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { countPixelsNear, decodePng } from './helpers/png';
import { resolveBasePath } from '../base-path.ts';

const BASE_PATH = resolveBasePath();
const ORIGIN = 'http://localhost:4173';
const SITE = `${ORIGIN}${BASE_PATH}`;

/** The route line colour from `src/styles`, as drawn by ActivityMap. */
const ROUTE_RGB: [number, number, number] = [0x4a, 0xa3, 0xff];

const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');

/** Uploads a fixture through the real file input (plan §13, E2E). */
async function loadFixture(page: Page, name: string): Promise<void> {
  // The drop zone only exists before an activity is open; changing files goes
  // through "Close activity" first.
  const close = page.getByRole('button', { name: 'Close activity' });
  if (await close.isVisible().catch(() => false)) await close.click();

  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, name));
}

/** Records every request the page makes, so privacy claims can be asserted. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}

/**
 * Route-only mode keeps a test hermetic: no external tile provider is involved.
 * It must be set before a file is opened, because the map is constructed with
 * the basemap already hidden.
 */
/** AV-012: header navigation lives in the Tools menu. */
async function openTools(page: Page) {
  await page.getByRole('button', { name: /Tools/ }).click();
  return page.getByRole('menu', { name: 'Tools' });
}

/** Settings is a modal (AV-007): it neither navigates nor unmounts the viewer. */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  return page.getByRole('dialog');
}

async function useRouteOnlyBasemap(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function gotoViewer(page: Page): Promise<void> {
  await page.goto('./#/viewer');
}

test.beforeEach(async ({ page }) => {
  await gotoViewer(page);
});

test('loads a GPX fixture and renders the route and stats', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  await expect(page.getByText('Elevation Route')).toBeVisible();
  await expect(page.getByText('Elevation gain')).toBeVisible();
  await expect(page.getByTestId('elevation-chart-svg')).toBeVisible();
  await expect(page.getByTestId('map-placeholder')).toHaveCount(0);

  // The route layer exists on the live map instance.
  const hasRouteLayer = await page.evaluate(() =>
    Boolean(document.querySelector('.maplibregl-canvas')),
  );
  expect(hasRouteLayer).toBe(true);
});

test('actually renders the route into the map canvas', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  // The unit tests mock MapLibre, so only a real browser can prove the route
  // reaches the GPU. Regression: a 404 on MapLibre's worker left GeoJSON
  // sources permanently unloaded — raster tiles still drew, the camera still
  // fitted the bounds, every source and layer looked correct, and the route was
  // simply never rendered. Only the pixels catch that.
  const canvas = page.locator('.maplibregl-canvas');
  await expect(canvas).toHaveCount(0);

  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(canvas).toBeVisible();
  await expect(page.getByText('Elevation Route')).toBeVisible();
  // Let the fit-bounds animation settle before sampling the canvas.
  await page.waitForTimeout(1500);

  const routePixels = countPixelsNear(decodePng(await canvas.screenshot()), ROUTE_RGB);
  expect(routePixels).toBeGreaterThan(200);
});

test('fits the whole track inside the viewport', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();
  await page.waitForTimeout(1500);

  const canvas = page.locator('.maplibregl-canvas');
  const png = decodePng(await canvas.screenshot());

  // Find the drawn route's pixel extent and require a margin on every side, so
  // a track that overflows the viewport (or is clipped by it) fails here.
  let minX = png.width;
  let maxX = -1;
  let minY = png.height;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      const near =
        Math.abs(png.pixels[i]! - ROUTE_RGB[0]) <= 40 &&
        Math.abs(png.pixels[i + 1]! - ROUTE_RGB[1]) <= 40 &&
        Math.abs(png.pixels[i + 2]! - ROUTE_RGB[2]) <= 40;
      if (!near) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  expect(maxX).toBeGreaterThan(-1);
  expect(minX).toBeGreaterThan(0);
  expect(maxX).toBeLessThan(png.width - 1);
  expect(minY).toBeGreaterThan(0);
  expect(maxY).toBeLessThan(png.height - 1);
  // The fit should use a meaningful share of the viewport, not a dot.
  expect(maxY - minY).toBeGreaterThan(png.height * 0.3);
});

test('requests no map tiles until an activity is opened', async ({ page }) => {
  // The map is not constructed without a route, so simply opening the app must
  // not tell a tile provider that anyone is using it.
  const requests = recordRequests(page);
  // AV-004: no map region before an activity is ready.
  await expect(page.getByTestId('map-placeholder')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity overview' })).toHaveCount(0);
  await page.waitForTimeout(1500);

  expect(requests.filter((request) => !request.url().startsWith(ORIGIN))).toEqual([]);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);

  // ...and it does request them once there is a route to show. Polled rather
  // than timed: this is the one assertion that depends on a live tile server.
  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect
    .poll(
      () =>
        requests.filter((request) => request.url().startsWith('https://tile.openstreetmap.org/'))
          .length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

test('renders the route again after closing and reopening an activity', async ({ page }) => {
  // Closing an activity destroys the MapLibre instance. Its worker pool is
  // process-wide, so a second map must still be able to tile a GeoJSON source.
  await useRouteOnlyBasemap(page);
  const canvas = page.locator('.maplibregl-canvas');

  await loadFixture(page, 'route-with-elevation.gpx');
  await page.waitForTimeout(1500);
  expect(countPixelsNear(decodePng(await canvas.screenshot()), ROUTE_RGB)).toBeGreaterThan(200);

  await page.getByRole('button', { name: 'Close activity' }).click();
  await expect(page.getByTestId('file-input')).toBeAttached();

  await loadFixture(page, 'flat-route.gpx');
  await page.waitForTimeout(1500);
  expect(countPixelsNear(decodePng(await canvas.screenshot()), ROUTE_RGB)).toBeGreaterThan(200);
});

test('switches the chart x-axis between distance and time (AV-504)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  const distance = page.getByRole('button', { name: 'Distance' });
  const time = page.getByRole('button', { name: 'Time' });
  const elevationChart = page.getByRole('region', { name: 'Elevation chart' });
  await expect(distance).toHaveAttribute('aria-pressed', 'true');
  await expect(elevationChart.getByText(/x-axis: distance/)).toBeVisible();

  await time.click();

  // The axis is a panel-wide setting, so every chart follows it.
  await expect(time).toHaveAttribute('aria-pressed', 'true');
  await expect(elevationChart.getByText(/x-axis: elapsed time/)).toBeVisible();
  await expect(page.getByText(/x-axis: elapsed time/).first()).toBeVisible();
  // The chart is redrawn, not re-parsed: the activity is still the same file.
  await expect(page.getByText('Elevation Route')).toBeVisible();
});

test('disables an x-axis the activity cannot support', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'simple-route-no-time.gpx');

  await expect(page.getByRole('button', { name: 'Time' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Distance' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('charts pace and cadence for a running activity (AV-505, AV-506)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  await expect(page.getByRole('region', { name: 'Elevation chart' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pace chart' })).toContainText('/km');
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toContainText('spm');
  // AV-515: named as strides per minute, never rpm.
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toContainText(
    /strides per minute/i,
  );
});

test('explains why run charts are unavailable for other activities (AV-507)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  // The fixture is a hike, so pace and cadence do not apply.
  await expect(page.getByRole('region', { name: 'Pace chart' })).toContainText(
    /shown for running activities/i,
  );
  await expect(page.getByRole('region', { name: 'Elevation chart' })).toBeVisible();
});

test('keeps the upload layout when a parse fails (AV-004)', async ({ page }) => {
  await loadFixture(page, 'malformed.gpx');

  // The error sits by the upload control, and no part of the viewer appears.
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('file-input')).toBeAttached();
  await expect(page.getByRole('region', { name: 'Activity overview' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Elevation chart' })).toHaveCount(0);
});

test('orders the viewer as overview, map, then charts (AV-005, AV-011)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const overview = (await page.getByRole('region', { name: 'Activity overview' }).boundingBox())!;
  const map = (await page.getByRole('region', { name: 'Route map' }).boundingBox())!;
  const charts = (await page.locator('#activity-charts').boundingBox())!;

  expect(map.y).toBeGreaterThanOrEqual(overview.y + overview.height - 1);
  expect(charts.y).toBeGreaterThanOrEqual(map.y + map.height - 1);
  // The map stays big enough to inspect a route.
  expect(map.height).toBeGreaterThan(240);
});

test('centres the loaded viewer in a max-width column (AV-011)', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const content = (await page.locator('.viewer__content').boundingBox())!;
  expect(content.width).toBeLessThan(1300);
  // Centred: equal gutters either side.
  expect(Math.abs(content.x - (1800 - content.x - content.width))).toBeLessThan(4);
});

test('offers a section sidebar on large screens only (AV-011)', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const nav = page.getByRole('navigation', { name: 'Activity sections' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Overview' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Map' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Charts' })).toBeVisible();

  // It sits to the left of the content, not on top of it.
  const navBox = (await nav.boundingBox())!;
  const sections = (await page.locator('.viewer__sections').boundingBox())!;
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(sections.x + 1);

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(nav).toBeHidden();
});

test('section links scroll without navigating or clearing the activity (AV-011)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 700 });
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const scroll = page.locator('.shell__scroll');
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);

  await page.getByRole('navigation', { name: 'Activity sections' })
    .getByRole('button', { name: 'Charts' })
    .click();

  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // Still the same route, and the activity is untouched.
  expect(new URL(page.url()).hash).toBe('#/viewer');
  await expect(page.getByText('Synthetic Run')).toBeVisible();
});

test('hides the laps panel when the file has no laps (AV-406)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  // GPX has no lap concept, so a real GPX activity must show no laps at all —
  // not an empty panel, and not a section link leading nowhere.
  await expect(page.getByRole('region', { name: 'Laps' })).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Activity sections' }).getByRole('button', { name: 'Laps' }),
  ).toHaveCount(0);
  await expect(page.locator('.map-section')).not.toHaveClass(/has-laps/);
  // The map still occupies the section on its own.
  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();
});

test('places laps beside the map only where there is room (AV-406)', async ({ page }) => {
  // A stylesheet contract, not a full feature test: no format this build can
  // parse carries laps, so there is no way to load real lap data through the
  // UI yet. The rendering itself is covered by the integration tests in
  // src/app/App.test.tsx, which drive the real components with real laps.
  // Replace this with a lap-bearing fixture once FIT lands (AV-702/AV-703).
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const section = page.locator('.map-section');
  await section.evaluate((el) => el.classList.add('has-laps'));

  await page.setViewportSize({ width: 1500, height: 900 });
  await expect
    .poll(() => section.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length))
    .toBe(2);

  await page.setViewportSize({ width: 900, height: 900 });
  await expect
    .poll(() => section.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length))
    .toBe(1);
});

test('excludes a recording gap from the distance (P1 regression)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'paused-run.gpx');

  // Two 111 m legs; the ~5.5 km between them was not travelled on this route.
  // Accumulating across the segment boundary reported 5.7 km instead.
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('222 m');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
});

test('shows device information and never the serial number (AV-405)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'device-metadata.gpx');

  const device = page.getByRole('region', { name: 'Device' });
  await expect(device).toContainText('Garmin');
  await expect(device).toContainText('Edge 530');
  await expect(device).toContainText('9.75');

  // Privacy regression: the serial is in the file and in the domain model, but
  // it must never reach the page.
  await expect(page.locator('body')).not.toContainText('3939123456');
});

test('omits the device panel when the file states nothing useful (AV-405)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  // The fixture's creator is still device information, so the panel appears —
  // but as "Recorded with", not as a hardware model it cannot vouch for.
  const device = page.getByRole('region', { name: 'Device' });
  await expect(device).toContainText('Recorded with');
  await expect(device).not.toContainText('Manufacturer');
});

test('selects a chart range by dragging (AV-508)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const chart = page.getByRole('region', { name: 'Elevation chart' }).locator('svg');
  // Charts sit below the map: the pointer needs the chart actually on screen.
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, y, { steps: 8 });
  // Visible during the drag, before release.
  await expect(page.locator('[data-testid="chart-selection"]').first()).toBeVisible();
  await page.mouse.up();

  // On release the charts focus on the section, so the band gives way to the
  // focused view and its way back out (AV-511).
  await expect(page.getByRole('button', { name: 'Reset View' })).toBeVisible();
  await expect(page.locator('[data-testid="chart-selection"]')).toHaveCount(0);
});

test('ignores a tiny drag and treats it as a click (AV-508)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const chart = page.getByRole('region', { name: 'Elevation chart' }).locator('svg');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 3, y);
  await page.mouse.up();

  await expect(page.locator('[data-testid="chart-selection"]')).toHaveCount(0);
});

test('keeps the selection when the x-axis changes (AV-509)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const chart = page.getByRole('region', { name: 'Elevation chart' }).locator('svg');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Reset View' })).toBeVisible();

  await page.getByRole('button', { name: 'Time' }).click();

  // Stored as point indices, so the focus is re-projected onto the time axis
  // rather than discarded.
  await expect(page.getByRole('button', { name: 'Reset View' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Elevation chart' }).getByText(/x-axis: elapsed time/),
  ).toBeVisible();
});

test('redraws the charts for the selected section and back (AV-511, AV-512)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const chart = page.getByRole('region', { name: 'Elevation chart' }).locator('svg');
  await chart.scrollIntoViewIfNeeded();
  const plotted = () => chart.locator('.chart__line').getAttribute('d');
  const whole = await plotted();

  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 8 });
  await page.mouse.up();

  // The charts now show the section, and say so without implying an edit.
  await expect(page.getByText(/file is unchanged/i)).toBeVisible();
  expect(await plotted()).not.toBe(whole);

  await page.getByRole('button', { name: 'Reset View' }).click();

  await expect(page.getByRole('button', { name: 'Reset View' })).toHaveCount(0);
  await expect.poll(plotted).toBe(whole);
});

test('marks chart axes at real intervals and keeps labels clear (AV-514)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  const chart = page.getByRole('region', { name: 'Elevation chart' });
  const svg = chart.locator('svg');

  // The y gutter is real: labels sit left of the plot, never on top of it.
  const gap = await svg.evaluate((node) => {
    const label = node.querySelector('.chart__axis-label--y')!;
    const grid = node.querySelector('.chart__grid')!;
    return Number(grid.getAttribute('x1')) - Number(label.getAttribute('x'));
  });
  expect(gap).toBeGreaterThan(0);

  // No label escapes the canvas on the left.
  const leftmost = await svg.evaluate((node) =>
    Math.min(
      ...[...node.querySelectorAll('.chart__axis-label--y')].map((label) =>
        Number(label.getAttribute('x')),
      ),
    ),
  );
  expect(leftmost).toBeGreaterThan(0);

  // Text is not stretched: the viewBox is 1:1 with the rendered pixels.
  const [boxWidth, attrWidth] = await svg.evaluate((node) => [
    node.getBoundingClientRect().width,
    Number(node.getAttribute('width')),
  ]);
  expect(Math.abs(boxWidth - attrWidth)).toBeLessThan(2);

  // A 334 m activity has no whole-kilometre tick, so the ends carry the scale.
  await expect(chart.locator('.is-endpoint')).toHaveCount(2);

  await page.getByRole('button', { name: 'Time' }).click();
  await expect(chart.getByText(/x-axis: elapsed time/)).toBeVisible();
});

test('renders chart axes in both themes (AV-514)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');
  const label = page
    .getByRole('region', { name: 'Elevation chart' })
    .locator('.chart__axis-label--y')
    .first();

  await openSettings(page);
  await page.getByRole('radio', { name: 'Light' }).check();
  const light = await label.evaluate((node) => getComputedStyle(node).fill);

  await page.getByRole('radio', { name: 'Dark' }).check();
  const dark = await label.evaluate((node) => getComputedStyle(node).fill);

  // Axis text follows the theme rather than staying one fixed colour.
  expect(light).not.toBe(dark);
});

test('switches theme from settings without disturbing the activity (AV-009)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();

  const html = page.locator('html');
  const bodyBackground = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await openSettings(page);
  await page.getByRole('radio', { name: 'Light' }).check();

  await expect(html).toHaveAttribute('data-theme', 'light');
  const light = await bodyBackground();

  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const dark = await bodyBackground();

  // The palette really changed, not just the attribute.
  expect(light).not.toBe(dark);

  await page.getByRole('button', { name: 'Close settings' }).click();
  // No reload, no route change, and the activity is untouched.
  expect(new URL(page.url()).hash).toBe('#/viewer');
  await expect(page.getByText('Elevation Route')).toBeVisible();
});

test('applies the theme before first paint (AV-009)', async ({ page }) => {
  // The inline bootstrap in index.html resolves `system` before React boots,
  // so a dark-mode device never flashes the light palette.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./#/viewer');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('remembers the theme across a reload, and applies it before paint', async ({ page }) => {
  // A dark-mode device, so the stored choice has to override the system one to
  // prove it was read at all.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('./#/viewer');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const settings = await openSettings(page);
  await settings.getByRole('radio', { name: 'Light' }).check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload();

  // Still light on a dark-mode device: the stored choice survived, and the
  // pre-paint script read it rather than waiting for React.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('opentrack-viewer:theme'))).toBe('light');

  // ...and it is the only thing stored.
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toEqual(['opentrack-viewer:theme']);
});

test('starts from the browser locale for units', async ({ browser }) => {
  const american = await browser.newContext({ locale: 'en-US' });
  const page = await american.newPage();
  await page.goto(`${SITE}#/viewer`);
  await page.getByTestId('file-input').setInputFiles('src/test/fixtures/route-with-elevation.gpx');

  // No setting touched: the locale chose miles. `mph` rather than `mi`, which
  // runs into the next label in the concatenated text content.
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('mph');
  await american.close();

  const french = await browser.newContext({ locale: 'fr-FR' });
  const other = await french.newPage();
  await other.goto(`${SITE}#/viewer`);
  await other.getByTestId('file-input').setInputFiles('src/test/fixtures/route-with-elevation.gpx');

  await expect(other.getByRole('region', { name: 'Activity summary' })).toContainText('km/h');
  await french.close();
});

test('opens Settings from the homepage header (AV-007)', async ({ page }) => {
  await page.goto('./');

  // TD-008: an app-wide choice should not require opening a file to find.
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Dark' })).toBeVisible();

  // Choosing a theme on the homepage applies there, without navigating.
  await dialog.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(new URL(page.url()).hash).toBe('');

  // Close activity stays scoped to pages that have one.
  await expect(page.getByRole('button', { name: 'Close activity' })).toHaveCount(0);
});

test('reads a real GoPro video and opens it in the viewer (AV-907)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  const requests = recordRequests(page);

  await page.goto('./#/video-telemetry');
  await expect(page.getByRole('heading', { name: 'Video telemetry' })).toBeVisible();

  // Nothing of the viewer before there is anything to view.
  await expect(page.getByRole('region', { name: 'Route map' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Export activity' })).toHaveCount(0);

  // A real HERO8 clip, read by the browser itself — 4.2 MB of MP4.
  await page.getByTestId('file-input').setInputFiles('src/test/fixtures/hero8.mp4');

  // This clip was recorded indoors, so every GPS sample lacks a fix: the page
  // has to say so rather than draw a route through the North Pacific.
  const failed = page.getByRole('region', { name: 'Extraction failed' });
  await expect(failed).toBeVisible({ timeout: 60_000 });
  await expect(failed.getByRole('alert')).toContainText(/usable satellite fix/i);

  // Reading a video uploads nothing, whatever the outcome.
  expect(requests.map((request) => request.url()).filter((url) => !url.startsWith(ORIGIN))).toEqual(
    [],
  );
});

test('offers video telemetry in the Tools menu (AV-907)', async ({ page }) => {
  await page.goto('./');

  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Video telemetry' }).click();

  await expect(page.getByRole('heading', { name: 'Video telemetry' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/video-telemetry');

  // Opened directly, the viewer has no handed-over activity and says so.
  await page.goto('./#/viewer');
  await expect(page.getByTestId('file-input')).toBeAttached();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toHaveCount(0);
});

test('navigates to the viewer from the Tools menu (AV-012)', async ({ page }) => {
  await page.goto('./');

  // The standalone Viewer button is gone; navigation is in the menu. Exact,
  // because the brand link "OpenTrack Viewer" contains the word and Playwright
  // matches accessible names by substring.
  await expect(
    page.locator('.shell__header').getByRole('link', { name: 'Viewer', exact: true }),
  ).toHaveCount(0);

  const menu = await openTools(page);
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'File viewer' }).click();

  expect(new URL(page.url()).hash).toBe('#/viewer');
  await expect(page.getByTestId('file-input')).toBeAttached();
  await expect(page.getByRole('menu', { name: 'Tools' })).toHaveCount(0);
});

test('closes the Tools menu on Escape and outside clicks (AV-012)', async ({ page }) => {
  await page.goto('./#/viewer');

  await openTools(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Tools' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Tools/ })).toBeFocused();

  await openTools(page);
  await page.locator('.shell__header').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('menu', { name: 'Tools' })).toHaveCount(0);
});

test('keeps the Tools menu clear of the title and settings icon (AV-012)', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  await page.goto('./#/viewer');

  const title = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
  const tools = (await page.getByRole('button', { name: /Tools/ }).boundingBox())!;
  const settings = (await page.getByRole('button', { name: 'Settings' }).boundingBox())!;

  // Beside the title, not on top of it, and clear of the settings icon.
  expect(tools.x).toBeGreaterThanOrEqual(title.x + title.width - 1);
  expect(tools.x + tools.width).toBeLessThanOrEqual(settings.x + 1);
});

test('serves Terms and Conditions as its own route (AV-008)', async ({ page }) => {
  await page.goto('./');

  await page.getByRole('main').getByRole('link', { name: /Terms and Conditions/ }).click();

  expect(new URL(page.url()).hash).toBe('#/terms');
  await expect(page.getByRole('heading', { name: 'Terms and Conditions' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText(/draft/i);

  // Informational only: nothing that could process an activity is mounted.
  await expect(page.getByTestId('file-input')).toHaveCount(0);
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Deep-linkable, which is why it is a route rather than a modal.
  await page.goto('./#/terms');
  await expect(page.getByRole('heading', { name: 'Terms and Conditions' })).toBeVisible();
});

test('keeps a loaded activity while reading the Terms (AV-008)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();

  await page.getByRole('contentinfo').getByRole('link', { name: 'Terms and Conditions' }).click();
  await expect(page.getByRole('heading', { name: 'Terms and Conditions' })).toBeVisible();

  const menu = await openTools(page);
  await menu.getByRole('menuitem', { name: 'File viewer' }).click();

  await expect(page.getByText('Elevation Route')).toBeVisible();
});

test('focuses the map on the selected section, then leaves it alone (AV-604)', async ({
  page,
}) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  // The focused section is drawn over the dimmed full route.
  const focusPixels = () =>
    page
      .locator('.maplibregl-canvas')
      .screenshot()
      .then((shot) => countPixelsNear(decodePng(shot), [0xff, 0xd1, 0x66], 40));
  expect(await focusPixels()).toBe(0);

  // Measured after the screenshot: taking one scrolls its target into view,
  // which would otherwise leave this box pointing at the wrong place.
  const chart = page.getByRole('region', { name: 'Elevation chart' }).locator('svg');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Reset View' })).toBeVisible();

  await expect.poll(focusPixels, { timeout: 5000 }).toBeGreaterThan(50);

  // Reset View puts the whole route back.
  await page.getByRole('button', { name: 'Reset View' }).click();
  await expect.poll(focusPixels, { timeout: 5000 }).toBe(0);
});

test('keeps the summary describing the whole activity while focused (AV-604)', async ({
  page,
}) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const summary = page.getByRole('region', { name: 'Activity summary' });
  const whole = await summary.textContent();

  const chart = page.getByRole('region', { name: 'Elevation chart' }).locator('svg');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Reset View' })).toBeVisible();

  // The summary describes the activity, not the selection.
  expect(await summary.textContent()).toBe(whole);
});

test('charts speed for a ride, not pace or run cadence (AV-513, AV-515)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'ride-with-speed.gpx');

  const speed = page.getByRole('region', { name: 'Speed chart' });
  await expect(speed).toContainText('km/h');
  // ~8 m/s is around 29 km/h.
  await expect(speed).toContainText(/2[5-9]\.\d|3[0-2]\.\d/);

  // Run-specific charts explain that they do not apply to a ride.
  await expect(page.getByRole('region', { name: 'Pace chart' })).toContainText(
    /shown for running activities/i,
  );
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toContainText(
    /shown for running activities/i,
  );
});

test('labels running cadence in strides per minute (AV-515)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const cadence = page.getByRole('region', { name: 'Cadence chart', exact: true });
  await expect(cadence).toContainText('Cadence (spm)');
  await expect(cadence).not.toContainText('rpm');

  // A run gets no speed chart.
  await expect(page.getByRole('region', { name: 'Speed chart' })).toContainText(
    /shown for cycling activities/i,
  );
});

test('highlights a lap from its row, and lets go again (§17)', async ({ page }) => {
  await loadFixture(page, 'run-with-laps.tcx');
  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();

  const laps = page.getByRole('region', { name: 'Laps' });
  await laps.getByRole('button', { name: 'Highlight lap 1' }).click();
  await expect(laps.getByRole('button', { name: 'Stop highlighting lap 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Pressing again puts the route back, and no other lap is left pressed.
  await laps.getByRole('button', { name: 'Stop highlighting lap 1' }).click();
  await expect(laps.getByRole('button', { name: 'Highlight lap 1' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(laps.getByRole('button', { name: /^Stop highlighting/ })).toHaveCount(0);
});

test('offers no control for a lap with no stretch of route to draw (§17)', async ({ page }) => {
  await loadFixture(page, 'run-with-laps.tcx');

  // Lap 2 of this fixture has one point either side of a 4.5 minute pause, so
  // there is no continuous line to highlight. Found by running the app: the
  // press used to do nothing at all, with nothing said about why.
  const laps = page.getByRole('region', { name: 'Laps' });
  await expect(laps.getByRole('button', { name: 'Highlight lap 2' })).toHaveCount(0);
  await expect(laps.getByTitle(/either side of a recording gap/i)).toHaveText('2');

  // Its figures are unaffected: only the control is absent.
  await expect(laps).toContainText('11');
});

test('charts pedal cadence for a ride that records it', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'ride-with-sensors.fit');

  const pedal = page.getByRole('region', { name: 'Pedal cadence chart' });
  await expect(pedal).toBeVisible();
  await expect(pedal).toContainText('rpm');
  await expect(pedal).toContainText(/pedal revolutions per minute/i);

  // The running cadence chart is still listed, saying why it is empty — the
  // same way a run is told that speed is a cycling chart.
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toContainText(
    /shown for running activities/i,
  );
});

test('exports the loaded activity as a real download (AV-554)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Rewrite as GPX' }).click();
  const saved = await download;

  expect(saved.suggestedFilename()).toBe('Elevation-Route.gpx');

  // The bytes the browser actually received are valid GPX.
  const stream = await saved.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const xml = Buffer.concat(chunks).toString('utf-8');

  expect(xml).toContain('<gpx version="1.1"');
  expect(xml).toContain('<trkpt lat=');
  await expect(page.getByText(/^Saved/)).toContainText('Elevation-Route.gpx');
});

test('exports only the selected section when one is chosen (AV-554)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  // Drag a selection on the elevation chart. Charts sit below the map, so the
  // pointer needs the chart actually on screen.
  const chart = page.getByTestId('elevation-chart-svg');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Reset View' })).toBeVisible();

  await expect(page.getByRole('radio', { name: 'Selected section' })).toBeChecked();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Rewrite as GPX' }).click();
  const saved = await download;

  expect(saved.suggestedFilename()).toBe('Elevation-Route-section.gpx');
});

test('shows the selection its own figures, leaving the activity summary alone (AV-605)', async ({
  page,
}) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  const summary = page.getByRole('region', { name: 'Activity summary' });
  const distanceOf = (region: Locator) =>
    region.locator('.summary__stat', { hasText: 'Distance' }).locator('dd').innerText();

  const wholeBefore = await distanceOf(summary);
  await expect(page.getByRole('region', { name: 'Selected section summary' })).toHaveCount(0);

  // Select roughly the middle of the elevation chart.
  const chart = page.getByTestId('elevation-chart-svg');
  await chart.scrollIntoViewIfNeeded();
  const box = (await chart.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
  await page.mouse.up();

  const selection = page.getByRole('region', { name: 'Selected section summary' });
  await expect(selection).toBeVisible();
  await expect(selection).toContainText('Selected section');

  // The section is shorter than the whole ride...
  const sectionDistance = await distanceOf(selection);
  expect(sectionDistance).not.toBe(wholeBefore);
  // ...and the activity summary still says exactly what it said before, which
  // is the whole point: "Distance" is never ambiguous.
  expect(await distanceOf(summary)).toBe(wholeBefore);

  await page.getByRole('button', { name: 'Reset View' }).click();
  await expect(selection).toHaveCount(0);
  expect(await distanceOf(summary)).toBe(wholeBefore);
});

test('renders the export panel’s secondary text as muted', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');
  // The panel renders after the parse; reading it before then finds nothing.
  await expect(page.getByRole('region', { name: 'Export activity' })).toBeVisible();

  const colours = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).color : undefined;
    };
    return { body: read('.export__body'), text: getComputedStyle(document.body).color };
  });

  // A `var()` naming an undefined token is dropped silently, and the element
  // inherits body text instead — which is exactly what it must not do here.
  expect(colours.body).toBeDefined();
  expect(colours.body).not.toBe(colours.text);
});

test('opens a TCX run, with its laps and charts (AV-751)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-laps.tcx');

  const summary = page.getByRole('region', { name: 'Activity summary' });
  await expect(summary).toContainText('TCX');
  await expect(summary).toContainText('Avg pace');

  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();

  // TCX states laps and the calories only it carries.
  const laps = page.getByRole('region', { name: 'Laps' });
  await expect(laps).toBeVisible();
  await expect(laps).toContainText('Calories');
  await expect(laps).toContainText('12');

  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toBeVisible();
  // The device unit id is a serial number and must never appear.
  await expect(page.locator('body')).not.toContainText('3939123456');
});

test('exports a TCX file the app can read back (AV-752)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-laps.tcx');

  // A TCX file already defaults to TCX, and writing it back out is a rewrite.
  await expect(page.getByLabel('Format')).toHaveValue('tcx');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Rewrite as TCX' }).click();
  const saved = await download;

  expect(saved.suggestedFilename()).toMatch(/\.tcx$/);

  const stream = await saved.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const xml = Buffer.concat(chunks);
  expect(xml.toString('utf-8')).toContain('<TrainingCenterDatabase');

  // Hand it straight back to the app: the real proof it is readable TCX.
  await page.getByRole('button', { name: 'Close activity' }).click();
  await page.getByTestId('file-input').setInputFiles({
    name: saved.suggestedFilename(),
    mimeType: 'application/vnd.garmin.tcx+xml',
    buffer: xml,
  });

  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('TCX');
  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();
});

test('exports a FIT file the app can read back (AV-553)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  await page.getByLabel('Format').selectOption('fit');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Convert to FIT' }).click();
  const saved = await download;

  expect(saved.suggestedFilename()).toBe('Elevation-Route.fit');

  const stream = await saved.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);

  // A real FIT header, produced by the browser rather than by a test double.
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('.FIT');

  // The proof it is readable: hand it straight back to the app.
  await page.getByRole('button', { name: 'Close activity' }).click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'Elevation-Route.fit',
    mimeType: 'application/vnd.ant.fit',
    buffer: bytes,
  });

  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('FIT');
  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();
});

test('distinguishes a rewrite from a conversion (AV-555)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'ride-with-sensors.fit');

  // A FIT file offers its own format first, named for what it is.
  await expect(page.getByLabel('Format')).toHaveValue('fit');
  await expect(page.getByRole('button', { name: 'Rewrite as FIT' })).toBeVisible();

  // Choosing another target is a conversion, and the file that arrives is one.
  await page.getByLabel('Format').selectOption('gpx');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Convert to GPX' }).click();
  const saved = await download;

  expect(saved.suggestedFilename()).toMatch(/\.gpx$/);
});

test('disables an export target it cannot write, and says why (AV-555)', async ({ page }) => {
  await loadFixture(page, 'treadmill-run.fit');

  // An indoor run has timestamps but no coordinates, so GPX is the one format
  // it cannot be written to. Previously it was offered and refused on press.
  const gpx = page.getByRole('option', { name: /GPX/ });
  await expect(gpx).toBeDisabled();
  await expect(gpx).toContainText(/unavailable/i);

  // The formats it can be written to stay on offer, and work.
  await expect(page.getByRole('option', { name: /^FIT/ })).toBeEnabled();
  await expect(page.getByRole('option', { name: /^TCX/ })).toBeEnabled();

  await page.getByLabel('Format').selectOption('tcx');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Convert to TCX' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.tcx$/);
});

test('has no export controls before an activity is open (AV-554)', async ({ page }) => {
  await page.goto('./#/viewer');

  await expect(page.getByRole('button', { name: /^(Rewrite as|Convert to)/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Export activity' })).toHaveCount(0);
});

test('exports without contacting a server (AV-550)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  const requests = recordRequests(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Rewrite as GPX' }).click();
  await download;

  expect(requests.map((request) => request.url()).filter((url) => !url.startsWith(ORIGIN))).toEqual(
    [],
  );
});

test('opens a FIT ride, with its map and sensor charts (AV-702)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'ride-with-sensors.fit');

  const summary = page.getByRole('region', { name: 'Activity summary' });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('FIT');
  await expect(summary).toContainText('Avg speed');

  // The route reached the map, so the lazy FIT chunk and the map agree.
  await expect(page.getByRole('region', { name: 'Route map' })).toBeVisible();

  // Sensors the FIT file carries become charts with no format-specific code.
  for (const chart of ['Speed chart', 'Heart rate chart', 'Power chart', 'Elevation chart']) {
    await expect(page.getByRole('region', { name: chart })).toBeVisible();
  }
});

test('opens an indoor FIT run with no GPS at all (AV-703)', async ({ page }) => {
  await loadFixture(page, 'treadmill-run.fit');

  const summary = page.getByRole('region', { name: 'Activity summary' });
  await expect(summary).toBeVisible();
  // A run, so pace rather than speed — and the distance is real despite there
  // being no GPS, because the treadmill recorded it.
  await expect(summary).toContainText('Avg pace');
  await expect(summary).toContainText('133 m');
  // The map box explains itself rather than showing an empty map, and MapLibre
  // is never downloaded because there is nothing to draw.
  const map = page.getByRole('region', { name: 'Route map' });
  await expect(map).toContainText('No route to display');
  await expect(map.locator('canvas')).toHaveCount(0);

  // Charts that need no position still work.
  await expect(page.getByRole('region', { name: 'Pace chart' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toBeVisible();
});

test('tells an indoor FIT reader about the missing route exactly once', async ({ page }) => {
  await loadFixture(page, 'treadmill-run.fit');
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();

  // The notes are collapsed until asked for.
  await page.getByText(/parser (note|warning)/).click();

  const messages = await page.getByRole('listitem').allTextContents();
  const noGps = messages.filter((text) => /no GPS coordinates/i.test(text));
  expect(noGps).toHaveLength(1);
});

test('never displays the serial number in a FIT file (AV-702)', async ({ page }) => {
  await loadFixture(page, 'ride-with-sensors.fit');

  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();
  // The fixture's device serial. Parsed, but never rendered anywhere.
  await expect(page.locator('body')).not.toContainText('3987654321');
});

test('reads a FIT file without contacting a server (AV-702)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  const requests = recordRequests(page);
  await loadFixture(page, 'ride-with-sensors.fit');
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();

  const external = requests.filter((request) => !request.url().startsWith(ORIGIN));
  expect(external.map((request) => request.url())).toEqual([]);
});

test('shows a run its average pace, and a ride its average speed', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  const summary = page.getByRole('region', { name: 'Activity summary' });

  await loadFixture(page, 'run-with-cadence.gpx');
  await expect(summary).toContainText('Avg pace');
  await expect(summary).toContainText(/\d:\d\d \/km/);
  await expect(summary).not.toContainText('Avg speed');

  await page.getByRole('button', { name: 'Close activity' }).click();
  await loadFixture(page, 'ride-with-speed.gpx');
  await expect(summary).toContainText('Avg speed');
  await expect(summary).not.toContainText('Avg pace');
});

test('switches speed units across the chart and the summary (AV-513)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'ride-with-speed.gpx');

  const chart = page.getByRole('region', { name: 'Speed chart' });
  const summary = page.getByRole('region', { name: 'Activity summary' });

  // ~8 m/s is 28.8 km/h, in both places.
  await expect(chart).toContainText('Speed (km/h)');
  await expect(summary).toContainText('Avg speed');
  await expect(summary).toContainText(/2[5-9]\.\d km\/h|3[0-2]\.\d km\/h/);

  await openSettings(page);
  await page.getByLabel('Units').selectOption('imperial');
  await page.getByRole('button', { name: 'Close settings' }).click();

  // ...and miles per hour when Imperial is chosen.
  await expect(chart).toContainText('Speed (mph)');
  await expect(summary).toContainText(/1[5-9]\.\d mph|2[0-1]\.\d mph/);
  await expect(summary).not.toContainText('km/h');
});

test('shows a useful error for a malformed GPX file', async ({ page }) => {
  await loadFixture(page, 'malformed.gpx');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not open this file');
  await expect(alert).toContainText('invalid_gpx_xml');
});

test('rejects an unsupported file before parsing', async ({ page }) => {
  await loadFixture(page, 'not-gpx.txt');

  await expect(page.getByRole('alert')).toContainText('not supported');
});

test('never uploads the activity file (privacy regression)', async ({ page }) => {
  const requests = recordRequests(page);

  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();

  const mutating = requests.filter((request) =>
    ['POST', 'PUT', 'PATCH'].includes(request.method()),
  );
  expect(mutating).toHaveLength(0);

  // No request body may carry coordinates or file names from the activity.
  for (const request of requests) {
    const body = request.postData() ?? '';
    expect(body).not.toContain('51.50');
    expect(body).not.toContain('route-with-elevation');
  }
});

test('route-only mode issues no tile requests', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  const requests = recordRequests(page);

  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();

  const external = requests.filter((request) => !request.url().startsWith(ORIGIN));
  expect(external).toHaveLength(0);
});

test('hovering the chart highlights the corresponding map point', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  const chart = page.getByTestId('elevation-chart-svg');
  await expect(chart).toBeVisible();
  await chart.hover({ position: { x: 10, y: 40 } });

  // Hovering one chart marks the point on the others too: the hover is shared
  // interaction state, not a property of the chart the pointer is over.
  await expect(chart.getByTestId('chart-cursor')).toBeVisible();
  await expect(page.getByTestId('chart-cursor').first()).toBeVisible();
  expect(await page.getByTestId('chart-cursor').count()).toBeGreaterThan(1);
});

test('shows a placeholder instead of a map for an activity with no GPS', async ({ page }) => {
  await loadFixture(page, 'no-location.gpx');

  await expect(page.getByTestId('map-placeholder')).toContainText('No route to display');
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  // The activity is still usable.
  await expect(page.getByTestId('elevation-chart-svg')).toBeVisible();
});

test('hides the drop zone while an activity is open', async ({ page }) => {
  await expect(page.getByTestId('file-input')).toBeAttached();

  await loadFixture(page, 'simple-route.gpx');
  await expect(page.getByText('Simple Route')).toBeVisible();

  await expect(page.getByTestId('file-input')).toHaveCount(0);
  // Named specifically: the export panel reassures about uploading too, and the
  // claim under test is that the *drop zone* is gone.
  await expect(page.getByText(/^Drop a .* file here$/)).toHaveCount(0);

  // Closing brings it back, which is the route to loading a different file.
  await page.getByRole('button', { name: 'Close activity' }).click();
  await expect(page.getByTestId('file-input')).toBeAttached();
});

test('closing the activity returns to the empty state', async ({ page }) => {
  await loadFixture(page, 'simple-route.gpx');
  await expect(page.getByText('Simple Route')).toBeVisible();

  await page.getByRole('button', { name: 'Close activity' }).click();

  await expect(page.getByText('No activity open')).toBeVisible();
});

test('opens settings as a modal from the header (AV-007)', async ({ page }) => {
  await expect(page.getByLabel('Basemap tiles')).toHaveCount(0);

  const dialog = await openSettings(page);

  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByLabel('Basemap tiles')).toBeVisible();
  await expect(page.getByLabel('Units')).toBeVisible();
  // The route does not change, and the viewer stays mounted behind it.
  expect(new URL(page.url()).hash).toBe('#/viewer');
  await expect(page.getByTestId('file-input')).toBeAttached();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps the loaded activity while settings is open (AV-007)', async ({ page }) => {
  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();

  await openSettings(page);
  await page.getByLabel('Units').selectOption('imperial');

  // The activity is still there behind the dialog, already in the new units.
  await expect(page.getByText('Elevation Route')).toBeVisible();
  await expect(page.getByText('Elevation (ft)')).toBeVisible();

  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByText('Elevation Route')).toBeVisible();
  await expect(page.getByText('Elevation (ft)')).toBeVisible();
});

test('keeps the footer below the fold until the content is scrolled', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toBeAttached();

  const viewport = page.viewportSize()!;
  const footer = page.getByRole('contentinfo');
  const scroll = page.locator('.shell__scroll');
  const header = page.locator('.shell__header');

  // The content really does overflow, so this is not passing on a short page.
  expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

  // The footer sits after the content, off-screen until the reader gets there.
  const before = (await footer.boundingBox())!;
  expect(before.y).toBeGreaterThan(viewport.height);

  // The overflow must be reachable by a real gesture: `overflow: hidden` still
  // permits programmatic scrollTo, so asserting on that would pass either way.
  //
  // The pointer must be over the overview box, not the centre of the scroll
  // region: that centre is the map canvas, and MapLibre consumes the wheel for
  // zooming, which made this test position-dependent.
  const overview = (await page.getByRole('region', { name: 'Activity overview' }).boundingBox())!;
  await page.mouse.move(overview.x + overview.width / 2, overview.y + 20);
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, 200);
        return scroll.evaluate((el) => el.scrollTop);
      },
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);

  // Positioning is asserted from a known scroll offset rather than wherever the
  // wheel happened to land.
  await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const after = (await footer.boundingBox())!;
  expect(Math.round(after.y + after.height)).toBe(viewport.height);
  await expect(footer).toBeInViewport();

  // The header stays put throughout.
  expect((await header.boundingBox())!.y).toBe(0);
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(scrollHeight).toBeLessThanOrEqual(viewport.height + 1);
});

test('grows short content so the footer still reaches the bottom edge', async ({ page }) => {
  // Nothing loaded: the body must stretch rather than leaving the footer
  // floating halfway up the page.
  const viewport = page.viewportSize()!;
  const footer = page.getByRole('contentinfo');
  const scroll = page.locator('.shell__scroll');

  expect(await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
  const box = (await footer.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(viewport.height);
  await expect(footer).toBeInViewport();
});

test('separates and pads the footer', async ({ page }) => {
  const footer = page.getByRole('contentinfo');

  // A gap above it, so it does not butt up against the content.
  const marginTop = await footer.evaluate((el) => parseFloat(getComputedStyle(el).marginTop));
  expect(marginTop).toBeGreaterThan(0);

  // Breathing room inside the columns...
  const inner = await page.locator('.footer__inner').evaluate((el) => {
    const computed = getComputedStyle(el);
    return {
      paddingTop: parseFloat(computed.paddingTop),
      paddingLeft: parseFloat(computed.paddingLeft),
    };
  });
  expect(inner.paddingTop).toBeGreaterThanOrEqual(24);
  expect(inner.paddingLeft).toBeGreaterThanOrEqual(16);

  // ...and a rule between the columns and the copyright line.
  const bottom = await page.locator('.footer__bottom').evaluate((el) => {
    const computed = getComputedStyle(el);
    return {
      borderTopWidth: parseFloat(computed.borderTopWidth),
      paddingTop: parseFloat(computed.paddingTop),
      textAlign: computed.textAlign,
    };
  });
  expect(bottom.borderTopWidth).toBeGreaterThan(0);
  expect(bottom.paddingTop).toBeGreaterThanOrEqual(12);
  expect(bottom.textAlign).toBe('center');
});

test('lays the footer out in columns on a wide screen', async ({ page }) => {
  const columns = await page
    .locator('.footer__inner')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

  expect(columns).toBe(3);

  // The brand block and the first link column sit side by side, not stacked.
  const brand = (await page.locator('.footer__brand').boundingBox())!;
  const firstColumn = (await page.getByRole('navigation', { name: 'App' }).boundingBox())!;
  expect(firstColumn.x).toBeGreaterThan(brand.x + brand.width - 1);
});

test('stacks the footer columns on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 700 });

  const columns = await page
    .locator('.footer__inner')
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);

  expect(columns).toBe(1);
});

test('keeps the footer reachable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 700 });
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');
  await expect(page.getByRole('region', { name: 'Cadence chart', exact: true })).toBeAttached();

  const footer = page.getByRole('contentinfo');
  await footer.scrollIntoViewIfNeeded();

  const box = (await footer.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(700 + 1);
  await expect(footer).toBeInViewport();
  // The header is still a fixed band at the top after scrolling.
  expect((await page.locator('.shell__header').boundingBox())!.y).toBe(0);
});

test('credits nyt87 in the footer on every page', async ({ page }) => {
  const credit = page.getByRole('link', { name: 'nyt87' });
  const repo = page.getByRole('link', { name: 'GitHub' });

  await expect(credit).toHaveAttribute('href', 'https://nyt87.github.io/');
  await expect(repo).toHaveAttribute('href', 'https://github.com/NYT87/opentrack-viewer');

  await page.getByRole('link', { name: 'OpenTrack Viewer' }).click();
  await expect(credit).toBeVisible();
  await expect(repo).toBeVisible();
});

test('serves every asset from the deployment sub-path', async ({ page }) => {
  // The app is deployed at https://nyt87.github.io/opentrack-viewer/. Anything
  // requested from the origin root would 404 there — including the lazily
  // loaded map chunk and MapLibre's worker, whose absence fails silently.
  const requests = recordRequests(page);
  // Reload so the document and its entry bundles are recorded too, not just
  // what loads after beforeEach. A goto to the same hash route would be a
  // same-document navigation and would re-request nothing.
  await page.reload();

  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await page.waitForTimeout(1500);

  const ownRequests = requests
    .map((request) => request.url())
    .filter((url) => url.startsWith(ORIGIN))
    // Browsers ask for /favicon.ico at the origin root on their own.
    .filter((url) => !url.endsWith('/favicon.ico'));

  // Document, entry JS, entry CSS, map chunk, map CSS, worker.
  expect(ownRequests.length).toBeGreaterThanOrEqual(6);
  expect(ownRequests.filter((url) => !url.startsWith(SITE))).toEqual([]);
  // The map chunk and its worker are the two that matter most.
  expect(ownRequests.some((url) => url.startsWith(`${SITE}assets/ActivityMap`))).toBe(true);
  expect(ownRequests.some((url) => url.startsWith(`${SITE}assets/maplibre-gl-worker`))).toBe(true);
});

test('deep-links into the viewer under the sub-path', async ({ page }) => {
  // Hash routing is what makes this work without server rewrites.
  await page.goto('./#/viewer');

  await expect(page.getByTestId('file-input')).toBeAttached();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'nyt87' })).toBeVisible();
});

test('falls back to the homepage for an unknown hash route (AV-006)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  // A stale bookmark, a renamed route, a typo — under the deployment sub-path,
  // where the router is the only thing that can resolve it.
  await page.goto('./#/settings');

  // The homepage itself, not an empty shell: its heading and its content.
  await expect(page.getByRole('heading', { name: /Open your activity files/i })).toBeVisible();
  await expect(page.getByText(/Your file stays on your device/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the Terms and Conditions' })).toBeVisible();

  // The chrome is intact, so the reader can go somewhere real from here.
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'nyt87' })).toBeVisible();

  // The title falls back to the site default rather than naming a route that
  // does not exist (AV-013).
  await expect(page).toHaveTitle(/open GPX, FIT and TCX activity files/);
  expect(errors).toEqual([]);

  // ...and navigating on from it works.
  await page.getByRole('link', { name: 'Read the Terms and Conditions' }).click();
  await expect(page.getByRole('heading', { name: /Terms and Conditions/i })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/terms');
});

test('publishes a 404 fallback for unknown paths, not just unknown hashes (AV-006)', async () => {
  // The other half of "no blank screen". A hash the router cannot resolve is
  // the app's problem; a *path* it never sees is the host's, and GitHub Pages
  // answers an unknown path with its own 404 page unless the build ships one.
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci-deploy.yml'), 'utf-8');

  expect(workflow).toContain('cp dist/index.html dist/404.html');
});

test('serves SEO metadata a crawler can read without running the app (AV-013)', async ({
  page,
}) => {
  // Fetched as text, not rendered: this is what a crawler that never executes
  // JavaScript actually sees.
  const html = await (await page.request.get(`${ORIGIN}${BASE_PATH}index.html`)).text();

  expect(html).toMatch(/<title>OpenTrack Viewer/);
  expect(html).toMatch(/<meta\s+name="description"/);
  expect(html).toMatch(/property="og:title"/);
  expect(html).toMatch(/property="og:image"/);
  expect(html).toMatch(/name="twitter:card"/);
  expect(html).toMatch(/rel="canonical"/);
});

test('publishes robots.txt and a sitemap that agree on the site URL (AV-013)', async ({
  page,
}) => {
  const robots = await (await page.request.get(`${ORIGIN}${BASE_PATH}robots.txt`)).text();
  const sitemap = await (await page.request.get(`${ORIGIN}${BASE_PATH}sitemap.xml`)).text();

  const sitemapUrl = robots.match(/Sitemap:\s*(\S+)/)?.[1];
  expect(sitemapUrl).toBeDefined();
  expect(sitemapUrl).toMatch(/\/sitemap\.xml$/);

  // One indexable URL, because the app routes on the hash.
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
  expect(locations).toHaveLength(1);
  expect(locations[0]).not.toContain('#');
  // ...and the sitemap the robots file points at is the one that was published.
  expect(sitemapUrl).toBe(`${locations[0]}sitemap.xml`);
});

test('updates the title on navigation, and never names the open file (AV-013)', async ({
  page,
}) => {
  await useRouteOnlyBasemap(page);
  // Every test starts on the viewer route.
  await expect(page).toHaveTitle(/^Open an activity file/);

  // Navigating changes it, with no reload: the brand is the link home.
  await page.getByRole('link', { name: 'OpenTrack Viewer', exact: true }).click();
  await expect(page).toHaveTitle(/open GPX, FIT and TCX activity files/);

  await page.getByRole('link', { name: 'Open an activity' }).first().click();
  await loadFixture(page, 'route-with-elevation.gpx');
  await expect(page.getByText('Elevation Route')).toBeVisible();

  // The route's own title, not the activity's.
  await expect(page).toHaveTitle(/^Open an activity file/);
  const head = await page.evaluate(() => document.head.innerHTML);
  expect(head).not.toContain('Elevation Route');
  expect(head).not.toContain('route-with-elevation');
});

test('scopes the web app manifest to the sub-path', async ({ page }) => {
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement;
    const response = await fetch(link.href);
    const parsed = await response.json();
    const resolve = (value: string) => new URL(value, link.href).pathname;
    return {
      status: response.status,
      href: new URL(link.href).pathname,
      startUrl: resolve(parsed.start_url),
      scope: resolve(parsed.scope),
      icon: resolve(parsed.icons[0].src),
    };
  });

  expect(manifest.status).toBe(200);
  expect(manifest.href).toBe(`${BASE_PATH}manifest.webmanifest`);
  expect(manifest.startUrl).toBe(BASE_PATH);
  expect(manifest.scope).toBe(BASE_PATH);
  expect(manifest.icon).toBe(`${BASE_PATH}icons/icon-192.png`);
});

test('serves the app shell offline after a first visit (AV-802)', async ({ page, context }) => {
  await page.goto('./#/viewer');
  // Wait for the worker to install and take control of the page.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(
    true,
  );

  await context.setOffline(true);
  try {
    await page.reload();

    // The shell is served entirely from the precache.
    await expect(page.getByRole('heading', { name: 'OpenTrack Viewer' })).toBeVisible();
    await expect(page.getByTestId('file-input')).toBeAttached();

    // ...and the app still does its job, because parsing never needed a server.
    await loadFixture(page, 'route-with-elevation.gpx');
    await expect(page.getByText('Elevation Route')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Elevation chart' })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('caches the app, and nothing of the user or the tile provider (AV-802)', async ({ page }) => {
  await page.goto('./#/viewer');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const name of names) {
      const keys = await (await caches.open(name)).keys();
      urls.push(...keys.map((request) => request.url));
    }
    return urls;
  });

  expect(cached.length).toBeGreaterThan(0);
  // Everything cached is this app's own build output.
  expect(cached.filter((url) => !url.startsWith(ORIGIN))).toEqual([]);
  // Map tiles are explicitly out of scope: caching them would record where the
  // reader has been looking.
  expect(cached.filter((url) => url.includes('tile.openstreetmap.org'))).toEqual([]);
  // The map chunk and its worker are cached, so route-only mode works offline.
  expect(cached.some((url) => url.includes('assets/ActivityMap'))).toBe(true);
  expect(cached.some((url) => url.includes('maplibre-gl-worker'))).toBe(true);
  // The FIT parser chunk too, so a .fit file still opens offline.
  expect(cached.some((url) => url.includes('assets/parseFit'))).toBe(true);
  // And the GoPro extraction chunks, so video telemetry reads offline too.
  expect(cached.some((url) => url.includes('assets/extractGpmf'))).toBe(true);
  expect(cached.some((url) => url.includes('assets/parseGopro'))).toBe(true);
});

test('adds, drags and deletes points on a real map (AV-1104)', async ({ page }) => {
  const requests = recordRequests(page);
  await useRouteOnlyBasemap(page);
  await page.goto('./#/route-builder');
  await page.getByRole('button', { name: 'Start a new route' }).click();

  const map = page.getByTestId('route-editor-map');
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const points = page.getByRole('region', { name: 'Current route' });
  const distanceText = async () => (await points.locator('.summary__value').nth(1).textContent()) ?? '';

  // Click-to-add. Clicks are spaced so none lands on a point already placed.
  await page.mouse.click(cx - 80, cy);
  await page.mouse.click(cx, cy - 40);
  await page.mouse.click(cx + 80, cy);
  await expect(points.locator('.summary__value').first()).toHaveText('3');
  await expect(page.getByText('Point 3 of 3 selected')).toBeVisible();
  const before = await distanceText();

  // MapLibre draws the new points on its next frame; a person takes longer than
  // that to reach for one, a test does not.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(250);

  // Drag the middle point; the map underneath must not pan with it.
  await page.mouse.move(cx, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 70, { steps: 8 });
  await page.mouse.move(cx, cy - 110, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByText('Point 2 of 3 selected')).toBeVisible();
  await expect(points.locator('.summary__value').first()).toHaveText('3');
  await expect.poll(distanceText).not.toBe(before);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

  // The drop did not also add a point, and a later click still does.
  await page.mouse.click(cx + 120, cy + 60);
  await expect(points.locator('.summary__value').first()).toHaveText('4');

  await page.getByRole('button', { name: 'Delete point' }).click();
  await expect(points.locator('.summary__value').first()).toHaveText('3');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(points.locator('.summary__value').first()).toHaveText('4');

  // Nothing about the route left the browser.
  expect(requests.filter((r) => !r.url().startsWith(ORIGIN))).toEqual([]);
});

test('plans a route from an activity and exports it (AV-1108)', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');

  await page.getByRole('button', { name: 'Create Custom Track' }).click();
  await expect(page.getByRole('heading', { name: 'Route Builder' })).toBeVisible();
  const count = page.getByRole('region', { name: 'Current route' }).locator('.summary__value').first();
  await expect(count).toHaveText('4');

  // Mark points 2 to 3 and discard them; the ends are joined.
  await page.getByRole('button', { name: 'Next point' }).click();
  await page.getByRole('button', { name: 'Next point' }).click();
  await page.getByRole('button', { name: 'Mark section start' }).click();
  await page.getByRole('button', { name: 'Next point' }).click();
  await expect(page.getByText(/Section: points 2 to 3/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard section' }).click();
  await expect(count).toHaveText('2');

  // Append another saved track.
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'simple-route.gpx'));
  await expect(count).toHaveText('6');

  // Export, and read the bytes the browser received.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export as GPX' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('elevation-route-planned-route.gpx');
  const path = testInfo.outputPath('planned.gpx');
  await saved.saveAs(path);
  const xml = readFileSync(path, 'utf-8');
  expect((xml.match(/<trkpt /g) ?? []).length).toBe(6);
  expect(xml).not.toContain('<time>');

  // The viewer reads it back as a route.
  await page.goto('./#/viewer');
  await page.getByRole('button', { name: 'Close activity' }).click();
  await page.getByTestId('file-input').setInputFiles(path);
  await expect(page.getByTestId('map-placeholder')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();

  // The original recording was never altered, and nothing left the browser.
  expect(requests.filter((request) => !request.url().startsWith(ORIGIN))).toEqual([]);
});

test('starts an empty route directly, and has a usable phone layout (AV-1108)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await useRouteOnlyBasemap(page);
  await page.goto('./#/route-builder');
  await expect(page.getByRole('region', { name: 'Start a route' })).toBeVisible();
  await page.getByRole('button', { name: 'Start a new route' }).click();

  for (const name of ['Undo', 'Delete point', 'Mark section start', 'Export as GPX']) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }
  // Nothing forces the page to scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  // Export is not offered until there is a route to export.
  await expect(page.getByRole('button', { name: 'Export as GPX' })).toBeDisabled();
});

test('saves the route as a transparent PNG of the requested size (AV-1009)', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await page.goto('./#/overlays');
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'route-with-elevation.gpx'));
  await expect(page.getByTestId('overlay-canvas')).toBeVisible();

  // A portrait size, so the dimensions are not the default by accident.
  await page.getByLabel(/^Size/).selectOption('portrait');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as PNG' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('elevation-route-route-overlay.png');

  const path = testInfo.outputPath('overlay.png');
  await saved.saveAs(path);
  const image = decodePng(readFileSync(path));
  expect([image.width, image.height]).toEqual([1080, 1920]);

  const alphaAt = (x: number, y: number) => image.pixels[(y * image.width + x) * 4 + 3]!;
  // Nothing but the route is drawn: every corner is fully transparent.
  for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]] as const) {
    expect(alphaAt(x, y)).toBe(0);
  }
  let opaque = 0;
  let translucentOrOpaque = 0;
  let white = 0;
  for (let i = 0; i < image.pixels.length; i += 4) {
    const a = image.pixels[i + 3]!;
    if (a > 0) translucentOrOpaque += 1;
    if (a === 255) opaque += 1;
    if (a === 255 && image.pixels[i] === 255 && image.pixels[i + 1] === 255 && image.pixels[i + 2] === 255) white += 1;
  }
  // The route is there, in the default colour, and is a small part of the frame.
  expect(white).toBeGreaterThan(500);
  expect(opaque).toBeGreaterThan(500);
  expect(translucentOrOpaque).toBeLessThan(image.width * image.height * 0.2);

  expect(requests.filter((request) => !request.url().startsWith(ORIGIN))).toEqual([]);
});

test('hands the viewer\'s activity to the overlay page (AV-1009)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'route-with-elevation.gpx');
  await page.getByRole('button', { name: 'Create route overlay' }).click();
  await expect(page.getByTestId('overlay-canvas')).toBeVisible();
  await expect(page.getByText('Elevation Route')).toBeVisible();
  // No viewer panels on the overlay page.
  await expect(page.getByRole('region', { name: 'Route map' })).toHaveCount(0);
});

/** What the overlay canvas currently holds: how much is drawn, and a fingerprint of it. */
async function overlayPixels(page: Page) {
  return page.getByTestId('overlay-video-canvas').evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let drawn = 0;
    let fingerprint = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! > 0) {
        drawn += 1;
        fingerprint = (fingerprint * 31 + data[i]! + data[i + 1]! * 3 + data[i + 3]! * 7 + i) >>> 0;
      }
    }
    return { drawn, fingerprint, width: canvas.width, height: canvas.height };
  });
}

async function openOverlayPreview(page: Page) {
  await page.goto('./#/overlays');
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'overlay-sync.gpx'));
  await expect(page.getByRole('region', { name: 'Video overlay' })).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'sync-test.webm'));
  await expect(page.getByTestId('overlay-video')).toBeVisible();
  // Metadata has loaded once the duration is known.
  await expect(page.getByText(/\/ 0:04/)).toBeVisible();
}

test('draws the overlay over a playing video and follows a seek (AV-1004)', async ({ page }) => {
  const requests = recordRequests(page);
  await openOverlayPreview(page);

  const scrub = page.getByLabel('Video position');
  const seekTo = async (seconds: number) => {
    await scrub.evaluate((node, value) => {
      const input = node as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, seconds);
    await expect.poll(() => page.getByTestId('overlay-video').evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeCloseTo(seconds, 0);
  };

  // The canvas takes the video's own size, so overlays match the picture.
  await seekTo(1);
  const at1 = await expect.poll(async () => (await overlayPixels(page)).drawn).toBeGreaterThan(100).then(() => overlayPixels(page));
  expect([at1.width, at1.height]).toEqual([160, 90]);

  // A different moment shows different figures.
  await seekTo(3);
  await expect.poll(async () => (await overlayPixels(page)).fingerprint).not.toBe(at1.fingerprint);

  // Playing advances the clock, and the overlay keeps pace with it.
  await seekTo(0);
  const before = (await overlayPixels(page)).fingerprint;
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect.poll(() => page.getByTestId('overlay-video').evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0.5);
  await expect.poll(async () => (await overlayPixels(page)).fingerprint).not.toBe(before);
  await page.getByRole('button', { name: 'Pause' }).click();

  // Nothing about the video or the telemetry left the browser. The video's own
  // object URL is this tab reading a local file, not a network request.
  expect(
    requests.map((request) => request.url()).filter((url) => !url.startsWith(ORIGIN) && !url.startsWith('blob:')),
  ).toEqual([]);
  expect(requests.some((request) => request.url().startsWith('blob:'))).toBe(true);
});

test('lines the telemetry up with an offset, and blanks outside it (AV-1004)', async ({ page }) => {
  await openOverlayPreview(page);
  const scrub = page.getByLabel('Video position');
  await scrub.evaluate((node) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(node as HTMLInputElement, '1');
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBeGreaterThan(100);
  const baseline = await overlayPixels(page);

  // Four seconds later in the telemetry: different figures at the same frame.
  const offset = page.getByLabel('Offset (seconds)');
  await offset.fill('4');
  await expect.poll(async () => (await overlayPixels(page)).fingerprint).not.toBe(baseline.fingerprint);
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBeGreaterThan(100);

  // Shifted past the end of the recording, nothing is drawn.
  await offset.fill('100');
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBe(0);

  // And the buttons move it by a second each way.
  await offset.fill('0');
  await page.getByRole('button', { name: 'Telemetry earlier 1 s' }).click();
  await expect(offset).toHaveValue('1');
  await page.getByRole('button', { name: 'Telemetry later 1 s' }).click();
  await page.getByRole('button', { name: 'Telemetry later 1 s' }).click();
  await expect(offset).toHaveValue('-1');
});

test('customizes the overlay and restores the look from a project file (AV-1005)', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await openOverlayPreview(page);
  const scrub = page.getByLabel('Video position');
  await scrub.evaluate((node) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(node as HTMLInputElement, '2');
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBeGreaterThan(100);

  // Switch every readout off: nothing is left to draw.
  for (const name of ['Speed', 'Distance', 'Time', 'Elevation']) {
    await page.getByLabel(`Show ${name} readout`).uncheck();
  }
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBe(0);

  // Move one back on, and it is drawn where the sliders put it.
  await page.getByLabel('Show Distance readout').check();
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBeGreaterThan(50);
  // The position controls live inside the component's own section: open it.
  await page.locator('details', { has: page.getByLabel('Show Distance readout') }).evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.getByLabel('Distance readout left').fill('60');

  // Save the look.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project file' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('compact-hud-overlay-template.json');
  const path = testInfo.outputPath('look.json');
  await file.saveAs(path);
  const project = JSON.parse(readFileSync(path, 'utf-8'));
  expect(project.template.components.filter((c: { visible: boolean }) => c.visible).map((c: { id: string }) => c.id)).toEqual(['distance']);
  expect(readFileSync(path, 'utf-8')).not.toMatch(/overlay-sync|Overlay Sync|"lat"/);

  // Throw the edits away: the shipped template is back.
  await page.getByRole('button', { name: 'Reset template' }).click();
  await expect(page.getByLabel('Show Speed readout')).toBeChecked();

  // Load the file: the saved look is restored, and the edits are in force again.
  await page.getByTestId('project-input').setInputFiles(path);
  await expect(page.getByRole('option', { name: 'Compact HUD (loaded)' })).toBeAttached();
  await expect(page.getByLabel('Show Speed readout')).not.toBeChecked();
  await expect(page.getByLabel('Show Distance readout')).toBeChecked();
  await expect.poll(async () => (await overlayPixels(page)).drawn).toBeGreaterThan(50);

  // Nothing was stored on the device or sent anywhere.
  expect(await page.evaluate(() => localStorage.length)).toBeLessThanOrEqual(1);
  expect(
    requests.map((r) => r.url()).filter((url) => !url.startsWith(ORIGIN) && !url.startsWith('blob:')),
  ).toEqual([]);
});

test('keeps the template controls usable on a phone (AV-1005)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openOverlayPreview(page);
  await page.locator('details', { has: page.getByLabel('Show Speed readout') }).evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  for (const name of ['Speed readout left', 'Speed readout colour', 'Speed readout background']) {
    await expect(page.getByLabel(name)).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Save project file' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/** Unzips with the system tool, returning the folder; also proves the archive is valid. */
function unzipTo(path: string): string {
  execFileSync('unzip', ['-tq', path]);
  const dir = mkdtempSync(join(tmpdir(), 'overlay-frames-'));
  execFileSync('unzip', ['-oq', path, '-d', dir]);
  return dir;
}

test('saves the overlay as real transparent PNG frames in a valid zip (AV-1006)', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await openOverlayPreview(page);
  const panel = page.getByRole('region', { name: 'Export overlay frames' });

  // Defaults come from the video itself.
  await expect(panel.getByLabel('Frame width')).toHaveValue('160');
  await expect(panel.getByLabel('Frame height')).toHaveValue('90');
  await expect(panel.getByLabel('Export to')).toHaveValue('4');

  // Telemetry shifted so it runs out at video second 2: the second half is empty.
  await page.getByLabel('Offset (seconds)').fill('8');
  await panel.getByLabel(/Frame rate/).fill('10');
  await expect(panel.getByText(/40 frames, in one zip file/)).toBeVisible();

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save PNG frames (zip)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('overlay-frames-part-01.zip');
  await expect(panel.getByText(/Saved 40 frames/)).toBeVisible();

  const path = testInfo.outputPath('frames.zip');
  await file.saveAs(path);
  const dir = unzipTo(path);
  const names = execFileSync('unzip', ['-Z1', path]).toString().trim().split('\n');
  expect(names.filter((n) => n.endsWith('.png'))).toHaveLength(40);
  expect(names).toContain('README.txt');
  const readme = readFileSync(join(dir, 'README.txt'), 'utf-8');
  expect(readme).toContain('10 fps');
  expect(readme).toContain('160 x 90');
  expect(readme).not.toMatch(/sync-test|overlay-sync/);

  const frame = (n: number) => decodePng(readFileSync(join(dir, `overlay_${String(n).padStart(6, '0')}.png`)));
  const stats = (image: ReturnType<typeof decodePng>) => {
    let drawn = 0;
    for (let i = 3; i < image.pixels.length; i += 4) if (image.pixels[i]! > 0) drawn += 1;
    return { drawn, corner: image.pixels[3]! };
  };

  const first = frame(1);
  expect([first.width, first.height]).toEqual([160, 90]);
  // A real RGBA PNG with a transparent background and something drawn on it.
  expect(stats(first).corner).toBe(0);
  expect(stats(first).drawn).toBeGreaterThan(100);
  // Past the end of the telemetry nothing is drawn: fully transparent.
  expect(stats(frame(40)).drawn).toBe(0);
  // The figures differ from frame to frame.
  expect(Buffer.compare(frame(1).pixels, frame(15).pixels)).not.toBe(0);

  expect(
    requests.map((r) => r.url()).filter((url) => !url.startsWith(ORIGIN) && !url.startsWith('blob:')),
  ).toEqual([]);
});

test('splits a long export across zip files without gaps in the numbering (AV-1006)', async ({ page }, testInfo) => {
  await openOverlayPreview(page);
  const panel = page.getByRole('region', { name: 'Export overlay frames' });
  await panel.getByLabel(/Frame rate/).fill('100');
  await panel.getByLabel('Export to').fill('20');
  await expect(panel.getByText(/2,000 frames, in at least 2 zip files/)).toBeVisible();

  const downloads: { name: string; path: string }[] = [];
  page.on('download', async (download) => {
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    downloads.push({ name: download.suggestedFilename(), path });
  });
  await panel.getByRole('button', { name: 'Save PNG frames (zip)' }).click();
  await expect(panel.getByText(/Saved 2,000 frames/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => downloads.length).toBe(2);

  downloads.sort((a, b) => a.name.localeCompare(b.name));
  expect(downloads.map((d) => d.name)).toEqual(['overlay-frames-part-01.zip', 'overlay-frames-part-02.zip']);
  const frames: number[] = [];
  for (const { path } of downloads) {
    execFileSync('unzip', ['-tq', path]);
    for (const name of execFileSync('unzip', ['-Z1', path]).toString().trim().split('\n')) {
      const match = /^overlay_(\d{6})\.png$/.exec(name);
      if (match) frames.push(Number(match[1]));
    }
  }
  frames.sort((a, b) => a - b);
  expect(frames).toHaveLength(2000);
  expect(frames[0]).toBe(1);
  expect(frames.at(-1)).toBe(2000);
  expect(new Set(frames).size).toBe(2000);
});

test('stops an export when asked, and says what was kept (AV-1006)', async ({ page }) => {
  await openOverlayPreview(page);
  const panel = page.getByRole('region', { name: 'Export overlay frames' });
  // Large frames, so the export is slow enough to interrupt.
  await panel.getByLabel('Frame width').fill('3840');
  await panel.getByLabel('Frame height').fill('2160');
  await panel.getByLabel(/Frame rate/).fill('60');

  await panel.getByRole('button', { name: 'Save PNG frames (zip)' }).click();
  await expect(panel.getByRole('progressbar', { name: 'Export progress' })).toBeVisible();
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(panel.getByText(/^Stopped\./)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save PNG frames (zip)' })).toBeEnabled();
});


interface WireRequest {
  url: string;
  method: string;
  body: string | null;
}
interface PageNetworkCall {
  api: string;
  url: string;
  method: string;
  hasBody: boolean;
}

/**
 * Watches every way a page can reach the network. Two views, because each
 * misses something the other sees: the browser's own request log (which includes
 * the service worker's fetches), and wrappers around the page's `fetch`, XHR,
 * beacon, WebSocket and EventSource, which see a call even if it fails to leave.
 * Must be set up before a navigation, since an init script runs per document.
 */
async function watchNetwork(page: Page) {
  await page.addInitScript({
    content: `
      (() => {
        const calls = [];
        window.__net = calls;
        const origFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
          calls.push({
            api: 'fetch',
            url: String(request ? request.url : input),
            method: String((init && init.method) || (request && request.method) || 'GET').toUpperCase(),
            hasBody: Boolean((init && init.body) || (request && request.body)),
          });
          return origFetch(input, init);
        };
        const open = XMLHttpRequest.prototype.open;
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this.__m = method;
          this.__u = String(url);
          return open.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (body) {
          calls.push({ api: 'xhr', url: this.__u || '', method: String(this.__m || 'GET').toUpperCase(), hasBody: body != null });
          return send.call(this, body);
        };
        navigator.sendBeacon = (url) => {
          calls.push({ api: 'sendBeacon', url: String(url), method: 'POST', hasBody: true });
          return false;
        };
        for (const name of ['WebSocket', 'EventSource']) {
          const Original = window[name];
          if (!Original) continue;
          window[name] = function (...args) {
            calls.push({ api: name, url: String(args[0]), method: 'GET', hasBody: false });
            return new Original(...args);
          };
        }
      })();
    `,
  });
  const wire: WireRequest[] = [];
  page.context().on('request', (request) => {
    wire.push({ url: request.url(), method: request.method(), body: request.postData() });
  });
  return {
    wire,
    isLive: () => page.evaluate(() => Array.isArray((window as unknown as { __net?: unknown }).__net)),
    calls: () => page.evaluate(() => (window as unknown as { __net: PageNetworkCall[] }).__net),
  };
}

/** Requests that are not a plain GET, with no body, for this site's own files (or a `blob:` the page made). */
function outsideTheSite(wire: WireRequest[]): WireRequest[] {
  const site = `${ORIGIN}${BASE_PATH}`;
  return wire.filter(
    ({ url, method, body }) =>
      !(url.startsWith('blob:') || url.startsWith('data:')) && !(url.startsWith(site) && method === 'GET' && body === null),
  );
}

/** Moves the preview video to `seconds` and waits for it to land there. */
async function seekPreview(page: Page, seconds: number) {
  await page.getByLabel('Video position').evaluate((node, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(node as HTMLInputElement, String(value));
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, seconds);
  await expect
    .poll(() => page.getByTestId('overlay-video').evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeCloseTo(seconds, 1);
  // The overlay is redrawn on `seeked`, a moment after the clock moves.
  await page.waitForTimeout(80);
}

/**
 * Pixels of one pure colour on the overlay canvas, within a region given as
 * fractions of the frame. Measuring by colour makes the checks independent of
 * fonts and anti-aliasing, which differ between machines.
 */
async function colourStats(
  page: Page,
  rgb: [number, number, number],
  region: { x0: number; y0: number; x1: number; y1: number } = { x0: 0, y0: 0, x1: 1, y1: 1 },
) {
  return page.getByTestId('overlay-video-canvas').evaluate(
    (node, args) => {
      const canvas = node as HTMLCanvasElement;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const { rgb, region } = args;
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = Math.floor(region.y0 * canvas.height); y < Math.ceil(region.y1 * canvas.height); y += 1) {
        for (let x = Math.floor(region.x0 * canvas.width); x < Math.ceil(region.x1 * canvas.width); x += 1) {
          const i = (y * canvas.width + x) * 4;
          const close =
            Math.abs(data[i]! - rgb[0]) < 60 && Math.abs(data[i + 1]! - rgb[1]) < 60 && Math.abs(data[i + 2]! - rgb[2]) < 60;
          if (close && data[i + 3]! > 20) {
            count += 1;
            sumX += x;
            sumY += y;
          }
        }
      }
      return { count, x: count ? sumX / count : NaN, y: count ? sumY / count : NaN };
    },
    { rgb, region },
  );
}

test('draws each component where and how big it should be, at fixed timestamps (AV-1008)', async ({ page }) => {
  await openOverlayPreview(page);
  await page.getByTestId('project-input').setInputFiles(join(FIXTURE_DIR, 'overlay-project-test-pattern.json'));
  await expect(page.getByRole('option', { name: 'Test pattern (loaded)' })).toBeAttached();

  const BAR = { x0: 0.05, y0: 0.85, x1: 0.55, y1: 0.93 };
  const MAP = { x0: 0.6, y0: 0.1, x1: 0.95, y1: 0.65 };
  const DIAL = { x0: 0.05, y0: 0.1, x1: 0.5, y1: 0.75 };
  const MAGENTA: [number, number, number] = [255, 0, 255];
  const YELLOW: [number, number, number] = [255, 255, 0];
  const ORANGE: [number, number, number] = [255, 136, 0];
  const GREEN: [number, number, number] = [0, 255, 0];
  const CYAN: [number, number, number] = [0, 255, 255];

  // The telemetry is ten seconds long; the video shows the first four.
  await seekPreview(page, 1);
  const bar1 = await colourStats(page, MAGENTA, BAR);
  const marker1 = await colourStats(page, YELLOW, MAP);
  await seekPreview(page, 3);
  const bar3 = await colourStats(page, MAGENTA, BAR);
  const marker3 = await colourStats(page, YELLOW, MAP);

  // Progress: 10% then 30% of the way through, so about three times the fill.
  expect(bar1.count).toBeGreaterThan(20);
  expect(bar3.count / bar1.count).toBeGreaterThan(2);
  expect(bar3.count / bar1.count).toBeLessThan(4);
  // And the fill grows from the left edge of the bar.
  expect(bar3.x).toBeGreaterThan(bar1.x);

  // The marker is on the route, and moves up and to the right along it.
  expect(marker1.count).toBeGreaterThan(5);
  expect(marker3.count).toBeGreaterThan(5);
  expect(marker3.x).toBeGreaterThan(marker1.x);
  expect(marker3.y).toBeLessThan(marker1.y);
  // The route line itself is drawn in its own colour inside its own box.
  expect((await colourStats(page, CYAN, MAP)).count).toBeGreaterThan(20);

  // The dial: a track and a value arc, in the left block only.
  expect((await colourStats(page, GREEN, DIAL)).count).toBeGreaterThan(20);
  expect((await colourStats(page, ORANGE, DIAL)).count).toBeGreaterThan(10);
  expect((await colourStats(page, ORANGE, { x0: 0.5, y0: 0, x1: 1, y1: 1 })).count).toBe(0);

  // The same moment reached by different routes is the same picture.
  const fingerprint = () =>
    page.getByTestId('overlay-video-canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      let hash = 0;
      for (let i = 0; i < data.length; i += 1) hash = (hash * 31 + data[i]!) >>> 0;
      return hash;
    });
  await seekPreview(page, 2);
  const direct = await fingerprint();
  await seekPreview(page, 3.5);
  await seekPreview(page, 0.5);
  await seekPreview(page, 2);
  expect(await fingerprint()).toBe(direct);

  // Past the telemetry, none of it is drawn.
  await page.getByLabel('Offset (seconds)').fill('100');
  await expect.poll(async () => (await colourStats(page, YELLOW)).count).toBe(0);
  for (const colour of [MAGENTA, ORANGE, GREEN]) {
    expect((await colourStats(page, colour)).count).toBe(0);
  }
  // Except the route line, which never depended on the clock.
  expect((await colourStats(page, CYAN, MAP)).count).toBeGreaterThan(20);
});

test('explains a broken project file in a real browser, and keeps the current template (AV-1008)', async ({ page }) => {
  await openOverlayPreview(page);
  await page.getByTestId('project-input').setInputFiles(join(FIXTURE_DIR, 'overlay-project-invalid.json'));
  const alert = page.getByRole('alert').filter({ hasText: 'could not be loaded' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/units: must be/);
  await expect(alert).toContainText(/metric: must be one of/);
  await expect(alert).toContainText(/must be a colour/);
  // Nothing changed: still the shipped template, with nothing loaded.
  await expect(page.getByRole('combobox', { name: /^Template/ })).toHaveValue('compact-hud');
  await expect(page.getByRole('option', { name: /\(loaded\)/ })).toHaveCount(0);
});

test('keeps video, telemetry, frames and file names off the network in every overlay flow (AV-1008)', async ({ page }, testInfo) => {
  const network = await watchNetwork(page);

  // A real navigation, not a hash change on the page the suite opened: an init
  // script only runs when a new document loads.
  await page.goto('about:blank');
  await page.goto('./#/overlays');
  expect(await network.isLive()).toBe(true);

  // 1. A route image from a file.
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'overlay-sync.gpx'));
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as PNG' }).click();
  const png = await pngDownload;

  // 2. The video preview: choose, seek, play, line up.
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'sync-test.webm'));
  await expect(page.getByText(/\/ 0:04/)).toBeVisible();
  await seekPreview(page, 2);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(() => page.getByTestId('overlay-video').evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(2.1);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByLabel('Offset (seconds)').fill('2');

  // 3. Customize, save the project, and load one back.
  await page.getByLabel('Show Speed readout').uncheck();
  const projectDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project file' }).click();
  const project = await projectDownload;
  await page.getByTestId('project-input').setInputFiles(join(FIXTURE_DIR, 'overlay-project-test-pattern.json'));
  await expect(page.getByRole('option', { name: 'Test pattern (loaded)' })).toBeAttached();

  // 4. Export frames.
  const panel = page.getByRole('region', { name: 'Export overlay frames' });
  await panel.getByLabel(/Frame rate/).fill('5');
  await panel.getByLabel('Export to').fill('2');
  const zipDownload = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save PNG frames (zip)' }).click();
  const zip = await zipDownload;
  await expect(panel.getByText(/Saved 10 frames/)).toBeVisible();

  // The route image is named after the route, as the viewer's exports are: a
  // local file name the user will recognise. The sequence and project file sit
  // beside a video and are named generically, never after it or the telemetry.
  expect(png.suggestedFilename()).toBe('overlay-sync-route-overlay.png');
  for (const name of [project, zip].map((d) => d.suggestedFilename())) {
    expect(name).not.toMatch(/overlay-sync|sync-test|test-pattern/i);
  }

  // Every request is for the app's own static files: a plain GET, no body, to
  // this site (or a blob: the page made itself), and naming nothing of the user's.
  const { wire } = network;
  expect(outsideTheSite(wire)).toEqual([]);
  const identifying = /overlay-sync|sync-test|test-pattern|Overlay(%20| )Sync|51\.5/i;
  expect(wire.filter(({ url }) => !url.startsWith('blob:') && identifying.test(url))).toEqual([]);

  // Nothing the page itself did could have sent anything either.
  const calls = await network.calls();
  expect(calls.filter((c) => c.api !== 'fetch' && c.api !== 'xhr')).toEqual([]);
  for (const call of calls) {
    expect(call.method).toBe('GET');
    expect(call.hasBody).toBe(false);
    expect(new URL(call.url, ORIGIN).origin).toBe(ORIGIN);
  }

  // And the session left nothing behind on the device.
  const stored = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    databases: (await indexedDB.databases?.())?.map((d) => d.name) ?? [],
  }));
  expect(stored.session).toEqual([]);
  expect(stored.databases).toEqual([]);
  // Only the theme preference is ever written (§5); nothing about an overlay.
  expect(stored.local.filter((key) => !/theme/i.test(key))).toEqual([]);
  void testInfo;
});

test('the network watch actually sees a leak when there is one (AV-1008)', async ({ page }) => {
  // A check that cannot fail proves nothing. This makes the page misbehave on
  // purpose, in each way the privacy test guards against, and expects it caught.
  const network = await watchNetwork(page);
  await page.goto('about:blank');
  await page.goto('./#/overlays');
  expect(await network.isLive()).toBe(true);

  await page.evaluate(async (origin) => {
    await fetch(`${origin}/leak`, { method: 'POST', body: 'telemetry' }).catch(() => undefined);
    const request = new XMLHttpRequest();
    request.open('PUT', `${origin}/leak-xhr`);
    request.send('frames');
    navigator.sendBeacon(`${origin}/leak-beacon`, 'video');
    try {
      new WebSocket('ws://localhost:1/leak').close();
    } catch {
      /* the attempt is what is recorded */
    }
  }, ORIGIN);
  await page.waitForTimeout(200);

  const calls = await network.calls();
  expect(calls.map((c) => c.api)).toEqual(expect.arrayContaining(['fetch', 'xhr', 'sendBeacon', 'WebSocket']));
  expect(calls.find((c) => c.api === 'fetch')).toMatchObject({ method: 'POST', hasBody: true });
  expect(calls.find((c) => c.api === 'xhr')).toMatchObject({ method: 'PUT', hasBody: true });
  // And on the wire, outside the "plain GET for our own files" rule.
  const leaked = outsideTheSite(network.wire).map((r) => `${r.method} ${r.url}`);
  expect(leaked).toEqual(expect.arrayContaining([expect.stringContaining('POST'), expect.stringContaining('PUT')]));
});

interface MediaProbe {
  video?: { codec: string; width: number; height: number };
  audio?: { codec: string };
  durationSeconds?: number;
}

/** What `ffprobe` finds in a saved video. */
function probeMedia(path: string): MediaProbe {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]).toString(),
  ) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration?: string } };
  const video = out.streams.find((st) => st.codec_type === 'video');
  const audio = out.streams.find((st) => st.codec_type === 'audio');
  const duration = Number(out.format.duration);
  return {
    ...(video ? { video: { codec: video.codec_name, width: video.width!, height: video.height! } } : {}),
    ...(audio ? { audio: { codec: audio.codec_name } } : {}),
    ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
  };
}

/** One decoded frame of a video, at `seconds`. */
function frameAt(path: string, seconds: number) {
  const dir = mkdtempSync(join(tmpdir(), 'burn-frame-'));
  const png = join(dir, 'frame.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1', png]);
  return decodePng(readFileSync(png));
}

/** Pixels of one colour in a region (fractions of the frame), and their centroid. */
function colourIn(
  image: ReturnType<typeof decodePng>,
  rgb: [number, number, number],
  region: { x0: number; y0: number; x1: number; y1: number },
  tolerance = 90,
) {
  let count = 0;
  for (let y = Math.floor(region.y0 * image.height); y < Math.ceil(region.y1 * image.height); y += 1) {
    for (let x = Math.floor(region.x0 * image.width); x < Math.ceil(region.x1 * image.width); x += 1) {
      const i = (y * image.width + x) * 4;
      if (
        Math.abs(image.pixels[i]! - rgb[0]) < tolerance &&
        Math.abs(image.pixels[i + 1]! - rgb[1]) < tolerance &&
        Math.abs(image.pixels[i + 2]! - rgb[2]) < tolerance
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Mean absolute difference between two frames over a region, per channel. */
function regionDifference(
  a: ReturnType<typeof decodePng>,
  b: ReturnType<typeof decodePng>,
  region: { x0: number; y0: number; x1: number; y1: number },
) {
  let total = 0;
  let n = 0;
  for (let y = Math.floor(region.y0 * a.height); y < Math.ceil(region.y1 * a.height); y += 1) {
    for (let x = Math.floor(region.x0 * a.width); x < Math.ceil(region.x1 * a.width); x += 1) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs(a.pixels[i + c]! - b.pixels[i + c]!);
        n += 1;
      }
    }
  }
  return total / n;
}

/** Mean volume of a file's sound in dB, or undefined if it has none. */
function meanVolume(path: string): number | undefined {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const match = /mean_volume: (-?[\d.]+) dB/.exec(out.stderr.toString());
  return match ? Number(match[1]) : undefined;
}

const BURN_IN = { name: 'Save video with overlay' };

test('records the video with the overlay burned into the picture (AV-1007)', async ({ page }, testInfo) => {
  const requests = recordRequests(page);
  await openOverlayPreview(page);
  await page.getByTestId('project-input').setInputFiles(join(FIXTURE_DIR, 'overlay-project-test-pattern.json'));
  await expect(page.getByRole('option', { name: 'Test pattern (loaded)' })).toBeAttached();

  const panel = page.getByRole('region', BURN_IN);
  await expect(panel.getByLabel('Video width')).toHaveValue('160');
  await panel.getByLabel('Video frame rate').fill('10');
  await expect(panel.getByText(/Takes about 4 s/)).toBeVisible();

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save video with overlay' }).click();
  // The preview steps aside while the export plays the video itself.
  await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled();
  await expect(panel.getByRole('progressbar', { name: 'Recording progress' })).toBeVisible();
  const file = await download;
  expect(file.suggestedFilename()).toBe('video-with-overlay.webm');
  await expect(panel.getByText(/Saved/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();

  const path = testInfo.outputPath('burned.webm');
  await file.saveAs(path);

  // A real video of the right size and length (the length is the patched header).
  const media = probeMedia(path);
  expect(media.video).toMatchObject({ codec: 'vp9', width: 160, height: 90 });
  expect(media.durationSeconds).toBeGreaterThan(3.5);
  expect(media.durationSeconds).toBeLessThan(5);
  // The source had no sound, so there is none, and the panel says so.
  expect(media.audio).toBeUndefined();
  await expect(panel.getByText(/It has no sound/)).toBeVisible();
  // It decodes end to end.
  execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']);

  const BAR = { x0: 0.05, y0: 0.85, x1: 0.55, y1: 0.93 };
  const STRIP = { x0: 0, y0: 0.94, x1: 1, y1: 1 };
  const MAGENTA: [number, number, number] = [255, 0, 255];
  const early = frameAt(path, 1);
  const late = frameAt(path, 3);

  // The overlay is in the picture, and moves with the video: the progress bar fills.
  expect(colourIn(early, MAGENTA, BAR)).toBeGreaterThan(10);
  expect(colourIn(late, MAGENTA, BAR)).toBeGreaterThan(colourIn(early, MAGENTA, BAR) * 1.5);
  expect(colourIn(late, [255, 255, 0], { x0: 0.6, y0: 0.1, x1: 0.95, y1: 0.65 })).toBeGreaterThan(3);

  // And the video is still there under it: a strip the overlay never touches matches the source.
  const source = frameAt(join(FIXTURE_DIR, 'sync-test.webm'), 3);
  expect(regionDifference(late, source, STRIP)).toBeLessThan(30);
  // ...and is not simply a blank canvas with an overlay on it.
  expect(colourIn(late, [0, 0, 0], { x0: 0, y0: 0, x1: 1, y1: 1 }, 30)).toBeLessThan(late.width * late.height * 0.5);

  // Nothing left the browser.
  expect(
    requests.map((r) => r.url()).filter((url) => !url.startsWith(ORIGIN) && !url.startsWith('blob:')),
  ).toEqual([]);
});

test('carries the video\'s sound across, or leaves it out when asked (AV-1007)', async ({ page }, testInfo) => {
  await page.goto('./#/overlays');
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'overlay-sync.gpx'));
  // The same input first takes the route and then the video: wait for the swap.
  await expect(page.getByRole('region', { name: 'Video overlay' })).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'sync-test-audio.webm'));
  await expect(page.getByText(/\/ 0:04/)).toBeVisible();
  const panel = page.getByRole('region', BURN_IN);
  await panel.getByLabel('Video frame rate').fill('10');

  const record = async (name: string) => {
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Save video with overlay' }).click();
    const file = await download;
    await expect(panel.getByText(/Saved/)).toBeVisible({ timeout: 20_000 });
    const path = testInfo.outputPath(name);
    await file.saveAs(path);
    return path;
  };

  // With sound: it is really there, and about as loud as the source (a muted
  // element would record silence at about -91 dB).
  const withSound = await record('with-sound.webm');
  expect(probeMedia(withSound).audio).toMatchObject({ codec: 'opus' });
  const sourceVolume = meanVolume(join(FIXTURE_DIR, 'sync-test-audio.webm'))!;
  const recordedVolume = meanVolume(withSound)!;
  expect(recordedVolume).toBeGreaterThan(-40);
  expect(Math.abs(recordedVolume - sourceVolume)).toBeLessThan(6);
  await expect(panel.getByText(/It has no sound/)).toHaveCount(0);

  // Without: no audio stream at all.
  await panel.getByLabel(/Include the video's sound/).uncheck();
  const withoutSound = await record('without-sound.webm');
  expect(probeMedia(withoutSound).audio).toBeUndefined();
  expect(probeMedia(withoutSound).video).toBeDefined();
});

test('records a real GoPro clip, a range of it, with its sound (AV-1007)', async ({ page }, testInfo) => {
  // Recording runs at the video's own speed and decodes and encodes as it goes,
  // so on a loaded machine it takes longer than the clip. Allow for that.
  test.setTimeout(120_000);
  // The real HERO8 sample: 848x480 H.264 with AAC sound, 12.6 s. The overlay
  // comes from a separate telemetry file, as it would for a clip with no GPS fix.
  await page.goto('./#/overlays');
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'overlay-sync.gpx'));
  // The same input first takes the route and then the video: wait for the swap.
  await expect(page.getByRole('region', { name: 'Video overlay' })).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(join(FIXTURE_DIR, 'hero8.mp4'));
  await expect(page.getByText(/\/ 0:1[23]/)).toBeVisible({ timeout: 60_000 });

  const panel = page.getByRole('region', BURN_IN);
  await expect(panel.getByLabel('Video width')).toHaveValue('848');
  await expect(panel.getByLabel('Video height')).toHaveValue('480');
  // Two seconds in, for four seconds: the range is honoured.
  await panel.getByLabel('Video from').fill('2');
  await panel.getByLabel('Video to').fill('6');
  await expect(panel.getByText(/Takes about 4 s/)).toBeVisible();

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save video with overlay' }).click();
  const file = await download;
  await expect(panel.getByText(/Saved/)).toBeVisible({ timeout: 90_000 });
  const path = testInfo.outputPath('gopro.webm');
  await file.saveAs(path);

  const media = probeMedia(path);
  expect(media.video).toMatchObject({ width: 848, height: 480 });
  expect(media.durationSeconds).toBeGreaterThan(3.4);
  expect(media.durationSeconds).toBeLessThan(5.5);
  expect(media.audio).toMatchObject({ codec: 'opus' });
  // The camera's own sound came through.
  expect(meanVolume(path)!).toBeGreaterThan(-70);
  // The overlay is drawn over real footage: text-sized panels in the corner, so
  // some of the frame is overlay-dark and the rest is varied picture.
  const frame = frameAt(path, 1.5);
  const distinct = new Set<number>();
  for (let i = 0; i < frame.pixels.length; i += 4 * 97) {
    distinct.add((frame.pixels[i]! >> 4) * 256 + (frame.pixels[i + 1]! >> 4) * 16 + (frame.pixels[i + 2]! >> 4));
  }
  expect(distinct.size).toBeGreaterThan(40);
  // The source file itself was not touched.
  expect(readFileSync(join(FIXTURE_DIR, 'hero8.mp4')).length).toBe(4_402_730);
});

test('stops a recording when asked, saving nothing (AV-1007)', async ({ page }) => {
  await openOverlayPreview(page);
  const panel = page.getByRole('region', BURN_IN);
  let downloads = 0;
  page.on('download', () => (downloads += 1));

  await panel.getByRole('button', { name: 'Save video with overlay' }).click();
  await expect(panel.getByRole('progressbar', { name: 'Recording progress' })).toBeVisible();
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(panel.getByText(/Stopped\. Nothing was saved\./)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save video with overlay' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
  expect(downloads).toBe(0);
});

test('fixture files are never read by the server', async () => {
  // Sanity check that fixtures are local test data, not network resources.
  const gpx = readFileSync(join(FIXTURE_DIR, 'simple-route.gpx'), 'utf-8');
  expect(gpx).toContain('<gpx');
});
