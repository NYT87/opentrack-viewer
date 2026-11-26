import type { Activity } from '../domain/activity';
import { isJoinedRecording } from '../domain/mergeTracks';

export function hasStretchesTouchingInFit(activity: Activity): boolean {
  let previous: { second: number; segment: number } | undefined;
  for (const point of activity.points) {
    if (!(point.time instanceof Date) || !Number.isFinite(point.time.getTime())) continue;
    const second = Math.floor(point.time.getTime() / 1000);
    const segment = point.segmentIndex ?? 0;
    if (previous && segment !== previous.segment && second <= previous.second) return true;
    previous = { second, segment };
  }
  return false;
}

/**
 * FIT counts unsigned 32-bit seconds from 1989-12-31T00:00:00Z, and reads any count under 0x10000000
 * (July 1998) as seconds since the device powered on, not a date: such a time cannot be written as one.
 */
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);
const FIT_FIRST_DATE_MS = FIT_EPOCH_MS + 0x10000000 * 1000;
const FIT_LAST_MS = FIT_EPOCH_MS + 0xffffffff * 1000;

export function hasTimeOutsideFit(activity: Activity): boolean {
  const times = [
    ...activity.points.map((point) => point.time),
    ...(activity.laps ?? []).flatMap((lap) => [lap.startTime, lap.endTime]),
  ];
  return times.some((time) => time instanceof Date && (time.getTime() < FIT_FIRST_DATE_MS || time.getTime() >= FIT_LAST_MS));
}

/** Shared by availability and serializers; a page handoff must not weaken it. */
export function exportPreservationProblem(activity: Activity, format: 'gpx' | 'fit' | 'tcx'): string | undefined {
  if (format === 'fit' && hasStretchesTouchingInFit(activity)) {
    return 'FIT keeps time to the whole second, and here one recording ends in the same second the next begins: the file could not keep those stretches apart. GPX keeps the two apart.';
  }
  if (format === 'fit' && hasTimeOutsideFit(activity)) {
    return 'FIT can write times only from July 1998 to 2126, and this activity has one outside them, often from a device clock that had not yet set itself from GPS. GPX and TCX can write it.';
  }
  if (format === 'tcx' && isJoinedRecording(activity) &&
      new Set(activity.points.map((point) => point.segmentIndex ?? 0)).size > 1) {
    return 'TCX is written as one lap whose time is the elapsed time, so the pause between the files would count as time spent riding.';
  }
  return undefined;
}
