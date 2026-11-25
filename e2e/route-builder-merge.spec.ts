import { expect, test, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { AFTERNOON_RIDE, MORNING_RIDE, buildMergeRides } from '../src/test/helpers/mergeFixtures';

/**
 * AV-1109. The two rides the task names, synthesized at full size (5,817 and
 * 10,465 points, the originals' clocks), merged in Route Builder in a real
 * browser, written out, and read back by the viewer.
 */

const rides = () => {
  const { morning, afternoon } = buildMergeRides();
  return {
    morning: { name: MORNING_RIDE.fileName, mimeType: 'application/gpx+xml', buffer: Buffer.from(morning) },
    afternoon: { name: AFTERNOON_RIDE.fileName, mimeType: 'application/gpx+xml', buffer: Buffer.from(afternoon) },
  };
};

const stat = (scope: ReturnType<Page['getByRole']>, label: string) =>
  scope.getByText(label, { exact: true }).locator('xpath=following-sibling::dd');

test('merges the morning ride and its continuation into one ride with a 74-minute pause, either way round', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  await page.goto('./#/route-builder');
  // Route-only basemap, so the maps fetch no tiles and the request list
  // below measures the merge alone.
  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Basemap tiles').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const { morning, afternoon } = rides();
  // Chosen afternoon first: the order on the page is the clocks', not the choice's.
  await page.getByTestId('track-input').setInputFiles([afternoon, morning]);

  const region = page.getByRole('region', { name: 'Add tracks' });
  const merged = region.getByRole('group', { name: 'The merged activity', exact: true });
  await expect(merged).toBeVisible({ timeout: 60_000 });
  const order = region.getByRole('list', { name: 'Files in the order they were recorded' }).getByRole('listitem');
  await expect(order).toHaveCount(2);
  await expect(order.nth(0)).toContainText(MORNING_RIDE.fileName);
  await expect(order.nth(1)).toContainText(AFTERNOON_RIDE.fileName);

  await expect(merged.getByRole('heading', { name: 'Imabari City Cycling (merged)' })).toBeVisible();
  await expect(stat(merged, 'Points')).toHaveText(/^16,?282$/);
  await expect(stat(merged, 'Pause')).toHaveText('1:14:29');
  await expect(stat(merged, 'Elapsed')).toHaveText('7:40:45');
  await expect(merged.getByRole('list', { name: 'Pauses between the files' })).toContainText(
    `between ${MORNING_RIDE.fileName} and ${AFTERNOON_RIDE.fileName}`,
  );
  const distance = await stat(merged, 'Distance').textContent();
  const moving = await stat(merged, 'Moving time').textContent();

  // The merge is a preview until the reader explicitly asks for a route copy.
  await merged.getByTestId('activity-map').locator('canvas').click();
  await expect(page.getByRole('region', { name: 'Planned track' })).toHaveCount(0);
  await merged.getByRole('button', { name: 'Edit a route copy' }).click();
  await expect(page.getByRole('region', { name: 'Edit points' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Planned track' })).toContainText(/16,?282/);

  // Written as GPX: one track, a segment per ride, every point with its time.
  const exporter = merged.getByRole('group', { name: 'Export the merged activity' });
  await exporter.getByRole('radio', { name: 'GPX' }).check();
  const downloading = page.waitForEvent('download');
  await exporter.getByRole('button', { name: 'Download Imabari-City-Cycling-merged.gpx' }).click();
  const saved = await downloading;
  expect(saved.suggestedFilename()).toBe('Imabari-City-Cycling-merged.gpx');
  const path = test.info().outputPath(saved.suggestedFilename());
  await saved.saveAs(path);
  const xml = readFileSync(path, 'utf-8');
  expect(xml.match(/<trkpt /g)).toHaveLength(16_282);
  expect(xml.match(/<time>/g)).toHaveLength(16_282 + 1);
  expect(xml.match(/<trkseg>/g)).toHaveLength(2);

  // Read back by the viewer: the same ride, the same totals.
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'File viewer' }).click();
  await page.getByTestId('file-input').setInputFiles(path);
  const summary = page.getByRole('region', { name: 'Activity summary' });
  await expect(summary).toContainText(/16,?282 points/, { timeout: 60_000 });
  await expect(stat(summary, 'Distance')).toHaveText(distance!);
  await expect(stat(summary, 'Moving time')).toHaveText(moving!);
  await expect(stat(summary, 'Duration')).toHaveText('7:40:45');

  // And nothing left the tab.
  const origin = new URL(page.url()).origin;
  for (const request of requests) {
    const url = request.url();
    expect(url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:'), url).toBe(true);
    expect(request.method(), url).toBe('GET');
    expect(request.postData(), url).toBeNull();
    expect(url).not.toContain('activity_2457');
  }
});

test('refuses overlapping rides by name, and merges once one is removed', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('./#/route-builder');
  const { morning, afternoon } = rides();
  await page.getByTestId('track-input').setInputFiles([morning, { ...morning, name: 'copy-of-morning.gpx' }, afternoon]);

  const region = page.getByRole('region', { name: 'Add tracks' });
  await expect(region.getByRole('alert')).toContainText(/cover exactly the same time: they look like the same recording/, {
    timeout: 60_000,
  });
  await region.getByRole('button', { name: 'Remove copy-of-morning.gpx' }).click();
  await expect(region.getByRole('alert')).toHaveCount(0);
  await expect(region.getByRole('group', { name: 'The merged activity', exact: true })).toBeVisible();
});
