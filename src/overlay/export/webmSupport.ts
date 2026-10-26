/**
 * AV-1012. Whether this browser can record the overlay as a transparent WebM.
 *
 * TD-039 measured it: `MediaRecorder` keeps the alpha of a canvas in VP9 WebM
 * in the Chromium family and drops it in WebKit, which records the clear parts
 * as opaque black. An API that exists is therefore not an answer. The quick
 * check below rules out a browser without the parts; the probe after it
 * records a short transparent clip, plays it back over magenta and reads a
 * pixel, so the answer is the browser's own, never its name.
 */

export const WEBM_MIME_TYPE = 'video/webm;codecs=vp9';

export interface WebmSupport {
  supported: boolean;
  /** Said to the reader when `supported` is false. */
  reason?: string;
}

const NO_TRANSPARENT_VIDEO =
  'This browser cannot record a transparent video. Use the PNG sequence, which every editor can read.';

/** The parts a recording needs, by capability: a recorder that writes VP9 WebM and a canvas it can record. */
export function getWebmCapability(env: typeof globalThis = globalThis): WebmSupport {
  const recorder = (env as { MediaRecorder?: unknown }).MediaRecorder as
    | ((...args: never[]) => unknown) & { isTypeSupported?: (type: string) => boolean }
    | undefined;
  const canvas = (env as { HTMLCanvasElement?: { prototype?: { captureStream?: unknown } } }).HTMLCanvasElement;
  if (
    typeof recorder !== 'function' ||
    typeof recorder.isTypeSupported !== 'function' ||
    typeof canvas?.prototype?.captureStream !== 'function'
  ) {
    return { supported: false, reason: NO_TRANSPARENT_VIDEO };
  }
  if (!recorder.isTypeSupported(WEBM_MIME_TYPE)) return { supported: false, reason: NO_TRANSPARENT_VIDEO };
  return { supported: true };
}

/** How long the probe may take before the answer is "no". */
export const WEBM_PROBE_TIMEOUT_MS = 5000;

const PROBE_WIDTH = 128;
const PROBE_HEIGHT = 72;
const PROBE_FPS = 30;
const PROBE_FRAMES = 12;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Records a clear canvas with a white square for under half a second, plays
 * it back over magenta, and reads a corner and the square. The corner must
 * come back magenta (the clear part stayed clear) and the square white (the
 * clip decoded at all), so a black frame or a failed decode is a "no".
 */
async function recordAndRead(): Promise<boolean> {
  const canvas = document.createElement('canvas');
  canvas.width = PROBE_WIDTH;
  canvas.height = PROBE_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return false;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  if (!track || typeof track.requestFrame !== 'function') return false;

  const recorder = new MediaRecorder(stream, { mimeType: WEBM_MIME_TYPE, videoBitsPerSecond: 1_000_000 });
  const parts: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) parts.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();
  for (let i = 0; i < PROBE_FRAMES; i += 1) {
    ctx.clearRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(PROBE_WIDTH / 4, PROBE_HEIGHT / 4, PROBE_WIDTH / 2, PROBE_HEIGHT / 2);
    track.requestFrame();
    await sleep(1000 / PROBE_FPS);
  }
  recorder.stop();
  await stopped;
  track.stop();

  const url = URL.createObjectURL(new Blob(parts, { type: 'video/webm' }));
  const video = document.createElement('video');
  // Kept in the document so every engine decodes it, and out of sight.
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  video.muted = true;
  video.playsInline = true;
  document.body.append(video);
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('The test clip could not be played.'));
    });
    video.src = url;
    await loaded;
    await video.play().catch(() => undefined);
    await sleep(150);
    video.pause();

    const check = document.createElement('canvas');
    check.width = PROBE_WIDTH;
    check.height = PROBE_HEIGHT;
    const out = check.getContext('2d', { willReadFrequently: true });
    if (!out) return false;
    out.fillStyle = '#ff00ff';
    out.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    out.drawImage(video, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    const [r, g, b] = out.getImageData(4, 4, 1, 1).data;
    const [sr, sg, sb] = out.getImageData(PROBE_WIDTH / 2, PROBE_HEIGHT / 2, 1, 1).data;
    const corner = r! > 200 && g! < 60 && b! > 200;
    const square = sr! > 200 && sg! > 200 && sb! > 200;
    return corner && square;
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

let cached: Promise<WebmSupport> | undefined;

/** Asked once per page load: the answer does not change while the page is open. */
export function probeWebmSupport(env: typeof globalThis = globalThis): Promise<WebmSupport> {
  const capability = getWebmCapability(env);
  if (!capability.supported) return Promise.resolve(capability);
  cached ??= Promise.race([
    recordAndRead().then(
      (kept): WebmSupport => (kept ? { supported: true } : { supported: false, reason: NO_TRANSPARENT_VIDEO }),
      (): WebmSupport => ({ supported: false, reason: NO_TRANSPARENT_VIDEO }),
    ),
    sleep(WEBM_PROBE_TIMEOUT_MS).then((): WebmSupport => ({ supported: false, reason: NO_TRANSPARENT_VIDEO })),
  ]);
  return cached;
}

/** For tests: forget the answer. */
export function resetWebmProbe(): void {
  cached = undefined;
}
