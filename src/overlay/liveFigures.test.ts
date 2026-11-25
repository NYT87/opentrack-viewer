import { describe, expect, it } from 'vitest';
import { formatClockTime } from './dateFormat';
import { CLOCK_OFFSET_LIMITS, DEFAULT_CLOCK, STOPWATCH_START_MAX_SECONDS, clockZoneOf, formatClock, formatStopwatch, parseClockSetting, parseStopwatchSetting, stopwatchSeconds } from './liveFigures';
import { formatVerticalSpeed } from '../domain/units';

/** 2026-09-24 08:05:09 UTC, a Thursday. */
const MOMENT = Date.UTC(2026, 8, 24, 8, 5, 9) / 1000;
/** 2026-09-24 23:59:59 UTC. */
const LATE = Date.UTC(2026, 8, 24, 23, 59, 59) / 1000;
/** 2026-09-24 00:00:00 UTC. */
const MIDNIGHT = Date.UTC(2026, 8, 24, 0, 0, 0) / 1000;
const NOON = Date.UTC(2026, 8, 24, 12, 30, 0) / 1000;

describe('the clock (AV-1025)', () => {
  it('writes the time in UTC, 24-hour with seconds by default format', () => {
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'utc' })).toBe('08:05:09');
    expect(formatClock(LATE, { ...DEFAULT_CLOCK, zone: 'utc' })).toBe('23:59:59');
    expect(formatClock(MIDNIGHT, { ...DEFAULT_CLOCK, zone: 'utc' })).toBe('00:00:00');
  });

  it('writes the same moment in two time zones, the reader’s named zone and an offset typed in', () => {
    expect(formatClock(MOMENT, DEFAULT_CLOCK, 'America/New_York')).toBe('04:05:09');
    expect(formatClock(MOMENT, DEFAULT_CLOCK, 'Asia/Tokyo')).toBe('17:05:09');
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'offset', offsetMinutes: 330 })).toBe('13:35:09');
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'offset', offsetMinutes: -210 })).toBe('04:35:09');
    // The reader's zone is the one the page says, and UTC and an offset are never the reader's.
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'utc' }, 'Asia/Tokyo')).toBe('08:05:09');
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'offset', offsetMinutes: 60 }, 'Asia/Tokyo')).toBe('09:05:09');
  });

  it('writes 12-hour time with AM and PM, noon and midnight as 12, and drops the seconds on request', () => {
    const twelve = { ...DEFAULT_CLOCK, zone: 'utc' as const, hour12: true };
    expect(formatClock(MOMENT, twelve)).toBe('8:05:09 AM');
    expect(formatClock(NOON, twelve)).toBe('12:30:00 PM');
    expect(formatClock(MIDNIGHT, twelve)).toBe('12:00:00 AM');
    expect(formatClock(LATE, twelve)).toBe('11:59:59 PM');
    expect(formatClock(MOMENT, { ...twelve, seconds: false })).toBe('8:05 AM');
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'utc', seconds: false })).toBe('08:05');
  });

  it('adds the date as the still image writes it, in the zone the time is in', () => {
    expect(formatClock(MOMENT, { ...DEFAULT_CLOCK, zone: 'utc', date: true })).toBe('24 Sep 2026, 08:05:09');
    // Eight hours east, the date has moved on while the clock has not yet reached midnight at UTC.
    expect(formatClock(LATE, { ...DEFAULT_CLOCK, zone: 'offset', offsetMinutes: 480, date: true })).toBe('25 Sep 2026, 07:59:59');
    expect(formatClock(MIDNIGHT, { ...DEFAULT_CLOCK, zone: 'offset', offsetMinutes: -60, date: true, hour12: true, seconds: false })).toBe('23 Sep 2026, 11:00 PM');
  });

  it('is deterministic: the zone is named or an offset, never the locale', () => {
    const date = new Date(MOMENT * 1000);
    expect(formatClockTime(date, { kind: 'offset', minutes: 0 }, { hour12: false, seconds: true, date: false })).toBe('08:05:09');
    expect(clockZoneOf({ ...DEFAULT_CLOCK, zone: 'reader' }, 'Europe/Paris')).toEqual({ kind: 'zone', timeZone: 'Europe/Paris' });
    expect(clockZoneOf({ ...DEFAULT_CLOCK, zone: 'utc' })).toEqual({ kind: 'offset', minutes: 0 });
  });

  it('reads a setting as it may be drawn: defaults where it does not read, an offset only where the zone is one', () => {
    expect(parseClockSetting(undefined)).toEqual(DEFAULT_CLOCK);
    expect(parseClockSetting('x')).toEqual(DEFAULT_CLOCK);
    expect(parseClockSetting({ zone: 'mars', hour12: 'yes', seconds: 0 })).toEqual({ ...DEFAULT_CLOCK, hour12: false, seconds: true });
    expect(parseClockSetting({ zone: 'utc', offsetMinutes: 60, hour12: true, seconds: false, date: true })).toEqual({ zone: 'utc', hour12: true, seconds: false, date: true });
    expect(parseClockSetting({ zone: 'offset', offsetMinutes: 90.4 })).toMatchObject({ zone: 'offset', offsetMinutes: 90 });
    expect(parseClockSetting({ zone: 'offset' })).toMatchObject({ offsetMinutes: 0 });
    expect(parseClockSetting({ zone: 'offset', offsetMinutes: 99_999 }).offsetMinutes).toBe(CLOCK_OFFSET_LIMITS.max);
    expect(parseClockSetting({ zone: 'offset', offsetMinutes: -99_999 }).offsetMinutes).toBe(CLOCK_OFFSET_LIMITS.min);
    expect(parseClockSetting({ zone: 'offset', offsetMinutes: Number.NaN }).offsetMinutes).toBe(0);
  });
});

