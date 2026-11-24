import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The viewer mounts a map once an activity loads, and jsdom has no WebGL.
vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {},
    setWorkerUrl,
  };
});

import { App } from './App';
import { draftFromActivity } from '../domain/routeDraft';
import { computeStreams } from '../domain/activity';
import { useRouteDraftStore } from '../state/routeDraftStore';
import { metadataForRoute } from './seo';
import { ROUTES } from './routes';

beforeEach(() => {
  useRouteDraftStore.getState().clear();
  window.location.hash = '';
});

const openFromTools = async () => {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Route Builder' }));
};

describe('Route Builder page (AV-1102)', () => {
  it('is offered in the Tools menu and routes to its own page', async () => {
    await openFromTools();
    expect(await screen.findByRole('heading', { name: 'Route Builder' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/route-builder');
  });

  it('offers to start a new route when entered directly, and shows the empty draft', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);

    expect(await screen.findByRole('region', { name: 'Start a route' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start a new route' }));

    const current = screen.getByRole('region', { name: 'Current route' });
    expect(current).toHaveTextContent('Points');
    expect(current).toHaveTextContent('0');
    expect(screen.queryByRole('region', { name: 'Start a route' })).not.toBeInTheDocument();
  });

  it('shows a draft handed over from elsewhere, and lets the user start over', async () => {
    const points = [
      { index: 0, lat: 42, lon: -8 },
      { index: 1, lat: 42.001, lon: -8 },
    ];
    const draft = draftFromActivity({
      id: 'a',
      source: { format: 'gpx', parserVersion: 't' },
      metadata: { name: 'Handed over' },
      points,
      streams: computeStreams(points),
      warnings: [],
    });
    useRouteDraftStore.getState().setDraft(draft);
    window.location.hash = '#/route-builder';
    render(<App />);

    const current = await screen.findByRole('region', { name: 'Current route' });
    expect(current).toHaveTextContent('Handed over');
    expect(current).toHaveTextContent('2');

    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('region', { name: 'Start a route' })).toBeInTheDocument();
  });

  it('starts empty after a reload, because nothing is stored', async () => {
    useRouteDraftStore.getState().startBlank();
    // A reload is a fresh module state; clearing models it.
    useRouteDraftStore.getState().clear();
    window.location.hash = '#/route-builder';
    render(<App />);
    expect(await screen.findByRole('region', { name: 'Start a route' })).toBeInTheDocument();
  });

  it('has its own title and a description that names no route', () => {
    const metadata = metadataForRoute(ROUTES.routeBuilder);
    expect(metadata.title).toMatch(/route/i);
    expect(metadata.description).toMatch(/never uploaded|nothing is uploaded/i);
  });

  it('keeps Settings reachable on the page', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /settings/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Create Custom Track (AV-1103)', () => {
  const load = async (fixture: string) => {
    const { readFixture } = await import('../test/helpers/fixtures');
    const { useActivityStore } = await import('../state/activityStore');
    const { parseGpx } = await import('../parsers/gpx/parseGpx');
    const activity = await parseGpx(readFixture(fixture), { fileName: fixture });
    useActivityStore.getState().setActivity(activity);
    return { activity, useActivityStore };
  };

  it('opens Route Builder with a copy, leaving the activity as it was', async () => {
    const { activity, useActivityStore } = await load('simple-route.gpx');
    const snapshot = JSON.stringify(activity);
    window.location.hash = '#/viewer';
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Create Custom Track' }));

    expect(await screen.findByRole('region', { name: 'Current route' })).toBeInTheDocument();
    const draft = useRouteDraftStore.getState().draft!;
    expect(draft.points.length).toBe(activity.points.length);
    expect(draft.origin.kind).toBe('activity');
    expect(JSON.stringify(useActivityStore.getState().activity)).toBe(snapshot);

    // Going back finds the activity still open.
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'File viewer' }));
    expect(await screen.findByRole('button', { name: 'Create Custom Track' })).toBeInTheDocument();
  });

  it('is disabled, with the reason, when the activity has no route', async () => {
    const { useActivityStore } = await load('simple-route.gpx');
    const noRoute = {
      ...useActivityStore.getState().activity!,
      points: [{ index: 0 }],
      streams: { ...useActivityStore.getState().activity!.streams, hasLocation: false },
    };
    useActivityStore.getState().setActivity(noRoute);
    window.location.hash = '#/viewer';
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Create Custom Track' })).toBeDisabled();
    expect(screen.getByText(/no GPS coordinates, so there is no route to copy/)).toBeInTheDocument();
  });
});

describe('editing on the map (AV-1104)', () => {
  const lngLat = (lat: number, lng: number) => ({
    lat,
    lng,
    wrap() {
      return { lat, lng };
    },
  });
  const pointer = (lat: number, lng: number, x = 100, y = 100) => ({
    point: { x, y },
    lngLat: lngLat(lat, lng),
    preventDefault: () => undefined,
  });

  const openEditor = async (points: [number, number][] = []) => {
    const { latestMap, resetMapLibreMock } = await import('../test/helpers/maplibreMock');
    resetMapLibreMock();
    const { addPoint, createBlankDraft } = await import('../domain/routeDraft');
    let draft = createBlankDraft();
    for (const [lat, lon] of points) {
      const result = addPoint(draft, { lat, lon });
      if (result.ok) draft = result.draft;
    }
    useRouteDraftStore.getState().setDraft(draft);
    window.location.hash = '#/route-builder';
    render(<App />);
    await screen.findByTestId('route-editor-map');
    const map = await vi.waitFor(() => latestMap());
    act(() => map.completeStyleLoad());
    return map;
  };

  const emit = (map: { emit: (event: string, payload?: unknown) => void }, event: string, payload?: unknown) =>
    act(() => map.emit(event, payload));
  const draftPoints = () => useRouteDraftStore.getState().draft!.points;
  const dotsOf = (map: { getSource: (id: string) => unknown }) =>
    (map.getSource('draft-points') as { data: { features: { properties: unknown }[] } }).data.features;
  const hit = (map: { queryRenderedFeatures: ReturnType<typeof vi.fn> }, index?: number) =>
    map.queryRenderedFeatures.mockReturnValue(index === undefined ? [] : [{ properties: { index } }]);

  it('draws the draft and fits to it once', async () => {
    const map = await openEditor([[42, -8], [42.01, -8.01]]);
    expect(dotsOf(map)).toHaveLength(2);
    expect(map.fitBoundsCalls).toHaveLength(1);
    // Editing afterwards must not re-fit and fight the person editing.
    hit(map);
    emit(map, 'click', pointer(42.02, -8.02));
    expect(map.fitBoundsCalls).toHaveLength(1);
  });

  it('adds a point where the map is clicked, and selects it', async () => {
    const map = await openEditor();
    hit(map);
    emit(map, 'click', pointer(42, -8));
    emit(map, 'click', pointer(42.001, -8));

    expect(draftPoints().map((p) => p.lat)).toEqual([42, 42.001]);
    expect(dotsOf(map)).toHaveLength(2);
    expect(screen.getByText('Point 2 of 2 selected')).toBeInTheDocument();
  });

  it('selects a point that is clicked instead of adding one', async () => {
    const map = await openEditor([[42, -8], [42.001, -8], [42.002, -8]]);
    hit(map, 1);
    emit(map, 'click', pointer(42.001, -8));

    expect(draftPoints()).toHaveLength(3);
    expect(screen.getByText('Point 2 of 3 selected')).toBeInTheDocument();
    expect((dotsOf(map)[1]!.properties as { selected: boolean }).selected).toBe(true);
  });

  it('drags a point: live on the map, committed once on release', async () => {
    const map = await openEditor([[42, -8], [42.001, -8], [42.002, -8]]);
    hit(map, 1);
    emit(map, 'mousedown', pointer(42.001, -8));
    expect(map.dragPan.enabled).toBe(false);

    emit(map, 'mousemove', pointer(42.005, -8.005));
    // The map shows the point in motion; the draft has not been written yet.
    const moving = (map.getSource('draft-points') as { data: { features: { geometry: { coordinates: number[] } }[] } }).data;
    expect(moving.features[1]!.geometry.coordinates).toEqual([-8.005, 42.005]);
    expect(draftPoints()[1]!.lat).toBe(42.001);
    expect(useRouteDraftStore.getState().past).toHaveLength(0);

    emit(map, 'mouseup', pointer(42.005, -8.005));
    expect(map.dragPan.enabled).toBe(true);
    expect(draftPoints()[1]).toMatchObject({ lat: 42.005, lon: -8.005 });
    expect(draftPoints()).toHaveLength(3);
    expect(useRouteDraftStore.getState().past).toHaveLength(1);
    expect(screen.getByText('Point 2 of 3 selected')).toBeInTheDocument();
  });

  it('does not add a point from the click that follows a drop', async () => {
    const map = await openEditor([[42, -8], [42.001, -8]]);
    hit(map, 0);
    emit(map, 'mousedown', pointer(42, -8));
    emit(map, 'mousemove', pointer(42.1, -8));
    emit(map, 'mouseup', pointer(42.1, -8));
    hit(map);
    emit(map, 'click', pointer(42.1, -8));

    expect(draftPoints()).toHaveLength(2);
    // And the next genuine click works again.
    emit(map, 'mousedown', pointer(43, -8));
    emit(map, 'click', pointer(43, -8));
    expect(draftPoints()).toHaveLength(3);
  });

  it('treats a press with no movement as a click, not a move', async () => {
    const map = await openEditor([[42, -8], [42.001, -8]]);
    hit(map, 0);
    emit(map, 'mousedown', pointer(42, -8));
    emit(map, 'mouseup', pointer(42, -8));
    expect(useRouteDraftStore.getState().past).toHaveLength(0);
    expect(map.dragPan.enabled).toBe(true);
  });

  it('moves a point by touch as well', async () => {
    const map = await openEditor([[42, -8], [42.001, -8]]);
    hit(map, 1);
    emit(map, 'touchstart', pointer(42.001, -8));
    emit(map, 'touchmove', pointer(42.01, -8));
    emit(map, 'touchend', pointer(42.01, -8));
    expect(draftPoints()[1]!.lat).toBe(42.01);
  });

  it('rejects a place that is not on the map, and keeps editing', async () => {
    const map = await openEditor([[42, -8]]);
    hit(map);
    emit(map, 'click', pointer(95, -8));
    expect(draftPoints()).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(/not a valid place/i);

    emit(map, 'click', pointer(42.5, -8));
    expect(draftPoints()).toHaveLength(2);
    expect(screen.queryByText(/not a valid place/i)).not.toBeInTheDocument();
  });

  it('deletes the selected point, and undoes and redoes the edit', async () => {
    const map = await openEditor([[42, -8], [42.001, -8], [42.002, -8]]);
    expect(screen.getByRole('button', { name: 'Delete point' })).toBeDisabled();

    hit(map, 1);
    emit(map, 'click', pointer(42.001, -8));
    await userEvent.click(screen.getByRole('button', { name: 'Delete point' }));
    expect(draftPoints().map((p) => p.lat)).toEqual([42, 42.002]);
    expect(dotsOf(map)).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(draftPoints()).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(draftPoints()).toHaveLength(2);
  });

  it('can do everything without the pointer: step, nudge and delete', async () => {
    await openEditor([[42, -8], [42.001, -8], [42.002, -8]]);
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    expect(screen.getByText('Point 2 of 3 selected')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Nudge north/ }));
    expect(draftPoints()[1]!.lat).toBeGreaterThan(42.001);
    await userEvent.click(screen.getByRole('button', { name: /Nudge east/ }));
    expect(draftPoints()[1]!.lon).toBeGreaterThan(-8);

    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    expect(screen.getByText('Point 1 of 3 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete point' }));
    expect(draftPoints()).toHaveLength(2);
  });

  it('shows nothing selected when the selected point disappears under undo', async () => {
    const map = await openEditor();
    hit(map);
    emit(map, 'click', pointer(42, -8));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('No point selected')).toBeInTheDocument();
  });

  it('never changes the activity the draft was copied from', async () => {
    const { useActivityStore } = await import('../state/activityStore');
    const { readFixture } = await import('../test/helpers/fixtures');
    const { parseGpx } = await import('../parsers/gpx/parseGpx');
    const activity = await parseGpx(readFixture('simple-route.gpx'), { fileName: 'simple-route.gpx' });
    useActivityStore.getState().setActivity(activity);
    const snapshot = JSON.stringify(activity);

    const { draftFromActivity } = await import('../domain/routeDraft');
    useRouteDraftStore.getState().setDraft(draftFromActivity(activity));
    window.location.hash = '#/route-builder';
    const { latestMap, resetMapLibreMock } = await import('../test/helpers/maplibreMock');
    resetMapLibreMock();
    render(<App />);
    await screen.findByTestId('route-editor-map');
    const map = await vi.waitFor(() => latestMap());
    act(() => map.completeStyleLoad());

    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete point' }));
    hit(map);
    emit(map, 'click', pointer(10, 10));

    expect(JSON.stringify(useActivityStore.getState().activity)).toBe(snapshot);
  });
});
