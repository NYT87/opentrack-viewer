import { describe, expect, it, vi } from 'vitest';
import { OverlayExportError } from './errors';
import { MAX_LAG_MS, recordWebm, startWebmExport, type RecorderLike, type WebmRecordingDeps } from './recordWebm';
import type { OverlayContext2D } from './drawOverlay';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';
import { canvasTemplate, newZonesComponent } from '../customCanvas';

/**
 * AV-1012. The recording loop with a clock, a canvas and a recorder that are
 * not the browser's: what is drawn, when, and what happens when the page
 * cannot keep up.
 */

/** A recorder that keeps what it is handed, and a clock the waits move. */
function fakes(options: { hiddenAfter?: number; stallAt?: { frame: number; ms: number }; onDataBytes?: number } = {}) {
  let clock = 0;
  const frames: { at: number; videoTime: number }[] = [];
  const requested: number[] = [];
  const events: string[] = [];
  let lastVideoTime = Number.NaN;

  const recorder: RecorderLike = {
    state: 'inactive',
    start(timeslice) {
      events.push(`start ${timeslice}`);
      (this as { state: string }).state = 'recording';
    },
    stop() {
      events.push('stop');
      (this as { state: string }).state = 'inactive';
      if (options.onDataBytes !== 0) this.ondataavailable?.({ data: new Blob([new Uint8Array(options.onDataBytes ?? 10)]) });
      queueMicrotask(() => this.onstop?.());
    },
    ondataavailable: null,
    onstop: null,
    onerror: null,
  };
  const release = vi.fn();
  const trackStop = vi.fn();

  const deps: WebmRecordingDeps = {
    setUp: (width, height, bitsPerSecond) => {
      events.push(`setUp ${width}x${height} ${bitsPerSecond}`);
      return {
        ctx: {} as OverlayContext2D,
        track: {
          requestFrame: () => {
            requested.push(clock);
            frames.push({ at: clock, videoTime: lastVideoTime });
            if (options.stallAt && frames.length === options.stallAt.frame) clock += options.stallAt.ms;
          },
          stop: trackStop,
        },
        recorder,
        release,
      };
    },
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    isHidden: () => options.hiddenAfter !== undefined && frames.length >= options.hiddenAfter,
  };
  const drawFrame = (_ctx: OverlayContext2D, videoTime: number) => {
    lastVideoTime = videoTime;
  };
  return { deps, drawFrame, frames, requested, events, release, trackStop, clock: () => clock };
}

