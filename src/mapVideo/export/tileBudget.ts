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
/** A tilted camera sees further ahead; MapLibre's far plane stops it at about this many times the near distance. */
const MAX_FAR = 3;
/** MapLibre asks for tiles a little past the frame's edge, so a view is counted this much larger. */
const MARGIN = 1.25;

const toRadians = Math.PI / 180;
const mercatorX = (lon: number) => (lon + 180) / 360;
const mercatorY = (lat: number) => {
  const sin = Math.sin(lat * toRadians);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
};

/** The tiles one view covers, generously: the frame's footprint on the ground, turned by the heading. */
function addView(tiles: Set<string>, camera: MapVideoCamera, width: number, height: number): void {
  const z = Math.max(0, Math.min(VECTOR_MAX_ZOOM, Math.floor(camera.zoom)));
  const n = 2 ** z;
  // Tiles per pixel at this camera's zoom.
  const scale = 2 ** (z - camera.zoom) / TILE_PIXELS;
  const halfW = (width / 2) * scale * MARGIN;
  const halfH = (height / 2) * scale * MARGIN;
  const far = Math.min(MAX_FAR, 1 / Math.max(1e-6, Math.cos(camera.pitch * toRadians)));
  // Near edge as it is; far edge further and wider, as perspective makes it.
  const corners: [number, number][] = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW * far, halfH * far],
    [-halfW * far, halfH * far],
  ];
  const bearing = camera.bearing * toRadians;
  const cx = mercatorX(camera.center[0]) * n;
  const cy = mercatorY(camera.center[1]) * n;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    // Turned to the heading; y grows southward in tile space.
    const tx = cx + x * Math.cos(bearing) + y * Math.sin(bearing);
    const ty = cy - (-x * Math.sin(bearing) + y * Math.cos(bearing));
    minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
    minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
  }
  for (let x = Math.floor(minX); x <= Math.floor(maxX); x += 1) {
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(n - 1, Math.floor(maxY)); y += 1) {
      tiles.add(`${z}/${((x % n) + n) % n}/${y}`);
    }
  }
}

/**
 * The basemap tiles an export would ask for: every frame's view, read from
 * the camera alone (no line is built), so a fast camera on a long route
 * leaves no stretch uncounted between two looks.
 */
export function estimateBasemapTiles(model: MapVideoModel, settings: Pick<MapVideoSettings, 'output'>): number {
  const { width, height } = settings.output;
  const tiles = new Set<string>();
  for (let frame = 0; frame < model.frameCount; frame += 1) {
    addView(tiles, model.camera.atSeconds(model.timeline.frameSeconds(frame, model.frameCount)), width, height);
  }
  return tiles.size;
}
