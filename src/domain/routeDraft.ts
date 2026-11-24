import {
  computeStreams,
  hasValidLocation,
  toValidCoordinate,
  type Activity,
  type Coordinate,
} from './activity';
import { ActivityError } from './errors';
import { haversineMeters, withDerivedStats } from './stats';

/**
 * AV-1101. The editable model behind Route Builder.
 *
 * A draft is deliberately not an `Activity`. An activity is a record of
 * something that happened and is never edited (TD-006); a draft is a plan that
 * exists to be changed. Keeping them apart means no edit can reach the file the
 * user opened, and `draftToActivity` is the one place a plan becomes something
 * the map, stats and exporters understand.
 *
 * **Retention policy.** A draft keeps position, elevation and which recorded
 * segment a point belongs to — and nothing else. Heart rate, power, cadence,
 * temperature, speed, laps and device information describe a performance, not a
 * route, and carrying them onto a plan someone will load onto another device
 * would be wrong (and, for the device, a leak). Timestamps are dropped too: a
 * planned route has no clock, and inventing one would make an exporter claim a
 * pace nobody rode.
 *
 * Every operation is pure and returns a new draft; the points inside are plain
 * values, so a previous draft stays valid for undo.
 */
export interface DraftPoint extends Coordinate {
  elevationMeters?: number;
  /**
   * Points in different segments are not joined by a line and add no distance
   * between them — the same meaning `ActivityPoint.segmentIndex` has.
   */
  segmentIndex: number;
}

export type DraftOrigin =
  | { kind: 'blank' }
  | { kind: 'activity'; activityId: string; fileName?: string }
  | { kind: 'appended'; sources: string[] };

export interface RouteDraft {
  name: string;
  points: DraftPoint[];
  origin: DraftOrigin;
}

/** A gap longer than this between a draft's end and an appended track is worth saying. */
export const FAR_JOIN_METERS = 1_000;

export function createBlankDraft(name = 'Planned route'): RouteDraft {
  return { name, points: [], origin: { kind: 'blank' } };
}

/**
 * Copies an activity's route into a draft. Points without a usable position
 * are dropped, because a draft is a line and those cannot be on one.
 */
export function draftFromActivity(activity: Activity): RouteDraft {
  const points = pointsOf(activity);
  if (points.length === 0) {
    throw new ActivityError(
      'no_location_stream',
      'This activity has no GPS coordinates to plan a route from.',
    );
  }
  return {
    name: activity.metadata.name ?? activity.source.fileName ?? 'Planned route',
    points,
    origin: { kind: 'activity', activityId: activity.id, fileName: activity.source.fileName },
  };
}

function pointsOf(activity: Activity): DraftPoint[] {
  return activity.points.filter(hasValidLocation).map((point) => ({
    lat: point.lat,
    lon: point.lon,
    ...(Number.isFinite(point.elevationMeters) ? { elevationMeters: point.elevationMeters } : {}),
    segmentIndex: point.segmentIndex ?? 0,
  }));
}

export type EditResult = { ok: true; draft: RouteDraft } | { ok: false; error: ActivityError };

const rejected = (message: string): EditResult => ({
  ok: false,
  error: new ActivityError('invalid_selected_range', message),
});

/**
 * Adds a point at `position` (default: the end). A coordinate the app would not
 * draw is refused rather than stored — the same definition parsers use.
 */
export function addPoint(
  draft: RouteDraft,
  coordinate: Coordinate,
  options: { position?: number; elevationMeters?: number } = {},
): EditResult {
  const valid = toValidCoordinate(coordinate.lat, coordinate.lon);
  if (!valid) return rejected('That is not a valid place on the map.');

  const position = options.position ?? draft.points.length;
  if (!Number.isInteger(position) || position < 0 || position > draft.points.length) {
    return rejected('That position is outside the route.');
  }

  // A new point continues the segment of the point before it, or the one after
  // when it is placed first, so adding never opens a gap on its own.
  const neighbour = draft.points[position - 1] ?? draft.points[position];
  const point: DraftPoint = {
    ...valid,
    ...(Number.isFinite(options.elevationMeters) ? { elevationMeters: options.elevationMeters } : {}),
    segmentIndex: neighbour?.segmentIndex ?? 0,
  };
  const points = [...draft.points.slice(0, position), point, ...draft.points.slice(position)];
  return { ok: true, draft: { ...draft, points } };
}

export function removePoint(draft: RouteDraft, position: number): EditResult {
  if (!Number.isInteger(position) || position < 0 || position >= draft.points.length) {
    return rejected('That point is not in the route.');
  }
  return {
    ok: true,
    draft: { ...draft, points: draft.points.filter((_, index) => index !== position) },
  };
}

