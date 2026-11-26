import { join } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { RIDE_PATH, fetchBlobBytes } from './helpers/overlayFixtures';
import { decodePng, type DecodedPng } from './helpers/png';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1031 (TD-103). The overlay's font in a real browser: a text exported as a PNG frame in the system
 * font, in a font file the reader loaded, and in a bundled font chosen from the list. The export worker
 * draws the frame, so a different font showing in the PNG shows that it registered the same bytes before
 * its first frame. No request goes anywhere but the app's own origin, and a font is asked for only
 * under the app's own /fonts/ path.
 */

/** A bundled font (SIL OFL), loaded here as if it were the reader's own file. */
const FIXTURE_FONT = join(process.cwd(), 'public/fonts/oswald/oswald-latin-700-normal.woff2');
const ORIGIN = 'http://localhost:4173';
const WORDS = 'Hamburgefonstiv Wxyz';

async function openCanvas(page: Page) {
  const requests: string[] = [];
  page.on('request', (request) => void requests.push(request.url()));
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-file-input').setInputFiles(RIDE_PATH);
  await page.getByRole('radio', { name: 'A custom video overlay, with no video' }).check();
  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  await canvas.getByLabel('Size', { exact: true }).selectOption('1280x720');
  await canvas.getByLabel('Add', { exact: true }).selectOption({ label: 'Text' });
  await canvas.getByRole('button', { name: 'Add to the canvas' }).click();
  await canvas.getByLabel('Text', { exact: true }).fill(WORDS);
  return { canvas, requests };
}

async function firstFrame(page: Page, canvas: Locator): Promise<DecodedPng> {
  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-1280x720-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 180_000 });
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  return decodePng(Buffer.from(entries[1]!.data));
}

const inked = (png: DecodedPng) => {
  let count = 0;
  for (let i = 3; i < png.pixels.length; i += 4) if (png.pixels[i]! > 0) count += 1;
  return count;
};
const differs = (a: DecodedPng, b: DecodedPng) => Buffer.compare(Buffer.from(a.pixels), Buffer.from(b.pixels)) !== 0;

/** Every request stayed on the app's own origin (or was a blob or data URL), and the fonts came from its own /fonts/ path. */
function expectOnlyOwnRequests(requests: string[], fonts: string[]) {
  for (const url of requests) expect(url.startsWith(ORIGIN) || url.startsWith('blob:') || url.startsWith('data:'), url).toBe(true);
  expect(requests.filter((url) => /\.(woff2?|ttf|otf)(\?|$)/.test(url) || /font/i.test(new URL(url).hostname))).toEqual(fonts);
}

/** A fresh page's first exported frame, after `choose` has set the layout's font; its requests are added to `all`. */
async function frameIn(browser: Browser, baseURL: string, all: string[], choose?: (canvas: Locator) => Promise<void>): Promise<DecodedPng> {
  const page = await (await browser.newContext({ baseURL, locale: 'en-GB' })).newPage();
  const { canvas, requests } = await openCanvas(page);
  await choose?.(canvas);
  const png = await firstFrame(page, canvas);
  all.push(...requests);
  await page.context().close();
  return png;
}

test('a font file of the reader’s, loaded on this device, is what the exported frame is drawn in', async ({ browser, baseURL }) => {
  const requests: string[] = [];
  const system = await frameIn(browser, baseURL!, requests);
  expect(inked(system)).toBeGreaterThan(200);
  const own = await frameIn(browser, baseURL!, requests, async (canvas) => {
    await canvas.getByLabel('Layout font', { exact: true }).selectOption({ label: 'Load a font file…' });
    await canvas.getByLabel('Layout font: font file').setInputFiles(FIXTURE_FONT);
    // Offered under its file's name, and chosen.
    await expect(canvas.getByLabel('Layout font', { exact: true })).toHaveValue('oswald-latin-700-normal');
  });
  expect(inked(own)).toBeGreaterThan(200);
  expect([own.width, own.height]).toEqual([system.width, system.height]);
  // The same words in another face: other pixels.
  expect(differs(own, system)).toBe(true);
  // The file was read on this device: nothing was asked of anyone for a font.
  expectOnlyOwnRequests(requests, []);
});

test('a bundled font is fetched from the app’s own path only when chosen, and the exported frame is drawn in it', async ({ browser, baseURL }) => {
  const plain: string[] = [];
  const system = await frameIn(browser, baseURL!, plain);
  expectOnlyOwnRequests(plain, []);

  const requests: string[] = [];
  const oswald = await frameIn(browser, baseURL!, requests, async (canvas) => {
    await canvas.getByLabel('Layout font', { exact: true }).selectOption('Oswald');
    await expect(canvas.getByLabel('Layout font', { exact: true })).toHaveValue('Oswald');
  });
  expect(inked(oswald)).toBeGreaterThan(200);
  expect(differs(oswald, system)).toBe(true);
  expectOnlyOwnRequests(requests, [`${baseURL}fonts/oswald/oswald-latin-400-normal.woff2`, `${baseURL}fonts/oswald/oswald-latin-700-normal.woff2`]);
});

test('a layout naming a font that is not loaded says so, with a way to load it, and an export stops rather than draw in another', async ({ page }) => {
  const { canvas } = await openCanvas(page);
  const layout = {
    kind: 'opentrack-overlay-layout',
    version: 1,
    image: { width: 1280, height: 720 },
    template: {
      version: 2,
      name: 'x',
      style: { fontFamily: 'Brand Sans' },
      components: [{ id: 'note-1', type: 'label', content: WORDS, visible: true, unitMode: 'auto', style: {}, rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.1 }, text: { align: 'left', weight: 'bold' } }],
    },
  };
  await page.getByTestId('canvas-layout-input').setInputFiles({ name: 'layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(layout)) });
  const needs = canvas.getByRole('group', { name: 'Fonts this layout needs' });
  await expect(needs).toContainText('This layout uses Brand Sans, which is not loaded here.');
  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  await expect(exporter.getByText('This layout uses Brand Sans, which is not loaded here.')).toBeVisible();
  await expect(exporter.getByRole('link', { name: /overlay-1280x720/ })).toHaveCount(0);

  await needs.getByRole('button', { name: 'Load Brand Sans…' }).click();
  await needs.getByLabel('Font file').setInputFiles(FIXTURE_FONT);
  await expect(needs).toHaveCount(0);
});
