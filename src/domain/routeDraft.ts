import {
  computeStreams,
  hasValidLocation,
  type Activity,
  type ActivityPoint,
  type ActivityPointRange,
  type ActivityWarning,
} from './activity';
import { withDerivedStats } from './stats';

/**
 * AV-1101. The route draft: a planned track, kept apart from the immutable
 * `Activity` a file was read into (TD-006).
 *
 * An activity records what happened; a draft is what someone intends, and is
 * going to be edited. So it is its own type, shaped for editing — an ordered
 * list of places, each with an id that survives edits and a note of where it
 * came from — and never aliases an activity's points. Every operation here is a
 * pure function: it returns a new draft and leaves its arguments, and any
 * activity it read, exactly as they were.
 *
 * **What a draft keeps of an activity (the documented policy).** Place and
 * order: latitude, longitude, elevation, time, and the recorded segment a point
 * belonged to. Everything that describes the *athlete* or the *device* is
 * intentionally dropped, because a planned track is not a recording of anyone:
 * heart rate, power, cadence, temperature, speed, grade, accuracy, laps,
 * events, auxiliary sensor streams, device metadata, format extensions and
 * warnings. The distance a file recorded is kept on the point as a reading of
 * the source, but is **not** carried into a generated activity: it would go
 * stale at the first edit, so the activity's distance is derived from the
 * geometry. Points without a usable location are not part of a route and are
 * left out, counted in `dropped`, and the fixes either side of one start
 * separate segments: nothing says the ground between them was travelled.
 */

export const DRAFT_RETAINED_FIELDS = [
  'lat',
  'lon',
  'elevationMeters',
  'time',
  'distanceMeters (as a reading of the source only)',
  'segmentIndex',
] as const;

export const DRAFT_DROPPED_FIELDS = [
  'heartRateBpm',
  'runningCadenceSpm',
  'cyclingCadenceRpm',
  'powerWatts',
  'temperatureCelsius',
  'speedMetersPerSecond',
  'gradePercent',
  'accuracyMeters',
  'extensions',
  'laps',
  'events',
  'sensorStreams',
  'metadata.device',
  'warnings',
] as const;

/** Where a point came from: placed by hand, copied from an activity, or imported. */
export type DraftPointOrigin =
  | { kind: 'manual' }
  | { kind: 'activity'; sourceId: string; pointIndex: number }
  | { kind: 'import'; sourceId: string; pointIndex: number };

/** How a point has been changed since it arrived. Absent for one that has not been. */
export type DraftPointEdit =
  | { kind: 'added' }
  | { kind: 'moved'; fromLat: number; fromLon: number };

export interface DraftPoint {
  /** Stable for the life of the draft: an edit changes a point, never its id. */
  id: string;
  lat: number;
  lon: number;
  elevationMeters?: number;
  time?: Date;
  /** The source's odometer reading, if it had one. Not authoritative once the draft is edited. */
  distanceMeters?: number;
  /**
   * The recorded segment the point belonged to. Points in different segments are
   * not joined by a line, and distance is not counted between them: a copied
   * recording's pauses survive, and an appended route starts a segment of its
   * own rather than being joined to the end of the one before.
   */
  segmentIndex?: number;
  origin: DraftPointOrigin;
  edit?: DraftPointEdit;
}

/** Something the draft was made from, kept so a point's `origin.sourceId` can be explained. */
export interface DraftSource {
  id: string;
  role: 'copied' | 'imported';
  /** The file the activity came from, when it had one. Never used to name an export. */
  fileName?: string;
  name?: string;
  /** Points offered by the source, and how many of those were usable. */
  sourcePointCount: number;
  usedPointCount: number;
  /** The span of the source that was taken, when it was a section. */
  range?: ActivityPointRange;
}

export type DraftKind = 'blank' | 'copied' | 'appended';

export interface RouteDraft {
  id: string;
  name: string;
  kind: DraftKind;
  points: DraftPoint[];
  sources: DraftSource[];
  /** Points left out of the draft because they had no usable location. */
  dropped: { unlocatedPoints: number };
  /** The next point and source number, so ids are made without a clock or a random source. */
  counters: { point: number; source: number };
}

export type RouteDraftErrorCode = 'empty_draft' | 'no_route_points' | 'invalid_range';

export class RouteDraftError extends Error {
  readonly code: RouteDraftErrorCode;

