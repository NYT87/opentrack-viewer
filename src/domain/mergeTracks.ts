import {
  computeStreams,
  hasValidLocation,
  type Activity,
  type ActivityEvent,
  type ActivityLap,
  type ActivityPoint,
  type ActivityWarning,
} from './activity';
import { computeDistance, computeStats, haversineMeters, withDerivedStats } from './stats';

/**
 * AV-1109 (TD-060). Several recorded track files made into one timed activity,
 * as if one device had recorded the whole day and been paused in between.
 *
 * The rules, each a decision rather than a default:
 *
 * - **Order is the files' own clocks**, oldest first, whatever order they were
 *   chosen in and whatever they are called. A file with no timestamps cannot
 *   be placed by its clock, so it is refused with that reason rather than put
 *   somewhere by guess.
 * - **Overlap is refused.** Two recordings that both claim the same minutes
 *   cannot both be the ride; interleaving them would draw a zigzag between two
 *   devices, and trimming one would silently drop a stretch the reader may
 *   want. The reader is told which files overlap and by how much.
 * - **The gap between files is a pause.** It counts in elapsed time and in
 *   nothing else: each file keeps its own segments, so no distance, climb or
 *   line is counted across the jump and no point is invented in it.
 * - **Totals are the sum of the parts.** Each file's distance is worked out
 *   the way the viewer works it out for that file alone, and the next file's
 *   continues from where it ended, so the merged distance stream never jumps.
 */

/** Why a file cannot be part of a merge at all. */
export interface MergeRefusal {
  code: 'merge_no_timestamps';
  message: string;
}

/** Whether a file can take part, judged before anything is merged. */
export function assessMergeSource(activity: Activity): MergeRefusal | undefined {
  if (activity.points.some(hasTime)) return undefined;
  return {
    code: 'merge_no_timestamps',
    message:
      'It has no timestamps, so there is no telling when it was recorded or where it falls among the others. A merge is ordered by the files’ own clocks, not by guess.',
  };
}

export interface MergeSource {
  fileName: string;
  activity: Activity;
}

/** One file as it sits in the merge, with its totals worked out on its own. */
export interface MergePart {
  /** Where this file was in the list given to `mergeTracks`, so a caller can tell its own entries apart. */
  sourceIndex: number;
  fileName: string;
  name?: string;
  startTime: Date;
  endTime: Date;
  pointCount: number;
  /** Points left out because they had no time, and so no place in the order. */
  untimedPointCount: number;
  durationSeconds: number;
  movingDurationSeconds?: number;
  distanceMeters?: number;
  elevationGainMeters?: number;
  elevationLossMeters?: number;
}

/** The gap between one file's last point and the next file's first. */
export interface MergePause {
  /** Index into `parts` of the file before the pause. */
  after: number;
  startTime: Date;
  endTime: Date;
  seconds: number;
  /** Straight-line distance across the gap, where both ends have a position. */
  jumpMeters?: number;
  /** The next file starts far from where the last one stopped. */
  far: boolean;
}

export type MergeError =
  | { code: 'merge_needs_two'; message: string }
  | {
      code: 'merge_overlap';
      message: string;
      /** Indices into the oldest-first order of the two files that overlap. */
      between: [number, number];
      overlapSeconds: number;
    };

export type MergeResult =
  | {
      ok: true;
      activity: Activity;
      parts: MergePart[];
      pauses: MergePause[];
      warnings: ActivityWarning[];
    }
  | { ok: false; error: MergeError; parts: MergePart[] };

/**
 * Beyond this, the next file is said to start far from where the last one
 * ended: the same line Route Builder draws for an appended track
 * (`FAR_APPEND_METERS`), for the same reason. A pause at a café starts where
 * it stopped; a ride that resumes a kilometre away was carried, or is not the
 * same ride.
 */
export const FAR_PAUSE_JUMP_METERS = 1000;

const hasTime = (point: ActivityPoint): point is ActivityPoint & { time: Date } =>
  point.time instanceof Date && !Number.isNaN(point.time.getTime());

interface Prepared {
  source: MergeSource;
  sourceIndex: number;
  /** Timed points, oldest first; the order a device would have written them. */
  points: (ActivityPoint & { time: Date })[];
  untimed: number;
  start: number;
  end: number;
}

