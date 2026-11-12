import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { CLIP_PATH, RIDE_PATH, fetchBlobBytes } from './helpers/overlayFixtures';
import { readZip } from '../src/test/helpers/zipReader';

/**
 * AV-1008. Privacy regression: while a video and its telemetry are previewed
 * and exported, nothing about them leaves the device.
 *
 * The files carry a *canary* — a token found nowhere else — in their names, in
 * the activity's name and in its coordinates. If any request, header, body or
 * outbound browser API ever carried the video, the telemetry, a frame, a file
 * name or the export's metadata, the canary would be in it. A canary that is
 * found nowhere proves little unless it is also shown to have reached the
 * page, so the test checks that too.
 */
const CANARY = '7731canary';
const ORIGIN = 'http://localhost:4173';

const canaryGpx = () =>
  readFileSync(RIDE_PATH, 'utf8')
    .replace('<name>Overlay test ride</name>', `<name>Secret ride ${CANARY}</name>`)
    // The same ride, relocated: a coordinate nobody else has.
    .replace(/lat="51\.(\d+)" lon="0\.0000000"/g, (_m, rest) => `lat="47.${rest}" lon="8.${CANARY.slice(0, 4)}000"`);

/**
 * The telemetry values to look for, read back from the file the page is given
 * rather than written beside it: the first point's coordinates exactly as the
 * file states them, and the coordinate's digits on their own (a request might
 * carry `47.5`, or `47.5000000`, or the pair). Any of them in a request is the
 * telemetry leaving.
 */
function telemetryNeedles(gpx: string): { lat: string; lon: string; all: string[] } {
  const first = /<trkpt lat="([\d.-]+)" lon="([\d.-]+)"/.exec(gpx);
  if (!first) throw new Error('the canary GPX has no points');
  const [lat, lon] = [first[1]!, first[2]!];
  // `47.5000000` -> the whole value, and the same without its trailing zeros: `47.5`.
  const trimmed = (value: string) => value.replace(/0+$/, '').replace(/\.$/, '');
  return { lat, lon, all: [...new Set([lat, lon, trimmed(lat), trimmed(lon)])] };
}

/**
 * Whether `url` is this app's own origin — parsed and compared exactly, not by
 * prefix, so `http://localhost:4173.attacker.example/` and
 * `http://localhost:4173@evil.example/` are not mistaken for it. A `blob:` URL
 * has the origin of the page that made it, and `data:` carries its content in
 * the URL and goes nowhere.
 */
export function isOwnOrigin(url: string, own: string = ORIGIN): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:') return true;
    return parsed.origin === own;
  } catch {
    return false;
  }
}

/** What of `needles` appears anywhere in the requests' methods, URLs, headers or bodies. */
function leaksIn(requests: Request[], needles: string[]): { needle: string; where: string }[] {
  const found: { needle: string; where: string }[] = [];
  for (const request of requests) {
    const where = `${request.method()} ${request.url()}`;
    const text = describeRequest(request);
    for (const needle of needles) if (text.includes(needle)) found.push({ needle, where });
  }
  return found;
}

/** Everything the page could send somewhere, recorded from inside it. */
const instrument = (page: Page) =>
  page.addInitScript(() => {
    const sent: { api: string; detail: string }[] = [];
    (window as unknown as { __outbound: typeof sent }).__outbound = sent;
    const record = (api: string, detail: unknown) => sent.push({ api, detail: String(detail) });

    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      record('fetch', `${input instanceof Request ? input.url : String(input)} ${init?.method ?? ''} ${typeof init?.body}`);
      return realFetch(input, init);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      record('xhr', `${method} ${String(url)}`);
      return (open as (...args: unknown[]) => void).call(this, method, url, ...rest);
    };
    const beacon = navigator.sendBeacon?.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      record('beacon', String(url));
      return beacon ? beacon(url, data) : false;
    };
    const RealWebSocket = window.WebSocket;
    window.WebSocket = class extends RealWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        record('websocket', String(url));
        super(url, protocols);
      }
    };
    const RealEventSource = window.EventSource;
    window.EventSource = class extends RealEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        record('eventsource', String(url));
        super(url, init);
      }
    };
  });

const describeRequest = (request: Request) =>
  [
    request.method(),
    request.url(),
    JSON.stringify(request.headers()),
    request.postDataBuffer()?.toString('latin1') ?? '',
  ].join('\n');

