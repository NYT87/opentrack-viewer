/**
 * Shared by the overlay browser tests. The video is the real HERO8 clip, whose
 * container states a start of 2019-11-18T15:41:25Z; the activity is generated to
 * begin at that instant, so a hand-chosen GPX lines up with it at offset zero.
 */
export const HERO8_START = '2019-11-18T15:41:25Z';

export function widestGpx(): string {
  const start = Date.parse(HERO8_START);
  const points = Array.from({ length: 21 }, (_, i) => {
    const time = new Date(start + i * 1000).toISOString().replace('.000Z', 'Z');
    return `<trkpt lat="${(51.5 + i * 0.0003).toFixed(5)}" lon="${(0.001 * i).toFixed(5)}">
        <ele>${1000 + i}</ele><time>${time}</time>
        <extensions><speed>27.8</speed><gpxtpx:TrackPointExtension>
          <gpxtpx:hr>${188 + (i % 3)}</gpxtpx:hr><gpxtpx:cad>${88 + (i % 3)}</gpxtpx:cad>
          <power>${999 + (i % 2)}</power></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Widest values</name><type>cycling</type><trkseg>${points.join('')}</trkseg></trk>
</gpx>`;
}

// ---------------------------------------------------------------------------
// AV-1008: the committed overlay fixtures, and what they say at any second.

import { join } from 'node:path';

export const FIXTURE_DIR = join(process.cwd(), 'src/test/fixtures');
/** A 6-second, 256×144 synthetic video a browser can play. No telemetry, no clock. */
export const CLIP_PATH = join(FIXTURE_DIR, 'overlay-test-clip.mp4');
export const CLIP_SECONDS = 6;
/** A 60-second ride with every channel; its first point is video time zero. */
export const RIDE_PATH = join(FIXTURE_DIR, 'overlay-ride.gpx');

/**
 * What `overlay-ride.gpx` states at second `t` — the formulae in
 * `make-overlay-fixtures.mjs`, written out again here so a test says what it
 * expects rather than copying what the app drew.
 */
export const ride = {
  speedMps: (t: number) => 4 + 0.2 * t,
  speedKmh: (t: number) => (4 + 0.2 * t) * 3.6,
  heartRate: (t: number) => 100 + t,
  elevation: (t: number) => 100 + t,
  power: (t: number) => 150 + 2 * t,
  distance: (t: number) => 4 * t + 0.1 * t * (t - 1),
};

/** Reads the bytes behind a `blob:` URL in the page, exactly as a download would. */
export async function fetchBlobBytes(
  page: import('@playwright/test').Page,
  href: string,
): Promise<Buffer> {
  const base64 = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }, href);
  return Buffer.from(base64, 'base64');
}

/**
 * A long recording, made on the spot: `hours` of a ride at one point a second,
 * as a GPX. Never committed — at four hours it is over two megabytes — and
 * deterministic, so the same call gives the same file.
 */
export function longRideGpx(hours: number): string {
  const count = Math.round(hours * 3600) + 1;
  const start = Date.parse('2024-06-01T08:00:00Z');
  const points: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = i / 600;
    points.push(
      `<trkpt lat="${(51.5 + 0.02 * Math.sin(angle)).toFixed(6)}" lon="${(-0.12 + 0.03 * Math.cos(angle)).toFixed(6)}">` +
        `<ele>${(40 + 15 * Math.sin(i / 300)).toFixed(1)}</ele><time>${new Date(start + i * 1000).toISOString().replace('.000Z', 'Z')}</time>` +
        `<extensions><speed>${(6 + 2 * Math.sin(i / 90)).toFixed(2)}</speed><gpxtpx:TrackPointExtension>` +
        `<gpxtpx:hr>${140 + Math.round(20 * Math.sin(i / 240))}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="e2e" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Long synthetic ride</name><type>cycling</type><trkseg>${points.join('')}</trkseg></trk>
</gpx>`;
}
