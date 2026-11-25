import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportBurnedIn, type BurnInEnvironment, type BurnInOptions, type BurnInProgress } from '../../overlays/burnIn';
import type { OverlayContext2D, OverlayRenderer, RenderFrameOptions } from '../../overlays/renderOverlay';

/**
 * A browser, faked, for driving the burned-in export without one: a video that
 * moves only when told to, a recorder, a canvas, an audio route and tab
 * visibility. Shared by the exporter's own tests and the panel's.
 */

export const recordedWebm = new Uint8Array(readFileSync(join(__dirname, '../fixtures/no-duration.webm')));


const defaultOptions = (over: Partial<BurnInOptions> = {}): BurnInOptions => ({
  fps: 10,
  width: 320,
  height: 180,
  startSeconds: 0,
  endSeconds: 2,
  offsetSeconds: 0,
  quality: 'standard',
  includeAudio: true,
  ...over,
});

/** A video that only moves when the test says so, firing the events a real one would. */
export class FakeVideo extends EventTarget {
  muted = true;
  src = '';
  duration = 10;
  currentTime = 0;
  paused = true;
  ended = false;
  readyState = 0;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  playRejects = false;
  private frames: ((now: number, metadata: { mediaTime: number }) => void)[] = [];
  sawMutedAtPlay: boolean | undefined;
  pauses = 0;
  plays = 0;

  fire(type: string) {
    this.dispatchEvent(new Event(type));
    if (type === 'error') this.onerror?.();
    if (type === 'ended') this.onended?.();
  }
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  play() {
    this.sawMutedAtPlay = this.muted;
    this.plays += 1;
    if (this.playRejects) return Promise.reject(new Error('blocked'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.pauses += 1;
    this.paused = true;
  }
  requestVideoFrameCallback(callback: (now: number, metadata: { mediaTime: number }) => void) {
    this.frames.push(callback);
    return this.frames.length;
  }
  /** Moves the picture to `t` and delivers the frame, as the browser does. */
  tick(t: number) {
    this.currentTime = t;
    const callbacks = this.frames;
    this.frames = [];
    for (const callback of callbacks) callback(0, { mediaTime: t });
  }
  get waiting() {
    return this.frames.length;
  }
}

export class FakeTrack {
  stopped = false;
  constructor(readonly kind: 'video' | 'audio') {}
  stop() {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks: FakeTrack[] = [new FakeTrack('video')];
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  getTracks() {
    return this.tracks;
  }
}

export class FakeRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  started: number | undefined;
  /** What it produces when stopped. */
  output: Blob[] = [new Blob([recordedWebm], { type: 'video/webm' })];
  constructor(readonly stream: FakeStream, readonly settings: MediaRecorderOptions) {
    this.mimeType = settings.mimeType ?? '';
  }
  start(timeslice?: number) {
    this.state = 'recording';
    this.started = timeslice;
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    for (const data of this.output) this.ondataavailable?.({ data });
    this.onstop?.();
  }
  /** A chunk arriving while it records. */
  emit(data: { size: number }) {
    this.ondataavailable?.({ data: data as Blob });
  }
}

export interface Harness {
  env: BurnInEnvironment;
  video: FakeVideo;
  recorders: FakeRecorder[];
  revoked: string[];
  audioClosed: number;
  draws: string[];
  clock: { now: number };
  hidden: { value: boolean; listeners: (() => void)[] };
  config: { supported: boolean; mimes: string[]; hasAudio: boolean | undefined; audioRoute: boolean };
  setHidden(value: boolean): void;
  stream: FakeStream;
}

export function harness(over: Partial<Harness['config']> = {}): Harness {
  const video = new FakeVideo();
  const recorders: FakeRecorder[] = [];
  const draws: string[] = [];
  const revoked: string[] = [];
  const clock = { now: 0 };
  const hidden = { value: false, listeners: [] as (() => void)[] };
  const config = { supported: true, mimes: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'], hasAudio: true as boolean | undefined, audioRoute: true, ...over };
  const stream = new FakeStream();
  const h = { video, recorders, revoked, audioClosed: 0, draws, clock, hidden, config, stream } as Harness;

  h.env = {
    isRecordingSupported: () => config.supported,
    isTypeSupported: (mime) => config.mimes.includes(mime),
    createVideo: () => video as unknown as HTMLVideoElement,
    createObjectUrl: () => 'blob:fake/1',
    revokeObjectUrl: (url) => revoked.push(url),
    createCanvas: (width, height) => {
      const context = {
        drawImage: () => draws.push('video'),
      };
      return {
        width,
        height,
        getContext: () => context,
        captureStream: () => stream,
      } as unknown as HTMLCanvasElement;
    },
    createRecorder: (s, settings) => {
      const recorder = new FakeRecorder(s as unknown as FakeStream, settings);
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    createAudioRoute: () =>
      config.audioRoute
        ? {
            track: new FakeTrack('audio') as unknown as MediaStreamTrack,
            close: () => {
              h.audioClosed += 1;
            },
          }
        : undefined,
    hasAudio: () => config.hasAudio,
    isTabHidden: () => hidden.value,
    onVisibilityChange: (listener) => {
      hidden.listeners.push(listener);
      return () => {
        hidden.listeners = hidden.listeners.filter((l) => l !== listener);
      };
    },
    now: () => clock.now,
  };
  h.setHidden = (value) => {
    hidden.value = value;
    for (const listener of [...hidden.listeners]) listener();
  };
  return h;
}

export interface RenderCall {
  t: number;
  offset: number;
  clear: boolean | undefined;
  w: number;
  h: number;
}

export function rendererFor(h: Harness) {
  const calls: RenderCall[] = [];
  const renderer: OverlayRenderer = {
    resolved: { components: [], hidden: [] },
    render: (_c: OverlayContext2D, w, hh, t, offset, opts?: RenderFrameOptions) => {
      h.draws.push('overlay');
      calls.push({ t, offset, clear: opts?.clear, w, h: hh });
    },
  };
  return { renderer, calls };
}

/** Lets the export reach the point where it waits on video frames. */
export const settle = async (h: Harness, frames = 1) => {
  for (let i = 0; i < 50 && h.video.waiting < frames; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** Starts an export with metadata already loaded, returning what a test needs to drive it. */
export function start(h: Harness, over: Partial<BurnInOptions> = {}, extra: { signal?: AbortSignal; onProgress?: (p: BurnInProgress) => void } = {}) {
  const { renderer, calls } = rendererFor(h);
  const promise = exportBurnedIn({ file: new Blob(['v']), options: defaultOptions(over), renderer, env: h.env, ...extra });
  // Metadata arrives a moment after the source is set.
  queueMicrotask(() => {
    h.video.readyState = 1;
    h.video.fire('loadedmetadata');
  });
  // Observe a rejection without making it unhandled while the test drives the video.
  promise.catch(() => undefined);
  return { promise, calls };
}

/** Plays `times` through, then lets the export finish. */
export async function play(h: Harness, times: number[]) {
  await settle(h);
  for (const t of times) {
    h.video.tick(t);
    await new Promise((r) => setTimeout(r, 0));
  }
}

