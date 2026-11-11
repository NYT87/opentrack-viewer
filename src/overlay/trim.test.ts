import { describe, expect, it } from 'vitest';
import { MIN_TRIM_SECONDS, trimRange, withTrimEnd, withTrimStart } from './trim';

describe('the part of the video exported (TD-081)', () => {
  it('is the whole video with no trim', () => {
    expect(trimRange(undefined, 120)).toEqual({ start: 0, end: 120, length: 120, trimmed: false });
  });

  it('is held inside the video, and never shorter than the least kept', () => {
    expect(trimRange({ startSeconds: 30, endSeconds: 90 }, 120)).toEqual({ start: 30, end: 90, length: 60, trimmed: true });
    // A trim set on a longer video, read against a shorter one.
    expect(trimRange({ startSeconds: 200, endSeconds: 300 }, 120)).toMatchObject({ start: 120 - MIN_TRIM_SECONDS, end: 120 });
    expect(trimRange({ startSeconds: -5 }, 120)).toMatchObject({ start: 0, trimmed: false });
    expect(trimRange(undefined, 0)).toEqual({ start: 0, end: 0, length: 0, trimmed: false });
  });

  it('moves one end at a time, never past the other', () => {
    const start = withTrimStart(undefined, 40, 120);
    expect(start).toEqual({ startSeconds: 40 });
    const both = withTrimEnd(start, 100, 120);
    expect(both).toEqual({ startSeconds: 40, endSeconds: 100 });
    expect(withTrimStart(both, 150, 120)).toEqual({ startSeconds: 100 - MIN_TRIM_SECONDS, endSeconds: 100 });
    expect(withTrimEnd(both, 10, 120)).toEqual({ startSeconds: 40, endSeconds: 40 + MIN_TRIM_SECONDS });
  });

  it('forgets a trim that cuts nothing', () => {
    expect(withTrimStart({ startSeconds: 40 }, 0, 120)).toBeUndefined();
    expect(withTrimEnd({ startSeconds: 0, endSeconds: 100 }, 130, 120)).toBeUndefined();
    expect(withTrimEnd({ startSeconds: 10, endSeconds: 100 }, 120, 120)).toEqual({ startSeconds: 10 });
  });
});