test('no request carries the video, the telemetry, a frame, a file name or the export metadata', async ({
  page,
  context,
}) => {
  const requests: Request[] = [];
  context.on('request', (request) => requests.push(request));
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await instrument(page);

  const gpx = canaryGpx();
  const needles = telemetryNeedles(gpx);
  // The needles are real: they are in the file the page is about to be given.
  expect(gpx).toContain(`lat="${needles.lat}"`);
  expect(gpx).toContain(`lon="${needles.lon}"`);
  expect(needles.lat.startsWith('47.')).toBe(true);

  await page.goto('./#/overlays');
  await page.getByTestId('overlay-file-input').setInputFiles({
    name: `${CANARY}-clip.mp4`,
    mimeType: 'video/mp4',
    buffer: readFileSync(CLIP_PATH),
  });
  await expect(page.getByRole('group', { name: 'Video', exact: true })).toContainText(`${CANARY}-clip.mp4`, {
    timeout: 30_000,
  });
  await page.getByTestId('overlay-file-input').setInputFiles({
    name: `${CANARY}-ride.gpx`,
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(gpx),
  });
  // The canary reached the page: it is the activity's file name, and its values are drawn.
  await expect(page.getByRole('group', { name: 'Activity', exact: true })).toContainText(`${CANARY}-ride.gpx`);
  await expect(page.getByTestId('overlay-layer').locator('[data-component="speed"]')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Video position' })).toBeEnabled({ timeout: 30_000 });

  // Use everything the page offers: scrub, play, change the template and the units, export.
  await page.getByRole('slider', { name: 'Video position' }).evaluate((input) => {
    const slider = input as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '3');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Pause' }).click();
  const controls = page.getByRole('region', { name: 'Overlay controls' });
  await controls.getByRole('radio', { name: /Compact HUD/ }).check();
  await controls.getByLabel('Units').selectOption('imperial');

  const panel = page.getByRole('region', { name: 'Export overlay' });
  await panel.getByLabel('Frame rate').selectOption('10');
  await panel.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = panel.getByRole('link', { name: /overlay.*\.zip/ });
  await expect(link).toBeVisible({ timeout: 90_000 });

  // The archive is the one place all of it is *meant* to be — and it stays on the device.
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  expect(entries.length).toBeGreaterThan(10);
  const metadata = new TextDecoder().decode(entries[0]!.data);
  expect(metadata).toContain('png-sequence'); // the thing the network must never see
  expect(metadata).not.toContain(CANARY); // and even it names nothing of the reader's

  // 1. Every request went to this app's own origin, or was a blob: reference to a local file.
  const external = requests.filter((request) => !isOwnOrigin(request.url()));
  expect(external.map((request) => request.url())).toEqual([]);

  // 2. None sent anything: no body, no method other than GET, no query string on an asset.
  expect(requests.filter((request) => request.method() !== 'GET').map(describeRequest)).toEqual([]);
  expect(requests.filter((request) => request.postDataBuffer() !== null)).toEqual([]);
  expect(
    requests.filter((request) => new URL(request.url()).origin === ORIGIN && new URL(request.url()).search !== '').map((request) => request.url()),
  ).toEqual([]);

  // 3. The canary, and everything that describes the files or the export, appears in none of it.
  const everything = requests.map(describeRequest).join('\n');
  expect(leaksIn(requests, needles.all)).toEqual([]);
  for (const forbidden of [
    CANARY,
    '.gpx',
    'clip.mp4',
    'overlay-test-clip',
    'Secret ride',
    ...needles.all,
    'frame_0',
    'overlay-export.json',
    'png-sequence',
    'frameRate',
    'telemetryOffsetSeconds',
    'ftyp', // an MP4's first box
    'IHDR', // a PNG's first chunk
  ]) {
    expect(everything, `a request mentions "${forbidden}"`).not.toContain(forbidden);
  }

  // 4. And nothing was handed to an API that sends: fetch beyond this origin, XHR, beacons, sockets.
  const outbound = await page.evaluate(
    () => (window as unknown as { __outbound: { api: string; detail: string }[] }).__outbound,
  );
  expect(outbound.filter((entry) => !(entry.api === 'fetch' && isOwnOrigin(entry.detail.split(' ')[0]!)))).toEqual([]);
  const outboundText = outbound.map((entry) => entry.detail).join('\n');
  for (const needle of [CANARY, ...needles.all]) expect(outboundText).not.toContain(needle);
  expect(sockets).toEqual([]);
});

/**
 * AV-1018 (TD-086). The reader's own maximum heart rate and FTP: personal, held in
 * this tab for the session, drawn with and sent to the export worker, and sent
 * nowhere else. They are distinctive numbers, so a request, a header, a body, a
 * storage entry or a layout file that carries them is found.
 */
const MAX_HEART_RATE = '217';
const FTP = '347';
/** The figures as a value in text, not as part of a longer number or a word. */
const figureIn = (text: string) => new RegExp(`(?<![\\w.])(${MAX_HEART_RATE}|${FTP})(?![\\w.])`).exec(text)?.[1];
const KEYS = ['maxHeartRate', 'personal', '"ftp"'];

test('the reader’s maximum heart rate and FTP are drawn and exported, and appear in no request, no storage and no layout file unless asked for (AV-1018)', async ({
  page,
  context,
}) => {
  const requests: Request[] = [];
  context.on('request', (request) => requests.push(request));
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await instrument(page);

  await page.goto('./#/overlays');
  await page.getByTestId('overlay-file-input').setInputFiles(RIDE_PATH);
  await page.getByRole('radio', { name: 'A custom video overlay, with no video' }).check();
  const canvas = page.getByRole('region', { name: 'Custom canvas' });
  await expect(canvas).toBeVisible();
  await canvas.getByLabel('Width (px)', { exact: true }).fill('320');
  await canvas.getByLabel('Height (px)', { exact: true }).fill('180');

  const add = async (label: string) => {
    await canvas.getByLabel('Add', { exact: true }).selectOption({ label });
    await canvas.getByRole('button', { name: 'Add to the canvas' }).click();
  };
  await add('Heart rate zones');
  await canvas.getByLabel('My maximum heart rate (bpm)').fill(MAX_HEART_RATE);
  await add('Power zones');
  await canvas.getByLabel('My FTP (W)').fill(FTP);
  // They reached the page: they are in its fields.
  await expect(canvas.getByLabel('My FTP (W)')).toHaveValue(FTP);

  // Exported across the activity, with them: the worker is handed them with the request.
  const exporter = canvas.getByRole('region', { name: 'Export overlay' });
  await exporter.getByLabel('Frame rate').selectOption('10');
  await exporter.getByRole('button', { name: 'Export PNG sequence' }).click();
  const link = exporter.getByRole('link', { name: /overlay-320x180-10fps\.zip/ });
  await expect(link).toBeVisible({ timeout: 120_000 });
  const entries = readZip(new Uint8Array(await fetchBlobBytes(page, (await link.getAttribute('href'))!)));
  expect(entries.length).toBeGreaterThan(10);
  // Even the archive's own metadata names nothing of them.
  const metadata = new TextDecoder().decode(entries[0]!.data);
  expect(figureIn(metadata)).toBeUndefined();
  for (const key of KEYS) expect(metadata).not.toContain(key);

  // A layout saved as it is by default holds neither; ticked, it holds both, so the check can see them.
  const saved = async () => {
    const download = page.waitForEvent('download');
    await canvas.getByRole('button', { name: 'Save layout' }).click();
    const path = await (await download).path();
    return readFileSync(path, 'utf8');
  };
  const plain = await saved();
  expect(figureIn(plain)).toBeUndefined();
  for (const key of KEYS) expect(plain).not.toContain(key);
  await canvas.getByLabel('Include my maximum heart rate and FTP').check();
  const included = await saved();
  expect(JSON.parse(included).template.components.map((component: { zones: { personal: unknown } }) => component.zones.personal)).toEqual([
    { maxHeartRate: Number(MAX_HEART_RATE), ftp: Number(FTP) },
    { maxHeartRate: Number(MAX_HEART_RATE), ftp: Number(FTP) },
  ]);
  await canvas.getByLabel('Include my maximum heart rate and FTP').uncheck();
  expect(figureIn(await saved())).toBeUndefined();

  // Nothing on the device: not in either storage, not in a cookie.
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }));
  expect(stored.local.filter(([key]) => key !== 'opentrack-viewer:theme')).toEqual([]);
  expect(stored.session).toEqual([]);
  expect(figureIn(JSON.stringify(stored))).toBeUndefined();
  expect(stored.cookie).toBe('');

  // Every request stayed on this origin, sent nothing, and carries neither figure nor the name of one.
  expect(requests.filter((request) => !isOwnOrigin(request.url())).map((request) => request.url())).toEqual([]);
  expect(requests.filter((request) => request.method() !== 'GET' || request.postDataBuffer() !== null).map(describeRequest)).toEqual([]);
  const everything = requests.map(describeRequest).join('\n');
  expect(figureIn(everything), 'a request carries a figure').toBeUndefined();
  for (const key of KEYS) expect(everything, `a request mentions ${key}`).not.toContain(key);
  const outbound = await page.evaluate(() => (window as unknown as { __outbound: { api: string; detail: string }[] }).__outbound);
  expect(outbound.filter((entry) => !(entry.api === 'fetch' && isOwnOrigin(entry.detail.split(' ')[0]!)))).toEqual([]);
  const outboundText = outbound.map((entry) => entry.detail).join('\n');
  expect(figureIn(outboundText)).toBeUndefined();
  expect(sockets).toEqual([]);
});

