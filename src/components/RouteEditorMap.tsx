import { useEffect, useRef, useState } from 'react';
import {
  Map as MapLibreMap,
  NavigationControl,
  type GeoJSONSource,
  type MapMouseEvent,
  type MapTouchEvent,
} from 'maplibre-gl';
import {
  DEFAULT_BASEMAP_STYLE,
  basemapLayerIdsOf,
  fitToBounds,
  withBasemapVisibility,
} from './ActivityMap';
import type { Coordinate } from '../domain/activity';
import type { DraftPoint } from '../domain/routeDraft';
import { draftBounds, draftLineGeoJSON, draftPointsGeoJSON } from '../domain/routeDraftGeojson';

const LINE_SOURCE = 'draft-line';
const LINE_CASING_LAYER = 'draft-line-casing';
const LINE_LAYER = 'draft-line-stroke';
const POINT_SOURCE = 'draft-points';
const POINT_LAYER = 'draft-points-dot';

/** How close, in screen pixels, a press has to be to count as on a point. */
const HIT_RADIUS_PX = 10;

export interface RouteEditorMapProps {
  points: readonly DraftPoint[];
  selectedIndex?: number;
  basemapEnabled: boolean;
  /** A press on empty map: add a point there. */
  onAdd: (coordinate: Coordinate) => void;
  /** A press on a point, or `undefined` to clear the selection. */
  onSelect: (index: number | undefined) => void;
  /** A point was dropped somewhere new. */
  onMove: (index: number, coordinate: Coordinate) => void;
}

type PointerEventLike = MapMouseEvent | MapTouchEvent;

/**
 * AV-1104. The editing surface: a map where the route is a line of points that
 * can be added, selected, and dragged.
 *
 * Like `ActivityMap`, MapLibre is owned imperatively and React only feeds it
 * data. A drag never goes through React: while a point is held, the two sources
 * are rewritten straight from the pointer, and only the drop is reported, so
 * moving a point in a 50,000-point route does not re-render the page on every
 * pixel.
 */