  constructor(code: RouteDraftErrorCode, message: string) {
    super(message);
    this.name = 'RouteDraftError';
    this.code = code;
  }
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: RouteDraftError };

const ok = <T>(value: T): DraftResult<T> => ({ ok: true, value });
const fail = <T>(code: RouteDraftErrorCode, message: string): DraftResult<T> => ({
  ok: false,
  error: new RouteDraftError(code, message),
});

export interface CreateDraftOptions {
  /** For a stable id (tests, a restored session); otherwise one is made. */
  id?: string;
  name?: string;
}

let draftSequence = 0;
function newDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `draft-${crypto.randomUUID()}`;
  }
  draftSequence += 1;
  return `draft-${draftSequence}`;
}

const DEFAULT_NAME = 'Planned track';

/** A new, empty planned track. */
export function createBlankDraft(options: CreateDraftOptions = {}): RouteDraft {
  return {
    id: options.id ?? newDraftId(),
    name: options.name?.trim() || DEFAULT_NAME,
    kind: 'blank',
    points: [],
    sources: [],
    dropped: { unlocatedPoints: 0 },
    counters: { point: 0, source: 0 },
  };
}

export interface FromActivityOptions extends CreateDraftOptions {
  /** Copy only this span, in `point.index` terms as the viewer's selection is (AV-510). */
  range?: ActivityPointRange;
}

function validateRange(range: ActivityPointRange | undefined): DraftResult<undefined> | undefined {
  if (!range) return undefined;
  if (
    !Number.isInteger(range.startIndex) ||
    !Number.isInteger(range.endIndex) ||
    range.endIndex < range.startIndex
  ) {
    return fail('invalid_range', 'The selected range is not a valid span of this activity.');
  }
  return undefined;
}

/**
 * Takes the usable places out of an activity, as new draft points. Nothing of the
 * activity is shared with them: not a point, not a `Date`.
 */
function takePoints(
  activity: Activity,
  range: ActivityPointRange | undefined,
  counters: { point: number },
  sourceId: string,
  originKind: 'activity' | 'import',
  segmentBase: number,
): { points: DraftPoint[]; offered: number; unlocated: number } {
  const points: DraftPoint[] = [];
  let offered = 0;
  let unlocated = 0;
  const segments = new Map<string, number>();
  // How many stretches without a location have been passed: the fixes either
  // side of one are not known to be joined, so they do not share a segment.
  let breaks = 0;
  let inBreak = false;
  for (const source of activity.points) {
    if (range && (source.index < range.startIndex || source.index > range.endIndex)) continue;
    offered += 1;
    if (!hasValidLocation(source)) {
      unlocated += 1;
      if (!inBreak) breaks += 1;
      inBreak = true;
      continue;
    }
    inBreak = false;
    // Segments are renumbered from the base, in order of appearance, so two
    // sources never share one and a gap in a recording is still a gap.
    const key = `${source.segmentIndex ?? 0}:${breaks}`;
    if (!segments.has(key)) segments.set(key, segmentBase + segments.size);
    const point: DraftPoint = {
      id: `p${counters.point}`,
      lat: source.lat,
      lon: source.lon,
      segmentIndex: segments.get(key)!,
      origin: { kind: originKind, sourceId, pointIndex: source.index },
    };
    counters.point += 1;
    if (source.elevationMeters !== undefined) point.elevationMeters = source.elevationMeters;
    if (source.time) point.time = new Date(source.time.getTime());
    if (source.distanceMeters !== undefined) point.distanceMeters = source.distanceMeters;
    points.push(point);
  }
  return { points, offered, unlocated };
}

/** The first segment number a new source's points may use. */
const nextSegment = (draft: RouteDraft) =>
  draft.points.reduce((max, point) => Math.max(max, (point.segmentIndex ?? 0) + 1), 0);

