import {
  computeStreams,
  hasValidLocation,
  toValidCoordinate,
  type Activity,
  type ActivityPoint,
  type ActivityPointRange,
  type ActivityWarning,
} from './activity';
import { haversineMeters, withDerivedStats } from './stats';

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

export type RouteDraftErrorCode =
  | 'empty_draft'
  | 'no_route_points'
  | 'invalid_range'
  | 'invalid_point'
  | 'unknown_point';

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

/*
 * AV-1104. Editing by hand. Each operation returns a new draft and leaves the
 * one it was given as it was; a refusal (`invalid_point`, `unknown_point`)
 * carries a reason and changes nothing. Points that did not change are shared
 * with the previous draft.
 */

export interface DraftPlace {
  lat: number;
  lon: number;
  elevationMeters?: number;
}

/**
 * A place a reader typed or clicked is checked before it becomes a point: a
 * latitude past the poles, a longitude past the antimeridian, or anything that
 * is not a finite number is refused rather than drawn somewhere it cannot be.
 */
export function validatePlace(place: DraftPlace): DraftResult<DraftPlace> {
  const { lat, lon, elevationMeters } = place;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return fail('invalid_point', 'Latitude must be a number between -90 and 90.');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return fail('invalid_point', 'Longitude must be a number between -180 and 180.');
  }
  // The rule every reader, the map and every writer apply (`toValidCoordinate`):
  // 0°, 0° is where a device puts a point it has no fix for, so the app drops
  // it everywhere. A point placed there would be kept here and drawn and
  // written nowhere; it is refused instead, with the reason.
  if (!toValidCoordinate(lat, lon)) {
    return fail('invalid_point', 'Latitude 0, longitude 0 is not used: it is where devices put a point with no fix, so the map and every file format leave it out.');
  }
  if (elevationMeters !== undefined && !Number.isFinite(elevationMeters)) {
    return fail('invalid_point', 'Elevation must be a number of metres, or left blank.');
  }
  return ok({ lat, lon, ...(elevationMeters !== undefined ? { elevationMeters } : {}) });
}

export interface AddPointOptions {
  /**
   * Put the new point after this one rather than at the end. It joins that
   * point's stretch, so the line runs through it.
   */
  afterId?: string;
}

const indexOfPoint = (draft: RouteDraft, id: string): number =>
  draft.points.findIndex((point) => point.id === id);

/**
 * Adds a place as a point the reader put there: at the end of the track, or
 * after a chosen point. It continues the stretch it lands in — a new point
 * is drawn joined to its neighbours, which is the whole point of adding it —
 * and an empty draft starts its first stretch with it.
 */
export function addPoint(
  draft: RouteDraft,
  place: DraftPlace,
  options: AddPointOptions = {},
): DraftResult<RouteDraft> {
  const valid = validatePlace(place);
  if (!valid.ok) return valid as unknown as DraftResult<RouteDraft>;

  let at = draft.points.length;
  if (options.afterId !== undefined) {
    const after = indexOfPoint(draft, options.afterId);
    if (after === -1) return fail('unknown_point', 'That point is not in this track.');
    at = after + 1;
  }
  const neighbour = draft.points[at - 1] ?? draft.points[at];
  const point: DraftPoint = {
    id: `p${draft.counters.point}`,
    ...valid.value,
    segmentIndex: neighbour?.segmentIndex ?? 0,
    origin: { kind: 'manual' },
    edit: { kind: 'added' },
  };
  return ok({
    ...draft,
    points: [...draft.points.slice(0, at), point, ...draft.points.slice(at)],
    counters: { ...draft.counters, point: draft.counters.point + 1 },
  });
}

/** Takes one point out. Its neighbours keep their stretches; the line now runs between them. */
export function removePoint(draft: RouteDraft, id: string): DraftResult<RouteDraft> {
  const at = indexOfPoint(draft, id);
  if (at === -1) return fail('unknown_point', 'That point is not in this track.');
  return ok({ ...draft, points: draft.points.filter((_, index) => index !== at) });
}

/**
 * Moves a point to a new place. The place it came from is remembered once —
 * the first move records where the source had it, and later moves keep that
 * record rather than the last stop — so what was changed from the original
 * can always be told. A point the reader added has no original to remember.
 */