export function RouteEditorMap({
  points,
  selectedIndex,
  basemapEnabled,
  onAdd,
  onSelect,
  onMove,
}: RouteEditorMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [isStyleReady, setIsStyleReady] = useState(false);
  const [styleError, setStyleError] = useState<string | undefined>();

  // Handlers are registered once, so they read the latest props through refs.
  const pointsRef = useRef(points);
  const selectedRef = useRef(selectedIndex);
  const callbacksRef = useRef({ onAdd, onSelect, onMove });
  const hasFittedRef = useRef(false);
  /** The point being dragged and where it is now, while a drag is in progress. */
  const dragRef = useRef<{ index: number; at: Coordinate; moved: boolean } | undefined>(undefined);
  /** A drop is followed by a click event; this swallows it. */
  const suppressClickRef = useRef(false);

  useEffect(() => {
    pointsRef.current = points;
    selectedRef.current = selectedIndex;
    callbacksRef.current = { onAdd, onSelect, onMove };
  }, [points, selectedIndex, onAdd, onSelect, onMove]);

  // Create the map once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const map = new MapLibreMap({
      container,
      style: withBasemapVisibility(DEFAULT_BASEMAP_STYLE, basemapEnabled),
      center: [0, 20],
      zoom: 1,
      attributionControl: { compact: true },
      // Double-click is how a person adds two points close together; zooming
      // on it would make that feel broken.
      doubleClickZoom: false,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.on('error', (event) => {
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (sourceId === LINE_SOURCE || sourceId === POINT_SOURCE) return;
      setStyleError(event.error?.message ?? 'The basemap could not be loaded.');
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The basemap toggle is handled by its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Install sources and layers once the style has loaded.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const install = () => {
      if (!map.getSource(LINE_SOURCE)) {
        map.addSource(LINE_SOURCE, { type: 'geojson', data: draftLineGeoJSON(pointsRef.current) });
        map.addLayer({
          id: LINE_CASING_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0b0f14', 'line-width': 7, 'line-opacity': 0.6 },
        });
        map.addLayer({
          id: LINE_LAYER,
          type: 'line',
          source: LINE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#4aa3ff', 'line-width': 3.5 },
        });
      }
      if (!map.getSource(POINT_SOURCE)) {
        map.addSource(POINT_SOURCE, {
          type: 'geojson',
          data: draftPointsGeoJSON(pointsRef.current, selectedRef.current),
        });
        map.addLayer({
          id: POINT_LAYER,
          type: 'circle',
          source: POINT_SOURCE,
          paint: {
            // The selected point is the one Delete and the arrow buttons act
            // on, so it is larger and a different colour, not just outlined.
            'circle-radius': ['case', ['get', 'selected'], 8, ['get', 'endpoint'], 6, 4],
            'circle-color': [
              'case',
              ['get', 'selected'],
              '#ffd166',
              ['get', 'endpoint'],
              '#ffffff',
              '#4aa3ff',
            ],
            'circle-stroke-color': '#0b0f14',
            'circle-stroke-width': 2,
          },
        });
      }
      setIsStyleReady(true);
    };

    if (map.loaded()) install();
    map.on('load', install);
    return () => {
      map.off('load', install);
    };
  }, []);

  // Show or hide the basemap in place (see `basemapLayerIdsOf` for why).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;
    setStyleError(undefined);
    for (const id of basemapLayerIdsOf(DEFAULT_BASEMAP_STYLE)) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', basemapEnabled ? 'visible' : 'none');
      }
    }
  }, [basemapEnabled, isStyleReady]);

  // Publish the draft, and fit to it the first time there is something to fit.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;

    const line = map.getSource(LINE_SOURCE);
    if (line && 'setData' in line) (line as GeoJSONSource).setData(draftLineGeoJSON(points));
    const dots = map.getSource(POINT_SOURCE);
    if (dots && 'setData' in dots) {
      (dots as GeoJSONSource).setData(draftPointsGeoJSON(points, selectedIndex));
    }

    // Fitting on every edit would fight the person editing; once, on arrival,
    // is what "fits bounds to the current draft" needs.
    const bounds = draftBounds(points);
    if (bounds && !hasFittedRef.current) {
      hasFittedRef.current = true;
      fitToBounds(map, bounds, 500);
    }
  }, [points, selectedIndex, isStyleReady]);

  // Pointer interaction: add, select, drag.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isStyleReady) return;

    const pointAt = (event: PointerEventLike): number | undefined => {
      const { x, y } = event.point;
      const hits = map.queryRenderedFeatures(
        [
          [x - HIT_RADIUS_PX, y - HIT_RADIUS_PX],
          [x + HIT_RADIUS_PX, y + HIT_RADIUS_PX],
        ],
        { layers: [POINT_LAYER] },
      );
      // Several can overlap in a dense route; the selected one wins, so a
      // point can be picked up again where it was dropped.
      const indices = hits.map((hit) => Number(hit.properties?.index));
      if (indices.length === 0) return undefined;
      return indices.includes(selectedRef.current ?? -1) ? selectedRef.current : indices[0];
    };

    const render = (current: DraftPoint[], selected: number | undefined) => {
      const line = map.getSource(LINE_SOURCE);
      if (line && 'setData' in line) (line as GeoJSONSource).setData(draftLineGeoJSON(current));
      const dots = map.getSource(POINT_SOURCE);
      if (dots && 'setData' in dots) {
        (dots as GeoJSONSource).setData(draftPointsGeoJSON(current, selected));
      }
    };

    const start = (event: PointerEventLike) => {
      // A drop whose click never arrived must not swallow the next real one.
      suppressClickRef.current = false;
      const index = pointAt(event);
      if (index === undefined) return;
      // Holding a point must not pan the map underneath it.
      event.preventDefault();
      map.dragPan.disable();
      dragRef.current = {
        index,
        at: { lat: event.lngLat.lat, lon: event.lngLat.lng },
        moved: false,
      };
    };

    const move = (event: PointerEventLike) => {
      const drag = dragRef.current;
      if (!drag) {
        map.getCanvas().style.cursor = pointAt(event) !== undefined ? 'grab' : 'crosshair';
        return;
      }
      const wrapped = event.lngLat.wrap();
      drag.at = { lat: wrapped.lat, lon: wrapped.lng };
      drag.moved = true;
      map.getCanvas().style.cursor = 'grabbing';
      const current = pointsRef.current.map((point, index) =>
        index === drag.index ? { ...point, ...drag.at } : point,
      );
      render(current, drag.index);
    };

    const end = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = undefined;
      map.dragPan.enable();
      map.getCanvas().style.cursor = 'crosshair';
      if (drag.moved) {
        suppressClickRef.current = true;
        callbacksRef.current.onMove(drag.index, drag.at);
      }
    };

    const click = (event: MapMouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      const index = pointAt(event);
      if (index !== undefined) {
        callbacksRef.current.onSelect(index);
        return;
      }
      const wrapped = event.lngLat.wrap();
      callbacksRef.current.onAdd({ lat: wrapped.lat, lon: wrapped.lng });
    };

    map.getCanvas().style.cursor = 'crosshair';
    map.on('mousedown', start);
    map.on('touchstart', start);
    map.on('mousemove', move);
    map.on('touchmove', move);
    map.on('mouseup', end);
    map.on('touchend', end);
    map.on('click', click);

    return () => {
      map.off('mousedown', start);
      map.off('touchstart', start);
      map.off('mousemove', move);
      map.off('touchmove', move);
      map.off('mouseup', end);
      map.off('touchend', end);
      map.off('click', click);
      // Never leave panning disabled behind a half-finished drag.
      map.dragPan.enable();
      dragRef.current = undefined;
    };
  }, [isStyleReady]);

  return (
    <div className="map" data-testid="route-editor-map">
      <div ref={containerRef} className="map__canvas" />
      {styleError && basemapEnabled && (
        <div className="map__notice" role="status">
          Basemap unavailable — the route is still shown. Try route-only mode.
        </div>
      )}
    </div>
  );
}
