import { describe, expect, it } from 'vitest';
import {
  EXPORT_FRAME_RATES,
  exportDimensions,
  formatBytes,
  frameVideoTime,
  highestFittingFrameRate,
  planExport,
  planWebmExport,
  WEBM_MAX_BYTES,
  webmBitsPerSecond,
} from './plan';

describe('export plan (AV-1006)', () => {
  it('sizes the picture from the aspect, in even numbers', () => {
    expect(exportDimensions(16 / 9, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(exportDimensions(848 / 480, 480)).toEqual({ width: 848, height: 480 });
    expect(exportDimensions(1, 721)).toEqual({ width: 722, height: 722 });
    expect(exportDimensions(9 / 16, 1920)).toEqual({ width: 1080, height: 1920 });
    // A video that reported nothing sensible still gets a picture.
    expect(exportDimensions(Number.NaN, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('counts frames to cover the whole video, and reports the duration they make', () => {
    const plan = planExport({ videoDurationSeconds: 13, fps: 2, width: 848, height: 480 });
    expect(plan.frameCount).toBe(26);
    expect(plan.durationSeconds).toBe(13);
    // Not a whole number of frames: round up, never cut the end off.
    const odd = planExport({ videoDurationSeconds: 10.04, fps: 30, width: 1920, height: 1080 });
    expect(odd.frameCount).toBe(302);
    expect(odd.durationSeconds).toBeCloseTo(302 / 30);
    // Float noise does not add a frame: 0.1 * 30 is 3.0000000000000004.
    expect(planExport({ videoDurationSeconds: 0.1, fps: 30, width: 2, height: 2 }).frameCount).toBe(3);
  });

  it('always plans at least one frame', () => {
    expect(planExport({ videoDurationSeconds: 0, fps: 30, width: 100, height: 100 }).frameCount).toBe(1);
  });

  it('puts each frame at its own video time', () => {
    expect(frameVideoTime(0, 25)).toBe(0);
    expect(frameVideoTime(50, 25)).toBe(2);
  });

  it('puts a floor under the estimate for a small frame, as measured (TD-059)', () => {
    // 180 frames at 256 × 144 came to 781 KB; by area alone it would say 400 KB.
    const small = planExport({ videoDurationSeconds: 6, fps: 30, width: 256, height: 144 });
    expect(small.estimatedBytes).toBe(180 * 4_500);
    expect(Math.abs(small.estimatedBytes - 781_000) / 781_000).toBeLessThan(0.1);
  });

  it('scales the size estimate with the picture area', () => {
    const hd = planExport({ videoDurationSeconds: 10, fps: 30, width: 1920, height: 1080 });
    const uhd = planExport({ videoDurationSeconds: 10, fps: 30, width: 3840, height: 2160 });
    expect(hd.estimatedBytes).toBe(300 * 125_000);
    expect(uhd.estimatedBytes).toBe(hd.estimatedBytes * 4);
    expect(uhd.estimatedSeconds).toBeGreaterThan(hd.estimatedSeconds);
  });

  it('says when a plain ZIP cannot hold it, by size or by file count', () => {
    const fine = planExport({ videoDurationSeconds: 60, fps: 30, width: 1920, height: 1080 });
    expect(fine.fitsArchive).toBe(true);
    // 4K, 30 minutes at 60 fps: far beyond 4 GB.
    const tooBig = planExport({ videoDurationSeconds: 1800, fps: 60, width: 3840, height: 2160 });
    expect(tooBig.fitsArchive).toBe(false);
    // Small frames, but more of them than the format counts.
    const tooMany = planExport({ videoDurationSeconds: 2000, fps: 60, width: 64, height: 64 });
    expect(tooMany.estimatedBytes).toBeLessThan(4e9);
    expect(tooMany.fitsArchive).toBe(false);
  });

  it('checks against the limit it is given: less than the format\'s own where storage is smaller', () => {
    const input = { videoDurationSeconds: 600, fps: 30, width: 1920, height: 1080 };
    expect(planExport(input).fitsArchive).toBe(true);
    const inMemory = planExport({ ...input, limitBytes: 1_000_000_000 });
    expect(inMemory.fitsArchive).toBe(false);
    expect(inMemory.limitBytes).toBe(1_000_000_000);
    const lower = highestFittingFrameRate({ ...input, limitBytes: 1_000_000_000 })!;
    expect(lower).toBeLessThan(highestFittingFrameRate(input)!);
    expect(planExport({ ...input, fps: lower, limitBytes: 1_000_000_000 }).fitsArchive).toBe(true);
  });

  it('finds the highest frame rate that fits, or none', () => {
    const input = { videoDurationSeconds: 600, width: 3840, height: 2160 };
    const best = highestFittingFrameRate(input)!;
    expect(EXPORT_FRAME_RATES).toContain(best);
    expect(planExport({ ...input, fps: best }).fitsArchive).toBe(true);
    const next = EXPORT_FRAME_RATES.find((rate) => rate > best);
    if (next) expect(planExport({ ...input, fps: next }).fitsArchive).toBe(false);
    expect(highestFittingFrameRate({ videoDurationSeconds: 100_000, width: 3840, height: 2160 })).toBeUndefined();
  });

  it('formats sizes plainly', () => {
    expect(formatBytes(500)).toBe('1 KB');
    expect(formatBytes(64_000_000)).toBe('64 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });
});

describe('frame rates as an editor names them (TD-059)', () => {
  it('writes whole rates as they are and the NTSC fractions by their names', async () => {
    const { formatFrameRate, EXPORT_FRAME_RATES } = await import('./plan');
    expect(formatFrameRate(30)).toBe('30');
    expect(formatFrameRate(30000 / 1001)).toBe('29.97');
    expect(formatFrameRate(60000 / 1001)).toBe('59.94');
    expect(formatFrameRate(24000 / 1001)).toBe('23.976');
    expect(EXPORT_FRAME_RATES).toContain(30000 / 1001);
  });
});

describe('planning a transparent WebM (AV-1012)', () => {
  it('asks for 8 Mbit/s at 1080p, scaled with the area and held between 1 and 24', () => {
    expect(webmBitsPerSecond(1920, 1080)).toBe(8_000_000);
    expect(webmBitsPerSecond(1280, 720)).toBe(3_555_556);
    expect(webmBitsPerSecond(256, 144)).toBe(1_000_000);
    expect(webmBitsPerSecond(7680, 4320)).toBe(24_000_000);
  });

  it('takes as long as the overlay, and is at most its bitrate over that length', () => {
    const plan = planWebmExport({ videoDurationSeconds: 10, fps: 30, width: 1920, height: 1080 });
    expect(plan).toMatchObject({ frameCount: 300, durationSeconds: 10, estimatedSeconds: 10, estimatedBytes: 10_000_000, fits: true });
  });

  it('refuses a recording a tab could not hold', () => {
    const hour = planWebmExport({ videoDurationSeconds: 3600, fps: 30, width: 3840, height: 2160 });
    expect(hour.estimatedBytes).toBeGreaterThan(WEBM_MAX_BYTES);
    expect(hour.fits).toBe(false);
  });
});
