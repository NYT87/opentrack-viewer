/**
 * Generates the overlay fixtures beside this script (`AV-1008`).
 *
 *   overlay-ride.gpx       a 60-second ride with every channel the overlay can show
 *   overlay-test-clip.mp4  a 6-second synthetic video a browser can actually play
 *
 * Run `node src/test/fixtures/make-overlay-fixtures.mjs` after changing this and
 * commit the results. The GPX needs only Node. The clip is made in a headless
 * Chromium with Mediabunny (both already dependencies), because no encoder is
 * installed on a development machine otherwise; the file is committed so tests
 * need neither.
 *
 * Both are synthetic: nothing in them was ever recorded, so no route, time or
 * device of a real person is committed (plan §13). The values are *formulae*,
 * so a test can state the expected number for any second instead of copying
 * whatever the code produced:
 *
 *   speed(t)      = 4 + 0.2 t   m/s      (recorded, so it is read as stated)
 *   distance(t)   = 4 t + 0.1 t (t - 1)  m   (the ride moves due north at that speed,
 *                                          so distance derived from the positions agrees)
 *   heart rate    = 100 + t     bpm
 *   elevation     = 100 + t     m
 *   power         = 150 + 2 t   W
 *   cadence       = 80 + (t mod 5)  rpm    (the activity is cycling)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');

export const RIDE_SECONDS = 60;
export const RIDE_START = '2024-01-01T10:00:00Z';
const METERS_PER_DEGREE = 111194.93;

export const speedAt = (t) => 4 + 0.2 * t;

function rideGpx() {
  let metersNorth = 0;
  const points = [];
  for (let t = 0; t <= RIDE_SECONDS; t += 1) {
    const time = new Date(Date.parse(RIDE_START) + t * 1000).toISOString().replace('.000Z', 'Z');
    const lat = (51.5 + metersNorth / METERS_PER_DEGREE).toFixed(7);
    points.push(
      `      <trkpt lat="${lat}" lon="0.0000000"><ele>${100 + t}.0</ele><time>${time}</time>` +
        `<extensions><speed>${speedAt(t).toFixed(1)}</speed><gpxtpx:TrackPointExtension>` +
        `<gpxtpx:hr>${100 + t}</gpxtpx:hr><gpxtpx:cad>${80 + (t % 5)}</gpxtpx:cad>` +
        `<power>${150 + 2 * t}</power></gpxtpx:TrackPointExtension></extensions></trkpt>`,
    );
    metersNorth += speedAt(t);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Synthetic (AV-1008): every value is a formula of the second; see make-overlay-fixtures.mjs. -->
<gpx version="1.1" creator="OpenTrackViewerTestFixture" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk>
    <name>Overlay test ride</name>
    <type>cycling</type>
    <trkseg>
${points.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}

async function testClip() {
  const { chromium } = await import('@playwright/test');
  const library = readFileSync(join(ROOT, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'), 'utf8');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage();
    // WebCodecs needs a secure context, and `localhost` is one: serve a blank
    // page there from a route, so no server has to be running.
    await page.route('http://localhost:9/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }),
    );
    await page.goto('http://localhost:9/');
    const base64 = await page.evaluate(async (source) => {
      const mb = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      const [width, height, fps, seconds] = [256, 144, 15, 6];
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      const target = new mb.BufferTarget();
      const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
      const video = new mb.CanvasSource(canvas, { codec: 'vp9', bitrate: 120_000 });
      output.addVideoTrack(video, { frameRate: fps });
      await output.start();
      for (let frame = 0; frame < fps * seconds; frame += 1) {
        const t = frame / fps;
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, `hsl(${(t * 40) % 360} 60% 25%)`);
        gradient.addColorStop(1, `hsl(${(t * 40 + 120) % 360} 60% 45%)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        // A bar that sweeps once a second, and the frame number: a picture that visibly changes.
        ctx.fillStyle = 'white';
        ctx.fillRect(((t % 1) * width) | 0, 0, 6, height);
        ctx.font = 'bold 28px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(String(frame).padStart(3, '0'), 10, 10);
        await video.add(t, 1 / fps);
      }
      await output.finalize();
      const bytes = new Uint8Array(target.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }, library);
    return Buffer.from(base64, 'base64');
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(HERE, 'overlay-ride.gpx'), rideGpx());
  console.log('wrote overlay-ride.gpx');
  if (!process.argv.includes('--gpx-only')) {
    const clip = await testClip();
    writeFileSync(join(HERE, 'overlay-test-clip.mp4'), clip);
    console.log(`wrote overlay-test-clip.mp4 (${clip.length} bytes)`);
  }
}
