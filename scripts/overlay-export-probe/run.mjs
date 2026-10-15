// Usage: node scripts/overlay-export-probe/run.mjs <engine...>
// Engines: chromium | brave | webkit | firefox. Needs the server running first.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const { chromium, webkit, firefox } = require('@playwright/test');

const port = process.env.PROBE_PORT ?? 8089;
const BRAVE = process.env.BRAVE_PATH ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const launch = {
  // The full browser in new headless mode, not the headless shell: the shell
  // may lack the proprietary codecs, and the point is to measure them.
  chromium: () => chromium.launch({ channel: 'chromium', headless: true }),
  brave: () => chromium.launch({ executablePath: BRAVE, headless: true }),
  webkit: () => webkit.launch({ headless: true }),
  firefox: () => firefox.launch({ headless: true }),
};

for (const name of process.argv.slice(2)) {
  if (!launch[name]) { console.log(`unknown engine ${name}`); continue; }
  const t0 = Date.now();
  const browser = await launch[name]();
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/^(ERR|DONE|SECTION)/.test(t)) console.log(`[${name}] ${t}`); });
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' }); break; }
    catch (e) { console.log(`[${name}] goto retry: ${e.message.split('\n')[0]}`); await new Promise((r) => setTimeout(r, 1000)); }
  }
  try {
    await page.waitForFunction('window.__done', null, { timeout: 900_000 });
  } catch (e) {
    console.log(`[${name}] timed out: ${e.message.split('\n')[0]}`);
  }
  const result = await page.evaluate('window.__result ?? { partial: true }');
  result.engine = name; result.browserVersion = browser.version(); result.wallMs = Date.now() - t0;
  const out = join(here, 'results', `${name}.json`);
  writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`[${name}] ${browser.version()} wrote ${out} in ${Math.round((Date.now() - t0) / 1000)}s, errors=${(result.errors || []).length}`);
  await browser.close();
}
