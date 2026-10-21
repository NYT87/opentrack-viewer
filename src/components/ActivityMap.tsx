import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
// MapLibre resolves its worker at runtime from `import.meta.url`, which no
// bundler can see: once the library is bundled, the sibling worker file is not
// emitted and the request 404s. A dead worker still draws raster tiles (they
// decode on the main thread) but silently never tiles a GeoJSON source, so the
// route vanishes with no error anywhere.
//
// `?worker&url` (not plain `?url`) is required: the worker entry itself imports
// `./maplibre-gl-shared.mjs`, so copying the single file leaves the worker
// broken on its own dependency. `?worker` makes Vite bundle the worker with
// everything it needs; `vite.config.ts` sets `worker.format: 'es'` so MapLibre
// can construct it as a module worker.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
// Imported here rather than in main.tsx so it ships in this lazily-loaded
// chunk instead of the initial CSS bundle.
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, LineString, Point } from 'geojson';
import type { RouteGeometry, RouteLineProperties } from '../domain/geojson';

setWorkerUrl(maplibreWorkerUrl);

/** An empty collection, for a map with no focused section. */
const EMPTY_ROUTE = { type: 'FeatureCollection' as const, features: [] };

const ROUTE_SOURCE = 'activity-route';
const ROUTE_LAYER = 'activity-route-line';
const ROUTE_CASING_LAYER = 'activity-route-casing';
const FOCUS_SOURCE = 'activity-focus';
const FOCUS_LAYER = 'activity-focus-line';
const MARKER_SOURCE = 'activity-marker';
const MARKER_LAYER = 'activity-marker-point';
const LAP_SOURCE = 'activity-lap';
const LAP_LAYER = 'activity-lap-line';
const EDIT_POINT_SOURCE = 'draft-points';
const EDIT_POINT_LAYER = 'draft-point';

/** An empty collection, for a map with no editable points. */
const EMPTY_POINTS: FeatureCollection<Point, EditPointProperties> = {
  type: 'FeatureCollection',
  features: [],
};

/**
 * AV-1104 / AV-1105. What a draft point carries onto the map: its id, whether
 * it is the one picked out, and whether it lies in the marked section. The
 * section is also a line (`lapRoute`), but a line needs two points, so the
 * points carry the mark too — a one-point section is still shown.
 */
export interface EditPointProperties {
  id: string;
  selected: boolean;
  inSection?: boolean;
}

/**
 * Default basemap: OpenStreetMap raster tiles, declared inline so there is no
 * style.json round-trip to fail. MapLibre's demo style was the previous default
 * and was the wrong tool — it carries only country outlines up to zoom 5, so a
 * fitted route showed a blank ocean.
 *
 * Tile requests reveal the approximate area being viewed, so the UI exposes a
 * route-only alternative (plan §5, AV-803). A production deployment should
 * point at its own tile provider and honour that provider's usage policy.
 */
export const DEFAULT_BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#11161c' } },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      // Muted so the bright raster sits behind a dark UI without washing out
      // the route line drawn on top of it.
      paint: { 'raster-saturation': -0.3, 'raster-brightness-max': 0.9 },
    },
  ],
};

/**
 * AV-803. Route-only mode hides the basemap's layers rather than swapping in a
 * different style. MapLibre 6.6 terminates its worker on `setStyle` and never
 * respawns it, which permanently breaks every GeoJSON source on the map — the
 * route silently stops rendering. Hiding layers also keeps the route on screen
 * across a toggle, and MapLibre requests no tiles for a source whose only
 * layers are hidden, so the privacy guarantee is unchanged.
 *
 * The background layer stays visible; it is the neutral backdrop the route is
 * drawn on when there is no basemap.
 */
function basemapLayerIdsOf(style: StyleSpecification): string[] {
  return style.layers.filter((layer) => layer.type !== 'background').map((layer) => layer.id);
}

/** Applies basemap visibility up front, so a disabled basemap fetches nothing. */
function withBasemapVisibility(
  style: StyleSpecification,
  enabled: boolean,
): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map((layer) =>
      layer.type === 'background'
        ? layer
        : { ...layer, layout: { ...layer.layout, visibility: enabled ? 'visible' : 'none' } },
    ),
  };
}

/**
 * Moves the camera so the whole route is inside the viewport. Zero-area bounds
 * (a single point, or a stationary track) would make fitBounds compute an
 * invalid zoom, so those centre instead.
 */
