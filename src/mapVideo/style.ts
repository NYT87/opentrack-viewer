import type { Activity } from '../domain/activity';
import type { MapVideoColorBy, MapVideoSettings } from './project';
import { positionAt, type MapVideoRoute } from './route';
import { timeModeRefusal } from './timing';
import { MAPTILER_CREDIT, OPENFREEMAP_CREDIT } from '../overlay/routeInset';

/**
 * AV-1205. How a map video is styled, as data: what the route's colour can
 * show for this activity, the colour of each stretch, the marker's heading
 * and trail, and the credit each map source asks for. Pure, so the preview
 * and the export (AV-1209) style a frame the same way.
 */

/** Seven steps from cool to hot; each stays readable over light and dark maps. */
export const COLOR_BY_PALETTE = ['#2c7bb6', '#00a6ca', '#00ccbc', '#90eb9d', '#f9d057', '#f29e2e', '#d7191c'] as const;

export interface ColorByChoice {
  value: MapVideoColorBy;
  label: string;
  available: boolean;
  /** Why it cannot be chosen for this activity. */
  reason?: string;
}

/** The colouring choices, each available or not for this activity, with the reason when not. */
export function colorByChoices(activity: Activity, route: MapVideoRoute): ColorByChoice[] {
  const timed = timeModeRefusal(route) === undefined;
  const elevations = route.vertices.filter((vertex) => vertex.elevation !== undefined).length;
  const heartRates = route.vertices.filter((vertex) => Number.isFinite(activity.points[vertex.pointIndex]?.heartRateBpm)).length;
  const enough = (count: number) => count >= Math.max(2, route.vertices.length / 2);
  return [
    { value: 'none', label: 'One colour', available: true },
    timed
      ? { value: 'speed', label: 'Speed', available: true }
      : { value: 'speed', label: 'Speed', available: false, reason: 'Not every point has a time, so there is no speed to show.' },
    enough(elevations)
      ? { value: 'elevation', label: 'Elevation', available: true }
      : { value: 'elevation', label: 'Elevation', available: false, reason: 'This activity records no elevation for most of its points.' },
    enough(heartRates)
      ? { value: 'heartRate', label: 'Heart rate', available: true }
      : { value: 'heartRate', label: 'Heart rate', available: false, reason: 'This activity records no heart rate for most of its points.' },
  ];
}

/** Speed at each vertex, averaged over the points within ±`meters` of it. */
function vertexSpeeds(route: MapVideoRoute, meters = 50): (number | undefined)[] {
  const { vertices } = route;
  let lo = 0;
  let hi = 0;
  return vertices.map((vertex, i) => {
    while (vertices[lo]!.distance < vertex.distance - meters || vertices[lo]!.segment !== vertex.segment) lo += 1;
    hi = Math.max(hi, i);
    while (hi + 1 < vertices.length && vertices[hi + 1]!.distance <= vertex.distance + meters && vertices[hi + 1]!.segment === vertex.segment) hi += 1;
    const seconds = (vertices[hi]!.time! - vertices[lo]!.time!) / 1000;
    return seconds > 0 ? (vertices[hi]!.distance - vertices[lo]!.distance) / seconds : undefined;
  });
}

function rawValues(activity: Activity, route: MapVideoRoute, by: Exclude<MapVideoColorBy, 'none'>): (number | undefined)[] {
  if (by === 'speed') return vertexSpeeds(route);
  if (by === 'elevation') return route.vertices.map((vertex) => vertex.elevation);
  return route.vertices.map((vertex) => {
    const value = activity.points[vertex.pointIndex]?.heartRateBpm;
    return Number.isFinite(value) ? value : undefined;
  });
}

export interface RouteColors {
  /** The palette step of each vertex of the route. */
  bins: Uint8Array;
  /** The values the first and last steps stand for, in the measurement's own unit. */
  low: number;
  high: number;
}

/**
 * The colour step of each vertex for `by`, or undefined for one colour. The
 * scale runs from the 5th to the 95th percentile, so one GPS spike or a
 * stop does not wash the rest of the route into one colour. A vertex without
 * a value takes its neighbour's.
 */
export function routeColors(activity: Activity, route: MapVideoRoute, by: MapVideoColorBy): RouteColors | undefined {
  if (by === 'none') return undefined;
  const values = rawValues(activity, route, by);
  const known = values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  if (known.length === 0) return undefined;
  const low = known[Math.floor(known.length * 0.05)]!;
  const high = known[Math.min(known.length - 1, Math.floor(known.length * 0.95))]!;
  const steps = COLOR_BY_PALETTE.length;
  const bins = new Uint8Array(values.length);
  let previous = values.find((value) => value !== undefined)!;
  values.forEach((value, i) => {
    const v = value ?? previous;
    previous = v;
    const t = high > low ? (v - low) / (high - low) : 0.5;
    bins[i] = Math.min(steps - 1, Math.max(0, Math.floor(t * steps)));
  });
  return { bins, low, high };
}

