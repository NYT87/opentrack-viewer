import type { Activity, ActivityWarning } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { EXPORT_FORMATS, exportActivity, safeFileStem, type ExportFormat, type ExportResult } from './index';

/**
 * AV-1109 (TD-060). A merged recording written out. It goes through the same
 * exporter registry as any activity, so there is one writer per format; what
 * this adds is which formats can carry the pause between the files:
 *
 * - **GPX**: one track, one segment per recorded stretch. A pause is the gap
 *   between two segments, which is how GPX has always said it.
 * - **FIT**: the timer is stopped at the end of each stretch and started at
 *   the next, so the pause counts in elapsed time and not in timer time.
 *   Unless two stretches meet within one second, which FIT cannot tell apart
 *   (`hasStretchesTouchingInFit`).
 * - **TCX**: the writer puts the whole activity in one lap, whose total time
 *   is the elapsed time, so a long pause would read as riding time. Offered
 *   as unavailable, with that reason, rather than written wrong.
 */

export interface MergedFormatAvailability {
  format: ExportFormat;
  label: string;
  available: boolean;
  /** Present only when unavailable. */
  reason?: string;
}

const CANNOT_CARRY_PAUSE: Partial<Record<ExportFormat, string>> = {
  tcx: 'TCX is written as one lap whose time is the elapsed time, so the pause between the files would count as time spent riding.',
};

const TOUCHING_IN_FIT =
  'FIT keeps time to the whole second, and here one recording ends in the same second the next begins: the file could not say which of the two the points of that second belong to, and reading it back would count the climb and distance between them. GPX keeps the two apart.';

/**
 * Whether any recorded stretch ends in the same whole second the next one
 * begins. FIT stores time in whole seconds and a reader assigns a record to a
 * stretch by its time (the records and the timer events are separate lists
 * once decoded), so at such a boundary the stretches cannot be told apart in
 * the file. A merge allows it (a file that starts the second the last one
 * ends is a zero-length pause), so FIT is refused for it rather than written
 * into a file that reads back with different totals (TD-060).
 */
export function hasStretchesTouchingInFit(activity: Activity): boolean {
  let previous: { second: number; segment: number } | undefined;
  for (const point of activity.points) {
    if (!(point.time instanceof Date) || Number.isNaN(point.time.getTime())) continue;
    // As the FIT writer floors it.
    const second = Math.floor(point.time.getTime() / 1000);
    const segment = point.segmentIndex ?? 0;
    if (previous && segment !== previous.segment && second <= previous.second) return true;
    previous = { second, segment };
  }
  return false;
}

export function mergedTrackFormats(activity: Activity): MergedFormatAvailability[] {
  const touching = hasStretchesTouchingInFit(activity);
  return EXPORT_FORMATS.map((entry) => {
    const pauseReason =
      CANNOT_CARRY_PAUSE[entry.format] ?? (entry.format === 'fit' && touching ? TOUCHING_IN_FIT : undefined);
    if (pauseReason) return { format: entry.format, label: entry.label, available: false, reason: pauseReason };
    return entry.requires(activity)
      ? { format: entry.format, label: entry.label, available: true }
      : { format: entry.format, label: entry.label, available: false, reason: entry.unavailableReason };
  });
}

/** `merged` is in every name, so the download is never taken for one of the originals. */
export function mergedTrackFileStem(activity: Activity): string {
  const name = (activity.metadata.name ?? '').replace(/\s*\(merged\)\s*$/, '').trim();
  return `${safeFileStem(name, 'activity')}-merged`;
}

/**
 * Writes the merged activity. Refuses, with a typed error, a format that
 * cannot carry the pause or this activity at all: the same conditions the
 * availability reports, so the page never offers a control that fails.
 */
export async function exportMergedTrack(activity: Activity, format: ExportFormat): Promise<ExportResult> {
  const availability = mergedTrackFormats(activity).find((entry) => entry.format === format);
  if (!availability?.available) {
    throw new ActivityError(
      'unsupported_format',
      availability?.reason ?? `${String(format).toUpperCase()} is not a format this build can write.`,
    );
  }
  const result = await exportActivity(activity, { format, baseName: mergedTrackFileStem(activity) });
  const pauses = (activity.events ?? []).filter((event) => event.type === 'pause').length;
  const written: ActivityWarning = {
    code: 'merged_pauses_kept',
    message:
      format === 'fit'
        ? `Written as one activity. The timer stops at the end of each file and starts again at the next, so the ${pauses === 1 ? 'pause' : `${pauses} pauses`} count in elapsed time and not in timer time.`
        : `Written as one track with a segment per recorded stretch. The ${pauses === 1 ? 'pause' : `${pauses} pauses`} between the files ${pauses === 1 ? 'is' : 'are'} the gaps between segments: nothing is drawn or counted across ${pauses === 1 ? 'it' : 'them'}.`,
    severity: 'info',
  };
  return { ...result, warnings: [written, ...result.warnings] };
}