function fitToBounds(
  map: MapLibreMap,
  bounds: [number, number, number, number],
  duration: number,
): void {
  const [west, south, east, north] = bounds;
  if (west === east && south === north) {
    map.easeTo({ center: [west, south], zoom: 14, duration });
    return;
  }
  map.fitBounds(bounds as LngLatBoundsLike, { padding: 48, duration, maxZoom: 16 });
}

export interface ActivityMapProps {
  route: RouteGeometry;
  /**
   * AV-604. The selected section. When present the full route is dimmed and
   * this is drawn over it, so the reader keeps the context of the whole ride
   * rather than losing everything outside the selection.
   */
  focusRoute?: RouteGeometry;
  /**
   * The lap the reader picked out. Drawn in its own colour over the route, and
   * never fitted to: a lap says "which part is this", not "take me there".
   */
  lapRoute?: RouteGeometry;
  /** Marker for the hovered/selected point (AV-602). */
  marker: FeatureCollection<Point, { index: number }>;
  basemapEnabled: boolean;
  /**
   * Inline basemap style. Inline (rather than a URL) so its layers' visibility
   * can be set before the first render, which is what keeps a disabled basemap
   * from fetching any tile at all.
   */
  basemapStyle?: StyleSpecification;
  /**
   * Fired with the index in `activity.points` under the pointer (AV-603).
   * Resolved here because only this component knows which route feature was
   * hit, and the route is drawn as one feature per recorded segment.
   */
  onRouteHover?: (pointIndex: number | undefined) => void;
  onRouteClick?: (pointIndex: number | undefined) => void;
  /**
   * AV-1104. Points a reader can pick out and edit, drawn as circles over the
   * route; the selected one in its own colour. The route draft's.
   */
  editPoints?: FeatureCollection<Point, EditPointProperties>;
  /** A press on one of `editPoints`, with its id. */
  onPointClick?: (id: string) => void;
  /**
   * A press on the map itself — not on a draft point, which `onPointClick`
   * takes — with the place pressed. How the page adds a point by clicking.
   */
  onMapClick?: (place: { lat: number; lon: number }) => void;
  /**
   * When given, the camera is fitted to the route only when this value
   * changes, not on every change to the route: a track being edited point by
   * point must not pull the camera back to the whole each time. Left out, the
   * viewer's behaviour — a fit on every new route — is unchanged.
   */
  fitKey?: string;
}

/**
 * AV-302 / AV-303. Owns the MapLibre instance imperatively; React only feeds it
 * normalized GeoJSON. The map is created once and its sources are updated in
 * place, so a new file never tears the canvas down.
 */
