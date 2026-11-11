import type { MapVideoCamera } from '../camera';
import type { MapVideoModel } from '../model';
import type { MapVideoSettings } from '../project';

/**
 * AV-1209. How many OpenFreeMap tiles an export will ask for, counted before
 * it starts from the camera path. OpenFreeMap's terms allow automated
 * collection of at most 3,000 tiles at a time (TD-064), so a longer or closer
 * video is not started: the panel says which zoom fits instead (TD-072).
 */

export const OPENFREEMAP_TILE_BUDGET = 3000;
/** OpenFreeMap's vector tiles stop here; the map draws them larger beyond it. */
const VECTOR_MAX_ZOOM = 14;
/** Vector tiles are 512 pixels a side at their own zoom. */
const TILE_PIXELS = 512;
/** MapLibre asks for tiles a little past the frame's edge, so a view is counted this much larger. */
const MARGIN = 1.25;
/** MapLibre's vertical field of view (its default, which the app keeps). */
const FOV = 0.6435011087932844;
/**
 * How much further than the centre a part of the view may be before MapLibre
 * draws it from coarser tiles: `1 / cos(FOV / 2)`, its own threshold. It does
 * so only with terrain on: without, it keeps one zoom up to a 60° tilt, the
 * app's steepest (TD-078).
 */
const COARSER_FROM = 1 / Math.cos(FOV / 2);
/** Bands a tilted view is cut into, near to far, each counted with what MapLibre may load there. */
const BANDS = 8;
/** The steepest a ray is followed: short of the horizon, which the app's 60° tilt never shows. */
const MAX_RAY = (85 * Math.PI) / 180;

const toRadians = Math.PI / 180;
const mercatorX = (lon: number) => (lon + 180) / 360;
const mercatorY = (lat: number) => {
  const sin = Math.sin(lat * toRadians);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
};

type Corner = [number, number];

/** A tile as a number: zoom, column and row packed (zoom ≤ 14, so column and row are under 2^14). */
const key = (z: number, x: number, y: number) => (z * 16384 + x) * 16384 + y;

/**
 * Every tile a convex polygon overlaps at a zoom of `n` tiles a side, row by
 * row: where the polygon crosses each row of tiles, from its edges, so no tile
 * outside it is counted and none inside is tested on its own.
 */
function eachTile(polygon: Corner[], n: number, visit: (x: number, y: number) => void): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of polygon) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let row = Math.max(0, Math.floor(minY)); row <= Math.min(n - 1, Math.floor(maxY)); row += 1) {
    const top = Math.max(row, minY);
    const bottom = Math.min(row + 1, maxY);
    let from = Infinity;
    let to = -Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
      const [ax, ay] = polygon[i]!;
      const [bx, by] = polygon[(i + 1) % polygon.length]!;
      // The part of this edge within the row, by its ends.
      const low = Math.max(top, Math.min(ay, by));
      const high = Math.min(bottom, Math.max(ay, by));
      if (low > high) continue;
      if (ay === by) {
        // Lying along the row: all of it.
        from = Math.min(from, ax, bx);
        to = Math.max(to, ax, bx);
        continue;
      }
      for (const y of [low, high]) {
        const x = ax + ((bx - ax) * (y - ay)) / (by - ay);
        from = Math.min(from, x);
        to = Math.max(to, x);
      }
    }
    if (from > to) continue;
    for (let x = Math.floor(from); x <= Math.floor(to); x += 1) visit(((x % n) + n) % n, row);
  }
}

/**
 * The tiles one view covers, generously: the frame's footprint on the ground,
 * as MapLibre's camera sees it (its field of view, tilted), turned by the
 * heading. Where a part of a tilted view is further than MapLibre's threshold,
 * the coarser tiles it may load there instead are counted as well, since a
 * place seen far off and later near is asked for at both.
 */
