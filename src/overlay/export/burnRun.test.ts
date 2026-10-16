import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectSource, runBurn, type MediabunnyModule } from './burnRun';
import type { BurnRequest } from './protocol';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const activity = makeActivity(
  Array.from({ length: 11 }, (_, i) => ({
    time: at(i),
    lat: 10 + i * 0.001,
    lon: 20 + i * 0.001,
    distanceMeters: i * 10,
    speedMetersPerSecond: i,
  })),
);
const template = buildOverlay(DEFAULT_OVERLAY_CONTROLS, buildOverlayTimeline(activity, { video: { durationSeconds: 10 } }), 16 / 9).template;

const request = (overrides: Partial<BurnRequest> = {}): BurnRequest => ({
  file: new File(['video'], 'GH010042.mp4'),
  width: 1280,
  height: 720,
  bitrate: 5_000_000,
  frameRate: 30,
  videoDurationSeconds: 10,
  offsetSeconds: 0,
  units: 'metric',
  template,
  activity,
  archiveName: 'overlay-export-x.zip',
  ...overrides,
});

/** Everything drawn on the canvas, and the frames put there, in order. */
const events: string[] = [];
function canvasContext() {
  const state: Record<string, unknown> = { font: '', fillStyle: '', globalAlpha: 1 };
  return new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        events.push(key === 'fillText' ? `text:${String(args[0])}` : key);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  });
}

interface Script {
  /** Seconds of video each frame is stamped with. */
  frames?: number[];
  /** Progress to report before finishing. */
  progress?: [number, number][];
  discarded?: { track: { isAudioTrack(): boolean; isVideoTrack(): boolean }; reason: string }[];
  valid?: boolean;
  /** Called after the frames, in place of finishing. */
  during?: (conversion: FakeConversion) => Promise<void>;
  failWith?: Error;
}

class FakeCanceled extends Error {}

/** The part of the conversion options these tests look at. */
interface InitOptions extends Record<string, unknown> {
  video: {
    process: (sample: unknown) => unknown;
    quality: { options: unknown };
  } & Record<string, unknown>;
}

interface FakeConversion {
  isValid: boolean;
  discardedTracks: Script['discarded'];
  onProgress?: (fraction: number, seconds: number) => void;
  cancel: ReturnType<typeof vi.fn>;
  execute: () => Promise<void>;
}

function fakeMediabunny(script: Script = {}) {
  const seen = {
    initOptions: undefined as InitOptions | undefined,
    inputs: [] as { disposed: boolean; source: unknown; formats: unknown }[],
    formatOptions: undefined as unknown,
    written: [] as { position: number; data: number[] }[],
    drawn: [] as { x: number; y: number; w?: number; h?: number }[],
    returned: [] as unknown[],
    conversion: undefined as FakeConversion | undefined,
    output: undefined as { target: { writable: WritableStream } } | undefined,
  };
  const track = (type: 'video' | 'audio') => ({
    codec: type === 'video' ? 'avc' : 'aac',
    displayWidth: 848,
    displayHeight: 480,
    canDecode: async () => true,
    isVideoTrack: () => type === 'video',
    isAudioTrack: () => type === 'audio',
  });
  const mb = {
    MP4: 'mp4',
    QTFF: 'qtff',
    BlobSource: class {
      constructor(public blob: Blob) {}
    },
    Input: class {
      state: { disposed: boolean; source: unknown; formats: unknown };
      constructor(options: { source: unknown; formats: unknown }) {
        this.state = { disposed: false, source: options.source, formats: options.formats };
        seen.inputs.push(this.state);
      }
      getPrimaryVideoTrack = async () => track('video');
      getPrimaryAudioTrack = async () => track('audio');
      dispose() {
        this.state.disposed = true;
      }
    },
    Mp4OutputFormat: class {
      constructor(options: unknown) {
        seen.formatOptions = options;
      }
    },
    StreamTarget: class {
      constructor(public writable: WritableStream) {}
    },
    Output: class {
      constructor(options: { target: { writable: WritableStream } }) {
        seen.output = options;
      }
    },
    Quality: class {
      constructor(public options: unknown) {}
    },
    ConversionCanceledError: FakeCanceled,
    canEncodeVideo: vi.fn(async () => true),
    Conversion: {
      init: vi.fn(async (options: InitOptions) => {
        seen.initOptions = options;
        const conversion: FakeConversion = {
          isValid: script.valid ?? true,
          discardedTracks: script.discarded ?? [],
          cancel: vi.fn(async () => undefined),
          execute: async () => {
            for (const [fraction, seconds] of script.progress ?? []) conversion.onProgress?.(fraction, seconds);
            for (const timestamp of script.frames ?? []) {
              const sample = {
                timestamp,
                draw: (_ctx: unknown, x: number, y: number, w?: number, h?: number) => {
                  events.push('frame');
                  seen.drawn.push({ x, y, w, h });
                },
              };
              seen.returned.push(await options.video.process(sample));
            }
            await script.during?.(conversion);
            if (script.failWith) throw script.failWith;
          },
        };
        seen.conversion = conversion;
        return conversion;
      }),
    },
  };
  return { mb: mb as unknown as MediabunnyModule, seen };
}

