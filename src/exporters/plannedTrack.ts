import type { Activity, ActivityWarning } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { draftToActivity, stretchLengths, type RouteDraft } from '../domain/routeDraft';
import { EXPORT_FORMATS, exportActivity, safeFileStem, type ExportFormat, type ExportResult } from './index';

/**
 * AV-1107. A planned track written out for a device.
 *
 * It goes through the same exporter registry as a recorded activity, by way
 * of `draftToActivity`, so there is one GPX writer, not two. What differs is
 * what a plan *is*: a sequence of places to go, not a record of having gone.
 * So it is written without timestamps, and only to a format that can say "a
 * route" without saying "a ride that happened" — which today is GPX alone
 * (TD-054):
 *
 * - **GPX**: a track of places, one segment per stretch. Devices load it as a
 *   course.
 * - **FIT** and **TCX**: the registry's writers produce *activity* files —
 *   sessions, laps and records keyed by time. A plan written that way would
 *   need invented times and would show on a watch as a finished workout.
 *   They are offered as disabled, with that reason, rather than hidden.
 */

export interface PlannedFormatAvailability {
  format: ExportFormat;
  label: string;
  available: boolean;
  /** Present only when unavailable. */
  reason?: string;
}

const NOT_A_RECORDING: Partial<Record<ExportFormat, string>> = {
  fit: 'FIT is written as a recorded activity, keyed by time; a planned track would need invented times and would show on a device as a workout already done.',
  tcx: 'TCX is written as a recorded activity, with laps and times; a planned track would need invented times and would show on a device as a workout already done.',
};

/**
 * Whether the draft is a route at all: some stretch with two points, so there
 * is a line to follow. Single points, or only stretches of one point, are not.
 */
export function hasExportableRoute(draft: RouteDraft): boolean {
  // Adjacent points, not shared numbers: `0, 1, 0` is three single points.
  return stretchLengths(writtenPoints(draft)).some((length) => length >= 2);
}

/**
 * The points the writer will keep: those with a location the map and every
 * writer accept (`hasValidLocation`). Availability, the segment count and
 * the warnings are all judged on these, so a control is never offered for a
 * file that would be written without a line, or not at all. The editor
 * refuses such places; a handed-over or older draft could still hold one.
 */
function writtenPoints(draft: RouteDraft): RouteDraft['points'] {
  return draft.points.filter((point) => toValidCoordinate(point.lat, point.lon) !== undefined);
}

export function plannedTrackFormats(draft: RouteDraft): PlannedFormatAvailability[] {
  const route = hasExportableRoute(draft);
  return EXPORT_FORMATS.map((entry) => {
    const notARecording = NOT_A_RECORDING[entry.format];
    if (notARecording) {
      return { format: entry.format, label: entry.label, available: false, reason: notARecording };
    }
    return route
      ? { format: entry.format, label: entry.label, available: true }
      : {
          format: entry.format,
          label: entry.label,
          available: false,
          reason: 'A track needs at least two joined points to be written.',
        };
  });
}

/** `planned-track` is in every name, so a download is never taken for a recording. */
export function plannedTrackFileStem(draft: RouteDraft): string {
  return `${safeFileStem(draft.name.trim(), 'route')}-planned-track`;
}

/** The draft as the activity a writer reads: places only, with no times. */
function toPlannedActivity(draft: RouteDraft): { activity: Activity; hadTimes: boolean } {
  const made = draftToActivity(draft);
  if (!made.ok) throw new ActivityError('no_route_points', made.error.message);
  const hadTimes = made.value.points.some((point) => point.time !== undefined);
  const points = made.value.points.map(({ time: _time, ...point }) => point);
  return {
    activity: {
      ...made.value,
      points,
      streams: { ...made.value.streams, hasTime: false },
      metadata: { name: draft.name },
      derived: made.value.derived
        ? { ...made.value.derived, startTime: undefined, endTime: undefined, durationSeconds: undefined, movingDurationSeconds: undefined }
        : undefined,
    },
    hadTimes,
  };
}

/** What a planned track leaves out, said beside the download (AV-1107). */
function plannedWarnings(draft: RouteDraft, hadTimes: boolean, activity: Activity): ActivityWarning[] {
  const warnings: ActivityWarning[] = [];
  if (draft.sources.length > 0) {
    warnings.push({
      code: 'planned_activity_data_omitted',
      message:
        'Only the route was written. Heart rate, cadence, power, temperature, speed, laps and the recording device are not part of a planned track, so none of them is in the file.',
      severity: 'info',
    });
  }
  warnings.push({
    code: 'planned_timestamps_omitted',
    message: hadTimes
      ? 'The times recorded along the source track were left out: a planned track says where to go, not when, and a device would otherwise read it as a ride already done.'
      : 'The file has no timestamps: a planned track says where to go, not when.',
    severity: 'info',
  });
  const kept = writtenPoints(draft);
  const left = draft.points.length - kept.length;
  if (left > 0) {
    warnings.push({
      code: 'planned_points_without_location',
      message: `${left} point${left === 1 ? '' : 's'} at 0°, 0° ${left === 1 ? 'was' : 'were'} left out: that is where devices put a point with no fix, and no file format keeps it.`,
      severity: 'warning',
    });
  }
  const stretches = stretchLengths(kept).length;
  if (stretches > 1) {
    warnings.push({
      code: 'planned_multiple_segments',
      message: `Written as ${stretches} separate track segments, one per stretch, with no line between them. Some devices show only the first segment, or join them; join the stretches in Route Builder first if it is one road.`,
      severity: 'warning',
    });
  }
  // What the draft itself noted, such as points without a location it left out.
  warnings.push(...activity.warnings);
  return warnings;
}

/**
 * Writes the planned track. Refuses, with a typed error, a format a plan
 * cannot be written to and a draft with no route — the same conditions the
 * availability above reports, so the page never offers a control that fails.
 */
export async function exportPlannedTrack(
  draft: RouteDraft,
  format: ExportFormat,
): Promise<ExportResult> {
  const availability = plannedTrackFormats(draft).find((entry) => entry.format === format);
  if (!availability?.available) {
    throw new ActivityError(
      hasExportableRoute(draft) ? 'unsupported_format' : 'no_route_points',
      availability?.reason ?? `${String(format).toUpperCase()} is not a format this build can write.`,
    );
  }
  const { activity, hadTimes } = toPlannedActivity(draft);
  const result = await exportActivity(activity, { format, baseName: plannedTrackFileStem(draft) });
  return { ...result, warnings: [...plannedWarnings(draft, hadTimes, activity), ...result.warnings] };
}
