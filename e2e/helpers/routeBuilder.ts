import { expect, type Page } from '@playwright/test';

type Files = Parameters<ReturnType<Page['getByTestId']>['setInputFiles']>[0];

/**
 * The first track of a test, into Route Builder's planned track. A track with
 * timestamps on its own is a recording first, and its route copy is the
 * planned track; a track without goes straight in (TD-060).
 */
export async function addFirstTrack(page: Page, files: Files): Promise<void> {
  await page.getByTestId('track-input').setInputFiles(files);
  const copy = page.getByRole('button', { name: 'Edit a route copy' });
  const planned = page.getByRole('region', { name: 'Planned track' });
  await expect(copy.or(planned).first()).toBeVisible({ timeout: 30_000 });
  if (!(await planned.isVisible())) await copy.click();
  await expect(planned).toBeVisible();
}
