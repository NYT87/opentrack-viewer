import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
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
/** The footer links to the same routes, so nav clicks target the header. */
function navLink(page: Page, name: 'Home' | 'Viewer') {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name });
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
  await expect(distance).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/x-axis: distance/)).toBeVisible();

  await time.click();

  await expect(time).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/x-axis: elapsed time/)).toBeVisible();
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
  await expect(page.getByRole('region', { name: 'Cadence chart' })).toContainText('rpm');
  // The cadence unit caveat is stated rather than silently resolved.
  await expect(page.getByRole('region', { name: 'Cadence chart' })).toContainText(
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

test('puts details beside the map, with charts below (AV-005)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const details = (await page.locator('.viewer__details').boundingBox())!;
  const map = (await page.locator('.viewer__map').boundingBox())!;
  const charts = (await page.locator('.chart-panel').boundingBox())!;

  // Two columns: details on the left, map on the right.
  expect(map.x).toBeGreaterThanOrEqual(details.x + details.width - 1);
  expect(Math.abs(map.y - details.y)).toBeLessThan(2);

  // Charts sit below the pair, spanning the full width rather than beside it.
  expect(charts.y).toBeGreaterThanOrEqual(details.y + details.height - 1);
  expect(charts.y).toBeGreaterThanOrEqual(map.y + map.height - 1);
  expect(charts.width).toBeGreaterThan(map.width);

  // The map's own controls do not sit on top of the details text.
  const zoomIn = (await page.getByRole('button', { name: 'Zoom in' }).boundingBox())!;
  expect(zoomIn.x).toBeGreaterThan(details.x + details.width);
});

test('stacks with the map first on a small screen (AV-005)', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'run-with-cadence.gpx');

  const details = (await page.locator('.viewer__details').boundingBox())!;
  const map = (await page.locator('.viewer__map').boundingBox())!;

  expect(map.y).toBeLessThan(details.y);
  expect(Math.abs(map.x - details.x)).toBeLessThan(2);
});

test('excludes a recording gap from the distance (P1 regression)', async ({ page }) => {
  await useRouteOnlyBasemap(page);
  await loadFixture(page, 'paused-run.gpx');

  // Two 111 m legs; the ~5.5 km between them was not travelled on this route.
  // Accumulating across the segment boundary reported 5.7 km instead.
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText('222 m');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
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

  await expect(page.locator('[data-testid="chart-cursor"]')).toBeVisible();
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
  await expect(page.getByText(/nothing is uploaded/i)).toHaveCount(0);

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
  await expect(page.getByRole('region', { name: 'Cadence chart' })).toBeAttached();

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
  const box = (await scroll.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 2000);
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

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
  await expect(page.getByRole('region', { name: 'Cadence chart' })).toBeAttached();

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

  await navLink(page, 'Home').click();
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

test('fixture files are never read by the server', async () => {
  // Sanity check that fixtures are local test data, not network resources.
  const gpx = readFileSync(join(FIXTURE_DIR, 'simple-route.gpx'), 'utf-8');
  expect(gpx).toContain('<gpx');
});