export function movePoint(
  draft: RouteDraft,
  id: string,
  place: DraftPlace,
): DraftResult<RouteDraft> {
  const valid = validatePlace(place);
  if (!valid.ok) return valid as unknown as DraftResult<RouteDraft>;
  const at = indexOfPoint(draft, id);
  if (at === -1) return fail('unknown_point', 'That point is not in this track.');

  const current = draft.points[at]!;
  const edit: DraftPointEdit =
    current.edit?.kind === 'added' || current.edit?.kind === 'moved'
      ? current.edit
      : { kind: 'moved', fromLat: current.lat, fromLon: current.lon };
  const moved: DraftPoint = { ...current, lat: valid.value.lat, lon: valid.value.lon, edit };
  if (valid.value.elevationMeters !== undefined) moved.elevationMeters = valid.value.elevationMeters;
  return ok({ ...draft, points: draft.points.map((point, index) => (index === at ? moved : point)) });
}

/*
 * AV-1105. Sections and stretches. A section is a contiguous span of the
 * track between two points, in either order; a stretch is a run of points
 * sharing a `segmentIndex`, drawn as one line. Discarding a section leaves a
 * cut, and the cut is either closed — the points either side joined, as a
 * reader removing a detour means — or kept as a gap. Joining and splitting
 * are also offered on their own, as the repairs for appended tracks (TD-048):
 * an import starts a stretch of its own, and only the reader says whether the
 * end of one track and the start of the next are really one road.
 */

export interface DraftSection {
  fromId: string;
  toId: string;
}

/** A section as index bounds, in draft order, whichever way round it was given. */
export function sectionBounds(
  draft: RouteDraft,
  section: DraftSection,
): DraftResult<{ start: number; end: number }> {
  const a = indexOfPoint(draft, section.fromId);
  const b = indexOfPoint(draft, section.toId);
  if (a === -1 || b === -1) return fail('unknown_point', 'That point is not in this track.');
  return ok({ start: Math.min(a, b), end: Math.max(a, b) });
}

/** The highest stretch number in use, so a new one can be made after it. */
const lastSegment = (points: readonly DraftPoint[]) =>
  points.reduce((max, point) => Math.max(max, point.segmentIndex ?? 0), -1);

/**
 * Gives the stretch beginning at `at` the stretch of the point before it: the
 * run from `at` onward that shared the old number takes the new one, and
 * later stretches are untouched. Nothing to do at the start of the track or
 * inside a stretch.
 */
function joinAt(points: readonly DraftPoint[], at: number): DraftPoint[] {
  const before = points[at - 1];
  const first = points[at];
  if (!before || !first) return [...points];
  const from = before.segmentIndex ?? 0;
  if (from === (first.segmentIndex ?? 0)) return [...points];
  const end = runEnd(points, at);
  const joined = renumberRun(points, at, from);
  // The run after the joined one may already carry `from` — stretches are
  // numbered in order of appearance, and a cut can bring two with the same
  // number together — and would silently join too. It keeps its boundary by
  // taking a number of its own.
  const following = joined[end + 1];
  return following && (following.segmentIndex ?? 0) === from
    ? renumberRun(joined, end + 1, lastSegment(points) + 1)
    : joined;
}

/**
 * The last index of the run that begins at `start`: the contiguous points
 * sharing its stretch number. Found once, so renumbering a run is one pass —
 * a later run that happens to reuse the number is past the end and untouched.
 */
function runEnd(points: readonly DraftPoint[], start: number): number {
  const segment = points[start]?.segmentIndex ?? 0;
  let end = start;
  while (end + 1 < points.length && (points[end + 1]?.segmentIndex ?? 0) === segment) end += 1;
  return end;
}

/** The run beginning at `start`, renumbered; every other point is shared as it was. */
function renumberRun(points: readonly DraftPoint[], start: number, segmentIndex: number): DraftPoint[] {
  const end = runEnd(points, start);
  const next = [...points];
  for (let index = start; index <= end; index += 1) {
    next[index] = { ...points[index]!, segmentIndex };
  }
  return next;
}

/** Starts a new stretch at `at`, if the point there shares one with the point before it. */
function splitAt(points: readonly DraftPoint[], at: number): DraftPoint[] {
  const before = points[at - 1];
  const first = points[at];
  if (!before || !first) return [...points];
  if ((before.segmentIndex ?? 0) !== (first.segmentIndex ?? 0)) return [...points];
  return renumberRun(points, at, lastSegment(points) + 1);
}

export interface DiscardOptions {
  /** Leave the cut open: the points after it start a stretch of their own. */
  keepGap?: boolean;
}

