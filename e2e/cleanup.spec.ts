import { expect, test } from '@playwright/test';

/** AV-1024. 40 s eastbound at 5 m/s with a one-kilometre GPS spike at point 10 (195 m of ground really covered). */
function spikedGpx(): string {
  const metersPerDegLon = 111_194.9 * Math.cos((45 * Math.PI) / 180);
  const points = Array.from({ length: 40 }, (_, i) => {
    const lat = i === 10 ? 45.009 : 45;
    const lon = (7 + (i * 5) / metersPerDegLon).toFixed(7);
    const time = new Date(Date.UTC(2024, 0, 1, 10, 0, i)).toISOString();
    return `<trkpt lat="${lat}" lon="${lon}"><time>${time}</time></trkpt>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">' +
    `<trk><name>Spiked</name><trkseg>${points.join('')}</trkseg></trk></gpx>`
  );
}

test('turning the clean-up on drops the spike and says how many, and turning it off restores the file', async ({ page }) => {
  await page.goto('./#/viewer');
  await page.getByTestId('file-input').setInputFiles({
    name: 'spiked.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(spikedGpx()),
  });

  const overview = page.getByRole('region', { name: 'Activity overview' });
  const distance = overview.locator('.summary__stat', { hasText: 'Distance' }).first();
  await expect(distance).toContainText('km');

  const toggle = page.getByRole('switch', { name: 'Clean up the telemetry' });
  await toggle.check();
  await expect(page.getByTestId('cleanup-dropped')).toContainText('Dropped 1 point: 1 for an implausible speed');
  await expect(distance).toContainText('195 m');
  await expect(page.getByTestId('cleanup-table')).toContainText('Raw');

  await toggle.uncheck();
  await expect(distance).toContainText('km');
  await expect(page.getByTestId('cleanup-dropped')).toBeEmpty();
});
