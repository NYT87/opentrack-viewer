import type { Activity, ActivityWarning } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { getExportAvailability, exportActivity, safeFileStem, type ExportFormat, type ExportResult } from './index';

/**
 * AV-1109 (TD-060). A merged recording written out. It goes through the same
 * exporter registry as any activity, so there is one writer per format; what
 * this adds is which formats can carry the pause between the files:
 *
 * - **GPX**: one track, one segment per recorded stretch. A pause is the gap
 *   between two segments, which is how GPX has always said it.
 * - **FIT**: the source activities end laps, while the timer is stopped at
 *   the end of each stretch and started at the next. The pause counts in
 *   elapsed time and not in timer time.
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

export { hasStretchesTouchingInFit } from './preservation';

export function mergedTrackFormats(activity: Activity): MergedFormatAvailability[] {
  return getExportAvailability(activity);
}

/**
 * `merged` is in the name of a file made of several, so the download is never
 * taken for one of the originals. One recording on its own keeps its name.
 */
export function mergedTrackFileStem(activity: Activity): string {
  const name = (activity.metadata.name ?? '').replace(/\s*\(merged\)\s*$/, '').trim();
  const joined = (activity.events ?? []).some((event) => event.type === 'pause');
  return joined ? `${safeFileStem(name, 'activity')}-merged` : safeFileStem(name, 'activity');
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
        ? `Written as one activity with ${activity.laps?.length ?? 0} laps. The timer stops at the end of each file and starts again at the next, so the ${pauses === 1 ? 'pause' : `${pauses} pauses`} count in elapsed time and not in timer time.`
        : `Written as one track with a segment per recorded stretch. The ${pauses === 1 ? 'pause' : `${pauses} pauses`} between the files ${pauses === 1 ? 'is' : 'are'} the gaps between segments: nothing is drawn or counted across ${pauses === 1 ? 'it' : 'them'} here, but GPX has no timer, so Garmin Connect and Strava read ${pauses === 1 ? 'it' : 'them'} as standing still and average the speed over ${pauses === 1 ? 'it' : 'them'}. Upload the FIT instead.`,
    severity: 'info',
  };
  return { ...result, warnings: [written, ...result.warnings] };
}
