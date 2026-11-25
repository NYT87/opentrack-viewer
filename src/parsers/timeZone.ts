/**
 * AV-1010. The UTC offset an ISO 8601 time states, in minutes east of UTC:
 * `2026-09-24T08:55:51+09:00` is 540. A time in `Z` says only that it is
 * written in UTC, not where it was recorded, so it gives none; nor does a time
 * with no zone at all. A file's own offset is what "the activity's time zone"
 * means on a still image; it is never guessed from the coordinates.
 */
export function utcOffsetFromIsoTime(text: string | null | undefined): number | undefined {
  const match = /T[\d:.]+([+-])(\d{2}):?(\d{2})$/.exec(text?.trim() ?? '');
  if (!match) return undefined;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  // Real offsets run from −12:00 to +14:00.
  if (minutes > 14 * 60) return undefined;
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * The offset a FIT file states: its activity message's local time less its
 * UTC time, to the nearest quarter hour (every real offset is one). Absent when
 * the device wrote no local time.
 */
export function utcOffsetFromLocalTimestamp(utc: unknown, local: unknown): number | undefined {
  if (!(utc instanceof Date) || !(local instanceof Date)) return undefined;
  const minutes = Math.round((local.getTime() - utc.getTime()) / 60_000 / 15) * 15;
  return Number.isFinite(minutes) && Math.abs(minutes) <= 14 * 60 ? minutes : undefined;
}