/**
 * Takes a section out of the track. The points either side of the cut are
 * joined into one stretch — a removed detour leaves the road running on —
 * unless the reader asks to keep the gap, in which case what follows the cut
 * begins a stretch of its own. A section at the start or the end has nothing
 * to join; discarding the whole track leaves an empty draft, which is a
 * track with no points rather than an error.
 */
export function discardSection(
  draft: RouteDraft,
  section: DraftSection,
  options: DiscardOptions = {},
): DraftResult<RouteDraft> {
  const bounds = sectionBounds(draft, section);
  if (!bounds.ok) return bounds as unknown as DraftResult<RouteDraft>;
  const { start, end } = bounds.value;
  const kept = [...draft.points.slice(0, start), ...draft.points.slice(end + 1)];
  // The cut sits at `start`: the point now there followed the section.
  const points = start > 0 && start < kept.length
    ? options.keepGap
      ? splitAt(kept, start)
      : joinAt(kept, start)
    : kept;
  return ok({ ...draft, points });
}

/** Joins the stretch that begins at this point to the one before it. */
export function joinBefore(draft: RouteDraft, id: string): DraftResult<RouteDraft> {
  const at = indexOfPoint(draft, id);
  if (at === -1) return fail('unknown_point', 'That point is not in this track.');
  if (at === 0) return fail('invalid_range', 'The first point has nothing before it to join.');
  if ((draft.points[at]!.segmentIndex ?? 0) === (draft.points[at - 1]!.segmentIndex ?? 0)) {
    return fail('invalid_range', 'That point is already joined to the one before it.');
  }
  return ok({ ...draft, points: joinAt(draft.points, at) });
}

/** Splits the track before this point, so it begins a stretch of its own. */
export function splitBefore(draft: RouteDraft, id: string): DraftResult<RouteDraft> {
  const at = indexOfPoint(draft, id);
  if (at === -1) return fail('unknown_point', 'That point is not in this track.');
  if (at === 0) return fail('invalid_range', 'The first point already begins the track.');
  if ((draft.points[at]!.segmentIndex ?? 0) !== (draft.points[at - 1]!.segmentIndex ?? 0)) {
    return fail('invalid_range', 'That point already begins a stretch.');
  }
  return ok({ ...draft, points: splitAt(draft.points, at) });
}

/** Whether this point begins a stretch: the first, or one not joined to the point before it. */
export function beginsStretch(draft: RouteDraft, id: string): boolean {
  const at = indexOfPoint(draft, id);
  if (at <= 0) return at === 0;
  return (draft.points[at]!.segmentIndex ?? 0) !== (draft.points[at - 1]!.segmentIndex ?? 0);
}

/*
 * AV-1106. Appending is `appendImportedRoute`, through the app's own intake.
 * What this adds is the measure of the jump: how far the start of what was
 * appended lies from the end of what was there. The two are never joined by
 * the append (TD-048, TD-052); a large jump is said out loud so the reader
 * can decide whether it is one road with a hole in it or two separate rides.
 */

/** Beyond this, the start of an appended track is called far from the end of the draft. */
export const FAR_APPEND_METERS = 1000;

export interface AppendJump {
  /** The first appended point, which begins its own stretch. */
  firstId: string;
  /** Straight-line distance from the last point before it. */
  meters: number;
  far: boolean;
}

/**
 * The jump an append made, comparing the draft before it with the draft after.
 * Undefined when there was nothing before to jump from, or nothing appended.
 */
export function appendJump(before: RouteDraft, after: RouteDraft): AppendJump | undefined {
  const last = before.points[before.points.length - 1];
  const first = after.points[before.points.length];
  if (!last || !first) return undefined;
  const meters = haversineMeters(last.lat, last.lon, first.lat, first.lon);
  return { firstId: first.id, meters, far: meters > FAR_APPEND_METERS };
}

/**
 * The lengths of the draft's stretches, in order: a stretch is a run of
 * *adjacent* points sharing a `segmentIndex`. Read by transitions, never by
 * collecting the numbers, because a number can come back after a different
 * one — runs `0, 1, 0` are three stretches, as the GPX writer and the map draw
 * them, not two.
 */
export function stretchLengths(points: readonly DraftPoint[]): number[] {
  const lengths: number[] = [];
  let previous: number | undefined;
  for (const point of points) {
    const segment = point.segmentIndex ?? 0;
    if (previous === undefined || segment !== previous) lengths.push(1);
    else lengths[lengths.length - 1]! += 1;
    previous = segment;
  }
  return lengths;
}
