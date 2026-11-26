import type { ActivityPoint } from '../domain/activity';

/**
 * XML text escaping. Applied to every value that reaches the document, without
 * exception: an activity name is user-controlled text that arrived from a file,
 * and an unescaped `&` alone is enough to produce a document this app cannot
 * read back. The control characters XML 1.0 forbids outright are dropped, as no
 * escape can carry them (a FIT name's raw bytes, a file name).
 */
export function escapeXml(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const decimal = (value: number, places: number) => Number(value.toFixed(places)).toString();

/**
 * A time written in the activity's own UTC offset, so the file reads back with
 * the zone it was opened with (`utcOffsetFromIsoTime`). Without one it stays in
 * `Z`, which states no zone.
 */
export function isoTime(date: Date, offsetMinutes: number | undefined): string {
  if (offsetMinutes === undefined || !Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 14 * 60) {
    return date.toISOString();
  }
  const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, -1);
  const minutes = Math.abs(offsetMinutes);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${local}${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The reading every other distance in the exported file is measured from. */
export function firstDistance(points: ActivityPoint[]): number {
  for (const point of points) {
    if (typeof point.distanceMeters === 'number' && Number.isFinite(point.distanceMeters)) return point.distanceMeters;
  }
  return 0;
}

/** Consecutive points sharing a `segmentIndex`: one recorded stretch each. */
export function groupBySegment<T extends ActivityPoint>(points: T[]): T[][] {
  const segments: T[][] = [];
  let current = -1;
  for (const point of points) {
    const segment = point.segmentIndex ?? 0;
    if (segment !== current || segments.length === 0) {
      segments.push([]);
      current = segment;
    }
    segments.at(-1)!.push(point);
  }
  return segments;
}
