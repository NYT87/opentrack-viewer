import type { Activity, ActivityPoint } from '../domain/activity';
import { buildMapVideoRoute, MIN_TRIMMED_ROUTE_METERS, trimRoute, type MapVideoRoute } from '../mapVideo/route';

/**
 * AV-1022 (TD-091). The overlay's privacy trim: a share of the route's distance hidden at each
 * end, from everything the overlay draws of *where* the activity went (the route inset, the still
 * image's route, the route image). One trim for the whole overlay, saved with its template as the
 * two shares, never as places.
 *
 * The cut is the map video's own (`trimRoute`, TD-068), made before anything is built from the
 * route: `keptRoute` returns an activity holding only the kept part, so the projection, the fit and
 * the thinning (`projectRoute`, `extractRoute`) see nothing else, and a hidden end cannot be
 * guessed from an empty margin.
 */

export interface PrivacyTrim {
  /** 0..`PRIVACY_TRIM_MAX_SHARE`: the share of the route's distance hidden from its start. */
  start: number;
  /** The same, from its end. */
  end: number;
}

/** The most either end may hide; the two together are at most twice this, so a tenth of the route is always kept. */
export const PRIVACY_TRIM_MAX_SHARE = 0.45;
/** The control's step, in percent. */
export const PRIVACY_TRIM_STEP_PERCENT = 0.1;

const clampShare = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(PRIVACY_TRIM_MAX_SHARE, Math.max(0, Math.round(value * 1000) / 1000)) : 0;

/** Whether a trim hides anything. */
export const hasPrivacyTrim = (trim: PrivacyTrim | undefined): trim is PrivacyTrim => trim !== undefined && (trim.start > 0 || trim.end > 0);

/**
 * A trim read from anything (a layout file, a draft): each share clamped to 0..45 % and rounded to a
 * tenth of a percent. `undefined` when nothing is hidden, so a template without a trim and one with
 * a trim of nothing are the same template.
 */
export function readPrivacyTrim(raw: unknown): PrivacyTrim | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { start, end } = raw as Record<string, unknown>;
  const trim = { start: clampShare(start), end: clampShare(end) };
  return hasPrivacyTrim(trim) ? trim : undefined;
}

/** What is kept of a route, and what was hidden. */
export interface KeptRoute {
  tooShort?: false;
  /** The activity itself when nothing is hidden; otherwise one holding only the kept vertices, for the projection and the route image. */
  activity: Activity;
  /** The activity time (ms since the epoch) the kept route starts at, when its start is cut and the cut has a time. */
  startMs?: number;
  /** The same for the end. */
  endMs?: number;
  /** An end is cut but the route has no time there, so no moment can be told to be in the kept part. */
  untimed?: boolean;
  hiddenMeters: { start: number; end: number };
  totalMeters: number;
}

/** Less than `MIN_TRIMMED_ROUTE_METERS` would be left (or the route has no length to share): none of it is drawn. */
export interface TooShortRoute {
  tooShort: true;
  hiddenMeters: { start: number; end: number };
  totalMeters: number;
}

const routes = new WeakMap<Activity, MapVideoRoute | null>();
const routeOf = (activity: Activity): MapVideoRoute | undefined => {
  let route = routes.get(activity);
  if (route === undefined) {
    route = buildMapVideoRoute(activity) ?? null;
    routes.set(activity, route);
  }
  return route ?? undefined;
};

/** The route's length in metres as the trim measures it (haversine along the located points, no distance across a gap); 0 without a route. */
export function routeTotalMeters(activity: Activity): number {
  return routeOf(activity)?.totalMeters ?? 0;
}

const wrapLongitude = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

const kept = new WeakMap<Activity, Map<string, KeptRoute | TooShortRoute>>();

/**
 * The part of the activity's route a trim keeps. `undefined` without an activity. With no trim it is
 * the activity itself, untouched (no copy), so nothing changes for anyone who never sets one. Made
 * once per activity and trim: the renderer and the preview ask for it per box.
 */
