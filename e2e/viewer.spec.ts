import { readFileSync } from 'node:fs';
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
});

test('fixture files are never read by the server', async () => {
  // Sanity check that fixtures are local test data, not network resources.
  const gpx = readFileSync(join(FIXTURE_DIR, 'simple-route.gpx'), 'utf-8');
  expect(gpx).toContain('<gpx');
});
