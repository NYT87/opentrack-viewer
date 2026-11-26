import { describe, expect, it } from 'vitest';
import { effectiveWarp, overallFactor } from './videoSpeed';
import type { VideoTimeWarp } from './timeline';

const camera: VideoTimeWarp = { kind: 'map', video: [0, 10, 20], real: [0, 10, 110] };

describe('the video speed in effect (AV-1027)', () => {
  it('defaults to the camera’s timing where there is one, else real time', () => {
    expect(effectiveWarp({ warp: camera }, undefined)).toBe(camera);
    expect(effectiveWarp({}, undefined)).toBeUndefined();
    expect(effectiveWarp(undefined, undefined)).toBeUndefined();
  });

  it('takes the reader’s choice over the default', () => {
    expect(effectiveWarp({ warp: camera }, { mode: 'factor', factor: 1 })).toBeUndefined();
    expect(effectiveWarp({ warp: camera }, { mode: 'factor', factor: 6 })).toEqual({ kind: 'factor', factor: 6 });
    expect(effectiveWarp({ warp: camera }, { mode: 'camera' })).toBe(camera);
    expect(effectiveWarp({}, { mode: 'camera' })).toBeUndefined();
  });

  it('ignores a factor that is not a positive number', () => {
    expect(effectiveWarp({}, { mode: 'factor', factor: Number.NaN })).toBeUndefined();
    expect(effectiveWarp({}, { mode: 'factor', factor: -3 })).toBeUndefined();
  });

  it('tells the overall factor of each warp', () => {
    expect(overallFactor(undefined)).toBe(1);
    expect(overallFactor({ kind: 'factor', factor: 7 })).toBe(7);
    expect(overallFactor(camera)).toBe(5.5);
  });
});
