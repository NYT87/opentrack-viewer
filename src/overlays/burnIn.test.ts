import { describe, expect, it } from 'vitest';
import { ActivityError } from '../domain/errors';
import {
  MAX_BYTES,
  MAX_DURATION_SECONDS,
  MAX_SIZE,
  bitrateFor,
  exportBurnedIn,
  pickRecorderFormat,
  planBurnIn,
  type BurnInOptions,
  type BurnInProgress,
} from './burnIn';
import { harness, play, recordedWebm, rendererFor, settle, start } from '../test/helpers/burnInHarness';

const options = (over: Partial<BurnInOptions> = {}): BurnInOptions => ({
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

// -------------------------------------------------------------------- planning

describe('planning a burned-in export (AV-1007)', () => {
  it('works out the bitrate, the length and a rough size', () => {
    const plan = planBurnIn(options({ width: 1920, height: 1080, fps: 30, endSeconds: 60 }));
    expect(plan.durationSeconds).toBe(60);
    expect(plan.videoBitsPerSecond).toBe(Math.round(1920 * 1080 * 30 * 0.09));
    // About 5.6 Mbit/s plus sound, for a minute.
    expect(plan.estimatedBytes).toBeGreaterThan(40e6);
    expect(plan.estimatedBytes).toBeLessThan(50e6);
  });

  it('asks for more for high quality, within limits', () => {
    const base = { width: 1920, height: 1080, fps: 30 } as const;
    expect(bitrateFor({ ...base, quality: 'high' })).toBeGreaterThan(bitrateFor({ ...base, quality: 'standard' }));
    expect(bitrateFor({ width: 16, height: 16, fps: 1, quality: 'standard' })).toBe(1_500_000);
    expect(bitrateFor({ width: 3840, height: 2160, fps: 60, quality: 'high' })).toBe(40_000_000);
  });

  it('leaves the sound out of the estimate when it is not wanted', () => {
    const with_ = planBurnIn(options({ includeAudio: true })).estimatedBytes;
    const without = planBurnIn(options({ includeAudio: false })).estimatedBytes;
    expect(with_).toBeGreaterThan(without);
  });

  it.each([
    ['a fractional frame rate', { fps: 29.97 }, 'invalid_selected_range', /frame rate/],
    ['a frame rate over the limit', { fps: 120 }, 'invalid_selected_range', /frame rate/],
    ['a tiny width', { width: 8 }, 'invalid_selected_range', /width/],
    ['a fractional height', { height: 100.5 }, 'invalid_selected_range', /height/],
    ['an oversize frame', { width: MAX_SIZE + 1 }, 'overlay_export_too_large', /width can be at most/],
    ['an empty range', { startSeconds: 1, endSeconds: 1 }, 'invalid_selected_range', /after its start/],
    ['a negative start', { startSeconds: -1 }, 'invalid_selected_range', /negative/],
    ['a NaN setting', { offsetSeconds: NaN }, 'invalid_selected_range', /must be a number/],
    ['too long a clip', { endSeconds: MAX_DURATION_SECONDS + 60 }, 'overlay_export_too_large', /video's own speed/],
  ] as [string, Partial<BurnInOptions>, string, RegExp][])('rejects %s, saying which setting', (_n, over, code, pattern) => {
    try {
      planBurnIn(options(over));
      throw new Error('expected an error');
    } catch (error) {
      expect(error).toBeInstanceOf(ActivityError);
      expect((error as ActivityError).code).toBe(code);
      expect((error as ActivityError).message).toMatch(pattern);
    }
  });

  it('refuses a file that would be too big to hold, naming the way out', () => {
    // 4K60 at high quality for 25 minutes is far past a gigabyte.
    expect(() => planBurnIn(options({ width: 3840, height: 2160, fps: 60, quality: 'high', endSeconds: 25 * 60 }))).toThrow(
      /Choose a shorter range, a smaller size or standard quality/,
    );
    expect(MAX_BYTES).toBe(1024 ** 3);
  });

  it('refuses a range past the end of the video', () => {
    expect(() => planBurnIn(options({ endSeconds: 12 }), 10)).toThrow(/only 10\.0 seconds long/);
    expect(() => planBurnIn(options({ endSeconds: 10.04 }), 10)).not.toThrow();
    // An unknown length is not a reason to refuse.
    expect(() => planBurnIn(options({ endSeconds: 12 }), Infinity)).not.toThrow();
  });
});

describe('choosing what to record (AV-1007)', () => {
  it('prefers VP9 in WebM, then VP8, then MP4', () => {
    const all = () => true;
    expect(pickRecorderFormat(all, true)).toMatchObject({ mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm', withAudio: true });
    expect(pickRecorderFormat((m) => !m.includes('vp9'), true)?.mimeType).toBe('video/webm;codecs=vp8,opus');
    expect(pickRecorderFormat((m) => m.startsWith('video/mp4'), true)).toMatchObject({ extension: 'mp4' });
  });

  it('asks for no audio codec when there is no audio', () => {
    expect(pickRecorderFormat(() => true, false)?.mimeType).toBe('video/webm;codecs=vp9');
  });

  it('falls back to a generic type, and to nothing', () => {
    expect(pickRecorderFormat((m) => m === 'video/webm', false)?.mimeType).toBe('video/webm');
    expect(pickRecorderFormat(() => false, true)).toBeUndefined();
  });
});

// --------------------------------------------------------------------- exporting

describe('recording the video with the overlay (AV-1007)', () => {
  it('draws the video frame, then the overlay over it, at the frame\'s own time', async () => {
    const h = harness();
    const { promise, calls } = start(h);
    await play(h, [0.5, 1.0, 1.5, 2.0]);
    await promise;

    // Per frame: the picture first, then the overlay, which must not clear it.
    expect(h.draws.slice(0, 2)).toEqual(['video', 'overlay']);
    for (let i = 0; i < h.draws.length; i += 2) expect(h.draws.slice(i, i + 2)).toEqual(['video', 'overlay']);
    expect(calls.every((c) => c.clear === false)).toBe(true);
    expect(calls.every((c) => c.w === 320 && c.h === 180)).toBe(true);
    // The overlay shows the time the picture shows, not the time the callback ran.
    expect(calls.map((c) => c.t)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it('uses the telemetry offset it was given', async () => {
    const h = harness();
    const { promise, calls } = start(h, { offsetSeconds: 3.5 });
    await play(h, [1, 2]);
    await promise;
    expect(calls.every((c) => c.offset === 3.5)).toBe(true);
  });

  it('records at the requested size and frame rate, and hands back a finished file', async () => {
    const h = harness();
    const { promise } = start(h, { fps: 24, width: 640, height: 360 });
    await play(h, [2]);
    const result = await promise;

    const recorder = h.recorders[0]!;
    expect(recorder.settings.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(recorder.settings.videoBitsPerSecond).toBe(bitrateFor({ width: 640, height: 360, fps: 24, quality: 'standard' }));
    expect(recorder.started).toBe(1000);
    expect(result).toMatchObject({ mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm', durationSeconds: 2, hasAudio: true });
    expect(result.bytes).toBe(result.blob.size);
  });

  it('writes the length into the recording, which the recorder leaves out', async () => {
    const h = harness();
    const { promise } = start(h);
    await play(h, [2]);
    const result = await promise;
    // The fixture has no duration; a Duration element (11 bytes) was added.
    expect(result.blob.size).toBe(recordedWebm.length + 11);
  });

  it('does not touch the source: it only plays it', async () => {
    const h = harness();
    const file = new Blob(['source bytes']);
    const { renderer } = rendererFor(h);
    const promise = exportBurnedIn({ file, options: options(), renderer, env: h.env });
    queueMicrotask(() => { h.video.readyState = 1; h.video.fire('loadedmetadata'); });
    await play(h, [2]);
    await promise;
    expect(await file.text()).toBe('source bytes');
  });

  describe('sound', () => {
    it('plays the video unmuted, because a muted element records silence', async () => {
      const h = harness();
      const { promise } = start(h);
      await play(h, [2]);
      await promise;
      expect(h.video.sawMutedAtPlay).toBe(false);
    });

    it('routes the sound into the recording, and gives it back when done', async () => {
      const h = harness();
      const { promise } = start(h);
      await play(h, [2]);
      const result = await promise;
      expect(h.stream.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
      expect(h.recorders[0]!.settings.audioBitsPerSecond).toBeGreaterThan(0);
      expect(result.hasAudio).toBe(true);
      expect(h.audioClosed).toBe(1);
    });

    it('records no sound when asked not to', async () => {
      const h = harness();
      const { promise } = start(h, { includeAudio: false });
      await play(h, [2]);
      const result = await promise;
      expect(h.stream.tracks.map((t) => t.kind)).toEqual(['video']);
      expect(h.recorders[0]!.settings.mimeType).toBe('video/webm;codecs=vp9');
      expect(result.hasAudio).toBe(false);
    });

    it('records no sound when the video has none', async () => {
      const h = harness({ hasAudio: false });
      const { promise } = start(h);
      await play(h, [2]);
      const result = await promise;
      expect(h.stream.tracks.map((t) => t.kind)).toEqual(['video']);
      expect(result.hasAudio).toBe(false);
    });

    it('tries for sound when the browser cannot say whether there is any', async () => {
      const h = harness({ hasAudio: undefined });
      const { promise } = start(h);
      await play(h, [2]);
      expect((await promise).hasAudio).toBe(true);
    });

    it('carries on without sound where it cannot be routed', async () => {
      const h = harness({ audioRoute: false });
      const { promise } = start(h);
      await play(h, [2]);
      const result = await promise;
      expect(result.hasAudio).toBe(false);
      expect(h.recorders[0]!.settings.mimeType).toBe('video/webm;codecs=vp9');
    });
  });

  describe('a range', () => {
    it('starts at the start of the range, and stops at its end', async () => {
      const h = harness();
      const { promise, calls } = start(h, { startSeconds: 3, endSeconds: 5 });
      await settle(h, 0);
      // Seeking to the start: the video moves, and says so.
      await new Promise((r) => setTimeout(r, 0));
      expect(h.video.currentTime).toBe(3);
      h.video.fire('seeked');
      await settle(h);
      for (const t of [3.5, 4, 4.5, 5]) {
        h.video.tick(t);
        await new Promise((r) => setTimeout(r, 0));
      }
      const result = await promise;
      expect(result.durationSeconds).toBe(2);
      // The first frame it drew was the start of the range.
      expect(calls[0]!.t).toBe(3);
      expect(Math.max(...calls.map((c) => c.t))).toBeLessThanOrEqual(5);
      expect(h.video.paused).toBe(true);
    });

    it('stops when the video ends, even short of the requested end', async () => {
      const h = harness();
      const { promise } = start(h, { endSeconds: 2 });
      await play(h, [0.5, 1]);
      h.video.currentTime = 1.2;
      h.video.ended = true;
      h.video.fire('ended');
      await expect(promise).resolves.toMatchObject({ extension: 'webm' });
    });

    it('refuses a range longer than the video before recording anything', async () => {
      const h = harness();
      h.video.duration = 5;
      const { promise } = start(h, { endSeconds: 9 });
      await expect(promise).rejects.toMatchObject({ code: 'invalid_selected_range' });
      expect(h.recorders).toHaveLength(0);
      expect(h.revoked).toEqual(['blob:fake/1']);
    });
  });

  it('reports how far it has got, and how long is left', async () => {
    const h = harness();
    const seen: BurnInProgress[] = [];
    const { promise } = start(h, { endSeconds: 4 }, { onProgress: (p) => seen.push(p) });
    h.clock.now = 1000;
    await play(h, [1]);
    h.clock.now = 2500;
    await play(h, [2.5]);
    await play(h, [4]);
    await promise;

    const mid = seen.find((p) => Math.abs(p.recordedSeconds - 2.5) < 1e-9)!;
    expect(mid).toMatchObject({ durationSeconds: 4, paused: false });
    expect(mid.remainingMs).toBeCloseTo(1500, 5);
    expect(seen.at(-1)).toMatchObject({ recordedSeconds: 4, remainingMs: 0 });
  });

  describe('stopping', () => {
    it('stops when asked, saves nothing, and puts everything back', async () => {
      const h = harness();
      const controller = new AbortController();
      const { promise } = start(h, {}, { signal: controller.signal });
      await play(h, [0.5]);
      controller.abort();
      h.video.tick(0.6);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_cancelled' });

      expect(h.recorders[0]!.state).toBe('inactive');
      expect(h.video.paused).toBe(true);
      expect(h.video.src).toBe('');
      expect(h.revoked).toEqual(['blob:fake/1']);
      expect(h.stream.tracks.every((t) => t.stopped || t.kind === 'audio')).toBe(true);
      expect(h.audioClosed).toBe(1);
      expect(h.hidden.listeners).toHaveLength(0);
    });

    it('does nothing at all when already stopped', async () => {
      const h = harness();
      const controller = new AbortController();
      controller.abort();
      const { promise } = start(h, {}, { signal: controller.signal });
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_cancelled' });
      expect(h.revoked).toEqual([]);
      expect(h.recorders).toHaveLength(0);
    });

    it('can be stopped while still loading', async () => {
      const h = harness();
      const controller = new AbortController();
      const { renderer } = rendererFor(h);
      const promise = exportBurnedIn({ file: new Blob(['v']), options: options(), renderer, env: h.env, signal: controller.signal });
      promise.catch(() => undefined);
      controller.abort();
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_cancelled' });
      expect(h.revoked).toEqual(['blob:fake/1']);
    });
  });

  describe('a tab that is not visible', () => {
    it('waits instead of recording frames the browser would drop, and carries on when it is back', async () => {
      const h = harness();
      const seen: BurnInProgress[] = [];
      const { promise, calls } = start(h, {}, { onProgress: (p) => seen.push(p) });
      await play(h, [0.5]);
      const drawn = calls.length;

      h.setHidden(true);
      expect(h.video.paused).toBe(true);
      expect(h.recorders[0]!.state).toBe('paused');
      expect(seen.at(-1)!.paused).toBe(true);
      // Frames that arrive while hidden are not drawn.
      h.video.tick(0.6);
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.length).toBe(drawn);

      h.setHidden(false);
      expect(h.recorders[0]!.state).toBe('recording');
      expect(h.video.plays).toBeGreaterThanOrEqual(2);
      await play(h, [1, 2]);
      await expect(promise).resolves.toBeDefined();
      expect(seen.some((p) => p.paused)).toBe(true);
    });
  });

  describe('failing clearly', () => {
    it('says so when the browser cannot record at all', async () => {
      const h = harness({ supported: false });
      const { promise } = start(h);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_unsupported', message: expect.stringMatching(/cannot record video/) });
      expect(h.revoked).toEqual([]);
    });

    it('says so when it can record no format it can save, and cleans up', async () => {
      const h = harness({ mimes: [] });
      const { promise } = start(h);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_unsupported', message: expect.stringMatching(/format it can save/) });
      expect(h.revoked).toEqual(['blob:fake/1']);
      expect(h.audioClosed).toBe(1);
    });

    it('says so when the browser cannot play the video', async () => {
      const h = harness();
      const { renderer } = rendererFor(h);
      const promise = exportBurnedIn({ file: new Blob(['v']), options: options(), renderer, env: h.env });
      promise.catch(() => undefined);
      queueMicrotask(() => h.video.fire('error'));
      await expect(promise).rejects.toMatchObject({
        code: 'overlay_export_unsupported',
        message: expect.stringMatching(/cannot play that video.*do not decode/),
      });
      expect(h.revoked).toEqual(['blob:fake/1']);
    });

    it('says so when the video cannot be started', async () => {
      const h = harness();
      h.video.playRejects = true;
      const { promise } = start(h);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_failed', message: expect.stringMatching(/could not be started/) });
      expect(h.recorders[0]!.state).toBe('inactive');
    });

    it('says so when the video breaks partway through', async () => {
      const h = harness();
      const { promise } = start(h);
      await play(h, [0.5]);
      h.video.fire('error');
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_failed', message: expect.stringMatching(/all the way through/) });
      expect(h.video.src).toBe('');
    });

    it('gives up on a video that stops advancing', async () => {
      const h = harness();
      const { promise } = start(h);
      await play(h, [0.5]);
      h.clock.now += 9_000;
      // The same picture again, long after it should have moved on.
      h.video.tick(0.5);
      await new Promise((r) => setTimeout(r, 0));
      h.video.tick(0.5);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_failed', message: expect.stringMatching(/stopped advancing/) });
    });

    it('stops a recording that grows past the limit', async () => {
      const h = harness();
      const { promise } = start(h);
      await play(h, [0.5]);
      h.recorders[0]!.emit({ size: MAX_BYTES + 1 });
      h.video.tick(0.6);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_too_large' });
    });

    it('reports an empty recording', async () => {
      const h = harness();
      const { promise } = start(h);
      await settle(h);
      h.recorders[0]!.output = [];
      h.video.tick(2);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_failed', message: expect.stringMatching(/came out empty/) });
    });

    it('keeps the cause of an unexpected failure', async () => {
      const h = harness();
      const boom = new Error('canvas exploded');
      h.env.createCanvas = () => {
        throw boom;
      };
      const { promise } = start(h);
      await expect(promise).rejects.toMatchObject({ code: 'overlay_export_failed', cause: boom });
      expect(h.revoked).toEqual(['blob:fake/1']);
    });

    it('rejects unusable options before touching the browser', async () => {
      const h = harness();
      const { promise } = start(h, { fps: 0 });
      await expect(promise).rejects.toMatchObject({ code: 'invalid_selected_range' });
      expect(h.recorders).toHaveLength(0);
    });
  });
});
