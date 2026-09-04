import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { FakeMap, latestMap, resetMapLibreMock, setWorkerUrl } from '../test/helpers/maplibreMock';

// jsdom provides no WebGL context, so the real MapLibre Map cannot be created.
vi.mock('maplibre-gl', async () => {
  const { FakeMap: Fake, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: Fake, NavigationControl: class {}, setWorkerUrl },
    Map: Fake,
    NavigationControl: class {},
    setWorkerUrl,
  };
});

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const { ActivityMap, DEFAULT_BASEMAP_STYLE } = await import('./ActivityMap');
const { activityToRouteGeoJSON, pointToGeoJSON } = await import('../domain/geojson');
const { makeActivity } = await import('../test/helpers/activity');

const route = activityToRouteGeoJSON(
  makeActivity([
    { lat: 51.5, lon: -0.3 },
    { lat: 51.7, lon: -0.1 },
    { lat: 51.9, lon: 0.2 },
  ]),
);
const emptyMarker = pointToGeoJSON(undefined);

const renderMap = (props: Partial<Parameters<typeof ActivityMap>[0]> = {}) =>
  render(<ActivityMap route={route} marker={emptyMarker} basemapEnabled {...props} />);

describe('ActivityMap (AV-302/AV-303)', () => {
  beforeEach(() => {
    resetMapLibreMock();
  });

  it('initializes a map and installs the route layers once the style loads', () => {
    renderMap();
    const map = latestMap();

    act(() => map.completeStyleLoad());

    expect(map.sources.has('activity-route')).toBe(true);
    expect(map.layers.map((layer) => layer.id)).toContain('activity-route-line');
  });

  it('fits the map to the route bounds', () => {
    renderMap();
    const map = latestMap();

    act(() => map.completeStyleLoad());

    expect(map.fitBoundsCalls).toHaveLength(1);
    expect(map.fitBoundsCalls[0]?.[0]).toEqual([-0.3, 51.5, 0.2, 51.9]);
  });

  it('re-fits the route when the canvas resizes', () => {
    // Regression: the map is laid out before the elevation chart mounts, so the
    // canvas shrinks right after the first fit and left the track clipped off
    // the bottom of the viewport.
    renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    expect(map.fitBoundsCalls).toHaveLength(1);

    act(() => map.emit('resize'));

    expect(map.fitBoundsCalls).toHaveLength(2);
    expect(map.fitBoundsCalls[1]?.[0]).toEqual([-0.3, 51.5, 0.2, 51.9]);
  });

  it('stops re-fitting once the user has moved the camera', () => {
    renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());

    // Only user-initiated moves carry an originalEvent; our own fitBounds does not.
    act(() => map.emit('zoomstart', {}));
    act(() => map.emit('resize'));
    expect(map.fitBoundsCalls).toHaveLength(2);

    act(() => map.emit('dragstart', { originalEvent: new MouseEvent('mousedown') }));
    act(() => map.emit('resize'));
    expect(map.fitBoundsCalls).toHaveLength(2);
  });

  it('resumes automatic fitting when a new activity is loaded', () => {
    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    act(() => map.emit('dragstart', { originalEvent: new MouseEvent('mousedown') }));

    const other = activityToRouteGeoJSON(
      makeActivity([
        { lat: 40.1, lon: -3.7 },
        { lat: 40.2, lon: -3.6 },
      ]),
    );
    rerender(<ActivityMap route={other} marker={emptyMarker} basemapEnabled />);
    act(() => map.emit('resize'));

    expect(map.fitBoundsCalls.length).toBeGreaterThan(2);
  });

  it('centers instead of fitting when the route has zero-area bounds', () => {
    const stationary = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.1 },
        { lat: 51.5, lon: -0.1 },
      ]),
    );

    renderMap({ route: stationary });
    const map = latestMap();
    act(() => map.completeStyleLoad());

    expect(map.fitBoundsCalls).toHaveLength(0);
    expect(map.easeToCalls).toHaveLength(1);
  });

  it('hides the basemap layers when the basemap is disabled (AV-803)', () => {
    renderMap({ basemapEnabled: false });
    const style = latestMap().options.style as { layers: { id: string; layout?: unknown }[] };

    // Applied before construction, so a disabled basemap fetches no tiles at all.
    expect(style.layers.find((layer) => layer.id === 'osm')?.layout).toMatchObject({
      visibility: 'none',
    });
    expect(style.layers.find((layer) => layer.id === 'background')?.layout).toBeUndefined();
  });

  it('ships a basemap with street-level tiles', () => {
    // Regression: the previous default (MapLibre demo tiles) stops at zoom 5,
    // so a fitted route rendered over a blank background.
    const source = DEFAULT_BASEMAP_STYLE.sources.osm;

    expect(source).toMatchObject({ type: 'raster', maxzoom: 19 });
    expect(DEFAULT_BASEMAP_STYLE.layers.map((layer) => layer.id)).toContain('osm');
  });

  it('never swaps the style when the basemap is toggled', () => {
    // Regression: MapLibre 6.6 terminates its worker on setStyle and never
    // respawns it, so every GeoJSON source stops loading and the route silently
    // disappears. Toggling layer visibility avoids setStyle entirely and keeps
    // the route on screen across the toggle.
    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());

    rerender(<ActivityMap route={route} marker={emptyMarker} basemapEnabled={false} />);

    expect(map.setStyleCalls).toBe(0);
    expect(map.layoutProperties.osm).toBe('none');
    expect(map.sources.has('activity-route')).toBe(true);

    rerender(<ActivityMap route={route} marker={emptyMarker} basemapEnabled />);
    expect(map.layoutProperties.osm).toBe('visible');
  });

  it('ignores errors raised by its own GeoJSON sources', () => {
    renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());

    act(() => map.emit('error', { sourceId: 'activity-route', error: new Error('nope') }));

    expect(screen.queryByText(/basemap unavailable/i)).not.toBeInTheDocument();
  });

  it('keeps the activity when the basemap fails to load', () => {
    renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());

    act(() => map.emit('error', { error: new Error('tiles unreachable') }));

    expect(screen.getByRole('status')).toHaveTextContent(/basemap unavailable/i);
    expect(map.sources.has('activity-route')).toBe(true);
  });

  it('reports the nearest coordinate index on route hover (AV-603)', () => {
    const onRouteHover = vi.fn();
    renderMap({ onRouteHover });
    const map = latestMap();
    act(() => map.completeStyleLoad());

    map.queryRenderedFeatures.mockReturnValue([
      {
        properties: { featureIndex: 0 },
        geometry: { type: 'LineString', coordinates: [[-0.3, 51.5], [-0.1, 51.7], [0.2, 51.9]] },
      },
    ]);

    act(() =>
      map.emit(
        'mousemove',
        { point: { x: 10, y: 10 }, lngLat: { lng: -0.11, lat: 51.69 } },
        'activity-route-line',
      ),
    );

    // Resolved to the activity point index, not the coordinate index.
    expect(onRouteHover).toHaveBeenCalledWith(1);
  });

  it('resolves a hover on a later segment to the right activity point', () => {
    // Regression: with one feature per segment, a coordinate index alone is
    // ambiguous — it must be resolved against the feature that was hit.
    const segmented = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.3, segmentIndex: 0 },
        { lat: 51.6, lon: -0.2, segmentIndex: 0 },
        { lat: 48.85, lon: 2.35, segmentIndex: 1 },
        { lat: 48.86, lon: 2.36, segmentIndex: 1 },
      ]),
    );
    const onRouteHover = vi.fn();
    renderMap({ route: segmented, onRouteHover });
    const map = latestMap();
    act(() => map.completeStyleLoad());

    map.queryRenderedFeatures.mockReturnValue([
      {
        properties: { featureIndex: 1 },
        geometry: { type: 'LineString', coordinates: [[2.35, 48.85], [2.36, 48.86]] },
      },
    ]);

    act(() =>
      map.emit(
        'mousemove',
        { point: { x: 5, y: 5 }, lngLat: { lng: 2.36, lat: 48.859 } },
        'activity-route-line',
      ),
    );

    expect(onRouteHover).toHaveBeenCalledWith(3);
  });

  it('clears the hover when the pointer leaves the route', () => {
    const onRouteHover = vi.fn();
    renderMap({ onRouteHover });
    const map = latestMap();
    act(() => map.completeStyleLoad());

    act(() => map.emit('mouseleave', undefined, 'activity-route-line'));

    expect(onRouteHover).toHaveBeenCalledWith(undefined);
  });

  it('overrides the MapLibre worker URL with a bundled asset', () => {
    // Regression: MapLibre derives its worker URL from `import.meta.url` at
    // runtime, so a bundler never emits the file. The resulting 404 leaves a
    // dead worker that still draws raster tiles but never tiles a GeoJSON
    // source, so the route line vanishes with no error anywhere.
    expect(setWorkerUrl).toHaveBeenCalledTimes(1);
    expect(setWorkerUrl.mock.calls[0]?.[0]).toEqual(expect.stringContaining('maplibre-gl-worker'));
  });

  it('draws the focused section over a dimmed full route (AV-604)', () => {
    const focus = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.1 },
      ]),
    );

    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    expect(map.paintProperties['activity-route-line.line-opacity']).toBe(1);

    rerender(
      <ActivityMap route={route} focusRoute={focus} marker={emptyMarker} basemapEnabled />,
    );

    // The whole route stays visible, dimmed, so the section keeps its context.
    expect(map.paintProperties['activity-route-line.line-opacity']).toBeLessThan(1);
    const data = map.getSource('activity-focus')?.data as { features: unknown[] };
    expect(data.features).toHaveLength(1);
  });

  it('fits the map to the focused section (AV-604)', () => {
    const focus = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.1 },
      ]),
    );

    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    const fitsBefore = map.fitBoundsCalls.length;

    rerender(
      <ActivityMap route={route} focusRoute={focus} marker={emptyMarker} basemapEnabled />,
    );

    expect(map.fitBoundsCalls.length).toBe(fitsBefore + 1);
    expect(map.fitBoundsCalls.at(-1)?.[0]).toEqual([-0.2, 51.6, -0.1, 51.7]);
  });

  it('leaves the map alone after the reader moves it (AV-604)', () => {
    const focus = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.1 },
      ]),
    );

    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    rerender(
      <ActivityMap route={route} focusRoute={focus} marker={emptyMarker} basemapEnabled />,
    );

    // The reader pans away, then something incidental resizes the map.
    act(() => map.emit('dragstart', { originalEvent: new MouseEvent('mousedown') }));
    const fitsAfterFocus = map.fitBoundsCalls.length;
    act(() => map.emit('resize'));

    expect(map.fitBoundsCalls.length).toBe(fitsAfterFocus);
  });

  it('restores the full route when the focus is cleared (AV-604)', () => {
    const focus = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.1 },
      ]),
    );

    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    rerender(
      <ActivityMap route={route} focusRoute={focus} marker={emptyMarker} basemapEnabled />,
    );

    rerender(<ActivityMap route={route} marker={emptyMarker} basemapEnabled />);

    expect(map.paintProperties['activity-route-line.line-opacity']).toBe(1);
    const data = map.getSource('activity-focus')?.data as { features: unknown[] };
    expect(data.features).toHaveLength(0);
  });

  it('re-fits to the full route after a reset, not the old section (AV-604)', () => {
    // Regression: clearing the focus left boundsRef pointing at the focused
    // section, so the next resize snapped back to a section no longer selected.
    const focus = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.1 },
      ]),
    );

    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    rerender(
      <ActivityMap route={route} focusRoute={focus} marker={emptyMarker} basemapEnabled />,
    );
    expect(map.fitBoundsCalls.at(-1)?.[0]).toEqual([-0.2, 51.6, -0.1, 51.7]);

    rerender(<ActivityMap route={route} marker={emptyMarker} basemapEnabled />);
    act(() => map.emit('resize'));

    expect(map.fitBoundsCalls.at(-1)?.[0]).toEqual([-0.3, 51.5, 0.2, 51.9]);
  });

  it('moves the camera back to the whole activity on reset (AV-604)', () => {
    const focus = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.1 },
      ]),
    );

    const { rerender } = renderMap();
    const map = latestMap();
    act(() => map.completeStyleLoad());
    rerender(
      <ActivityMap route={route} focusRoute={focus} marker={emptyMarker} basemapEnabled />,
    );
    // The reader pans around while focused.
    act(() => map.emit('dragstart', { originalEvent: new MouseEvent('mousedown') }));

    rerender(<ActivityMap route={route} marker={emptyMarker} basemapEnabled />);

    // Reset View is an explicit "show me the whole thing", so it overrides the
    // panning rather than waiting for a resize.
    expect(map.fitBoundsCalls.at(-1)?.[0]).toEqual([-0.3, 51.5, 0.2, 51.9]);
  });

  it('does not fit twice when an activity loads without a focus (AV-604)', () => {
    renderMap();
    const map = latestMap();

    act(() => map.completeStyleLoad());

    // Only the route's own fit: clearing a focus that never existed is not an
    // event.
    expect(map.fitBoundsCalls).toHaveLength(1);
  });

  it('says so when the focused section has no GPS points (AV-604)', () => {
    const noLocation = activityToRouteGeoJSON(makeActivity([{ elevationMeters: 5 }]));

    renderMap({ focusRoute: noLocation });
    act(() => latestMap().completeStyleLoad());

    expect(screen.getByRole('status')).toHaveTextContent(/no GPS points/i);
  });

  it('removes the map on unmount', () => {
    const { unmount } = renderMap();
    const map = latestMap();

    unmount();

    expect(map.removed).toBe(true);
  });
});

describe('FakeMap harness', () => {
  it('tracks created instances', () => {
    resetMapLibreMock();
    renderMap();
    expect(FakeMap.instances).toHaveLength(1);
  });
});
