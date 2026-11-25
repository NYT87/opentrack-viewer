import { describe, expect, it } from 'vitest';
import { BURN_MAX_BITRATE, BURN_MIN_BITRATE, burnBitrate, planBurn } from './burnPlan';

describe('burned-in render plan (AV-1007)', () => {
  it('scales the bitrate with the picture and the frame rate, within limits', () => {
    expect(burnBitrate(1920, 1080, 30)).toBeCloseTo(7_464_960, -3);
    expect(burnBitrate(3840, 2160, 30)).toBeCloseTo(burnBitrate(1920, 1080, 30) * 4, -4);
    expect(burnBitrate(1920, 1080, 60)).toBeGreaterThan(burnBitrate(1920, 1080, 30));
    expect(burnBitrate(160, 90, 30)).toBe(BURN_MIN_BITRATE);
    expect(burnBitrate(7680, 4320, 60)).toBe(BURN_MAX_BITRATE);
    expect(burnBitrate(1920, 1080)).toBe(burnBitrate(1920, 1080, 30));
  });

  it('estimates the size from the bitrate and the length, with sound if there is any', () => {
    const silent = planBurn({ videoDurationSeconds: 100, width: 1920, height: 1080, frameRate: 30, hasAudio: false });
    expect(silent.estimatedBytes).toBe(Math.round((100 * silent.bitrate) / 8));
    const loud = planBurn({ videoDurationSeconds: 100, width: 1920, height: 1080, frameRate: 30, hasAudio: true });
    expect(loud.estimatedBytes).toBeGreaterThan(silent.estimatedBytes);
  });

  it('renders small pictures far faster than real time and 4K only a little faster', () => {
    const at = (width: number, height: number) =>
      planBurn({ videoDurationSeconds: 600, width, height, hasAudio: false });
    expect(at(848, 480).realtimeMultiple).toBe(10); // measured 10.6× (TD-039)
    expect(at(1920, 1080).realtimeMultiple).toBeCloseTo(4.5);
    expect(at(3840, 2160).realtimeMultiple).toBe(1.2); // TD-039: 1.2–1.7×
    expect(at(3840, 2160).estimatedSeconds).toBeCloseTo(500);
    expect(at(1920, 1080).estimatedSeconds).toBeLessThan(at(3840, 2160).estimatedSeconds);
  });

  it('flags a picture beyond what the encoders are trusted with', () => {
    expect(planBurn({ videoDurationSeconds: 1, width: 3840, height: 2160, hasAudio: false }).tooLarge).toBe(false);
    expect(planBurn({ videoDurationSeconds: 1, width: 4096, height: 2160, hasAudio: false }).tooLarge).toBe(false);
    expect(planBurn({ videoDurationSeconds: 1, width: 7680, height: 4320, hasAudio: false }).tooLarge).toBe(true);
  });

  it('holds both sides to a bound, not just the pixel count', () => {
    const tooLarge = (width: number, height: number) =>
      planBurn({ videoDurationSeconds: 1, width, height, hasAudio: false }).tooLarge;
    // Wide and tall strips that fit the pixel budget but not the encoders.
    expect(tooLarge(5000, 1000)).toBe(true);
    expect(tooLarge(1000, 5000)).toBe(true);
    expect(tooLarge(8192, 100)).toBe(true);
    // The boundary itself is allowed, and one step past it is not.
    expect(tooLarge(4096, 2160)).toBe(false);
    expect(tooLarge(4098, 2160)).toBe(true);
    expect(tooLarge(3000, 2304)).toBe(false);
    expect(tooLarge(3000, 2306)).toBe(true);
    // A portrait 4K phone video is as welcome as a landscape one.
    expect(tooLarge(2160, 3840)).toBe(false);
    expect(tooLarge(3840, 2160)).toBe(false);
  });

  it('copes with no length yet', () => {
    const plan = planBurn({ videoDurationSeconds: 0, width: 640, height: 360, hasAudio: true });
    expect(plan.estimatedBytes).toBe(0);
    expect(plan.estimatedSeconds).toBe(0);
  });
});