describe('recording the overlay in real time (AV-1012)', () => {
  it('draws each frame on the clock, one every 1/fps, and lets the last last a frame', async () => {
    const fake = fakes();
    const progress: number[] = [];
    await recordWebm({
      frameCount: 5,
      fps: 10,
      width: 1920,
      height: 1080,
      drawFrame: fake.drawFrame,
      onProgress: (done) => progress.push(done),
      deps: fake.deps,
    });

    expect(fake.frames).toEqual([0, 100, 200, 300, 400].map((at, i) => ({ at, videoTime: i / 10 })));
    // The recorder is stopped a frame after the last was drawn.
    expect(fake.clock()).toBe(500);
    expect(progress).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fake.events).toEqual(['setUp 1920x1080 8000000', 'start 1000', 'stop']);
    expect(fake.trackStop).toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalled();
  });

  it('gives the recording its length', async () => {
    const fake = fakes();
    const result = await recordWebm({ frameCount: 2, fps: 30, width: 2, height: 2, drawFrame: fake.drawFrame, deps: fake.deps });
    // The fake recorder hands back bytes that are not a WebM: the file is kept, and the reason said.
    expect(result.file.size).toBe(10);
    expect(result.problem).toBe('This is not a WebM file.');
  });

  it('stops when the tab is hidden, where timers slow and frames would be stamped late', async () => {
    const fake = fakes({ hiddenAfter: 3 });
    await expect(
      recordWebm({ frameCount: 10, fps: 10, width: 2, height: 2, drawFrame: fake.drawFrame, deps: fake.deps }),
    ).rejects.toThrow(/this tab was hidden/);
    expect(fake.frames).toHaveLength(3);
    expect(fake.events.at(-1)).toBe('stop');
    expect(fake.release).toHaveBeenCalled();
  });

  it(`stops when it falls more than ${MAX_LAG_MS} ms behind, and not for a shorter hitch`, async () => {
    const hitch = fakes({ stallAt: { frame: 2, ms: MAX_LAG_MS - 100 } });
    await recordWebm({ frameCount: 20, fps: 10, width: 2, height: 2, drawFrame: hitch.drawFrame, deps: hitch.deps });
    // The frames after a hitch go back to their own times; only the ones inside it are late.
    expect(hitch.frames.at(-1)!.at).toBe(1900);

    const behind = fakes({ stallAt: { frame: 2, ms: MAX_LAG_MS + 200 } });
    await expect(
      recordWebm({ frameCount: 20, fps: 10, width: 2, height: 2, drawFrame: behind.drawFrame, deps: behind.deps }),
    ).rejects.toThrow(/fell behind/);
  });

  it('stops on request, keeping nothing', async () => {
    const fake = fakes();
    const controller = new AbortController();
    const recording = recordWebm({
      frameCount: 10,
      fps: 10,
      width: 2,
      height: 2,
      drawFrame: fake.drawFrame,
      signal: controller.signal,
      onProgress: (done) => done === 4 && controller.abort(),
      deps: fake.deps,
    });
    await expect(recording).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.frames).toHaveLength(4);
    expect(fake.events.at(-1)).toBe('stop');
  });

  it('says a frame that cannot be drawn, by number', async () => {
    const fake = fakes();
    let drawn = 0;
    const failing = () => {
      drawn += 1;
      if (drawn === 3) throw new Error('boom');
    };
    await expect(
      recordWebm({ frameCount: 5, fps: 10, width: 2, height: 2, drawFrame: failing, deps: fake.deps }),
    ).rejects.toThrow('Frame 3 of 5 could not be drawn.');
  });

  it('refuses a recording that came back empty', async () => {
    const fake = fakes({ onDataBytes: 0 });
    await expect(
      recordWebm({ frameCount: 2, fps: 10, width: 2, height: 2, drawFrame: fake.drawFrame, deps: fake.deps }),
    ).rejects.toThrow('The browser recorded nothing.');
  });
});

describe('a WebM export job (AV-1012)', () => {
  const activity = makeActivity(
    Array.from({ length: 11 }, (_, i) => ({
      time: new Date(Date.UTC(2024, 0, 1, 10, 0, i)),
      lat: 10 + i * 0.001,
      lon: 20 + i * 0.001,
      distanceMeters: i * 10,
      speedMetersPerSecond: i,
    })),
  );
  const template = buildOverlay(DEFAULT_OVERLAY_CONTROLS, buildOverlayTimeline(activity, { video: { durationSeconds: 1 } }), 16 / 9).template;
  const request = {
    width: 32,
    height: 18,
    fps: 10,
    frameCount: 3,
    videoDurationSeconds: 0.3,
    offsetSeconds: 0,
    units: 'metric' as const,
    template,
    activity,
  };

  it('hands back the recording with a note when its length could not be written', async () => {
    const fake = fakes();
    const ctx = { clearRect: vi.fn() } as unknown as OverlayContext2D;
    const deps: WebmRecordingDeps = { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) };
    // The renderer draws on a context this fake does not fully provide; the clear is enough to see it ran.
    const job = startWebmExport({ ...request, template: { ...template, components: [] } }, () => undefined, deps);
    const output = await job.done;
    expect(output).toMatchObject({ bytes: 10, frameCount: 3 });
    expect(output.notes?.[0]).toMatch(/length could not be written into it/);
    expect(ctx.clearRect).toHaveBeenCalledTimes(3);
  });

  it('rejects as cancelled when stopped', async () => {
    const fake = fakes();
    const job = startWebmExport({ ...request, template: { ...template, components: [] } }, () => undefined, {
      ...fake.deps,
      setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx: { clearRect: () => undefined } as unknown as OverlayContext2D }),
    });
    job.cancel();
    await expect(job.done).rejects.toBeInstanceOf(OverlayExportError);
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('zones in the transparent video (AV-1018)', () => {
  it('draws them with the reader’s figure that came with the request, and not without it', async () => {
    const rider = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: new Date(i * 100), distanceMeters: i, heartRateBpm: 100 + 10 * i })));
    const zones = newZonesComponent(canvasTemplate([]), 'heartRate', { width: 32, height: 18 });
    const base = {
      width: 32,
      height: 18,
      fps: 10,
      frameCount: 2,
      videoDurationSeconds: 1,
      offsetSeconds: 0,
      units: 'metric' as const,
      template: canvasTemplate([zones]),
      activity: rider,
    };
    const texts = async (personal?: { maxHeartRate: number }) => {
      const written: string[] = [];
      const ctx = new Proxy({} as Record<string, unknown>, {
        get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => void (key === 'fillText' && written.push(String(args[0])))),
        set: (target, key: string, value) => ((target[key] = value), true),
      }) as unknown as OverlayContext2D;
      const fake = fakes();
      const job = startWebmExport({ ...base, ...(personal ? { personal } : {}) }, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) });
      await job.done;
      return written;
    };
    expect((await texts({ maxHeartRate: 200 })).slice(0, 2)).toEqual(['Z1 Recovery', '100 bpm']);
    expect(await texts()).toEqual([]);
  });
});

