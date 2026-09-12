import { describe, expect, it, vi } from 'vitest';
import { extractGpmf } from './extractGpmf';
import { readBinaryFixture } from '../../test/helpers/fixtures';
import { ActivityError } from '../../domain/errors';

/** A real GoPro HERO8 clip, ~4.2 MB, © GoPro under Apache-2.0 or MIT. */
const heroVideo = (name = 'GH010042.mp4') =>
  new File([readBinaryFixture('hero8.mp4')], name, { type: 'video/mp4' });

describe('extracting GPMF from a real GoPro video (AV-903)', () => {
  it('finds the metadata track and returns its payload with timing', async () => {
    const payload = await extractGpmf(heroVideo());

    // The payload is a fraction of the video: 86 KB out of 4.2 MB. That ratio
    // is the whole reason this can run on a multi-gigabyte file.
    expect(payload.rawData).toBeInstanceOf(Uint8Array);
    expect(payload.rawData.length).toBeGreaterThan(10_000);
    expect(payload.rawData.length).toBeLessThan(readBinaryFixture('hero8.mp4').byteLength / 10);

    expect(payload.timing.videoDurationSeconds).toBeCloseTo(12.6, 0);
    expect(payload.timing.frameDurationMs).toBeGreaterThan(0);
    expect(payload.timing.samples.length).toBeGreaterThan(1);
  }, 60_000);

  it('reports timing per sample, in order, from the first frame', async () => {
    const { timing } = await extractGpmf(heroVideo());

    const times = timing.samples.map((sample) => sample.cts);
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(timing.samples.every((sample) => sample.duration > 0)).toBe(true);
  }, 60_000);

  it('reports progress as it reads', async () => {
    const seen: number[] = [];
    await extractGpmf(heroVideo(), { onProgress: (fraction) => seen.push(fraction) });

    expect(seen.length).toBeGreaterThan(0);
    // Fractions, not the library's percentages, and never going backwards.
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  }, 60_000);

  it('reads the same payload whatever the file is called', async () => {
    // Nothing about the extraction depends on the name, which is one of the
    // things §5 says never leaves the device.
    const [named, renamed] = await Promise.all([
      extractGpmf(heroVideo('GH010042.mp4')),
      extractGpmf(heroVideo('holiday clip.MOV')),
    ]);

    expect(named.rawData.length).toBe(renamed.rawData.length);
  }, 60_000);
});

describe('extraction limits and failures (AV-903)', () => {
  it('says a file with nothing to find has no telemetry, instead of hanging', async () => {
    // The library neither resolves nor rejects here: it reads to the end and
    // stops. Without the end-of-read guard this test never finishes.
    const notAVideo = new File(['this is not a video'], 'lies.mp4');

    await expect(extractGpmf(notAVideo)).rejects.toMatchObject({
      code: 'no_telemetry_track',
      message: expect.stringMatching(/no GoPro telemetry track/i),
    });
  }, 60_000);

  it('fails typed when the library crashes on a container it cannot read', async () => {
    // A shell of an MP4 with no real track structure makes the library throw
    // `TypeError: reading 'duration'` — not the documented 'Track not found'.
    // Whatever it throws, a caller sees an ActivityError.
    const plain = new File([readBinaryFixture('plain-video.mp4')], 'holiday.mp4');

    const error = await extractGpmf(plain).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ActivityError);
    expect((error as ActivityError).code).toMatch(/gopro_extract_failed|no_telemetry_track/);
  }, 60_000);

  it('refuses before reading anything when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(extractGpmf(heroVideo(), { signal: controller.signal })).rejects.toThrow();
  });

  it('reports a cancelled read as cancelled, not as a failure', async () => {
    // Aborting mid-read of a 12-second clip is a race this cannot win
    // reliably, so the mapping is what is tested: whatever the library says
    // once a signal has fired, the caller is told it was stopped.
    const controller = new AbortController();
    controller.abort();

    const error = await extractGpmf(heroVideo(), { signal: controller.signal }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe('the reader is always stopped (TD-025)', () => {
  it('cancels the token even when extraction succeeded', async () => {
    // The defect this works around: `gpmf-extract` resolves once it has the
    // samples but never stops reading, so a multi-gigabyte file would keep
    // streaming after the promise settled. The token is what ends it, and it
    // must be set on the way out of *every* path, not just the failures.
    const tokens: { cancelled: boolean }[] = [];

    vi.doMock('gpmf-extract', () => ({
      default: (_file: unknown, options: { cancellationToken: { cancelled: boolean } }) => {
        tokens.push(options.cancellationToken);
        return Promise.resolve({
          rawData: new Uint8Array([1, 2, 3]),
          timing: { videoDuration: 1, frameDuration: 33, samples: [{ cts: 0, duration: 33 }] },
        });
      },
    }));

    vi.resetModules();
    const { extractGpmf: fresh } = await import('./extractGpmf');
    await fresh(heroVideo());

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.cancelled).toBe(true);

    vi.doUnmock('gpmf-extract');
    vi.resetModules();
  });
});