function prepare(source: MergeSource, sourceIndex: number): Prepared | undefined {
  // A stable sort, so points a device wrote with the same second keep their
  // order; an out-of-order file is put right, as the stats already read it.
  const points = source.activity.points
    .filter(hasTime)
    .map((point, order) => ({ point, order }))
    .sort((a, b) => a.point.time.getTime() - b.point.time.getTime() || a.order - b.order)
    .map(({ point }) => point);
  if (points.length === 0) return undefined;
  return {
    source,
    sourceIndex,
    points,
    untimed: source.activity.points.length - points.length,
    start: points[0]!.time.getTime(),
    end: points.at(-1)!.time.getTime(),
  };
}

function describePart(prepared: Prepared): MergePart {
  const { stats } = computeStats(prepared.points);
  return {
    sourceIndex: prepared.sourceIndex,
    fileName: prepared.source.fileName,
    name: prepared.source.activity.metadata.name,
    startTime: new Date(prepared.start),
    endTime: new Date(prepared.end),
    pointCount: prepared.points.length,
    untimedPointCount: prepared.untimed,
    durationSeconds: (prepared.end - prepared.start) / 1000,
    movingDurationSeconds: stats.movingDurationSeconds,
    distanceMeters: stats.distanceMeters,
    elevationGainMeters: stats.elevationGainMeters,
    elevationLossMeters: stats.elevationLossMeters,
  };
}

/**
 * Oldest first by the first timestamp, then by the last, then by file name:
 * the same order whichever way the files were chosen.
 */
function byClock(a: Prepared, b: Prepared): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    a.source.fileName.localeCompare(b.source.fileName, 'en') ||
    a.source.activity.id.localeCompare(b.source.activity.id, 'en') ||
    a.sourceIndex - b.sourceIndex
  );
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function overlapMessage(first: Prepared, second: Prepared, seconds: number): string {
  if (first.start === second.start && first.end === second.end) {
    return `${first.source.fileName} and ${second.source.fileName} cover exactly the same time, ${clock(first.start)} to ${clock(first.end)} UTC: they look like the same recording. Remove one of them.`;
  }
  return `${second.source.fileName} starts at ${clock(second.start)} UTC, before ${first.source.fileName} ends at ${clock(first.end)} UTC: the two overlap by ${formatSpan(seconds)}. Overlapping recordings are not merged, because both cannot be the ride at the same moment. Remove one, or trim it in its own app first.`;
}

function formatSpan(seconds: number): string {
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/** The single value every source agrees on, or nothing when they differ. */
function agreed<T>(values: (T | undefined)[], same: (a: T, b: T) => boolean = Object.is): T | undefined {
  const first = values[0];
  if (first === undefined) return undefined;
  return values.every((value) => value !== undefined && same(value, first)) ? first : undefined;
}

function lastLocated(points: ActivityPoint[]) {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i]!;
    if (hasValidLocation(point)) return point;
  }
  return undefined;
}

function firstLocated(points: ActivityPoint[]) {
  return points.find(hasValidLocation);
}

/**
 * Merges the files. Files a reader chose that cannot be merged at all (no
 * timestamps) are expected to have been set aside with `assessMergeSource`;
 * any that slip through are left out here too, never placed by guess.
 */