beforeEach(() => {
  events.length = 0;
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return canvasContext();
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('inspecting a video before rendering it (AV-1007)', () => {
  it('reports what is in it and whether this browser can decode and encode it', async () => {
    const { mb, seen } = fakeMediabunny();
    const info = await inspectSource(mb, new Blob(['x']), { width: 1280, height: 720, bitrate: 5_000_000, frameRate: 30 });
    expect(info).toEqual({
      video: { codec: 'avc', width: 848, height: 480, canDecode: true },
      audio: { codec: 'aac', canDecode: true },
      canEncode: true,
    });
    // Only MP4 and QuickTime are read; the input is released afterwards.
    expect(seen.inputs[0]).toMatchObject({ formats: ['mp4', 'qtff'], disposed: true });
  });

  it('asks whether H.264 can be encoded, hardware preferred, at the size and rate that will be used', async () => {
    const { mb } = fakeMediabunny();
    await inspectSource(mb, new Blob(['x']), { width: 1280, height: 720, bitrate: 5_000_000, frameRate: 30 });
    expect(mb.canEncodeVideo).toHaveBeenCalledWith('avc', {
      width: 1280,
      height: 720,
      quality: expect.anything(),
      frameRate: 30,
      hardwareAcceleration: 'prefer-hardware',
    });
  });

  it('reports a missing encoder, and a file that is not a video this export can read', async () => {
    const { mb } = fakeMediabunny();
    (mb.canEncodeVideo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const info = await inspectSource(mb, new Blob(['x']), { width: 640, height: 360, bitrate: 1_000_000 });
    expect(info.canEncode).toBe(false);

    const unreadable = fakeMediabunny();
    const original = unreadable.mb.Input;
    unreadable.mb.Input = class extends original {
      getPrimaryVideoTrack = async () => {
        throw new Error('unrecognizable');
      };
    } as never;
    await expect(
      inspectSource(unreadable.mb, new Blob(['x']), { width: 640, height: 360, bitrate: 1_000_000 }),
    ).rejects.toMatchObject({ code: 'render_failed', message: expect.stringContaining('MP4 or MOV') });
    expect(unreadable.seen.inputs[0]!.disposed).toBe(true);
  });
});

describe('the burned-in render (AV-1007)', () => {
  const run = (script: Script, options: Partial<Parameters<typeof runBurn>[0]> = {}) => {
    const fake = fakeMediabunny(script);
    const written = fake.seen.written;
    const promise = runBurn({
      mb: fake.mb,
      request: request(),
      writeAt: (chunk, position) => void written.push({ position, data: [...chunk] }),
      ...options,
    });
    return { ...fake, promise };
  };

  it('asks for H.264, hardware preferred, at the requested size and bitrate, and leaves the sound to be copied', async () => {
    const { promise, seen } = run({});
    await promise;
    expect(seen.initOptions).toMatchObject({
      tracks: 'primary',
      video: {
        codec: 'avc',
        hardwareAcceleration: 'prefer-hardware',
        width: 1280,
        height: 720,
        fit: 'fill',
        frameRate: 30,
        processedWidth: 1280,
        processedHeight: 720,
      },
    });
    expect(seen.initOptions!.video.quality.options).toEqual({ bitrate: 5_000_000 });
    // No audio options: the library copies AAC through and converts the rest.
    expect(seen.initOptions).not.toHaveProperty('audio');
    expect(seen.formatOptions).toEqual({ fastStart: false });
  });

  it('draws the video frame, then the overlay over it, and hands back the canvas', async () => {
    const { promise, seen } = run({ frames: [0, 5] });
    const result = await promise;
    expect(result.frameCount).toBe(2);
    expect(seen.drawn).toEqual([
      { x: 0, y: 0, w: 1280, h: 720 },
      { x: 0, y: 0, w: 1280, h: 720 },
    ]);
    // The frame goes down first and nothing clears it: the overlay is drawn over the picture.
    const firstFrame = events.indexOf('frame');
    expect(events.indexOf('clearRect')).toBe(-1);
    expect(events.indexOf('text:SPEED')).toBeGreaterThan(firstFrame);
    // At t = 5 s the overlay shows the value for that moment.
    expect(events).toContain('text:18.0 km/h');
    expect(seen.returned).toHaveLength(2);
    expect(seen.returned[0]).toBe(seen.returned[1]);
  });

  it('draws the overlay for each frame at that frame\'s own time', async () => {
    const { promise } = run({ frames: [0, 5] });
    await promise;
    const values = events.filter((event) => event.startsWith('text:') && event.endsWith('km/h'));
    expect(values).toEqual(['text:0.0 km/h', 'text:18.0 km/h']);
  });

  it('applies the telemetry offset it was given', async () => {
    const { promise } = run({ frames: [5] }, { request: request({ offsetSeconds: 2 }) });
    await promise;
    expect(events).toContain('text:10.8 km/h'); // the activity as it was at t = 3
  });

  it('writes the output where the muxer says, at that position', async () => {
    const { promise, seen } = run({
      during: async () => {
        const writer = seen.output!.target.writable.getWriter();
        await writer.write({ type: 'write', data: new Uint8Array([1, 2, 3]), position: 0 });
        await writer.write({ type: 'write', data: new Uint8Array([9]), position: 4096 });
        writer.releaseLock();
      },
    });
    await promise;
    expect(seen.written).toEqual([
      { position: 0, data: [1, 2, 3] },
      { position: 4096, data: [9] },
    ]);
  });

  it('reports progress as a fraction, clamped, and ends at the whole', async () => {
    const onProgress = vi.fn();
    const { promise } = run({ progress: [[0.25, 2.5], [1.4, 14]] }, { onProgress });
    await promise;
    expect(onProgress.mock.calls).toEqual([[0.25, 2.5], [1, 14], [1, 10]]);
  });

  it('releases the input however it ends', async () => {
    const ok = run({});
    await ok.promise;
    expect(ok.seen.inputs[0]!.disposed).toBe(true);
    const bad = run({ failWith: new Error('decoder died') });
    await bad.promise.catch(() => undefined);
    expect(bad.seen.inputs[0]!.disposed).toBe(true);
  });

  describe('the sound', () => {
    it('says so when it could not be carried over', async () => {
      const audio = { isAudioTrack: () => true, isVideoTrack: () => false };
      const { promise } = run({ discarded: [{ track: audio, reason: 'no_encodable_target_codec' }] });
      expect((await promise).notes).toEqual([
        'The sound could not be carried over, so the rendered video has none.',
      ]);
    });
    it('has nothing to say when it was carried over', async () => {
      expect((await run({}).promise).notes).toEqual([]);
    });
  });

  describe('a render that cannot run', () => {
    const video = { isAudioTrack: () => false, isVideoTrack: () => true };
    it.each([
      ['undecodable_source_codec', /cannot decode this video/],
      ['unknown_source_codec', /cannot decode this video/],
      ['no_encodable_target_codec', /no H\.264 encoder/],
      ['cannot_copy', /cannot be rendered in this browser/],
    ])('explains %s', async (reason, message) => {
      const { promise, seen } = run({ valid: false, discarded: [{ track: video, reason }] });
      await expect(promise).rejects.toMatchObject({ code: 'unsupported_browser', message: expect.stringMatching(message) });
      expect(seen.inputs[0]!.disposed).toBe(true);
    });
  });

  describe('stopping', () => {
    it('does nothing if it is already stopped', async () => {
      const controller = new AbortController();
      controller.abort();
      const { promise, seen } = run({}, { signal: controller.signal });
      await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
      expect(seen.initOptions).toBeUndefined();
      expect(seen.inputs).toEqual([]);
    });

    it('cancels the conversion when asked mid-render, and reports a stop', async () => {
      const controller = new AbortController();
      const { promise, seen } = run(
        {
          during: async (conversion) => {
            controller.abort();
            // The real conversion's execute() rejects once cancelled.
            expect(conversion.cancel).toHaveBeenCalledTimes(1);
            throw new FakeCanceled('canceled');
          },
        },
        { signal: controller.signal },
      );
      await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
      expect(seen.conversion!.cancel).toHaveBeenCalledTimes(1);
      expect(seen.inputs[0]!.disposed).toBe(true);
    });

    it('reports a stop even if the library reports it as some other failure', async () => {
      const controller = new AbortController();
      const { promise } = run(
        {
          during: async () => {
            controller.abort();
            throw new Error('writable closed');
          },
        },
        { signal: controller.signal },
      );
      await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    });
  });

  it('reports a failure of the pipeline as a failed render, keeping the cause', async () => {
    const cause = new Error('VideoDecoder error');
    const failure = (await run({ failWith: cause }).promise.catch((error: unknown) => error)) as Error & { code: string };
    expect(failure.code).toBe('render_failed');
    expect(failure.message).toBe('The video could not be rendered.');
    expect(failure.cause).toBe(cause);
  });

  it('makes no network request while it renders: the video and the frames stay in the worker', async () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', class { open = open; });
    vi.stubGlobal('WebSocket', class { constructor() { open('websocket'); } });
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    try {
      await run({ frames: [0, 1, 2], progress: [[0.5, 5]] }).promise;
    } finally {
      Reflect.deleteProperty(navigator, 'sendBeacon');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses where an offscreen canvas has no 2D context', async () => {
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return null; } });
    await expect(run({}).promise).rejects.toMatchObject({ code: 'unsupported_browser' });
  });
});
