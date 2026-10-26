import { describe, expect, it, vi } from 'vitest';
import { OverlayExportError } from './errors';
import { MAX_LAG_MS, recordWebm, startWebmExport, type RecorderLike, type WebmRecordingDeps } from './recordWebm';
import type { OverlayContext2D } from './drawOverlay';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';

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