export function ActivityMap({
  route,
  focusRoute,
  lapRoute,
  marker,
  basemapEnabled,
  basemapStyle = DEFAULT_BASEMAP_STYLE,
  onRouteHover,
  onRouteClick,
  editPoints,
  onPointClick,
  onMapClick,
  fitKey,
}: ActivityMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [isStyleReady, setIsStyleReady] = useState(false);
  const [styleError, setStyleError] = useState<string | undefined>();

  // A style swap re-runs `install`, which must publish the *current* data
  // rather than whatever was in scope when the listener was registered.
  const routeRef = useRef(route);
  const focusRouteRef = useRef(focusRoute);
  const lapRouteRef = useRef(lapRoute);
  const markerRef = useRef(marker);
  const editPointsRef = useRef(editPoints);
  /** The `fitKey` the camera was last fitted for, so a route edit does not re-fit. */
  const fittedKeyRef = useRef<string | undefined>(undefined);
  /** Bounds of the route currently displayed, for re-fitting after a resize. */
  const boundsRef = useRef<[number, number, number, number] | undefined>(undefined);
  /** Set once the user moves the camera, so a resize stops overriding them. */
  const userMovedRef = useRef(false);
  /** Whether a section was focused, so clearing one can be told from never having had one. */
  const hadFocusRef = useRef(false);

  useEffect(() => {
    routeRef.current = route;
    focusRouteRef.current = focusRoute;
    lapRouteRef.current = lapRoute;
    markerRef.current = marker;
    editPointsRef.current = editPoints;
  }, [route, focusRoute, lapRoute, marker, editPoints]);

  // A newly loaded activity gets a fresh automatic fit even if the user had
  // moved the camera while viewing the previous one. With a fit key, only a
  // new key is a new thing to look at: an edit to the same draft keeps the
  // camera where the reader put it, through a resize as well.
  const movedForKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (fitKey !== undefined) {
      if (movedForKeyRef.current === fitKey) return;
      movedForKeyRef.current = fitKey;
    }
    userMovedRef.current = false;
  }, [route, fitKey]);

  const basemapLayerIds = useMemo(() => basemapLayerIdsOf(basemapStyle), [basemapStyle]);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = new MapLibreMap({
      container,
      style: withBasemapVisibility(basemapStyle, basemapEnabled),
      center: [0, 20],
      zoom: 1,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    // Only camera moves the user started should suppress automatic re-fitting;
    // our own fitBounds calls fire the same events without an originalEvent.
    const markUserMoved = (event: { originalEvent?: unknown }) => {
      if (event?.originalEvent) userMovedRef.current = true;
    };
    map.on('dragstart', markUserMoved);
    map.on('zoomstart', markUserMoved);
    map.on('rotatestart', markUserMoved);

    // The map is laid out before the elevation chart mounts, so the canvas
    // shrinks right after the first fit and would leave the route clipped.
    // Re-fitting on resize also keeps the whole track visible when the window
    // changes size.
    map.on('resize', () => {
      if (userMovedRef.current || !boundsRef.current) return;
      fitToBounds(map, boundsRef.current, 0);
    });
    map.on('error', (event) => {
      // Our own GeoJSON sources never fail over the network; only basemap
      // problems belong in the notice. A failed basemap must not invalidate the
      // loaded activity (§15).
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (sourceId === ROUTE_SOURCE || sourceId === MARKER_SOURCE) return;
      setStyleError(event.error?.message ?? 'The basemap could not be loaded.');
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Style/basemap changes are handled by the effect below, not by recreating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show or hide the basemap in place. No setStyle: see basemapLayerIdsOf.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;
    setStyleError(undefined);
    for (const id of basemapLayerIds) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', basemapEnabled ? 'visible' : 'none');
      }
    }
  }, [basemapEnabled, basemapLayerIds, isStyleReady]);

  // (Re)install sources and layers whenever a style finishes loading.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const install = () => {
      if (!map.getSource(ROUTE_SOURCE)) {
        map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeRef.current.featureCollection });
        map.addLayer({
          id: ROUTE_CASING_LAYER,
          type: 'line',
          source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0b0f14', 'line-width': 7, 'line-opacity': 0.6 },
        });
        map.addLayer({
          id: ROUTE_LAYER,
          type: 'line',
          source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#4aa3ff', 'line-width': 3.5 },
        });
      }
      if (!map.getSource(FOCUS_SOURCE)) {
        map.addSource(FOCUS_SOURCE, {
          type: 'geojson',
          data: focusRouteRef.current?.featureCollection ?? EMPTY_ROUTE,
        });
        map.addLayer({
          id: FOCUS_LAYER,
          type: 'line',
          source: FOCUS_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffd166', 'line-width': 4.5 },
        });
      }
      if (!map.getSource(LAP_SOURCE)) {
        map.addSource(LAP_SOURCE, {
          type: 'geojson',
          data: lapRouteRef.current?.featureCollection ?? EMPTY_ROUTE,
        });
        map.addLayer({
          id: LAP_LAYER,
          type: 'line',
          source: LAP_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          // A colour of its own: not the route's blue, and not the focus amber,
          // so a highlighted lap inside a focused section still reads as one.
          paint: { 'line-color': '#c77dff', 'line-width': 5 },
        });
      }
      if (!map.getSource(EDIT_POINT_SOURCE)) {
        map.addSource(EDIT_POINT_SOURCE, {
          type: 'geojson',
          data: editPointsRef.current ?? EMPTY_POINTS,
        });
        map.addLayer({
          id: EDIT_POINT_LAYER,
          type: 'circle',
          source: EDIT_POINT_SOURCE,
          paint: {
            // The selected point is larger and amber; points in the marked
            // section take the section line's colour; the rest white, so a
            // track of many points reads as a line with handles on it.
            'circle-radius': ['case', ['get', 'selected'], 8, 5],
            'circle-color': [
              'case',
              ['get', 'selected'],
              '#ffd166',
              ['==', ['get', 'inSection'], true],
              '#c77dff',
              '#ffffff',
            ],
            'circle-stroke-color': '#0b0f14',
            'circle-stroke-width': 2,
          },
        });
      }
      if (!map.getSource(MARKER_SOURCE)) {
        map.addSource(MARKER_SOURCE, { type: 'geojson', data: markerRef.current });
        map.addLayer({
          id: MARKER_LAYER,
          type: 'circle',
          source: MARKER_SOURCE,
          paint: {
            'circle-radius': 6,
            'circle-color': '#ffd166',
            'circle-stroke-color': '#0b0f14',
            'circle-stroke-width': 2,
          },
        });
      }
      setIsStyleReady(true);
    };

    // The style is never swapped, so a single install on `load` is enough.
    if (map.loaded()) install();
    map.on('load', install);
    return () => {
      map.off('load', install);
    };
    // `install` reads the latest route/marker through refs, so this listener is
    // registered once for the life of the map.
  }, []);

  // Push route updates and fit bounds (AV-303).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;

    const source = map.getSource(ROUTE_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(
        route.featureCollection as FeatureCollection<LineString, RouteLineProperties>,
      );
    }

    boundsRef.current = route.bounds;
    if (!route.bounds) return;
    // With a fit key, only a new key — a different draft — moves the camera;
    // an edit to the same draft leaves it where the reader put it.
    if (fitKey !== undefined) {
      if (fittedKeyRef.current === fitKey) return;
      fittedKeyRef.current = fitKey;
    }
    fitToBounds(map, route.bounds, 500);
  }, [route, isStyleReady, fitKey]);

  /**
   * AV-604. Dim the full route while a section is focused, draw the section
   * over it, and fit to the section the first time it changes — after that the
   * map is the reader's to pan and zoom.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;

    const source = map.getSource(FOCUS_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(focusRoute?.featureCollection ?? EMPTY_ROUTE);
    }

    const lapSource = map.getSource(LAP_SOURCE);
    if (lapSource && 'setData' in lapSource) {
      // Data only: no bounds, no camera. A lap recolours where the reader
      // already is (§17), unlike a chart selection, which moves the view.
      (lapSource as GeoJSONSource).setData(lapRoute?.featureCollection ?? EMPTY_ROUTE);
    }

    const hasFocus = Boolean(focusRoute && !focusRoute.isEmpty);
    if (map.getLayer(ROUTE_LAYER)) {
      map.setPaintProperty(ROUTE_LAYER, 'line-opacity', hasFocus ? 0.28 : 1);
    }

    if (!hasFocus || !focusRoute?.bounds) {
      // Hand the full route's bounds back, or a later resize would re-fit to a
      // section that is no longer selected.
      boundsRef.current = route.bounds;

      // Reset View means "show me the whole thing again", so the camera goes
      // back with it — overriding any panning, because that is what was asked
      // for. Guarded on having actually had a focus, so loading an activity
      // does not fit twice.
      if (hadFocusRef.current) {
        hadFocusRef.current = false;
        userMovedRef.current = false;
        if (route.bounds) fitToBounds(map, route.bounds, 500);
      }
      return;
    }

    // A fresh focus re-fits even if the reader had moved the map before it.
    hadFocusRef.current = true;
    userMovedRef.current = false;
    boundsRef.current = focusRoute.bounds;
    fitToBounds(map, focusRoute.bounds, 500);
  }, [focusRoute, lapRoute, route.bounds, isStyleReady]);

  // Push marker updates (AV-602).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;
    const source = map.getSource(MARKER_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(marker);
    }
  }, [marker, isStyleReady]);

  // AV-1104. Push the editable points, and hand presses on them and on the
  // map to the page. A press on a point is not also a press on the map: the
  // map-level handler steps aside when a draft point is under the pointer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;
    const source = map.getSource(EDIT_POINT_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(editPoints ?? EMPTY_POINTS);
    }
  }, [editPoints, isStyleReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady || (!onPointClick && !onMapClick)) return;

    const handlePointClick = (event: MapMouseEvent) => {
      const feature = map.queryRenderedFeatures(event.point, { layers: [EDIT_POINT_LAYER] })[0];
      const id = feature?.properties?.id;
      if (typeof id === 'string') onPointClick?.(id);
    };
    const handleMapClick = (event: MapMouseEvent) => {
      const onPoint = map.queryRenderedFeatures(event.point, { layers: [EDIT_POINT_LAYER] });
      if (onPoint.length > 0) return;
      // When a press on the route has a meaning of its own (`onRouteClick`,
      // which picks the nearest point), it is not also a press on the map.
      if (onRouteClick && map.queryRenderedFeatures(event.point, { layers: [ROUTE_LAYER] }).length > 0) return;
      // The map draws the world repeated, so a press past the antimeridian
      // reports a longitude past ±180. It is the same place; it is wrapped
      // here, so the model's strict check sees the real coordinate.
      onMapClick?.({ lat: event.lngLat.lat, lon: wrapLongitude(event.lngLat.lng) });
    };

    map.on('click', EDIT_POINT_LAYER, handlePointClick);
    map.on('click', handleMapClick);
    return () => {
      map.off('click', EDIT_POINT_LAYER, handlePointClick);
      map.off('click', handleMapClick);
    };
  }, [isStyleReady, onPointClick, onMapClick, onRouteClick]);

  // Route hover/click → active point index (AV-603).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady || route.isEmpty) return;

    const nearestIndex = (event: MapMouseEvent): number | undefined => {
      const feature = map.queryRenderedFeatures(event.point, { layers: [ROUTE_LAYER] })[0];
      if (!feature) return undefined;

      // Coordinates are per-segment, so the hit feature identifies which run to
      // look the activity point index up in. Only that: the feature's own
      // geometry is the tile's copy of the run, clipped at the tile's edge and
      // simplified for the zoom, so its coordinate indices are not the run's.
      // The nearest coordinate is looked for in the run as given to the map,
      // whose indices are the activity's (AV-1108, review).
      const featureIndex = Number(feature.properties?.featureIndex ?? 0);
      const run = routeRef.current.featureCollection.features[featureIndex];
      if (!run) return undefined;
      const coordinateIndex = nearestCoordinateIndex(run.geometry.coordinates, [
        wrapLongitude(event.lngLat.lng),
        event.lngLat.lat,
      ]);
      if (coordinateIndex === undefined) return undefined;
      return routeRef.current.sourceIndices[featureIndex]?.[coordinateIndex];
    };

    const handleMove = (event: MapMouseEvent) => onRouteHover?.(nearestIndex(event));
    const handleLeave = () => onRouteHover?.(undefined);
    const handleClick = (event: MapMouseEvent) => {
      // A press on a draft point is the point's (`onPointClick`), not the
      // route's: the handle names the point exactly, the route only nearly.
      if (onPointClick && map.queryRenderedFeatures(event.point, { layers: [EDIT_POINT_LAYER] }).length > 0) return;
      onRouteClick?.(nearestIndex(event));
    };

    map.on('mousemove', ROUTE_LAYER, handleMove);
    map.on('mouseleave', ROUTE_LAYER, handleLeave);
    map.on('click', ROUTE_LAYER, handleClick);

    return () => {
      map.off('mousemove', ROUTE_LAYER, handleMove);
      map.off('mouseleave', ROUTE_LAYER, handleLeave);
      map.off('click', ROUTE_LAYER, handleClick);
    };
  }, [isStyleReady, route.isEmpty, onRouteHover, onRouteClick, onPointClick]);

  return (
    <div className="map" data-testid="activity-map">
      <div ref={containerRef} className="map__canvas" />

      {focusRoute?.isEmpty && (
        <div className="map__notice" role="status">
          The selected section has no GPS points, so the map still shows the whole activity.
        </div>
      )}

      {styleError && basemapEnabled && (
        <div className="map__notice" role="status">
          Basemap unavailable — the route is still shown. Try route-only mode.
        </div>
      )}
    </div>
  );
}

/**
 * Brings a longitude from a repeated world back into [-180, 180]. One already
 * there is returned as it is, so the arithmetic cannot nudge a real coordinate.
 */
function wrapLongitude(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Squared planar distance is enough to rank candidates over a single track's
 * extent; a full geodesic comparison would not change the winner.
 */
function nearestCoordinateIndex(
  coordinates: number[][],
  target: [number, number],
): number | undefined {
  let bestIndex: number | undefined;
  let bestDistance = Infinity;
  for (let i = 0; i < coordinates.length; i += 1) {
    const coordinate = coordinates[i];
    if (!coordinate) continue;
    const dx = (coordinate[0] ?? 0) - target[0];
    const dy = (coordinate[1] ?? 0) - target[1];
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}