export function movePoint(draft: RouteDraft, position: number, to: Coordinate): EditResult {
  const valid = toValidCoordinate(to.lat, to.lon);
  if (!valid) return rejected('That is not a valid place on the map.');
  const existing = draft.points[position];
  if (!existing) return rejected('That point is not in the route.');

  // Elevation belonged to the old place; keeping it would put a wrong number
  // on the new one.
  const moved: DraftPoint = { ...valid, segmentIndex: existing.segmentIndex };
  return {
    ok: true,
    draft: { ...draft, points: draft.points.map((point, index) => (index === position ? moved : point)) },
  };
}

/**
 * Removes the points from `from` to `to`, inclusive, in either order (so a
 * section selected backwards behaves the same). The points either side then
 * simply become neighbours — the remainder is joined — unless `keepGap` asks
 * for the two halves to stay unconnected.
 */
export function discardSection(
  draft: RouteDraft,
  from: number,
  to: number,
  options: { keepGap?: boolean } = {},
): EditResult {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end >= draft.points.length
  ) {
    return rejected('That section is not part of the route.');
  }

  const before = draft.points.slice(0, start);
  const after = draft.points.slice(end + 1);
  const shifted = options.keepGap && before.length > 0 && after.length > 0;
  const points = [
    ...before,
    ...after.map((point) => (shifted ? { ...point, segmentIndex: point.segmentIndex + 1 } : point)),
  ];
  return { ok: true, draft: { ...draft, points } };
}

export interface AppendResult {
  draft: RouteDraft;
  /** Straight-line distance from the draft's last point to the new first point. */
  gapMeters?: number;
  /** True when `gapMeters` exceeds `FAR_JOIN_METERS`, so the UI can ask or warn. */
  farJoin: boolean;
}

/**
 * Appends another activity's route to the end. By default the two are joined by
 * a line; `breakAtJoin` starts a new segment so no line is drawn between them.
 * The activity must have a usable route, or the append is refused rather than
 * silently adding nothing.
 */
export function appendActivity(
  draft: RouteDraft,
  activity: Activity,
  options: { breakAtJoin?: boolean } = {},
): AppendResult {
  const incoming = pointsOf(activity);
  if (incoming.length === 0) {
    throw new ActivityError('no_route_points', 'That file has no route points to append.');
  }

  const lastSegment = draft.points.at(-1)?.segmentIndex ?? 0;
  const base = draft.points.length === 0 ? 0 : lastSegment + (options.breakAtJoin ? 1 : 0);
  // Segments inside the appended track keep their own boundaries, offset so
  // they continue the draft's numbering instead of colliding with it.
  const first = incoming[0]!.segmentIndex;
  const appended = incoming.map((point) => ({
    ...point,
    segmentIndex: base + point.segmentIndex - first,
  }));

  const last = draft.points.at(-1);
  const gapMeters = last
    ? haversineMeters(last.lat, last.lon, appended[0]!.lat, appended[0]!.lon)
    : undefined;

  const label = activity.source.fileName ?? activity.metadata.name ?? 'imported track';
  let sources: string[];
  if (draft.origin.kind === 'appended') sources = [...draft.origin.sources, label];
  else if (draft.points.length === 0) sources = [label];
  else
    sources = [
      draft.origin.kind === 'activity' ? (draft.origin.fileName ?? 'activity') : 'new route',
      label,
    ];

  return {
    draft: {
      ...draft,
      points: [...draft.points, ...appended],
      origin: { kind: 'appended', sources },
    },
    gapMeters,
    farJoin: gapMeters !== undefined && gapMeters > FAR_JOIN_METERS,
  };
}

/** Length of the drawn route: segment boundaries add nothing. */
export function draftDistanceMeters(draft: RouteDraft): number {
  let total = 0;
  for (let i = 1; i < draft.points.length; i += 1) {
    const a = draft.points[i - 1]!;
    const b = draft.points[i]!;
    if (a.segmentIndex !== b.segmentIndex) continue;
    total += haversineMeters(a.lat, a.lon, b.lat, b.lon);
  }
  return total;
}

/**
 * The draft as an `Activity`, for the map preview and the exporters. A new
 * object every call; nothing in it aliases the draft.
 */
export function draftToActivity(draft: RouteDraft, id = 'route-draft'): Activity {
  let cumulative = 0;
  const points = draft.points.map((point, index) => {
    const previous = draft.points[index - 1];
    if (previous && previous.segmentIndex === point.segmentIndex) {
      cumulative += haversineMeters(previous.lat, previous.lon, point.lat, point.lon);
    }
    return {
      index,
      lat: point.lat,
      lon: point.lon,
      ...(point.elevationMeters !== undefined ? { elevationMeters: point.elevationMeters } : {}),
      distanceMeters: cumulative,
      segmentIndex: point.segmentIndex,
    };
  });

  return withDerivedStats({
    id,
    source: { format: 'planned', parserVersion: 'route-builder-1' },
    metadata: { name: draft.name },
    points,
    streams: computeStreams(points),
    warnings: [],
  });
}