describe('the stopwatch (AV-1025)', () => {
  it('counts from the start the reader set on the activity’s clock, 0 before it, and from the timeline’s own where it set none', () => {
    expect(stopwatchSeconds({ startSeconds: 30 }, 75, 999)).toBe(45);
    expect(stopwatchSeconds({ startSeconds: 30 }, 30, 999)).toBe(0);
    expect(stopwatchSeconds({ startSeconds: 30 }, 12, 999)).toBe(0);
    expect(stopwatchSeconds(undefined, 75, 40)).toBe(40);
    expect(stopwatchSeconds({}, 75, 40)).toBe(40);
    expect(stopwatchSeconds(undefined, 75, undefined)).toBeUndefined();
  });

  it('writes whole seconds that have passed, never rounded up, with hours only from an hour', () => {
    expect(formatStopwatch(0)).toBe('0:00');
    expect(formatStopwatch(59.9)).toBe('0:59');
    expect(formatStopwatch(60)).toBe('1:00');
    expect(formatStopwatch(3599.99)).toBe('59:59');
    expect(formatStopwatch(3600)).toBe('1:00:00');
    expect(formatStopwatch(3725)).toBe('1:02:05');
    expect(formatStopwatch(-3)).toBe('0:00');
  });

  it('keeps a start in range, and none for what does not read, so a layout without one opens unchanged', () => {
    expect(parseStopwatchSetting({ startSeconds: 90 })).toEqual({ startSeconds: 90 });
    expect(parseStopwatchSetting({ startSeconds: -5 })).toEqual({ startSeconds: 0 });
    expect(parseStopwatchSetting({ startSeconds: 1e12 })).toEqual({ startSeconds: STOPWATCH_START_MAX_SECONDS });
    for (const bad of [undefined, null, {}, { startSeconds: 'x' }, { startSeconds: Number.NaN }, [], 4]) expect(parseStopwatchSetting(bad)).toBeUndefined();
  });
});

describe('the rate of ascent as written (AV-1025)', () => {
  it('is metres or feet a minute, signed, with no sign on nothing', () => {
    expect(formatVerticalSpeed(0.3)).toBe('+18 m/min');
    expect(formatVerticalSpeed(-0.1)).toBe('-6 m/min');
    expect(formatVerticalSpeed(0)).toBe('0 m/min');
    expect(formatVerticalSpeed(-0.001)).toBe('0 m/min');
    expect(formatVerticalSpeed(0.3, 'imperial')).toBe('+59 ft/min');
    expect(formatVerticalSpeed(0.3, 'metric', 1)).toBe('+18.0 m/min');
    expect(formatVerticalSpeed(Number.NaN)).toBe('—');
  });
});