function addView(tiles: Set<number>, camera: MapVideoCamera, width: number, height: number, terrain: boolean): void {
  const z = Math.max(0, Math.min(VECTOR_MAX_ZOOM, Math.floor(camera.zoom)));
  const n = 2 ** z;
  // Tiles per pixel at this camera's zoom, and the untilted frame's half sides in tiles.
  const scale = 2 ** (z - camera.zoom) / TILE_PIXELS;
  const halfW = (width / 2) * scale * MARGIN;
  const halfH = (height / 2) * scale * MARGIN;
  // The camera, `distance` from the centre along its view: `up` above the ground, `back` behind the centre.
  const pitch = Math.min(camera.pitch * toRadians, MAX_RAY - FOV / 2);
  const distance = halfH / Math.tan(FOV / 2);
  const up = distance * Math.cos(pitch);
  const back = distance * Math.sin(pitch);
  /** The ray `a` from the view's axis (−FOV/2 the bottom edge, +FOV/2 the top): where it meets the ground, its half width there, how far it is. */
  const ray = (a: number) => {
    const angle = Math.min(MAX_RAY, pitch + a);
    const along = up * Math.tan(angle) - back;
    const reach = up / Math.cos(angle);
    return { along, half: (halfW * reach * Math.cos(a)) / distance, ratio: reach / distance };
  };

  const bearing = camera.bearing * toRadians;
  const cos = Math.cos(bearing);
  const sin = Math.sin(bearing);
  const cx = mercatorX(camera.center[0]) * n;
  const cy = mercatorY(camera.center[1]) * n;
  // Turned to the heading; y grows southward in tile space.
  const place = ([x, y]: Corner): Corner => [cx + x * cos + y * sin, cy - (-x * sin + y * cos)];
  const quad = (near: ReturnType<typeof ray>, far: ReturnType<typeof ray>): Corner[] =>
    ([[-near.half, near.along], [near.half, near.along], [far.half, far.along], [-far.half, far.along]] as Corner[]).map(place);

  // The whole footprint at the view's zoom.
  eachTile(quad(ray(-FOV / 2), ray(FOV / 2)), n, (x, y) => tiles.add(key(z, x, y)));
  if (!terrain || camera.pitch <= 0) return;
  // With terrain, band by band, the coarser tiles MapLibre draws there: tilted, it may take even the centre a
  // level coarser, so every band one level, and one more for each doubling (or part of one) past its threshold.
  for (let band = 0; band < BANDS; band += 1) {
    const near = ray(-FOV / 2 + (FOV * band) / BANDS);
    const far = ray(-FOV / 2 + (FOV * (band + 1)) / BANDS);
    // The coarse tiles a band overlaps are the parents of the fine ones it does, and fewer to walk.
    const coarser = Math.min(z, 1 + Math.max(0, Math.ceil(Math.log2(far.ratio / COARSER_FROM))));
    const footprint = quad(near, far);
    for (let level = 1; level <= coarser; level += 1) {
      const shrink = 2 ** level;
      eachTile(footprint.map(([x, y]) => [x / shrink, y / shrink] as Corner), n / shrink, (x, y) => tiles.add(key(z - level, x, y)));
    }
  }
}

const sameView = (a: MapVideoCamera, b: MapVideoCamera) =>
  a.zoom === b.zoom && a.pitch === b.pitch && a.bearing === b.bearing && a.center[0] === b.center[0] && a.center[1] === b.center[1];

/**
 * The basemap tiles an export would ask for: every frame's view, read from
 * the camera alone (no line is built), so a fast camera on a long route
 * leaves no stretch uncounted between two looks.
 */
export function estimateBasemapTiles(model: MapVideoModel, settings: Pick<MapVideoSettings, 'output' | 'terrain'>): number {
  const { width, height } = settings.output;
  const terrain = settings.terrain.enabled;
  const tiles = new Set<number>();
  let last: MapVideoCamera | undefined;
  for (let frame = 0; frame < model.frameCount; frame += 1) {
    const camera = model.camera.atSeconds(model.timeline.frameSeconds(frame, model.frameCount));
    // A frame that does not move (a stop, a photo's wait) sees what the last one did.
    if (last && sameView(last, camera)) continue;
    addView(tiles, camera, width, height, terrain);
    last = camera;
  }
  return tiles.size;
}