/**
 * The vertices to draw a coloured line through: the simplified ones, and
 * every vertex where the colour steps, which simplification alone would drop
 * on a straight road whose speed or height changes along it.
 */
export function drawnWithColorSteps(kept: number[], colors: RouteColors): number[] {
  const all = new Set(kept);
  for (let i = 1; i < colors.bins.length; i += 1) if (colors.bins[i] !== colors.bins[i - 1]) all.add(i);
  return [...all].sort((a, b) => a - b);
}

/** A stretch of the drawn line in one colour step. */
export interface ColoredRun {
  bin: number;
  line: [number, number][];
}

/**
 * The drawn line up to the marker (as `revealAt` draws it, through `kept`),
 * cut into runs of one colour step. Each run starts where the last ended, so
 * the line is unbroken; a gap between segments breaks it, as always.
 */
export function coloredRuns(route: MapVideoRoute, distance: number, kept: number[], colors: RouteColors): ColoredRun[] {
  const position = positionAt(route, distance);
  const runs: ColoredRun[] = [];
  let line: [number, number][] = [];
  let bin = -1;
  let segment: number | undefined;
  for (const i of kept) {
    if (i > position.index) break;
    const vertex = route.vertices[i]!;
    const point: [number, number] = [vertex.lon, vertex.lat];
    if (segment !== undefined && vertex.segment !== segment) {
      // A gap: the run ends, and the next starts on its own.
      runs.push({ bin, line });
      line = [point];
      bin = colors.bins[i]!;
    } else if (line.length === 0) {
      line = [point];
      bin = colors.bins[i]!;
    } else if (colors.bins[i] !== bin) {
      // A new colour: the run ends here, and the next begins at the same place.
      line.push(point);
      runs.push({ bin, line });
      line = [point];
      bin = colors.bins[i]!;
    } else {
      line.push(point);
    }
    segment = vertex.segment;
  }
  const marker: [number, number] = [position.lon, position.lat];
  const last = line[line.length - 1];
  if (!last || last[0] !== marker[0] || last[1] !== marker[1]) line.push(marker);
  runs.push({ bin, line });
  return runs;
}

/** The route's direction at a place, in degrees clockwise from north, over ±`meters`. */
export function headingAt(route: MapVideoRoute, distance: number, meters = 15): number {
  const a = positionAt(route, distance - meters);
  const b = positionAt(route, distance + meters);
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

/** The stretch of route behind the marker that its trail covers, oldest place first. */
export function trailAt(route: MapVideoRoute, distance: number, meters: number): [number, number][] {
  const start = positionAt(route, distance - meters);
  const end = positionAt(route, distance);
  const line: [number, number][] = [[start.lon, start.lat]];
  for (let i = start.index + 1; i <= end.index; i += 1) {
    const vertex = route.vertices[i]!;
    // The trail never crosses a gap between segments: it starts again after one.
    if (vertex.segment !== route.vertices[i - 1]!.segment) line.length = 0;
    line.push([vertex.lon, vertex.lat]);
  }
  const last = line[line.length - 1];
  if (!last || last[0] !== end.lon || last[1] !== end.lat) line.push([end.lon, end.lat]);
  return line;
}

/** Whether 3D terrain is drawn: asked for, and over a map, since route only fetches nothing. */
export function terrainActive(settings: MapVideoSettings): boolean {
  return settings.terrain.enabled && settings.basemap.source !== 'route-only';
}

/** AWS Terrain Tiles, from the bucket's own host: CORS-enabled, and the one host the policy allows for terrain. */
export const TERRAIN_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';

/** The full credit the terrain's sources ask for (Mapzen's joerd attribution), for the outro card (AV-1207). */
export const TERRAIN_FULL_CREDIT =
  'Terrain tiles by Mapzen, on AWS Open Data. Elevation from: ArcticDEM (Polar Geospatial Center, NSF); ' +
  'EU-DEM (produced using Copernicus data and information funded by the European Union); ' +
  'Geoscience Australia; Natural Resources Canada (CDEM); Kartverket (Norway DEM); NOAA ETOPO1; ' +
  'INEGI (Mexico); NZ Land Information; SRTM (U.S. Geological Survey); USGS NED and 3DEP; GMTED2010.';

/**
 * The credit drawn in every frame, which no setting turns off (TD-064): the
 * map's source, and the terrain's in short when it is drawn. Route only uses
 * no one's map, and credits no one.
 */
export function mapVideoAttribution(settings: MapVideoSettings): string | undefined {
  const parts: string[] = [];
  if (settings.basemap.source === 'online') parts.push(OPENFREEMAP_CREDIT);
  if (settings.basemap.source === 'maptiler') parts.push(MAPTILER_CREDIT);
  if (terrainActive(settings)) parts.push('Terrain: Mapzen, AWS Open Data, USGS, Copernicus and others');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
