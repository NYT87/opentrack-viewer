import { describe, expect, it } from 'vitest';
import { parseTimeOfActivity, parseUtcOffset } from './MomentEditors';

describe('the stopwatch start and the clock offset a reader types (AV-1025)', () => {
  it('reads m:ss, h:mm:ss and a plain number of seconds, and nothing else', () => {
    expect(parseTimeOfActivity('1:05')).toBe(65);
    expect(parseTimeOfActivity(' 0:00 ')).toBe(0);
    expect(parseTimeOfActivity('12:34:56')).toBe(45_296);
    expect(parseTimeOfActivity('90')).toBe(90);
    for (const bad of ['', 'a', '1:60', '1:2:3:4', '1:75', '1:60:00', '-5', '1.5', '1:']) expect(parseTimeOfActivity(bad), bad).toBeUndefined();
  });

  it('reads an offset as hours and minutes east of UTC, signed, inside the real limits', () => {
    expect(parseUtcOffset('+5:30')).toBe(330);
    expect(parseUtcOffset('-3')).toBe(-180);
    expect(parseUtcOffset('9')).toBe(540);
    expect(parseUtcOffset('−03:30')).toBe(-210);
    expect(parseUtcOffset('+14:00')).toBe(840);
    expect(parseUtcOffset('-12:00')).toBe(-720);
    for (const bad of ['', '+', '+15', '-13', '5:60', 'UTC', '1:2', '+5:300']) expect(parseUtcOffset(bad), bad).toBeUndefined();
  });
});
