/**
 * The link-preview image: `public/social/preview-1200x630.png`, the picture a
 * shared link shows (Open Graph and X). Drawn here from HTML in a headless
 * Chromium rather than by hand, so it can be made again when the brand or the
 * copy changes:
 *
 *   node scripts/preview-image/make-preview-image.mjs
 *
 * The route and the elevation profile are made-up curves, not anyone's ride:
 * the privacy model (TD-016) keeps real places out of everything the site
 * publishes. Colours are DESIGN.md's dark palette. Type is the system UI font
 * of the machine that runs this, as in the app; run it on a Mac to match the
 * committed image.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'public', 'social', 'preview-1200x630.png');

const WIDTH = 1200;
const HEIGHT = 630;

/** A loop of a route, closed by a return leg: a few sine terms, nothing measured. */
function routePath(box) {
  const points = [];
  const steps = 240;
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const x = Math.cos(t) * 0.82 + 0.16 * Math.cos(3 * t + 0.6) + 0.05 * Math.sin(7 * t);
    const y = Math.sin(t) * 0.62 + 0.18 * Math.sin(2 * t + 1.1) + 0.04 * Math.cos(9 * t);
    points.push([box.x + box.w / 2 + (x * box.w) / 2.3, box.y + box.h / 2 + (y * box.h) / 1.75]);
  }
  return points;
}

/** An elevation profile over the same loop: two climbs and a long descent. */
function profilePath(box) {
  const points = [];
  const steps = 160;
  for (let i = 0; i <= steps; i += 1) {
    const s = i / steps;
    const climb = 0.55 * Math.exp(-((s - 0.32) ** 2) / 0.012) + 0.85 * Math.exp(-((s - 0.66) ** 2) / 0.02);
    const ripple = 0.05 * Math.sin(s * 40) + 0.03 * Math.sin(s * 97);
    const v = Math.min(1, Math.max(0, 0.12 + climb + ripple));
    points.push([box.x + s * box.w, box.y + box.h - v * box.h * 0.9]);
  }
  return points;
}

const d = (points) => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

const map = { x: 640, y: 64, w: 496, h: 360 };
const route = routePath({ x: map.x + 24, y: map.y + 24, w: map.w - 48, h: map.h - 48 });
const profile = { x: 640, y: 448, w: 496, h: 118 };
const elevation = profilePath({ x: profile.x + 20, y: profile.y + 14, w: profile.w - 40, h: profile.h - 28 });
const start = route[0];
const end = route[Math.round(route.length * 0.93)];
const ridden = route.slice(0, Math.round(route.length * 0.93) + 1);

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
    background: #0b0f14; color: #e6edf3;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .text { position: absolute; left: 72px; top: 72px; width: 520px; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
  .brand span { color: #8b9bb0; font-weight: 400; }
  .brand svg { width: 44px; height: 44px; color: #4aa3ff; }
  h1 { margin-top: 64px; font-size: 54px; line-height: 1.12; font-weight: 700; letter-spacing: -0.015em; }
  p { margin-top: 28px; font-size: 26px; line-height: 1.4; color: #8b9bb0; }
  .formats { position: absolute; left: 72px; bottom: 64px; display: flex; gap: 12px; }
  .formats b { font-size: 20px; font-weight: 600; padding: 8px 16px; border: 1px solid #223040; border-radius: 10px; background: #131a22; letter-spacing: 0.04em; }
</style></head><body>
  <div class="text">
    <div class="brand">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 19c3.5 0 3.5-6 7-6s3.5 6 7 6" />
        <circle cx="3" cy="19" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="17" cy="19" r="1.6" fill="currentColor" stroke="none" />
        <path d="M14.5 6.5 18 3l3 3.5" />
      </svg>
      <div>OpenTrack <span>Viewer</span></div>
    </div>
    <h1>Your activity files, read in your browser.</h1>
    <p>Routes, elevation, pace and heart rate, and overlays for your videos. Nothing is uploaded.</p>
  </div>
  <div class="formats"><b>GPX</b><b>FIT</b><b>TCX</b><b>KML</b></div>
  <svg width="${WIDTH}" height="${HEIGHT}" style="position:absolute;left:0;top:0">
    <rect x="${map.x}" y="${map.y}" width="${map.w}" height="${map.h}" rx="14" fill="#11161c" stroke="#223040" />
    ${Array.from({ length: 7 }, (_, i) => `<line x1="${map.x + ((i + 1) * map.w) / 8}" y1="${map.y + 1}" x2="${map.x + ((i + 1) * map.w) / 8}" y2="${map.y + map.h - 1}" stroke="#1a222d" />`).join('')}
    ${Array.from({ length: 5 }, (_, i) => `<line x1="${map.x + 1}" y1="${map.y + ((i + 1) * map.h) / 6}" x2="${map.x + map.w - 1}" y2="${map.y + ((i + 1) * map.h) / 6}" stroke="#1a222d" />`).join('')}
    <path d="${d(route)}" fill="none" stroke="#0b0f14" stroke-width="11" stroke-linejoin="round" stroke-linecap="round" />
    <path d="${d(route)}" fill="none" stroke="#2b4a6b" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" />
    <path d="${d(ridden)}" fill="none" stroke="#4aa3ff" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${start[0]}" cy="${start[1]}" r="9" fill="#4aa3ff" stroke="#0b0f14" stroke-width="3" />
    <circle cx="${end[0]}" cy="${end[1]}" r="9" fill="#ffd166" stroke="#0b0f14" stroke-width="3" />
    <rect x="${profile.x}" y="${profile.y}" width="${profile.w}" height="${profile.h}" rx="14" fill="#131a22" stroke="#223040" />
    <path d="${d(elevation)} L${elevation.at(-1)[0]} ${profile.y + profile.h - 14} L${elevation[0][0]} ${profile.y + profile.h - 14} Z" fill="rgba(74, 163, 255, 0.16)" />
    <path d="${d(elevation)}" fill="none" stroke="#4aa3ff" stroke-width="3" stroke-linejoin="round" />
  </svg>
</body></html>`;

mkdirSync(dirname(out), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: out, type: 'png' });
await browser.close();
console.log(`Wrote ${out}`);
