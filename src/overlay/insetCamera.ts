import type { Activity, Coordinate } from '../domain/activity';
import { toValidCoordinate } from '../domain/activity';
import { keptRoute, markerVisible, sampleActivityMs, type KeptRoute } from './privacyTrim';
import { MAX_MAP_INSETS, hasInsetMap, isPlainInset, routeInsetOf, type OverlayRouteInsetSetting } from './routeInset';
import type { OverlayComponent, OverlayTemplate } from './template';
import { smoothedValueAt, type OverlaySample, type OverlayTimeline } from './timeline';

/**
 * AV-1023 (TD-092). The route inset's camera and its projection, pure: where the camera is for a
 * moment (the position held in the centre while following, or the fit of the kept route), and how a
 * place becomes a pixel of the inset's box. The projection is Web Mercator with 512-pixel tiles,
 * the rotation by the bearing about the box's centre and no pitch: the one MapLibre draws a flat
 * map with, so a line drawn here over a map lies on its roads (a test holds the two together).
 *
 * The renderer, the preview's live map and the export's off-screen map all take their camera from
 * `createInsetModels`, so they cannot drift. The privacy trim (TD-091) is applied first: only the
 * kept route is framed, and while the moment is in a hidden stretch the camera holds at the kept
 * route's nearest end with no marker, so no part of a hidden stretch is ever looked at.
 */

/** MapLibre's tile size in pixels. */
export const INSET_TILE_PIXELS = 512;
/** The frame height a zoom is chosen at: a smaller or larger frame shows the same ground, drawn smaller or larger. */
export const INSET_REFERENCE_PX = 1080;
/** The most a whole-route fit is zoomed in: a route of one place is a street, not a house. */
export const INSET_FIT_MAX_ZOOM = 17;
/** The share of the box left empty around a whole-route fit, as the line-only inset has. */
export const INSET_FIT_PADDING = 0.08;
/** The same for a round inset: the route's box, corners and all, has to lie inside the circle. */
export const INSET_ROUND_FIT_PADDING = (1 - (1 - 2 * INSET_FIT_PADDING) / Math.SQRT2) / 2;
/** The heading is read smoothed over this long, as the compass reads it, so the map does not swing on GPS noise. */
export const INSET_HEADING_SMOOTHING_SECONDS = 3;
/** The distance a hold's bearing is taken over, in metres: the heading's own (TD-087). */
const HOLD_BEARING_METERS = 20;

export interface InsetCamera {
  /** `[longitude, latitude]`. */
  center: [number, number];
  zoom: number;
  /** Degrees clockwise from north that point up on the box: 0 is north up. */
  bearing: number;
}

export interface InsetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RAD = Math.PI / 180;
const MAX_LAT = 85.0511287798;

