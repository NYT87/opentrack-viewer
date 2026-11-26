import type { DateFormatId } from './template';

/**
 * AV-1010 (TD-061), AV-1025 (TD-094). How a date and a clock time are written: the same in every
 * browser, in a named zone or at a fixed offset. The still image's date and the live clock share it.
 */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Where a date is read: an offset the file states, or a named time zone. */
export type DateZone = { kind: 'offset'; minutes: number } | { kind: 'zone'; timeZone: string };

interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The calendar date and clock time of an instant in a zone. */
function civil(date: Date, zone: DateZone): CivilTime {
  if (zone.kind === 'offset') {
    const shifted = new Date(date.getTime() + zone.minutes * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute'), second: read('second') };
}

/**
 * AV-1032 (TD-104). A BCP 47 tag the browser can write dates in, as typed, or undefined for anything
 * else (a made-up tag, an empty string, a tag Intl rejects).
 */
export function supportedLocale(tag: string): string | undefined {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0 ? tag : undefined;
  } catch {
    return undefined;
  }
}

const isEnglish = (locale: string | undefined) => locale === undefined || /^en(-|$)/i.test(locale);

/**
 * The month's name beside its day (so a language that declines it writes it so), and the weekday's. Where
 * the name beside a day is only a number (ja, zh, ko write 3 and 月 apart), the month alone is used.
 */
function localNames(locale: string, year: number, month: number, day: number) {
  const at = new Date(Date.UTC(year, month - 1, day));
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC', calendar: 'gregory' });
  const monthName = (style: 'short' | 'long') => {
    const beside = format({ day: 'numeric', month: style }).formatToParts(at).find((entry) => entry.type === 'month')?.value;
    return beside && !/\p{N}/u.test(beside) ? beside : format({ month: style }).format(at);
  };
  return {
    short: monthName('short'),
    long: monthName('long'),
    weekday: format({ weekday: 'long' }).formatToParts(at).find((entry) => entry.type === 'weekday')?.value ?? '',
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A date as one of the four formats, written the same in every browser: the
 * month and weekday names are this module's, not the locale's (unless a locale is asked for), so `24 Sep 2026`
 * does not become `24 Sept 2026` where a locale prefers it. A time is 24-hour.
 */
export function formatStillDate(
  date: Date,
  format: DateFormatId,
  withTime: boolean,
  zone: DateZone,
  /** AV-1032 (TD-104). Names the month and the day in this language; absent or English is the tables above. */
  locale?: string,
): string {
  const { year, month, day, hour, minute } = civil(date, zone);
  const time = `${pad(hour)}:${pad(minute)}`;
  const names = isEnglish(locale) ? undefined : localNames(locale!, year, month, day);
  const weekday = names?.weekday ?? WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  const monthShort = names?.short ?? MONTHS_SHORT[month - 1];
  const monthLong = names?.long ?? MONTHS_LONG[month - 1];
  switch (format) {
    case 'iso':
      return `${year}-${pad(month)}-${pad(day)}${withTime ? ` ${time}` : ''}`;
    case 'medium':
      return `${day} ${monthShort} ${year}${withTime ? `, ${time}` : ''}`;
    case 'numeric':
      return `${pad(day)}/${pad(month)}/${year}${withTime ? ` ${time}` : ''}`;
    case 'long':
      return `${weekday} ${day} ${monthLong} ${year}${withTime ? `, ${time}` : ''}`;
  }
}

/** `UTC+09:00`, `UTC−03:30`, `UTC`. */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '−' : '+';
  const total = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}


/** What a live clock shows: 24-hour or 12-hour, with seconds or without, with the date or without. */
export interface ClockFormat {
  hour12: boolean;
  seconds: boolean;
  date: boolean;
}

/**
 * AV-1025 (TD-094). The wall-clock time of an instant in a zone: "14:03:07", or "2:03 PM", and with the date
 * "24 Sep 2026, 14:03:07". Never the locale's: the digits and the "AM" and "PM" are this module's, so a test
 * and every browser write the same.
 */
export function formatClockTime(date: Date, zone: DateZone, format: ClockFormat): string {
  const { hour, minute, second } = civil(date, zone);
  const clock = format.hour12 ? `${hour % 12 === 0 ? 12 : hour % 12}` : pad(hour);
  const time = `${clock}:${pad(minute)}${format.seconds ? `:${pad(second)}` : ''}${format.hour12 ? (hour < 12 ? ' AM' : ' PM') : ''}`;
  return format.date ? `${formatStillDate(date, 'medium', false, zone)}, ${time}` : time;
}
