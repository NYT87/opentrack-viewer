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

const ROUTE_SOURCE = 'activity-route';
const ROUTE_LAYER = 'activity-route-line';
const ROUTE_CASING_LAYER = 'activity-route-casing';
const MARKER_SOURCE = 'activity-marker';
const MARKER_LAYER = 'activity-marker-point';

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
}

/**
 * AV-302 / AV-303. Owns the MapLibre instance imperatively; React only feeds it
 * normalized GeoJSON. The map is created once and its sources are updated in
 * place, so a new file never tears the canvas down.
 */
export function ActivityMap({
  route,
  marker,
  basemapEnabled,
  basemapStyle = DEFAULT_BASEMAP_STYLE,
  onRouteHover,
  onRouteClick,
}: ActivityMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [isStyleReady, setIsStyleReady] = useState(false);
  const [styleError, setStyleError] = useState<string | undefined>();

  // A style swap re-runs `install`, which must publish the *current* data
  // rather than whatever was in scope when the listener was registered.
  const routeRef = useRef(route);
  const markerRef = useRef(marker);
  /** Bounds of the route currently displayed, for re-fitting after a resize. */
  const boundsRef = useRef<[number, number, number, number] | undefined>(undefined);
  /** Set once the user moves the camera, so a resize stops overriding them. */
  const userMovedRef = useRef(false);

  useEffect(() => {
    routeRef.current = route;
    markerRef.current = marker;
  }, [route, marker]);

  // A newly loaded activity gets a fresh automatic fit even if the user had
  // moved the camera while viewing the previous one.
  useEffect(() => {
    userMovedRef.current = false;
  }, [route]);

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
    fitToBounds(map, route.bounds, 500);
  }, [route, isStyleReady]);

  // Push marker updates (AV-602).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;
    const source = map.getSource(MARKER_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(marker);
    }
  }, [marker, isStyleReady]);

  // Route hover/click → active point index (AV-603).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady || route.isEmpty) return;

    const nearestIndex = (event: MapMouseEvent): number | undefined => {
      const features = map.queryRenderedFeatures(event.point, { layers: [ROUTE_LAYER] });
      const feature = features[0];
      const geometry = feature?.geometry;
      if (!geometry || geometry.type !== 'LineString') return undefined;

      const coordinateIndex = nearestCoordinateIndex(geometry.coordinates, [
        event.lngLat.lng,
        event.lngLat.lat,
      ]);
      if (coordinateIndex === undefined) return undefined;

      // Coordinates are per-segment, so the hit feature identifies which run to
      // look the activity point index up in.
      const featureIndex = Number(feature?.properties?.featureIndex ?? 0);
      return routeRef.current.sourceIndices[featureIndex]?.[coordinateIndex];
    };

    const handleMove = (event: MapMouseEvent) => onRouteHover?.(nearestIndex(event));
    const handleLeave = () => onRouteHover?.(undefined);
    const handleClick = (event: MapMouseEvent) => onRouteClick?.(nearestIndex(event));

    map.on('mousemove', ROUTE_LAYER, handleMove);
    map.on('mouseleave', ROUTE_LAYER, handleLeave);
    map.on('click', ROUTE_LAYER, handleClick);

    return () => {
      map.off('mousemove', ROUTE_LAYER, handleMove);
      map.off('mouseleave', ROUTE_LAYER, handleLeave);
      map.off('click', ROUTE_LAYER, handleClick);
    };
  }, [isStyleReady, route.isEmpty, onRouteHover, onRouteClick]);

  return (
    <div className="map" data-testid="activity-map">
      <div ref={containerRef} className="map__canvas" />

      {styleError && basemapEnabled && (
        <div className="map__notice" role="status">
          Basemap unavailable — the route is still shown. Try route-only mode.
        </div>
      )}
    </div>
  );
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
