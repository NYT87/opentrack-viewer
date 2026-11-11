import type { Activity } from '../domain/activity';
import { metersPerPixel } from '../mapVideo/model';
import { buildMapVideoRoute, simplifiedIndices, trimRoute, type MapVideoRoute } from '../mapVideo/route';
import { MAP_IMAGE_LIMITS, type MapImageCamera, type MapImageSettings } from './settings';

/**
 * AV-1013. The route a map image draws and where the map is looked at from.
 * Pure: the preview, the export and the tests read the same numbers.
 */

export type ImageRouteResult = { ok: true; route: MapVideoRoute } | { ok: false; error: string };

/** The route as the image draws it: after the privacy trim, which is the only route the fit, the line and the profile see. */
export function imageRoute(activity: Activity, trim: MapImageSettings['privacyTrim']): ImageRouteResult {
  const full = buildMapVideoRoute(activity);
  if (!full) return { ok: false, error: 'This activity has fewer than two points with a location, so there is no route to draw.' };
  const route = trimRoute(full, trim.startMeters, trim.endMeters);
  if (!route) return { ok: false, error: 'The privacy trim leaves less than 100 m of the route. Trim less, or choose a longer activity.' };
  return { ok: true, route };
}

/** The vertices worth drawing at `zoom`: none strays more than half a pixel from the line. */
export function drawnAtZoom(route: MapVideoRoute, zoom: number): number[] {
  const middle = route.vertices[Math.floor(route.vertices.length / 2)]!;
  return simplifiedIndices(route, metersPerPixel(zoom, middle.lat) / 2);
}

/** MapLibre's world at zoom 0: 512 pixels square, y down. */
const WORLD = 512;

export function project(lon: number, lat: number): [number, number] {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * WORLD, (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * WORLD];
}

export function unproject(x: number, y: number): [number, number] {
  const lon = (x / WORLD) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * Where a world point lands on a picture `size` pixels across, looked at from
 * `camera`: the picture's own pixels, y down, its top left at 0, 0. A bearing
 * turns the map so that direction is up.
 */
export function toScreen(lon: number, lat: number, camera: MapImageCamera, size: { width: number; height: number }): [number, number] {
  const [cx, cy] = project(camera.center[0], camera.center[1]);
  const [x, y] = project(lon, lat);
  const scale = 2 ** camera.zoom;
  const theta = (-camera.bearing * Math.PI) / 180;
  const dx = (x - cx) * scale;
  const dy = (y - cy) * scale;
  return [size.width / 2 + dx * Math.cos(theta) - dy * Math.sin(theta), size.height / 2 + dx * Math.sin(theta) + dy * Math.cos(theta)];
}

/** The share of each side left clear around a fitted route. */
export const FIT_MARGIN = 0.08;
/** The nearest a fit comes, so a short route is not drawn at a single street's scale. */
const MAX_FIT_ZOOM = 17;

/**
 * The camera that shows the whole route on a map `size` pixels across, turned
 * to `bearing`, with `FIT_MARGIN` clear on every side: the route's extent is
 * measured across the turned picture, so a long route turned across the
 * image is fitted to its width, not its height.
 */
export function fitCamera(route: MapVideoRoute, size: { width: number; height: number }, bearing = 0): MapImageCamera {
  const theta = (-bearing * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const vertex of route.vertices) {
    const [x, y] = project(vertex.lon, vertex.lat);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  // The middle of the turned extent, turned back into the world.
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const center = unproject(mx * cos + my * sin, -mx * sin + my * cos);
  const usable = 1 - 2 * FIT_MARGIN;
  const scale = Math.min(
    maxX > minX ? (size.width * usable) / (maxX - minX) : Infinity,
    maxY > minY ? (size.height * usable) / (maxY - minY) : Infinity,
  );
  const zoom = Number.isFinite(scale) ? Math.log2(scale) : MAX_FIT_ZOOM;
  return { center, zoom: clampZoom(Math.min(MAX_FIT_ZOOM, zoom)), bearing: normalizeBearing(bearing) };
}

export function clampZoom(zoom: number): number {
  return Math.min(MAP_IMAGE_LIMITS.zoom[1], Math.max(MAP_IMAGE_LIMITS.zoom[0], zoom));
}

/** A heading in 0 to 360. */
export function normalizeBearing(bearing: number): number {
  const turned = bearing % 360;
  return turned < 0 ? turned + 360 : turned === 0 ? 0 : turned;
}

/**
 * The camera at another size: the same place in the middle and the same
 * heading, zoomed so the same stretch of the world spans the picture's width.
 * The preview draws at its own size and the export at the image's.
 */
export function cameraAtWidth(camera: MapImageCamera, fromWidth: number, toWidth: number): MapImageCamera {
  return { ...camera, zoom: camera.zoom + Math.log2(toWidth / fromWidth) };
}
