import { expect, test, type Page } from '@playwright/test';
import { CLIP_PATH, RIDE_PATH, fetchBlobBytes } from './helpers/overlayFixtures';

async function exportedOverlay(page: Page) {
  await page.goto('./#/overlays');
  await page.getByTestId('overlay-video-input').setInputFiles(CLIP_PATH);
  await expect(page.getByRole('region', { name: 'Video', exact: true })).toContainText('overlay-test-clip.mp4');
  await page.getByTestId('overlay-activity-input').setInputFiles(RIDE_PATH);
  const panel = page.getByRole('region', { name: 'Export overlay' });
  await panel.getByLabel('Frame rate').selectOption('10');
  await panel.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = panel.getByRole('link', { name: /Download .*\.zip/ });
  await expect(link).toBeVisible();
  return { panel, href: (await link.getAttribute('href'))! };
}

const archives = (page: Page) => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (name.startsWith('overlay-export-')) names.push(name);
  }
  return names;
});

test('startup and another export preserve a finished download until it is discarded', async ({ page, context }) => {
  const first = await exportedOverlay(page);
  expect(await archives(page)).toHaveLength(1);
  const other = await context.newPage();
  const second = await exportedOverlay(other);
  expect(await archives(page)).toHaveLength(2);
  expect((await fetchBlobBytes(page, first.href)).length).toBeGreaterThan(0);
  expect((await fetchBlobBytes(other, second.href)).length).toBeGreaterThan(0);
  await first.panel.getByRole('button', { name: 'Discard export', exact: true }).click();
  await expect.poll(() => archives(other)).toHaveLength(1);
  await expect(first.panel.getByRole('link', { name: /Download/ })).toHaveCount(0);

  // A closed document releases ownership; the next visit reclaims its output.
  await other.close();
  const next = await context.newPage();
  await next.goto('./');
  await expect.poll(() => archives(next)).toEqual([]);
});

test('Settings preserves files owned by open tabs', async ({ page, context }) => {
  const first = await exportedOverlay(page);
  const other = await context.newPage();
  await other.goto('./');
  await other.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await other.getByRole('button', { name: 'Delete abandoned exports' }).click();
  await expect(other.getByRole('status')).toContainText('Removed 0 abandoned exports');
  expect((await fetchBlobBytes(page, first.href)).length).toBeGreaterThan(0);
});

test('the production policy blocks unapproved inline scripts and outside connections', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  const outsideRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.invalid/')) outsideRequests.push(request.url());
  });
  const result = await page.evaluate(async () => {
    const script = document.createElement('script');
    script.textContent = 'globalThis.opentrackInjected = true';
    document.head.append(script);
    const connected = await fetch('https://example.invalid/review-probe').then(() => true, () => false);
    return { injected: Reflect.get(globalThis, 'opentrackInjected') === true, connected };
  });
  expect(result).toEqual({ injected: false, connected: false });
  expect(outsideRequests).toEqual([]);
});

test('the basemap privacy choice survives a reload without persisting activity data', async ({ page }) => {
  const external: string[] = [];
  await page.goto('./#/viewer');
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.reload();
  page.on('request', (request) => {
    if (!request.url().startsWith(new URL(page.url()).origin)) external.push(request.url());
  });
  await page.getByTestId('file-input').setInputFiles(RIDE_PATH);
  await expect(page.getByRole('region', { name: 'Activity summary' })).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Basemap tiles')).not.toBeChecked();
  expect(external).toEqual([]);
  const stored = await page.evaluate(() => Object.entries(localStorage));
  expect(stored).toEqual([['opentrack-viewer:basemap', 'false']]);
});

for (const touching of [false, true]) {
  test(`merged export policy survives opening the viewer (${touching ? 'touching' : 'separated'} stretches)`, async ({ page }) => {
    const gpx = (times: number[]) => `<gpx><trk><trkseg>${times.map((seconds, i) =>
      `<trkpt lat="${40 + i * 0.001}" lon="-3"><time>${new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()}</time></trkpt>`,
    ).join('')}</trkseg></trk></gpx>`;
    await page.goto('./#/route-builder');
    await page.getByRole('banner').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Basemap tiles').uncheck();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByTestId('track-input').setInputFiles([
      { name: 'first.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx([0, 10])) },
      { name: 'second.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx([touching ? 10 : 100, 110])) },
    ]);
    await page.getByRole('button', { name: 'Open in the viewer', exact: true }).click();
    const format = page.getByLabel('Format', { exact: true });
    await expect(format.getByRole('option', { name: /^TCX/ })).toBeDisabled();
    if (touching) {
      await expect(format.getByRole('option', { name: /^FIT/ })).toBeDisabled();
      await expect(format).toHaveValue('gpx');
    } else {
      await expect(format.getByRole('option', { name: /^FIT/ })).toBeEnabled();
      await expect(format).toHaveValue('fit');
    }
  });
}
