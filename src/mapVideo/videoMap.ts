import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Activity } from '../domain/activity';
import { MARKER_ICON_PIXELS, markerIconImage, sportIcon } from './markerIcons';
import type { MapVideoModel } from './model';
import type { MapVideoSettings } from './project';
import { revealAt } from './route';
import {
  COLOR_BY_PALETTE,
  TERRAIN_TILES,
  coloredRuns,
  drawnWithColorSteps,
  headingAt,
  routeColors,
  terrainActive,
  trailAt,
  type RouteColors,
} from './style';

/**
 * AV-1209. The map of a map video, as the preview and the export both draw
 * it: one style, one set of layers, one way of drawing a frame. Kept apart
 * from either so they cannot drift (TD-067, TD-072). Only MapLibre's types
 * are imported here; the map itself is made by whoever draws.
 */

/** OpenFreeMap's styles, keyless and allowed for video with attribution (TD-064). */
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/';
/** MapTiler's styles, asked for with the reader's own key. */
export const MAPTILER_STYLE_URL = 'https://api.maptiler.com/maps/';

/** The style a map video's basemap is drawn from, or undefined for route only, or MapTiler without a key. */
export function basemapStyleUrl(settings: MapVideoSettings, maptilerKey: string): string | undefined {
  if (settings.basemap.source === 'online') return `${OPENFREEMAP_STYLE_URL}${settings.basemap.style}`;
  if (settings.basemap.source === 'maptiler') {
    const key = maptilerKey.trim();
    return key ? `${MAPTILER_STYLE_URL}${settings.basemap.maptilerStyle}/style.json?key=${encodeURIComponent(key)}` : undefined;
  }
  return undefined;
}

/** The page's own surface colour for route only, when no element says otherwise. */
export const ROUTE_ONLY_BACKGROUND = '#11161c';

/**
 * Route only: a background and nothing else, so no tile, glyph or sprite is
 * ever asked for.
 */
export function routeOnlyStyle(background: string = ROUTE_ONLY_BACKGROUND): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }] };
}

const REST = 'map-video-rest';
const REVEAL = 'map-video-reveal';
const CASING = 'map-video-reveal-casing';
const TRAIL = 'map-video-trail';
const MARKER = 'map-video-marker';
const MARKER_ICON = 'map-video-marker-icon';
const ENDS = 'map-video-ends';
const DEM = 'map-video-dem';
const OWN_SOURCES = [REST, REVEAL, TRAIL, MARKER, ENDS];

/** Whether a source is the route's own, which never fails over the network, rather than the map's. */
export const isOwnSource = (sourceId: string | undefined) => sourceId !== undefined && OWN_SOURCES.includes(sourceId);

/** How far behind the marker its trail reaches, in metres. */
const TRAIL_METERS = 400;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const lineFeature = (coordinates: [number, number][], properties: Record<string, unknown> = {}): Feature<LineString> => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates },
});
const pointFeature = (coordinates: [number, number], properties: Record<string, unknown> = {}): Feature<Point> => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates },
});

/** What the route's line is drawn from: the route, and the vertices worth drawing. */
export type RouteLine = Pick<MapVideoModel, 'route' | 'drawn'>;

/** The route's colours, and the vertices a coloured line is drawn through, or undefined for one colour. */
export type VideoMapColors = RouteColors & { drawn: number[] };

export function videoMapColors(activity: Activity, model: RouteLine, settings: Pick<MapVideoSettings, 'route'>): VideoMapColors | undefined {
  const steps = routeColors(activity, model.route, settings.route.colorBy);
  return steps && { ...steps, drawn: drawnWithColorSteps(model.drawn, steps) };
}

/** The drawn line's colour: one, or a step of the palette per run. */
function revealColor(settings: MapVideoSettings, colored: boolean): string | ExpressionSpecification {
  if (!colored) return settings.route.color;
  const steps = COLOR_BY_PALETTE.flatMap((color, bin) => [bin, color]);
  return ['match', ['get', 'bin'], ...steps, settings.route.color] as unknown as ExpressionSpecification;
}

function restData(model: RouteLine): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  let line: [number, number][] = [];
  let segment: number | undefined;
  for (const i of model.drawn) {
    const vertex = model.route.vertices[i]!;
    if (segment !== undefined && vertex.segment !== segment && line.length > 0) {
      features.push(lineFeature(line));
      line = [];
    }
    segment = vertex.segment;
    line.push([vertex.lon, vertex.lat]);
  }
  features.push(lineFeature(line));
  return { type: 'FeatureCollection', features };
}

