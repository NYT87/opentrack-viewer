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

  describe('discarding a section (AV-1105)', () => {
    const five: [number, number][] = [
      [42, -8],
      [42.001, -8],
      [42.002, -8],
      [42.003, -8],
      [42.004, -8],
    ];
    const selectPoint = async (map: Awaited<ReturnType<typeof openEditor>>, index: number, shift = false) => {
      hit(map, index);
      emit(map, 'click', { ...pointer(42 + index / 1000, -8), originalEvent: { shiftKey: shift } });
    };
    const rangeData = (map: { getSource: (id: string) => unknown }) =>
      (map.getSource('draft-range') as { data: { features: { geometry: { coordinates: number[][] } }[] } }).data;

    it('marks a section between two points and shows it before anything is removed', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 1);
      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      expect(screen.getByText(/Section starts at point 2/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Discard section' })).not.toBeInTheDocument();

      await selectPoint(map, 3);
      expect(screen.getByText(/Section: points 2 to 4 \(3 points/)).toBeInTheDocument();
      // The stretch that would go is drawn on the map, and the draft is untouched.
      expect(rangeData(map).features[0]!.geometry.coordinates).toHaveLength(3);
      expect(draftPoints()).toHaveLength(5);
    });

    it('marks a section with Shift-click', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 1);
      await selectPoint(map, 3, true);
      expect(screen.getByText(/Section: points 2 to 4/)).toBeInTheDocument();
    });

    it('discards the middle, joins the rest, and undoes', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 1);
      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      await selectPoint(map, 3);
      await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));

      expect(draftPoints().map((p) => p.lat)).toEqual([42, 42.004]);
      expect(screen.queryByRole('button', { name: 'Discard section' })).not.toBeInTheDocument();
      expect(rangeData(map).features).toEqual([]);

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(draftPoints()).toHaveLength(5);
    });

    it('treats a section selected backwards the same', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 3);
      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      await selectPoint(map, 1);
      await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
      expect(draftPoints().map((p) => p.lat)).toEqual([42, 42.004]);
    });

    it('can leave a gap instead of joining', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 1);
      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      await selectPoint(map, 3);
      await userEvent.click(screen.getByLabelText(/Leave a gap/));
      await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
      expect(draftPoints().map((p) => p.segmentIndex)).toEqual([0, 1]);
    });

    it('handles the first point, the last point and the whole route', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 0);
      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      await selectPoint(map, 1);
      await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
      expect(draftPoints().map((p) => p.lat)).toEqual([42.002, 42.003, 42.004]);

      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
      await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
      await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
      expect(draftPoints()).toHaveLength(0);
      expect(screen.getByText('No point selected')).toBeInTheDocument();
    });

    it('can be cancelled without changing the route', async () => {
      const map = await openEditor(five);
      await selectPoint(map, 1);
      await userEvent.click(screen.getByRole('button', { name: 'Mark section start' }));
      await selectPoint(map, 3);
      await userEvent.click(screen.getByRole('button', { name: 'Cancel section' }));
      expect(screen.queryByRole('button', { name: 'Discard section' })).not.toBeInTheDocument();
      expect(draftPoints()).toHaveLength(5);
      expect(rangeData(map).features).toEqual([]);
    });
  });

  describe('adding another track (AV-1106)', () => {
    const upload = async (name: string) => {
      const { fixtureFile } = await import('../test/helpers/fixtures');
      await userEvent.upload(screen.getByTestId('file-input'), fixtureFile(name));
    };

    it('appends a GPX track to the end, in order', async () => {
      await openEditor([[51.4995, 0]]);
      await upload('simple-route.gpx');

      await vi.waitFor(() => expect(draftPoints()).toHaveLength(5));
      expect(draftPoints().map((p) => p.lat)).toEqual([51.4995, 51.5, 51.501, 51.502, 51.503]);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('appends a TCX track through the same registry', async () => {
      await openEditor([[51.5, -0.1]]);
      const { fixtureFile } = await import('../test/helpers/fixtures');
      await userEvent.upload(
        screen.getByTestId('file-input'),
        fixtureFile('run-with-laps.tcx', 'application/vnd.garmin.tcx+xml'),
      );
      await vi.waitFor(() => expect(draftPoints().length).toBeGreaterThan(1));
    });

    it('asks how to join a track that starts far away, and can break the line', async () => {
      await openEditor([[10, 10]]);
      await upload('simple-route.gpx');

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent(/from where this route ends/);
      // Nothing is added until the choice is made.
      expect(draftPoints()).toHaveLength(1);

      await userEvent.click(screen.getByRole('button', { name: 'Keep them separate' }));
      expect(draftPoints()).toHaveLength(5);
      expect(draftPoints().map((p) => p.segmentIndex)).toEqual([0, 1, 1, 1, 1]);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('can join a far track with a line, or cancel', async () => {
      await openEditor([[10, 10]]);
      await upload('simple-route.gpx');
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(draftPoints()).toHaveLength(1);

      await upload('simple-route.gpx');
      await userEvent.click(await screen.findByRole('button', { name: 'Join with a straight line' }));
      expect(draftPoints().map((p) => p.segmentIndex)).toEqual([0, 0, 0, 0, 0]);
    });

    it('rejects a file with no route, and a file it cannot read, leaving the draft alone', async () => {
      await openEditor([[51.5, 0]]);
      await upload('no-location.gpx');
      expect(await screen.findByRole('status')).toHaveTextContent(/GPS|route points/i);
      expect(draftPoints()).toHaveLength(1);

      await upload('malformed.gpx');
      await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/GPX/i));
      expect(draftPoints()).toHaveLength(1);
    });

    it('can start a route from a file when entered directly', async () => {
      useRouteDraftStore.getState().clear();
      window.location.hash = '#/route-builder';
      render(<App />);
      await screen.findByRole('region', { name: 'Start a route' });
      await upload('simple-route.gpx');

      await screen.findByRole('region', { name: 'Current route' });
      expect(draftPoints()).toHaveLength(4);
      expect(useRouteDraftStore.getState().draft?.origin).toEqual({
        kind: 'appended',
        sources: ['simple-route.gpx'],
      });
    });

    it('is one undo step, and makes no network request', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await openEditor([[51.4995, 0]]);
      await upload('simple-route.gpx');
      await vi.waitFor(() => expect(draftPoints()).toHaveLength(5));

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(draftPoints()).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