/** A place in Web Mercator's unit square: x from the antimeridian eastwards, y down from the north edge. */
export function mercator(lon: number, lat: number): [number, number] {
  const sin = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

/** The place at a point of Web Mercator's unit square; the longitude wrapped into -180..180. */
export function fromMercator(x: number, y: number): [number, number] {
  const lon = (((x * 360 - 180 + 180) % 360) + 360) % 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return [lon, lat];
}

/** The output pixels one reference pixel is, for a frame: the frame's shorter side over the reference. */
export const insetScale = (frame: { width: number; height: number }): number => Math.min(frame.width, frame.height) / INSET_REFERENCE_PX;

export interface InsetProjection {
  /** Output pixels in one unit of the Mercator square at this zoom. */
  world: number;
  /** A point of the Mercator square, as a pixel of the box (relative to its top left). */
  toBox: (x: number, y: number) => [number, number];
  /** A place, as a pixel of the box. */
  project: (lon: number, lat: number) => [number, number];
}

/** Projects onto a box of `width` by `height` output pixels, `scale` output pixels to a reference pixel. */
export function createInsetProjection(camera: InsetCamera, width: number, height: number, scale = 1): InsetProjection {
  const [cx, cy] = mercator(camera.center[0], camera.center[1]);
  const world = INSET_TILE_PIXELS * 2 ** camera.zoom * scale;
  const b = camera.bearing * RAD;
  const cos = Math.cos(b);
  const sin = Math.sin(b);
  const toBox = (x: number, y: number): [number, number] => {
    // The nearest copy of the world, so a route across the antimeridian stays in one piece.
    let dx = x - cx;
    dx -= Math.round(dx);
    const px = dx * world;
    const py = (y - cy) * world;
    return [width / 2 + px * cos + py * sin, height / 2 - px * sin + py * cos];
  };
  return { world, toBox, project: (lon, lat) => toBox(...mercator(lon, lat)) };
}

/**
 * The kept route as the inset draws it: every valid vertex as a place in the Mercator square
 * (longitudes unwrapped from the first, so a route over the antimeridian is continuous), its
 * time in ms (carried forward where a point has none), and the unbroken run it belongs to.
 */
export interface InsetRoute {
  count: number;
  x: Float64Array;
  y: Float64Array;
  /** Activity time in ms since the epoch; `-Infinity` before the first timed point. Never decreasing. */
  ms: Float64Array;
  /** An unbroken stretch of valid fixes: a recorded segment boundary or an invalid fix ends one. */
  run: Int32Array;
  /** Whether any vertex has a time, so the route can be told into behind and ahead. */
  timed: boolean;
  lonLat: (index: number) => [number, number];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const routes = new WeakMap<Activity, InsetRoute | null>();

/** The route of an activity's valid points, once. `undefined` for none. */
export function buildInsetRoute(activity: Activity): InsetRoute | undefined {
  let found = routes.get(activity);
  if (found === undefined) {
    found = build(activity) ?? null;
    routes.set(activity, found);
  }
  return found ?? undefined;
}

function build(activity: Activity): InsetRoute | undefined {
  const xs: number[] = [];
  const ys: number[] = [];
  const mss: number[] = [];
  const runs: number[] = [];
  const lons: number[] = [];
  const lats: number[] = [];
  let run = 0;
  let lastSegment: number | undefined;
  let lastValid = true;
  let firstX: number | undefined;
  let ms = -Infinity;
  let timed = false;
  for (const point of activity.points) {
    const place = toValidCoordinate(point.lat, point.lon);
    const segment = point.segmentIndex ?? 0;
    if (!place) {
      lastValid = false;
      continue;
    }
    if (!lastValid || (lastSegment !== undefined && segment !== lastSegment)) run += 1;
    lastValid = true;
    lastSegment = segment;
    const [rawX, y] = mercator(place.lon, place.lat);
    let x = rawX;
    if (firstX === undefined) firstX = x;
    else {
      let delta = x - firstX;
      delta -= Math.round(delta);
      x = firstX + delta;
    }
    const t = point.time?.getTime();
    if (t !== undefined && Number.isFinite(t)) {
      ms = Math.max(ms, t);
      timed = true;
    }
    xs.push(x);
    ys.push(y);
    mss.push(ms);
    runs.push(run);
    lons.push(place.lon);
    lats.push(place.lat);
  }
  if (xs.length === 0) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    minX = Math.min(minX, xs[i]!);
    maxX = Math.max(maxX, xs[i]!);
    minY = Math.min(minY, ys[i]!);
    maxY = Math.max(maxY, ys[i]!);
  }
  return {
    count: xs.length,
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    ms: Float64Array.from(mss),
    run: Int32Array.from(runs),
    timed,
    lonLat: (index) => [lons[index]!, lats[index]!],
    bounds: { minX, maxX, minY, maxY },
  };
}

/** The camera that fits the whole route in a box of `width` by `height` reference pixels, north up. */
export function fitCamera(route: InsetRoute, width: number, height: number, padding = INSET_FIT_PADDING): InsetCamera {
  const { minX, maxX, minY, maxY } = route.bounds;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const innerW = Math.max(1, width * (1 - 2 * padding));
  const innerH = Math.max(1, height * (1 - 2 * padding));
  const fitX = spanX > 0 ? Math.log2(innerW / (spanX * INSET_TILE_PIXELS)) : Infinity;
  const fitY = spanY > 0 ? Math.log2(innerH / (spanY * INSET_TILE_PIXELS)) : Infinity;
  const zoom = Math.max(0, Math.min(INSET_FIT_MAX_ZOOM, fitX, fitY));
  return { center: fromMercator((minX + maxX) / 2, (minY + maxY) / 2), zoom, bearing: 0 };
}

/** The first vertex whose time is not before `ms`, or `count` where none is. */
export function lowerIndex(route: InsetRoute, ms: number): number {
  let low = 0;
  let high = route.count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (route.ms[mid]! < ms) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The last vertex whose time is not after `ms`, or -1 where none is. */
export function splitIndex(route: InsetRoute, ms: number): number {
  let low = 0;
  let high = route.count - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (route.ms[mid]! <= ms) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

const HEADING_SOURCE = { kind: 'metric', metric: 'heading' } as const;

/** The initial bearing from one place to another, degrees clockwise from north, 0 to 360. */
export function bearingBetween(from: [number, number], to: [number, number]): number {
  const [lon1, lat1] = [from[0] * RAD, from[1] * RAD];
  const [lon2, lat2] = [to[0] * RAD, to[1] * RAD];
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

const metersBetween = (a: [number, number], b: [number, number]): number => {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * The direction the kept route runs at one end, from kept places only: the way out of the first
 * vertex, or the way into the last, over `HOLD_BEARING_METERS`. A heading-up camera held at an end
 * is turned this way, so the hidden stretch's own heading is never read.
 */
export function endBearing(route: InsetRoute, atEnd: boolean): number {
  const step = atEnd ? -1 : 1;
  const anchor = atEnd ? route.count - 1 : 0;
  const a = route.lonLat(anchor);
  for (let i = anchor + step; i >= 0 && i < route.count; i += step) {
    const b = route.lonLat(i);
    if (metersBetween(a, b) >= HOLD_BEARING_METERS) return atEnd ? bearingBetween(b, a) : bearingBetween(a, b);
  }
  return 0;
}

/**
 * The activity time from which the timeline's heading reads only kept places: the time the kept route is `HOLD_BEARING_METERS`
 * along, and the smoothing window after it. `Infinity` where the route never gets that far with a time.
 */
export function headingFreeMs(route: InsetRoute): number {
  const a = route.lonLat(0);
  for (let i = 1; i < route.count; i += 1) {
    if (metersBetween(a, route.lonLat(i)) >= HOLD_BEARING_METERS) return Number.isFinite(route.ms[i]!) ? route.ms[i]! + INSET_HEADING_SMOOTHING_SECONDS * 1000 : Infinity;
  }
  return Infinity;
}

/** The inset at one moment: where the camera is, and where the marker is (absent in a hidden stretch). */
export interface InsetMoment {
  camera: InsetCamera;
  /** Absent while the moment is in a hidden stretch. */
  marker?: Coordinate;
  /** The activity time the trail and the route ahead are cut at, in ms; clamped to the kept route's. */
  nowMs?: number;
}

export interface InsetComponentModel {
  component: OverlayComponent;
  setting: OverlayRouteInsetSetting;
  /** The picture's frame, in output pixels: the component's box, or the square a round inset is drawn in. */
  frame: InsetBox;
  /** Output pixels to a reference pixel. */
  scale: number;
  kept: KeptRoute;
  route: InsetRoute;
  /** The whole-route fit. */
  fit: InsetCamera;
  /** Whether a basemap is drawn behind the line. */
  hasMap: boolean;
  /** `undefined` where the inset is not drawn at this moment (no position). */
  momentAt: (videoTimeSeconds: number) => InsetMoment | undefined;
}

/** The frame an inset is drawn in: its box, or for a round one the circle's square, centred in it. */
export function insetFrame(box: InsetBox, setting: OverlayRouteInsetSetting): InsetBox {
  if (setting.shape !== 'round') return box;
  const side = Math.min(box.w, box.h);
  return { x: box.x + (box.w - side) / 2, y: box.y + (box.h - side) / 2, w: side, h: side };
}

export interface InsetModelInput {
  template: OverlayTemplate;
  timeline: OverlayTimeline;
  activity: Activity | undefined;
  width: number;
  height: number;
}

/**
 * The route insets of a template that are not plain (not drawn the old way), each with what is needed to place
 * it at any moment. Insets whose kept route is too short, or that have no route, are not here: nothing
 * of them is drawn, framed or asked of a tile server.
 */
export function createInsetModels(input: InsetModelInput): Map<string, InsetComponentModel> {
  const { template, timeline, activity, width, height } = input;
  const models = new Map<string, InsetComponentModel>();
  // The plain inset is drawn the old way and needs none of this.
  const drawn = template.components.filter((component) => component.visible && component.type === 'routeInset' && !isPlainInset(component.routeInset));
  if (!activity || drawn.length === 0) return models;
  const kept = keptRoute(activity, template.privacyTrim);
  if (!kept || kept.tooShort) return models;
  const route = buildInsetRoute(kept.activity);
  if (!route) return models;
  const scale = insetScale({ width, height });
  let ends: { first: number; last: number } | undefined;
  const holdBearings = () => (ends ??= { first: endBearing(route, false), last: endBearing(route, true) });
  let free: number | undefined;
  const headingFreeFrom = () => (free ??= headingFreeMs(route));

  const capped = cappedMapIds(template.components);
  for (const component of drawn) {
    const setting = routeInsetOf(component.routeInset);
    const box: InsetBox = { x: component.rect.x * width, y: component.rect.y * height, w: component.rect.width * width, h: component.rect.height * height };
    const frame = insetFrame(box, setting);
    const fit = fitCamera(route, frame.w / scale, frame.h / scale, setting.shape === 'round' ? INSET_ROUND_FIT_PADDING : INSET_FIT_PADDING);
    const momentAt = (videoTimeSeconds: number): InsetMoment | undefined => {
      const sample = timeline.sampleAt(videoTimeSeconds);
      if (!sample?.position) return undefined;
      return momentOf(setting, kept, route, fit, timeline, sample, holdBearings, headingFreeFrom);
    };
    models.set(component.id, { component, setting, frame, scale, kept, route, fit, hasMap: capped.has(component.id), momentAt });
  }
  return models;
}

function momentOf(
  setting: OverlayRouteInsetSetting,
  kept: KeptRoute,
  route: InsetRoute,
  fit: InsetCamera,
  timeline: OverlayTimeline,
  sample: OverlaySample,
  holdBearings: () => { first: number; last: number },
  headingFreeFrom: () => number,
): InsetMoment {
  const ms = sampleActivityMs(timeline, sample);
  const visible = markerVisible(kept, ms);
  // Past the cut end the hold is the last kept vertex; before the cut start (or where no moment can be told) the first.
  const atEnd = !visible && ms !== undefined && kept.endMs !== undefined && ms > kept.endMs;
  const held = route.lonLat(atEnd ? route.count - 1 : 0);
  const marker: Coordinate | undefined = visible ? sample.position : undefined;
  const nowMs = visible ? ms : route.timed ? route.ms[atEnd ? route.count - 1 : 0] : undefined;
  const shown = marker ?? { lat: held[1], lon: held[0] };
  if (setting.view === 'whole') return { camera: fit, ...(marker ? { marker } : {}), ...(nowMs !== undefined && Number.isFinite(nowMs) ? { nowMs } : {}) };
  let bearing = 0;
  if (setting.orientation === 'heading') {
    // The heading is the bearing from the place 20 m back, smoothed over a window that looks back as well: until the kept route is 20 m
    // along and a window further, what it reads is partly the hidden stretch, so the kept route's own direction is used there (a
    // stop near the cut holds that direction too).
    const nearCut = visible && ms !== undefined && kept.startMs !== undefined && ms < headingFreeFrom();
    if (nearCut) {
      bearing = holdBearings().first;
    } else if (visible) {
      const heading = smoothedValueAt(timeline, HEADING_SOURCE, sample.videoTimeSeconds, INSET_HEADING_SMOOTHING_SECONDS) ?? sample.values['metric:heading'];
      bearing = typeof heading === 'number' && Number.isFinite(heading) ? heading : 0;
    } else {
      const bearings = holdBearings();
      bearing = atEnd ? bearings.last : bearings.first;
    }
  }
  return {
    camera: { center: [shown.lon, shown.lat], zoom: setting.zoom, bearing: ((bearing % 360) + 360) % 360 },
    ...(marker ? { marker } : {}),
    ...(nowMs !== undefined && Number.isFinite(nowMs) ? { nowMs } : {}),
  };
}

/**
 * The insets that really carry a map: the first `MAX_MAP_INSETS` with one, in layer order, hidden ones counted as the
 * layout file counts them. A duplicate or a toggled visibility cannot make a third map: each is a WebGL map the page holds open.
 */
export function cappedMapIds(components: readonly OverlayComponent[]): Set<string> {
  const ids = new Set<string>();
  for (const component of components) {
    if (component.type === 'routeInset' && hasInsetMap(component.routeInset) && ids.size < MAX_MAP_INSETS) ids.add(component.id);
  }
  return ids;
}

/** Whether a template draws any basemap in a route inset, which is what makes an export need a page's maps. */
export const hasMapInset = (template: OverlayTemplate): boolean => mapInsetIds(template).length > 0;

/** The ids of the insets a template gives a basemap to. */
export const mapInsetIds = (template: OverlayTemplate): string[] => {
  const capped = cappedMapIds(template.components);
  return template.components.filter((component) => component.visible && capped.has(component.id)).map((component) => component.id);
};