/** The route's sources and layers, and the terrain, added once the map's style has loaded. */
export function installVideoLayers(map: MapLibreMap, settings: MapVideoSettings): void {
  for (const id of OWN_SOURCES) map.addSource(id, { type: 'geojson', data: EMPTY, ...(id === TRAIL ? { lineMetrics: true } : {}) });
  if (terrainActive(settings)) {
    map.addSource(DEM, { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
    map.setTerrain({ source: DEM, exaggeration: settings.terrain.exaggeration });
  }
  const round = { 'line-join': 'round', 'line-cap': 'round' } as const;
  map.addLayer({ id: REST, type: 'line', source: REST, layout: round, paint: { 'line-opacity': 0.35 } });
  map.addLayer({ id: CASING, type: 'line', source: REVEAL, layout: round, paint: {} });
  map.addLayer({ id: REVEAL, type: 'line', source: REVEAL, layout: round, paint: {} });
  map.addLayer({ id: TRAIL, type: 'line', source: TRAIL, layout: round, paint: {} });
  map.addLayer({
    id: ENDS,
    type: 'circle',
    source: ENDS,
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'end'], 'start', '#2fbf71', '#1a1a1a'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
      'circle-pitch-alignment': 'map',
    },
  });
  map.addLayer({ id: MARKER, type: 'circle', source: MARKER, paint: { 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3, 'circle-pitch-alignment': 'map' } });
  map.addLayer({
    id: MARKER_ICON,
    type: 'symbol',
    source: MARKER,
    layout: {
      'icon-image': MARKER_ICON,
      'icon-rotate': ['get', 'rotate'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

/** The route's look for a model and settings: the rest of the route, the ends, the paint, the marker, the terrain. */
export function styleVideoMap(map: MapLibreMap, activity: Activity, model: RouteLine, settings: MapVideoSettings, colors: VideoMapColors | undefined): void {
  const { route, marker, endpoints, terrain: relief } = settings;
  (map.getSource(REST) as GeoJSONSource | undefined)?.setData(route.unrevealed === 'hidden' ? EMPTY : restData(model));
  const first = model.route.vertices[0]!;
  const last = model.route.vertices[model.route.vertices.length - 1]!;
  (map.getSource(ENDS) as GeoJSONSource | undefined)?.setData(
    endpoints.shown
      ? { type: 'FeatureCollection', features: [pointFeature([first.lon, first.lat], { end: 'start' }), pointFeature([last.lon, last.lat], { end: 'finish' })] }
      : EMPTY,
  );
  map.setPaintProperty(REST, 'line-color', route.color);
  map.setPaintProperty(REST, 'line-width', Math.max(1, route.width * 0.6));
  map.setPaintProperty(REVEAL, 'line-color', revealColor(settings, colors !== undefined));
  map.setPaintProperty(REVEAL, 'line-width', route.width);
  map.setPaintProperty(CASING, 'line-color', route.casingColor);
  map.setPaintProperty(CASING, 'line-width', route.width + 4);
  map.setLayoutProperty(CASING, 'visibility', route.casing ? 'visible' : 'none');
  map.setPaintProperty(TRAIL, 'line-width', route.width * 1.8);
  map.setPaintProperty(TRAIL, 'line-gradient', ['interpolate', ['linear'], ['line-progress'], 0, `${marker.color}00`, 1, `${marker.color}cc`]);
  map.setPaintProperty(MARKER, 'circle-color', marker.color);
  map.setPaintProperty(MARKER, 'circle-radius', marker.size / 2);
  const icon = markerIconImage(marker.shape, sportIcon(activity.metadata.sport), marker.color);
  if (map.hasImage(MARKER_ICON)) map.removeImage(MARKER_ICON);
  if (icon) map.addImage(MARKER_ICON, icon, { pixelRatio: 1 });
  map.setLayoutProperty(MARKER, 'visibility', marker.shape === 'dot' || !icon ? 'visible' : 'none');
  map.setLayoutProperty(MARKER_ICON, 'visibility', marker.shape !== 'dot' && icon ? 'visible' : 'none');
  map.setLayoutProperty(MARKER_ICON, 'icon-size', marker.size / MARKER_ICON_PIXELS);
  if (terrainActive(settings)) map.setTerrain({ source: DEM, exaggeration: relief.exaggeration });
}

/**
 * The moment `at` of the video on the map: the camera, the drawn line, the
 * trail and the marker. `zoomOffset` is log₂ of the drawn width over the
 * video's, so a smaller preview frames what the video does; 0 for the export.
 */
export function drawVideoMap(
  map: MapLibreMap,
  model: MapVideoModel,
  settings: MapVideoSettings,
  colors: VideoMapColors | undefined,
  at: number,
  zoomOffset: number,
): void {
  const frame = model.at(at);
  const { center, zoom, pitch, bearing } = frame.camera;
  map.jumpTo({ center, zoom: zoom + zoomOffset, pitch, bearing });
  const distance = frame.sample.distance;
  const revealed: FeatureCollection<LineString> = colors
    ? {
        type: 'FeatureCollection',
        features: coloredRuns(model.route, distance, colors.drawn, colors)
          .filter((run) => run.line.length > 1)
          .map((run) => lineFeature(run.line, { bin: run.bin })),
      }
    : { type: 'FeatureCollection', features: frame.reveal.lines.filter((line) => line.length > 1).map((line) => lineFeature(line)) };
  (map.getSource(REVEAL) as GeoJSONSource | undefined)?.setData(revealed);
  const trail = settings.marker.trail ? trailAt(model.route, distance, TRAIL_METERS) : [];
  (map.getSource(TRAIL) as GeoJSONSource | undefined)?.setData(trail.length > 1 ? { type: 'FeatureCollection', features: [lineFeature(trail)] } : EMPTY);
  (map.getSource(MARKER) as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: [pointFeature(frame.reveal.marker, { rotate: settings.marker.shape === 'arrow' ? headingAt(model.route, distance) : 0 })],
  });
}

/**
 * AV-1013. The whole route at once, as the video's last frame draws it but
 * with no marker or trail: for a still map, whose camera its owner sets.
 */
export function drawWholeRoute(map: MapLibreMap, line: RouteLine, colors: VideoMapColors | undefined): void {
  const distance = line.route.totalMeters;
  const lines = colors
    ? coloredRuns(line.route, distance, colors.drawn, colors).map((run) => lineFeature(run.line, { bin: run.bin }))
    : revealAt(line.route, distance, line.drawn).lines.map((points) => lineFeature(points));
  (map.getSource(REVEAL) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: lines.filter((feature) => feature.geometry.coordinates.length > 1) });
  (map.getSource(TRAIL) as GeoJSONSource | undefined)?.setData(EMPTY);
  (map.getSource(MARKER) as GeoJSONSource | undefined)?.setData(EMPTY);
}