function add(
  draft: RouteDraft,
  activity: Activity,
  role: DraftSource['role'],
  options: { range?: ActivityPointRange; label?: string },
): DraftResult<RouteDraft> {
  const invalid = validateRange(options.range);
  if (invalid) return invalid as DraftResult<RouteDraft>;

  const counters = { ...draft.counters };
  const sourceId = `s${counters.source}`;
  counters.source += 1;
  const taken = takePoints(
    activity,
    options.range,
    counters,
    sourceId,
    role === 'copied' ? 'activity' : 'import',
    nextSegment(draft),
  );
  if (taken.points.length === 0) {
    return fail(
      'no_route_points',
      taken.offered === 0
        ? 'There are no points in that range of the activity.'
        : 'None of those points has a usable location, so there is no route to take from them.',
    );
  }
  const source: DraftSource = {
    id: sourceId,
    role,
    sourcePointCount: taken.offered,
    usedPointCount: taken.points.length,
    ...(activity.source.fileName ? { fileName: activity.source.fileName } : {}),
    ...(activity.metadata.name ? { name: activity.metadata.name } : {}),
    ...(options.range ? { range: { ...options.range } } : {}),
  };
  return ok({
    ...draft,
    points: [...draft.points, ...taken.points],
    sources: [...draft.sources, source],
    dropped: { unlocatedPoints: draft.dropped.unlocatedPoints + taken.unlocated },
    counters,
  });
}

/**
 * A planned track copied from an activity (or from a section of one). The
 * activity is read and left alone.
 */
export function draftFromActivity(
  activity: Activity,
  options: FromActivityOptions = {},
): DraftResult<RouteDraft> {
  const blank = createBlankDraft({
    ...options,
    name: options.name ?? activity.metadata.name,
  });
  const result = add(blank, activity, 'copied', { range: options.range });
  return result.ok ? ok({ ...result.value, kind: 'copied' }) : result;
}

export interface AppendOptions {
  range?: ActivityPointRange;
}

/**
 * Appends an imported route after the points already in the draft. It begins a
 * segment of its own: the end of the draft and the start of the import are not
 * joined by a line the reader did not draw, and no distance is counted across
 * the jump. (Joining them is a repair, which is its own operation.)
 */
export function appendImportedRoute(
  draft: RouteDraft,
  activity: Activity,
  options: AppendOptions = {},
): DraftResult<RouteDraft> {
  const result = add(draft, activity, 'imported', options);
  if (!result.ok) return result;
  return ok({ ...result.value, kind: draft.kind === 'blank' ? 'appended' : result.value.kind });
}

/** A draft made by appending routes, in order. The first one that cannot be taken is the failure. */
export function draftFromImports(
  activities: readonly Activity[],
  options: CreateDraftOptions = {},
): DraftResult<RouteDraft> {
  let draft = createBlankDraft(options);
  for (const activity of activities) {
    const next = appendImportedRoute(draft, activity);
    if (!next.ok) return next;
    draft = next.value;
  }
  return draft.points.length
    ? ok(draft)
    : fail('empty_draft', 'There are no routes to build a track from.');
}

export interface DraftActivityOptions {
  /** The id of the generated activity; defaults to the draft's. */
  id?: string;
}

const DRAFT_PARSER_VERSION = 'route-draft-1';

/**
 * The draft as a normalized, route-oriented `Activity`, ready for the exporters
 * (GPX, TCX, FIT) and the viewer's own route code. Points are numbered from
 * zero in draft order; only place, elevation, time and segment are carried
 * (see the policy above), and distance and the totals are derived from the
 * geometry. An empty draft is refused: there is no track to write.
 */
export function draftToActivity(
  draft: RouteDraft,
  options: DraftActivityOptions = {},
): DraftResult<Activity> {
  if (draft.points.length === 0) {
    return fail('empty_draft', 'The draft has no points, so there is no track to make.');
  }
  const points: ActivityPoint[] = draft.points.map((point, index) => ({
    index,
    lat: point.lat,
    lon: point.lon,
    ...(point.elevationMeters !== undefined ? { elevationMeters: point.elevationMeters } : {}),
    ...(point.time ? { time: new Date(point.time.getTime()) } : {}),
    ...(point.segmentIndex !== undefined ? { segmentIndex: point.segmentIndex } : {}),
  }));

  const warnings: ActivityWarning[] = [];
  if (draft.dropped.unlocatedPoints > 0) {
    const count = draft.dropped.unlocatedPoints;
    warnings.push({
      code: 'draft_unlocated_points_dropped',
      message: `${count} point${count === 1 ? '' : 's'} without a location ${count === 1 ? 'was' : 'were'} left out of this planned track.`,
      severity: 'info',
    });
  }

  const activity: Activity = {
    id: options.id ?? draft.id,
    source: { format: 'unknown', parserVersion: DRAFT_PARSER_VERSION },
    metadata: { name: draft.name },
    points,
    streams: computeStreams(points),
    warnings,
  };
  return ok(withDerivedStats(activity));
}