describe('a map in a route inset, in the transparent video (AV-1023, TD-092)', () => {
  const ride = makeActivity(
    Array.from({ length: 11 }, (_, i) => ({ time: new Date(i * 1000), lat: 46 + i * 0.0005, lon: 7, distanceMeters: i * 55 })),
  );
  const mapTemplate = canvasTemplate([
    {
      id: 'route',
      type: 'routeInset',
      visible: true,
      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      unitMode: 'auto',
      style: {},
      routeInset: { view: 'follow', zoom: 15, orientation: 'north', shape: 'square', border: { width: 0, color: '#ffffff' }, trail: 'all', ahead: 'shown', lineWidth: 0.03, map: { provider: 'openfreemap', style: 'liberty' } },
    },
  ]);
  const base = { width: 64, height: 36, fps: 10, frameCount: 3, videoDurationSeconds: 10, offsetSeconds: 0, units: 'metric' as const, template: mapTemplate, activity: ride };
  const recordingContext = () => {
    const calls: string[] = [];
    const ctx = new Proxy({ measureText: () => ({ width: 10 }) } as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => void (key === 'drawImage' && calls.push(`drawImage:${String(args[1])},${String(args[2])}`))),
      set: (target, key: string, value) => ((target[key] = value), true),
    }) as unknown as OverlayContext2D;
    return { ctx, calls };
  };

  it('loads every tile of the plan before the clock starts, then draws each frame from the maps, closing each picture', async () => {
    const fake = fakes();
    const { ctx, calls } = recordingContext();
    const order: string[] = [];
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const session = {
      warm: vi.fn(async (times: Iterable<number>) => void order.push(`warm ${[...times].length}`)),
      bitmapsAt: vi.fn(async (seconds: number) => (order.push(`bitmap ${seconds}`), { route: bitmap })),
      close: vi.fn(),
    };
    const deps: WebmRecordingDeps = { ...fake.deps, setUp: (...args) => (order.push('setUp'), { ...fake.deps.setUp(...args), ctx }) };
    const job = startWebmExport({ ...base, trimStartSeconds: 4 }, () => undefined, deps, { createInsets: () => session });
    await job.done;
    // Warmed before the recording began, over the plan's three frames, from the trim's start.
    expect(order.slice(0, 2)).toEqual(['warm 3', 'setUp']);
    expect(session.warm.mock.calls[0]![0]).toEqual([4, 4.1, 4.2]);
    expect(session.bitmapsAt.mock.calls.map((call) => call[0])).toEqual([4, 4.1, 4.2]);
    expect(calls).toHaveLength(3);
    expect((bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(3);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('records a template with no map with no maps and no warming', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    const create = vi.fn();
    const job = startWebmExport({ ...base, template: canvasTemplate([]) }, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, { createInsets: create });
    await job.done;
    expect(create).not.toHaveBeenCalled();
  });

  it('stops with the reason, and ends the maps, when a tile cannot be had', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    const session = {
      warm: vi.fn(async () => {
        throw new OverlayExportError('render_failed', 'A map tile could not be loaded after 3 tries.');
      }),
      bitmapsAt: vi.fn(),
      close: vi.fn(),
    };
    const job = startWebmExport(base, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, { createInsets: () => session });
    await expect(job.done).rejects.toMatchObject({ message: expect.stringContaining('tile could not be loaded') });
    expect(session.close).toHaveBeenCalledTimes(1);
    // Nothing was recorded: it never started.
    expect(fake.events).not.toContain('start 1000');
  });

  it('keeps the rule that a frame more than a second behind stops the recording, when a map holds it up', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    const session = {
      warm: vi.fn(async () => undefined),
      bitmapsAt: vi.fn(async () => {
        // A tile not in memory: the map takes longer than the clock allows.
        fake.deps.wait(MAX_LAG_MS + 500);
        return {};
      }),
      close: vi.fn(),
    };
    const job = startWebmExport({ ...base, frameCount: 5 }, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, { createInsets: () => session });
    await expect(job.done).rejects.toThrow(/fell behind/);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('ends as stopped, not as a frame that could not be drawn, when Stop is pressed while a frame waits on its map', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    const session = {
      warm: vi.fn(async () => undefined),
      bitmapsAt: vi.fn(async () => {
        throw new OverlayExportError('cancelled', 'The export was stopped.');
      }),
      close: vi.fn(),
    };
    const job = startWebmExport(base, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, { createInsets: () => session });
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled', message: 'The export was stopped.' });
  });

  it('keeps a map’s own reason when a tile cannot be had during a frame', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    const session = {
      warm: vi.fn(async () => undefined),
      bitmapsAt: vi.fn(async () => {
        throw new OverlayExportError('render_failed', 'A map tile could not be loaded after 3 tries (503).');
      }),
      close: vi.fn(),
    };
    const job = startWebmExport(base, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, { createInsets: () => session });
    await expect(job.done).rejects.toMatchObject({ code: 'render_failed', message: 'A map tile could not be loaded after 3 tries (503).' });
  });

  it('reports why a map waits and how the pre-load goes', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    let given: Parameters<NonNullable<Parameters<typeof startWebmExport>[3]>['createInsets'] & {}>[0] | undefined;
    const session = {
      warm: vi.fn(async (_times: Iterable<number>, onProgress?: (done: number, total: number) => void) => void onProgress?.(3, 3)),
      bitmapsAt: vi.fn(async () => ({})),
      close: vi.fn(),
    };
    const onLoading = vi.fn();
    const onWaiting = vi.fn();
    const job = startWebmExport(base, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, {
      createInsets: (input) => ((given = input), session),
      onLoading,
      onWaiting,
    });
    await job.done;
    expect(onLoading).toHaveBeenCalledWith(3, 3);
    expect(given!.onWaiting).toBe(onWaiting);
  });

  it('stops the maps when the recording is stopped', async () => {
    const fake = fakes();
    const { ctx } = recordingContext();
    const session = { warm: vi.fn(async () => undefined), bitmapsAt: vi.fn(async () => ({})), close: vi.fn() };
    let signal: AbortSignal | undefined;
    const job = startWebmExport(base, () => undefined, { ...fake.deps, setUp: (...args) => ({ ...fake.deps.setUp(...args), ctx }) }, {
      createInsets: (input) => ((signal = input.signal), session),
    });
    job.cancel();
    expect(signal?.aborted).toBe(true);
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
