import { formatClockTime, type DateZone } from './dateFormat';

/**
 * AV-1025 (TD-094). The settings of the two live figures that are not read from the activity's
 * points but from the moment: a stopwatch counts from a moment, and a clock writes the wall-clock
 * time. Both live on the component, parsed by name, so a layout made before them opens unchanged.
 */

/** `stopwatch`. Where it starts, in seconds on the activity's clock; absent is the cut's start, else the activity's. */
export interface OverlayStopwatchSetting {
  startSeconds?: number;
}

/** The latest a stopwatch's start may be set: a week into the activity's clock. */
export const STOPWATCH_START_MAX_SECONDS = 86_400 * 7;

export type ClockZoneChoice = 'reader' | 'utc' | 'offset';
export const CLOCK_ZONE_CHOICES: readonly ClockZoneChoice[] = ['reader', 'utc', 'offset'];

/** `clock`. A file carries UTC only: the zone is the reader's, UTC, or an offset the reader enters. */
export interface OverlayClockSetting {
  zone: ClockZoneChoice;
  /** `zone: 'offset'` only: minutes east of UTC. */
  offsetMinutes?: number;
  hour12: boolean;
  seconds: boolean;
  date: boolean;
}

export const DEFAULT_CLOCK: OverlayClockSetting = { zone: 'reader', hour12: false, seconds: true, date: false };

/** Real offsets run from UTC-12:00 to UTC+14:00. */
export const CLOCK_OFFSET_LIMITS = { min: -12 * 60, max: 14 * 60 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A stopwatch's setting as it may be used; `undefined` when there is none to keep (the default). */
export function parseStopwatchSetting(raw: unknown): OverlayStopwatchSetting | undefined {
  if (!isRecord(raw) || !isNumber(raw.startSeconds)) return undefined;
  return { startSeconds: Math.min(STOPWATCH_START_MAX_SECONDS, Math.max(0, raw.startSeconds)) };
}

/** A clock's setting as it may be drawn: members that do not read take their defaults. Nothing here throws. */
export function parseClockSetting(raw: unknown): OverlayClockSetting {
  const record = isRecord(raw) ? raw : {};
  const zone = CLOCK_ZONE_CHOICES.includes(record.zone as ClockZoneChoice) ? (record.zone as ClockZoneChoice) : DEFAULT_CLOCK.zone;
  const clock: OverlayClockSetting = {
    zone,
    hour12: record.hour12 === true,
    seconds: record.seconds !== false,
    date: record.date === true,
  };
  if (zone === 'offset') {
    const minutes = isNumber(record.offsetMinutes) ? Math.round(record.offsetMinutes) : 0;
    clock.offsetMinutes = Math.min(CLOCK_OFFSET_LIMITS.max, Math.max(CLOCK_OFFSET_LIMITS.min, minutes));
  }
  return clock;
}

/** Where a clock reads: the reader's zone, UTC, or the offset entered. */
export function clockZoneOf(setting: OverlayClockSetting, readerTimeZone?: string): DateZone {
  if (setting.zone === 'utc') return { kind: 'offset', minutes: 0 };
  if (setting.zone === 'offset') return { kind: 'offset', minutes: setting.offsetMinutes ?? 0 };
  return { kind: 'zone', timeZone: readerTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC' };
}

/** The clock's text for a moment given in seconds since 1970 (UTC), the way the timeline carries it. */
export function formatClock(epochSeconds: number, setting: OverlayClockSetting = DEFAULT_CLOCK, readerTimeZone?: string): string {
  return formatClockTime(new Date(epochSeconds * 1000), clockZoneOf(setting, readerTimeZone), setting);
}

/**
 * The seconds a stopwatch reads: from the start the reader set (seconds on the activity's clock), or else
 * the timeline's own (the cut's start, else the activity's); 0 before the start, never negative.
 */
export function stopwatchSeconds(setting: OverlayStopwatchSetting | undefined, activityElapsedSeconds: number, timelineValue: number | undefined): number | undefined {
  if (setting?.startSeconds !== undefined) return Math.max(0, activityElapsedSeconds - setting.startSeconds);
  return timelineValue;
}

/** A stopwatch reads whole seconds that have passed, never rounded up: 0:59.9 is still 0:59. */
export function formatStopwatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds + 1e-9));
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}
