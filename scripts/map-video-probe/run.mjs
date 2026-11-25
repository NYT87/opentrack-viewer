// Usage: node scripts/map-video-probe/run.mjs <engine> [config...]
// Engines: chromium | webkit. Configs default to every local one; the live
// ones (`live-*`) fetch from OpenFreeMap and AWS and run only when named.
// Needs the server running first. Peak memory is the summed RSS of the
// browser's processes, sampled with `ps` every 250 ms, since GPU memory is
// invisible to the page.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE ?? '@playwright/test');

const port = process.env.PROBE_PORT ?? 8091;
const [engine, ...names] = process.argv.slice(2);
const configs = names.length ? names : ['caps', '2d', '2d-lag', '2d-lag-fade', '2d-redraw', '2d-cold', '3d', '3d-again', '3d-lag', '3d-clamped-cold', '3d-pure', '3d-pure-cold', '2d-vp9', '3d-4k', '2d-export', '3d-export', '2d-noenc', '2d-fail', '2d-60', '3d-60', '2d-bitmap', '2d-webgl-noenc', '2d-webgl-frame', '2d-webgl-frame-hash'];
const launch = {
  // The full browser in new headless mode: the headless shell has no H.264 encoder.
  chromium: () => chromium.launch({ channel: 'chromium', headless: true }),
  webkit: () => webkit.launch({ headless: true }),
};

function rssMB(marker) {
  const rows = execFileSync('ps', ['-A', '-o', 'rss=,command='], { encoding: 'utf8' }).split('\n');
  return Math.round(rows.filter((r) => r.includes(marker)).reduce((a, r) => a + Number(r.trim().split(/\s+/)[0] || 0), 0) / 1024);
}

mkdirSync(join(here, 'results'), { recursive: true });
const marker = engine === 'webkit' ? 'ms-playwright/webkit' : 'ms-playwright/chromium';
const browser = await launch[engine]();
const all = { engine, browserVersion: browser.version(), runs: {} };
for (const name of configs) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log(`[${engine}:${name}] pageerror ${e.message}`));
  let last = '';
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${engine}:${name}] console ${m.text().slice(0, 200)}`); else last = m.text(); });
  page.on('crash', () => console.log(`[${engine}:${name}] page crashed after: ${last}`));
  let peak = 0, tick = 0;
  const series = [];
  const timer = setInterval(() => { const mb = rssMB(marker); peak = Math.max(peak, mb); if (tick++ % 20 === 0) series.push(mb); }, 250);
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/?run=${name}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction('window.__done', null, { timeout: 1_200_000, polling: 1000 });
  } catch (e) {
    console.log(`[${engine}:${name}] timed out: ${e.message.split('\n')[0]}`);
  }
  clearInterval(timer);
  const result = await page.evaluate('window.__result ?? { partial: true }').catch((e) => ({ error: `${e.message.split('\n')[0]} after: ${last}` }));
  result.peakRssMB = peak; result.rssSeriesMB = series; result.wallMs = Date.now() - t0;
  all.runs[name] = result;
  console.log(`[${engine}:${name}] ${result.error ? 'ERROR ' + result.error.split('\n')[0] : `${result.totalMs ?? '-'} ms, ${result.fpsRendered ?? '-'} fps, peak ${peak} MB`}`);
  await page.close().catch(() => {});
  writeFileSync(join(here, 'results', `${engine}${names.length ? '-' + names.join('+') : ''}.json`), JSON.stringify(all, null, 1));
}
await browser.close();