export function mergeTracks(sources: MergeSource[]): MergeResult {
  const ordered = sources
    .map((source, index) => prepare(source, index))
    .filter((prepared): prepared is Prepared => prepared !== undefined)
    .sort(byClock);
  const parts = ordered.map(describePart);

  if (ordered.length < 2) {
    return {
      ok: false,
      parts,
      error: {
        code: 'merge_needs_two',
        message: 'A merge needs at least two recorded tracks with timestamps.',
      },
    };
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const before = ordered[i - 1]!;
    const after = ordered[i]!;
    if (after.start < before.end) {
      const overlapSeconds = (Math.min(before.end, after.end) - after.start) / 1000;
      return {
        ok: false,
        parts,
        error: {
          code: 'merge_overlap',
          message: overlapMessage(before, after, overlapSeconds),
          between: [i - 1, i],
          overlapSeconds,
        },
      };
    }
  }

  const points: ActivityPoint[] = [];
  const laps: ActivityLap[] = [];
  const events: ActivityEvent[] = [];
  const pauses: MergePause[] = [];
  const warnings: ActivityWarning[] = [];
  let segmentBase = 0;
  let distanceBase = 0;

  ordered.forEach((part, partIndex) => {
    // The part's own distance, worked out as the viewer would for this file
    // alone: its recorded odometer where it has a sane one, GPS otherwise.
    const own = computeDistance(part.points);
    // Each file's segments keep apart from every other file's: renumbered in
    // the order they appear, after the segments of the files before it.
    const segments = new Map<number, number>();
    for (let i = 0; i < part.points.length; i += 1) {
      const point = part.points[i]!;
      const original = point.segmentIndex ?? 0;
      if (!segments.has(original)) segments.set(original, segmentBase + segments.size);
      const travelled = own.cumulativeMeters[i];
      // The file's own odometer is replaced by the merged one: a second
      // device's reading starts again at zero.
      const merged: ActivityPoint = { ...point, index: points.length, segmentIndex: segments.get(original) };
      if (travelled !== undefined) merged.distanceMeters = distanceBase + travelled;
      else delete merged.distanceMeters;
      points.push(merged);
    }
    segmentBase += segments.size;
    distanceBase += own.totalMeters ?? 0;

    for (const lap of part.source.activity.laps ?? []) laps.push({ ...lap, index: laps.length });
    for (const event of part.source.activity.events ?? []) {
      // A source's point indices do not survive the merge; the time does.
      const carried: ActivityEvent = { ...event };
      delete carried.pointIndex;
      events.push(carried);
    }

    const next = ordered[partIndex + 1];
    if (next) {
      const from = lastLocated(part.points);
      const to = firstLocated(next.points);
      const jumpMeters = from && to ? haversineMeters(from.lat, from.lon, to.lat, to.lon) : undefined;
      const far = jumpMeters !== undefined && jumpMeters > FAR_PAUSE_JUMP_METERS;
      pauses.push({
        after: partIndex,
        startTime: new Date(part.end),
        endTime: new Date(next.start),
        seconds: (next.start - part.end) / 1000,
        jumpMeters,
        far,
      });
      events.push({ type: 'pause', time: new Date(part.end), label: `End of ${part.source.fileName}` });
      events.push({ type: 'resume', time: new Date(next.start), label: `Start of ${next.source.fileName}` });
      if (far && jumpMeters !== undefined) {
        warnings.push({
          code: 'merge_far_jump',
          message: `${next.source.fileName} starts ${(jumpMeters / 1000).toFixed(1)} km from where ${part.source.fileName} ended. The gap is kept as a pause and nothing is drawn or counted across it; check the two are the same outing.`,
          severity: 'warning',
        });
      }
    }

    if (part.untimed > 0) {
      warnings.push({
        code: 'merge_untimed_points',
        message: `${part.untimed} point${part.untimed === 1 ? '' : 's'} of ${part.source.fileName} had no time, so ${part.untimed === 1 ? 'it has' : 'they have'} no place in the order and ${part.untimed === 1 ? 'was' : 'were'} left out.`,
        severity: 'info',
      });
    }
  });

  if (ordered.some((part) => (part.source.activity.sensorStreams ?? []).length > 0)) {
    warnings.push({
      code: 'merge_sensor_streams_dropped',
      message:
        'The camera streams of a video’s telemetry (acceleration, rotation and the like) are not carried into the merge.',
      severity: 'info',
    });
  }

  const activities = ordered.map((part) => part.source.activity);
  const sport = agreed(activities.map((activity) => activity.metadata.sport));
  if (sport === undefined && activities.some((activity) => activity.metadata.sport)) {
    warnings.push({
      code: 'merge_sports_differ',
      message: 'The files name different sports, so the merged activity names none.',
      severity: 'info',
    });
  }
  // The name they share, else the oldest file's, else a plain one.
  const name =
    agreed(activities.map((activity) => activity.metadata.name?.trim() || undefined)) ||
    activities[0]!.metadata.name?.trim() ||
    'Merged activity';
  const device = agreed(
    activities.map((activity) => activity.metadata.device),
    (a, b) => a.name === b.name && a.manufacturer === b.manufacturer && a.model === b.model && a.product === b.product,
  );
  const format = agreed(activities.map((activity) => activity.source.format));

  const merged = withDerivedStats({
    id: `merged:${activities.map((activity) => activity.id).join('+')}`,
    source: { format: format ?? 'unknown', parserVersion: 'merge-1' },
    metadata: {
      name: `${name} (merged)`,
      description: `Merged from ${ordered.map((part) => part.source.fileName).join(', ')}.`,
      sport,
      creator: agreed(activities.map((activity) => activity.metadata.creator)),
      utcOffsetMinutes: agreed(activities.map((activity) => activity.metadata.utcOffsetMinutes)),
      device,
      deviceName: device ? activities[0]!.metadata.deviceName : undefined,
    },
    points,
    laps: laps.length > 0 ? laps : undefined,
    events,
    streams: computeStreams(points),
    warnings: [],
  });

  return {
    ok: true,
    activity: { ...merged, warnings: [...warnings, ...merged.warnings] },
    parts,
    pauses,
    warnings,
  };
}