export function keptRoute(activity: Activity | undefined, trim: PrivacyTrim | undefined): KeptRoute | TooShortRoute | undefined {
  if (!activity) return undefined;
  if (!hasPrivacyTrim(trim)) return { activity, hiddenMeters: { start: 0, end: 0 }, totalMeters: routeTotalMeters(activity) };
  const key = `${trim.start}:${trim.end}`;
  let byTrim = kept.get(activity);
  if (!byTrim) {
    byTrim = new Map();
    kept.set(activity, byTrim);
  }
  let found = byTrim.get(key);
  if (!found) {
    found = cut(activity, { start: clampShare(trim.start), end: clampShare(trim.end) });
    if (byTrim.size >= 16) byTrim.clear();
    byTrim.set(key, found);
  }
  return found;
}

function cut(activity: Activity, trim: PrivacyTrim): KeptRoute | TooShortRoute {
  const route = routeOf(activity);
  // A route of one place has no distance to share, and that place may be the one to hide.
  if (!route) return { tooShort: true, hiddenMeters: { start: 0, end: 0 }, totalMeters: 0 };
  const hiddenMeters = { start: trim.start * route.totalMeters, end: trim.end * route.totalMeters };
  const trimmed = trimRoute(route, hiddenMeters.start, hiddenMeters.end);
  if (!trimmed) return { tooShort: true, hiddenMeters, totalMeters: route.totalMeters };
  const points: ActivityPoint[] = trimmed.vertices.map((vertex, index) => ({
    index,
    lat: vertex.lat,
    lon: wrapLongitude(vertex.lon),
    ...(vertex.time !== undefined ? { time: new Date(vertex.time) } : {}),
    ...(vertex.elevation !== undefined ? { elevationMeters: vertex.elevation } : {}),
    segmentIndex: vertex.segment,
  }));
  const first = trimmed.vertices[0]!.time;
  const last = trimmed.vertices[trimmed.vertices.length - 1]!.time;
  const result: KeptRoute = {
    // Only the places: what a route is drawn from. Nothing else of the activity travels with it.
    activity: { ...activity, points, laps: undefined, events: undefined, sensorStreams: undefined },
    hiddenMeters,
    totalMeters: route.totalMeters,
  };
  if (trim.start > 0) {
    if (first === undefined) result.untimed = true;
    else result.startMs = first;
  }
  if (trim.end > 0) {
    if (last === undefined) result.untimed = true;
    else result.endMs = last;
  }
  return result;
}

/**
 * Whether the marker is drawn at this activity time (ms since the epoch): not while the moment is in
 * a hidden stretch. With no end cut it is always drawn; with one, an unknown moment is not.
 */
export function markerVisible(route: KeptRoute, activityMs: number | undefined): boolean {
  if (route.startMs === undefined && route.endMs === undefined && !route.untimed) return true;
  if (route.untimed || activityMs === undefined || !Number.isFinite(activityMs)) return false;
  if (route.startMs !== undefined && activityMs < route.startMs) return false;
  if (route.endMs !== undefined && activityMs > route.endMs) return false;
  return true;
}

/** The activity time of a sample, in ms since the epoch, from a timeline's start; undefined where the timeline has none. */
export function sampleActivityMs(timeline: { activityStartMs?: number }, sample: { activityElapsedSeconds: number }): number | undefined {
  return timeline.activityStartMs === undefined ? undefined : timeline.activityStartMs + sample.activityElapsedSeconds * 1000;
}

/** The shortest route a trim may leave, as the reader reads it: 100 m, or 330 ft. */
export function minimumKeptText(units: 'metric' | 'imperial'): string {
  return units === 'imperial' ? `${Math.round(MIN_TRIMMED_ROUTE_METERS / 0.3048 / 10) * 10} ft` : `${MIN_TRIMMED_ROUTE_METERS} m`;
}

/**
 * AV-1022 (TD-091). What a trim in metres hides as a share of the whole route, for the map video's and the
 * map image's fields beside their lengths: "4 % of the route". Empty where there is no route to share.
 */
export function shareOfRouteText(meters: number, totalMeters: number): string {
  if (!(totalMeters > 0) || !(meters >= 0)) return '';
  const percent = Math.min(100, Math.round((meters / totalMeters) * 1000) / 10);
  return `${percent} % of the route`;
}