/**
 * The checks above are only worth having if they can fail. These leak on
 * purpose — a coordinate in a query string and in a body, a file name to a host
 * that merely *starts* like this one — and require the same detection to see it.
 */
test.describe('the privacy checks catch a leak', () => {
  const needles = telemetryNeedles(canaryGpx());

  test('a telemetry coordinate in a URL, in a body, or in a header', async ({ page, context }) => {
    const requests: Request[] = [];
    context.on('request', (request) => requests.push(request));
    await page.goto('./');
    await page.evaluate(async ({ lat, lon }) => {
      await fetch(`./collect?lat=${lat}`).catch(() => undefined);
      await fetch('./collect', { method: 'POST', body: `${lon}` }).catch(() => undefined);
      await fetch('./collect', { headers: { 'x-position': lat } }).catch(() => undefined);
    }, needles);

    const found = leaksIn(requests, needles.all);
    expect(found.map((leak) => leak.where).join('\n')).toContain('/collect?lat=');
    expect(found.some((leak) => leak.needle === needles.lon && leak.where.startsWith('POST'))).toBe(true);
    // The header leak is found by its header, not only its URL.
    expect(found.filter((leak) => leak.where.endsWith('/collect') && leak.where.startsWith('GET')).length).toBeGreaterThan(0);
  });

  test('a request to a host that only starts like this origin is not this origin', async ({ page, context }) => {
    // Nothing is sent: the look-alike hosts are only looked at, by the same test the checks use.
    expect(isOwnOrigin('http://localhost:4173/opentrack-viewer/assets/x.js')).toBe(true);
    // (`http://localhost:4173.attacker.example/` is not even a valid URL: that would be a port.)
    expect(isOwnOrigin('http://localhost:4173.attacker.example/collect')).toBe(false);
    expect(isOwnOrigin('http://localhost:4173@evil.example/collect')).toBe(false);
    expect(isOwnOrigin('http://localhost:41730/collect')).toBe(false);
    expect(isOwnOrigin('https://localhost:4173/collect')).toBe(false);
    expect(isOwnOrigin('http://evil.example/?http://localhost:4173')).toBe(false);
    expect(isOwnOrigin('blob:http://localhost:4173/6c1f3a')).toBe(true);
    expect(isOwnOrigin('blob:http://evil.example/6c1f3a')).toBe(false);
    expect(isOwnOrigin('data:text/plain;base64,AAAA')).toBe(true);
    expect(isOwnOrigin('not a url')).toBe(false);

    // And a real request to such a host, were the page to make one, is reported as external. It
    // starts with this origin's text, which is what a prefix test would have accepted: a different
    // port that begins with the same digits. (A `user@host` URL is judged above, not sent: the
    // browser refuses to make a request with credentials in the URL at all.)
    const lookalikes = ['http://localhost:41730/collect'];
    const requests: Request[] = [];
    context.on('request', (request) => requests.push(request));
    await context.route(/attacker\.example|:41730/, (route) => route.abort());
    // Keep this probe on its initial blank page: the app CSP now blocks
    // the connection before the network-audit detector sees it.
    await page.evaluate(async (urls) => {
      for (const url of urls) await fetch(url).catch(() => undefined);
    }, lookalikes);
    const external = requests.filter((request) => !isOwnOrigin(request.url())).map((request) => request.url());
    expect(external).toHaveLength(1);
    for (const url of lookalikes) {
      expect(url.startsWith(ORIGIN)).toBe(true); // a prefix test would have called these "ours"
      expect(external.some((seen) => seen.includes(new URL(url).host))).toBe(true);
    }
  });

  test('the reader’s figures in a URL, a body, or a header, and in a request to the worker’s own origin (AV-1018)', async ({ page, context }) => {
    const requests: Request[] = [];
    context.on('request', (request) => requests.push(request));
    await page.goto('./');
    await page.evaluate(async ({ hr, ftp }) => {
      await fetch(`./collect?max=${hr}`).catch(() => undefined);
      await fetch('./collect', { method: 'POST', body: JSON.stringify({ ftp }) }).catch(() => undefined);
      await fetch('./collect', { headers: { 'x-zones': `hr=${hr}` } }).catch(() => undefined);
    }, { hr: Number(MAX_HEART_RATE), ftp: Number(FTP) });
    const everything = requests.map(describeRequest);
    expect(everything.some((text) => text.includes('/collect?max=') && figureIn(text) === MAX_HEART_RATE)).toBe(true);
    expect(everything.some((text) => text.startsWith('POST') && figureIn(text) === FTP && text.includes('"ftp"'))).toBe(true);
    expect(everything.some((text) => text.includes('x-zones') && figureIn(text) === MAX_HEART_RATE)).toBe(true);
    // And the other checks would see them: the keys, the number beside them.
    expect(KEYS.some((key) => everything.join('\n').includes(key))).toBe(true);
    // A longer number or a word that merely contains one is not a figure.
    expect(figureIn('chunk-2174.js 3470 a217')).toBeUndefined();
    expect(figureIn('max 217 bpm')).toBe(MAX_HEART_RATE);
  });
});
