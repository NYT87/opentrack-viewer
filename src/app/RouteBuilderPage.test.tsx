import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The page draws the draft on a map once there is one, and jsdom has no WebGL.
vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, ScaleControl: class { setUnit() {} }, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {}, ScaleControl: class { setUnit() {} },
    setWorkerUrl,
  };
});
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const { App } = await import('./App');
const { ALL_HANDLES_LIMIT } = await import('./RouteBuilderPage');
const { FakeMap, latestMap, resetMapLibreMock } = await import('../test/helpers/maplibreMock');
const { ROUTES, TOOLS_ITEMS } = await import('./routes');
const { metadataForRoute } = await import('./seo');
const { useRouteDraftStore } = await import('../state/routeDraftStore');
const { useActivityStore } = await import('../state/activityStore');
const { useInteractionStore } = await import('../state/interactionStore');
const { draftFromActivity, createBlankDraft } = await import('../domain/routeDraft');
type RouteDraft = import('../domain/routeDraft').RouteDraft;
const { fixtureFile, binaryFixtureFile } = await import('../test/helpers/fixtures');
const { makeActivity } = await import('../test/helpers/activity');

/**
 * The first track of a test, into the planned track. A track with timestamps
 * on its own is a recording first, and its route copy is the planned track; a
 * track without goes straight in (TD-060).
 */
async function firstTrack(file: File) {
  await userEvent.upload(await screen.findByTestId('track-input'), file);
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Planned track' }) ?? screen.queryByRole('button', { name: 'Edit a route copy' }),
    ).not.toBeNull(),
  );
  const copy = screen.queryByRole('button', { name: 'Edit a route copy' });
  if (copy && !screen.queryByRole('region', { name: 'Planned track' })) await userEvent.click(copy);
}

beforeEach(() => {
  useRouteDraftStore.getState().clear();
  useActivityStore.getState().clear();
  useInteractionStore.setState({ unitSystem: 'metric' });
  window.location.hash = '';
  resetMapLibreMock();
});

/** The map, once the page has lazily loaded it and its style has "loaded". */
async function readyMap() {
  await waitFor(() => expect(FakeMap.instances.length).toBeGreaterThan(0));
  const map = latestMap();
  act(() => map.completeStyleLoad());
  return map;
}

const routeFeatures = (map: ReturnType<typeof latestMap>) =>
  (map.sources.get('activity-route')?.data as { features: unknown[] }).features;
const pointFeatures = (map: ReturnType<typeof latestMap>) =>
  (map.sources.get('draft-points')?.data as { features: { properties: { id: string; selected: boolean; inSection?: boolean } }[] }).features;

const press = (map: ReturnType<typeof latestMap>, lat: number, lon: number) =>
  act(() => map.emit('click', { point: { x: 0, y: 0 }, lngLat: { lng: lon, lat } }));

const editor = () => screen.getByRole('region', { name: 'Edit points' });
const addForm = () => within(editor()).getByRole('form', { name: 'Add a point by coordinates' });
const draft = () => useRouteDraftStore.getState().draft!;

const goToRouteBuilder = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Route Builder' }));
};

/** The viewer's own regions, none of which belong on this page. */
const expectNoViewerPanels = () => {
  for (const name of ['Route map', 'Activity charts', 'Export activity', 'Activity summary']) {
    expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
  }
};

describe('reaching the tool (AV-1102)', () => {
  it('is offered in the Tools menu as Route Builder and routes to a page of its own', async () => {
    render(<App />);
    expect(TOOLS_ITEMS.map((item) => item.label)).toContain('Route Builder');

    await goToRouteBuilder();

    expect(await screen.findByRole('heading', { name: 'Route Builder' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/route-builder');
    expect(ROUTES.routeBuilder).toBe('/route-builder');
  });

  it('marks itself as the current tool in the menu', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(screen.getByRole('menuitem', { name: 'Route Builder' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('is its own page, not the viewer: nothing of the viewer is on it', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await screen.findByRole('heading', { name: 'Route Builder' });
    expectNoViewerPanels();
    expect(screen.queryByTestId('file-input')).not.toBeInTheDocument();
  });

  it('says nothing is uploaded', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    expect(await screen.findByText(/nothing is uploaded, stored or sent/i)).toBeInTheDocument();
  });
});

describe('arriving with nothing: direct entry and reload (AV-1102)', () => {
  it('shows the empty state, without crashing, with both ways to begin', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);

    const empty = await screen.findByRole('region', { name: 'Start a track' });
    expect(within(empty).getByRole('button', { name: 'Start a blank track' })).toBeInTheDocument();
    expect(screen.getByTestId('track-input')).toHaveAttribute(
      'accept',
      '.gpx,.fit,.tcx,.kml',
    );
    expect(screen.queryByRole('region', { name: 'Planned track' })).not.toBeInTheDocument();
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
  });

  it('starts a blank planned track on the action', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));

    const track = await screen.findByRole('region', { name: 'Planned track' });
    expect(within(track).getByRole('heading', { name: 'Planned track' })).toBeInTheDocument();
    expect(track).toHaveTextContent('A new planned track');
    expect(track).toHaveTextContent(/no points yet/i);
    expect(within(track).getByText('Points').nextSibling).toHaveTextContent('0');
    expect(screen.queryByRole('region', { name: 'Start a track' })).not.toBeInTheDocument();
    expect(useRouteDraftStore.getState().draft?.kind).toBe('blank');
  });

  it('starts over, back to the empty state', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByRole('region', { name: 'Start a track' })).toBeInTheDocument();
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
  });

  it('forgets a draft after a reload, which is a fresh store', async () => {
    useRouteDraftStore.getState().startBlank();
    useRouteDraftStore.getState().clear(); // what a reload does: nothing is persisted
    window.location.hash = '#/route-builder';
    render(<App />);
    expect(await screen.findByRole('region', { name: 'Start a track' })).toBeInTheDocument();
  });
});

describe('a draft handed over (AV-1102)', () => {
  it('shows the draft it is given, and leaves the viewer alone', async () => {
    const source = makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }, { lat: 10.002, lon: 20 }]);
    const handed = draftFromActivity(
      { ...source, source: { format: 'gpx', fileName: 'ride.gpx', parserVersion: 't' } },
      { name: 'Sunday loop' },
    );
    if (!handed.ok) throw new Error('draft expected');
    act(() => useRouteDraftStore.getState().setDraft(handed.value));
    window.location.hash = '#/route-builder';
    render(<App />);

    const track = await screen.findByRole('region', { name: 'Planned track' });
    expect(within(track).getByRole('heading', { name: 'Sunday loop' })).toBeInTheDocument();
    expect(track).toHaveTextContent('Copied from a track');
    expect(track).toHaveTextContent('ride.gpx: 3 of 3 points used');
    expect(within(track).getByText('Points').nextSibling).toHaveTextContent('3');
    expect(within(track).getByText('Distance').nextSibling).toHaveTextContent(/0\.22 km|222 m/);
    expect(screen.queryByRole('region', { name: 'Start a track' })).not.toBeInTheDocument();
    // The viewer's activity was never involved.
    expect(useActivityStore.getState().activity).toBeUndefined();
  });

  it('reports distance in the reader’s units', async () => {
    const handed = draftFromActivity(
      makeActivity([{ lat: 10, lon: 20 }, { lat: 10.1, lon: 20 }]),
      { name: 'Long' },
    );
    if (!handed.ok) throw new Error('draft expected');
    useInteractionStore.setState({ unitSystem: 'imperial' });
    act(() => useRouteDraftStore.getState().setDraft(handed.value));
    window.location.hash = '#/route-builder';
    render(<App />);
    const track = await screen.findByRole('region', { name: 'Planned track' });
    expect(within(track).getByText('Distance').nextSibling).toHaveTextContent(/mi/);
  });
});

describe('importing a track (AV-1102)', () => {
  it('begins a draft from a GPX file, naming the file and what was used', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));

    const track = await screen.findByRole('region', { name: 'Planned track' });
    expect(track).toHaveTextContent('Copied from a track');
    expect(track).toHaveTextContent(/simple-route\.gpx: \d+ of \d+ points used/);
    expect(useRouteDraftStore.getState().draft?.points.length).toBeGreaterThan(1);
    expect(useActivityStore.getState().activity).toBeUndefined();
  });

  it('adds a second track after the first as a separate stretch', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });
    const first = useRouteDraftStore.getState().draft!.points.length;

    expect(screen.getByRole('heading', { name: 'Add tracks to the planned track' })).toBeInTheDocument();
    await userEvent.upload(screen.getByTestId('track-input'), fixtureFile('simple-route.gpx'));

    await waitFor(() => expect(useRouteDraftStore.getState().draft!.points.length).toBe(first * 2));
    const track = screen.getByRole('region', { name: 'Planned track' });
    expect(within(track).getByText('Stretches').nextSibling).toHaveTextContent('2');
    expect(within(track).getAllByText(/simple-route\.gpx/)).toHaveLength(2);
  });

  it('adds a track to a blank one', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await userEvent.upload(screen.getByTestId('track-input'), fixtureFile('simple-route.gpx'));
    await waitFor(() => expect(useRouteDraftStore.getState().draft!.points.length).toBeGreaterThan(0));
    expect(useRouteDraftStore.getState().draft!.kind).toBe('appended');
    expect(screen.getByRole('region', { name: 'Planned track' })).toHaveTextContent('Built from imported tracks');
  });

  it('explains a file it cannot read, keeps what it holds, and offers another go', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await userEvent.upload(
      screen.getByTestId('track-input'),
      new File(['<gpx><not closed'], 'broken.gpx', { type: 'application/gpx+xml' }),
    );

    // Said beside the drop zone, with a way to clear it; the draft is untouched.
    const unused = await screen.findByRole('list', { name: 'Not used' });
    expect(unused).toHaveTextContent(/broken\.gpx is not used\. ./);
    expect(useRouteDraftStore.getState().draft?.points).toEqual([]);

    await userEvent.click(within(unused).getByRole('button', { name: 'Remove broken.gpx' }));
    expect(screen.queryByRole('list', { name: 'Not used' })).not.toBeInTheDocument();
    expect(screen.getByTestId('track-input')).toBeInTheDocument();
  });

  it('ignores a parse that finishes after the page was left', async () => {
    // A parser that finishes only when told, so the reader can leave, come
    // back and start over while it is still "running". Mocked in a fresh
    // module graph so the page under test actually imports it.
    vi.resetModules();
    let finish: (() => void) | undefined;
    vi.doMock('../parsers', async () => {
      const actual = await vi.importActual<typeof import('../parsers')>('../parsers');
      return {
        ...actual,
        parseActivityFile: (file: File) =>
          new Promise((resolve) => {
            finish = () => resolve(actual.parseActivityFile(file));
          }),
      };
    });
    try {
      const { App: Fresh } = await import('./App');
      const { useRouteDraftStore: freshStore } = await import('../state/routeDraftStore');
      window.location.hash = '#/route-builder';
      render(<Fresh />);
      await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
      await userEvent.upload(screen.getByTestId('track-input'), fixtureFile('simple-route.gpx'));
      await screen.findByText(/Reading 1 file/);

      // Leave mid-parse, come back, and discard the draft.
      await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'File viewer' }));
      await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Route Builder' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Start over' }));
      expect(freshStore.getState().draft).toBeUndefined();

      // The old parse now finishes. It belongs to a page that is gone, so it
      // must not bring the discarded draft back with the file's points in it.
      await act(async () => {
        finish!();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(freshStore.getState().draft).toBeUndefined();
      expect(await screen.findByRole('region', { name: 'Start a track' })).toBeInTheDocument();

      // Nor may it land in a draft started afterwards: a second stale parse,
      // left behind the same way, finds a new blank track and leaves it blank.
      await userEvent.upload(screen.getByTestId('track-input'), fixtureFile('simple-route.gpx'));
      await screen.findByText(/Reading 1 file/);
      await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'File viewer' }));
      await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Route Builder' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
      await act(async () => {
        finish!();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(freshStore.getState().draft?.kind).toBe('blank');
      expect(freshStore.getState().draft?.points).toEqual([]);
    } finally {
      vi.doUnmock('../parsers');
      vi.resetModules();
    }
  });

  it('lets an import still being read go when the reader replaces the draft themselves', async () => {
    // As above, but only a file named "held…" waits to be told: the merge's own reads go through.
    vi.resetModules();
    const pending: (() => void)[] = [];
    vi.doMock('../parsers', async () => {
      const actual = await vi.importActual<typeof import('../parsers')>('../parsers');
      return {
        ...actual,
        parseActivityFile: (file: File) =>
          file.name.startsWith('held')
            ? new Promise((resolve) => pending.push(() => resolve(actual.parseActivityFile(file))))
            : actual.parseActivityFile(file),
      };
    });
    const held = async () => new File([await fixtureFile('simple-route.gpx').text()], 'held.gpx', { type: 'application/gpx+xml' });
    const finishHeld = () =>
      act(async () => {
        pending.splice(0).forEach((finish) => finish());
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    const ride = (fileName: string, fromSecond: number) => {
      const points = Array.from({ length: 10 }, (_, i) =>
        `<trkpt lat="${(46 + i * 0.0001).toFixed(4)}" lon="7"><time>${new Date(Date.UTC(2024, 0, 1, 10, 0, fromSecond + i)).toISOString()}</time></trkpt>`,
      ).join('');
      return new File(
        [`<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Ride</name><trkseg>${points}</trkseg></trk></gpx>`],
        fileName,
        { type: 'application/gpx+xml' },
      );
    };
    try {
      const { App: Fresh } = await import('./App');
      const { useRouteDraftStore: freshStore } = await import('../state/routeDraftStore');
      window.location.hash = '#/route-builder';
      render(<Fresh />);

      // A recording first, then a blank planned track, and a file picked for it.
      await userEvent.upload(await screen.findByTestId('track-input'), [ride('a.gpx', 0), ride('b.gpx', 100)]);
      await screen.findByRole('button', { name: 'Edit a route copy' });
      await userEvent.click(screen.getByRole('button', { name: 'Start a blank track' }));
      await userEvent.upload(screen.getByTestId('track-input'), await held());
      await screen.findByText(/Reading 1 file/);

      // The recording's route copy takes the blank track's place while the file is read.
      await userEvent.click(screen.getByRole('button', { name: 'Edit a route copy' }));
      const merged = freshStore.getState().draft!;
      expect(merged.points).toHaveLength(20);
      await finishHeld();
      expect(freshStore.getState().draft).toBe(merged);
      expect(await screen.findByText(/held\.gpx was not added: the planned track changed while it was read/)).toBeInTheDocument();
    } finally {
      vi.doUnmock('../parsers');
      vi.resetModules();
    }
  });

  it('refuses a track with no location, says why, and keeps the draft as it was', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const before = useRouteDraftStore.getState().draft;
    const result = useRouteDraftStore.getState().importTrack(makeActivity([{ elevationMeters: 1 }]));
    expect(result.ok).toBe(false);
    expect(useRouteDraftStore.getState().draft).toBe(before);
  });
});

describe('the page uses the app’s shell (AV-1102)', () => {
  it('has the global header, with Settings that opens over the page without leaving it', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Units')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/route-builder');
    // The page stays mounted underneath, with its draft.
    expect(screen.getByRole('heading', { name: 'Route Builder' })).toBeInTheDocument();
    expect(useRouteDraftStore.getState().draft).toBeDefined();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Planned track' })).toBeInTheDocument();
  });

  it('applies the theme the reader chose', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await screen.findByRole('heading', { name: 'Route Builder' });
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('sets its own title and description, constants that never name a track', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });

    expect(document.title).toBe(metadataForRoute(ROUTES.routeBuilder).title);
    expect(document.title).toMatch(/Plan a route/);
    const head = document.head.innerHTML + document.title;
    expect(head).not.toContain('simple-route');
    expect(head).not.toContain('Simple Route');
  });

  it('keeps nothing on the device', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });
    expect(Object.keys(localStorage).filter((key) => key !== 'opentrack-viewer:theme')).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});

describe('editing points on the map (AV-1104)', () => {
  it('draws a blank draft on a map before it has any points, with nothing fitted yet', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));

    const map = await readyMap();
    expect(screen.getByRole('region', { name: 'Draft map' })).toBeInTheDocument();
    expect(routeFeatures(map)).toEqual([]);
    expect(map.fitBoundsCalls).toEqual([]);
  });

  it('adds a point where the map was pressed, selects it, and redraws the route at once', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();

    press(map, 43, -8);
    press(map, 43.01, -8);

    expect(draft().points).toHaveLength(2);
    expect(draft().points[1]).toMatchObject({ lat: 43.01, lon: -8, origin: { kind: 'manual' } });
    // The preview: one line through both points, and both drawn as handles,
    // the newest selected.
    expect(routeFeatures(map)).toHaveLength(1);
    expect(pointFeatures(map).map((f) => f.properties)).toEqual([
      { id: 'p0', selected: false, inSection: false },
      { id: 'p1', selected: true, inSection: false },
    ]);
    const track = screen.getByRole('region', { name: 'Planned track' });
    expect(within(track).getByText('Points').nextSibling).toHaveTextContent('2');
    expect(within(track).getByText('Distance').nextSibling).toHaveTextContent(/1\.1\d? km/);
    expect(editor()).toHaveTextContent('Selected: point 2 of 2');
  });

  it('adds a point from typed coordinates, with an elevation when given', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await readyMap();

    await userEvent.type(within(addForm()).getByLabelText('Latitude'), '51.5');
    await userEvent.type(within(addForm()).getByLabelText('Longitude'), '-0.1');
    await userEvent.type(within(addForm()).getByLabelText(/Elevation/), '12');
    await userEvent.click(within(addForm()).getByRole('button', { name: 'Add point' }));

    expect(draft().points[0]).toMatchObject({ lat: 51.5, lon: -0.1, elevationMeters: 12, edit: { kind: 'added' } });
  });

  it('refuses an impossible place with a word, not a block, and changes nothing', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    const before = draft();

    await userEvent.type(within(addForm()).getByLabelText('Latitude'), '95');
    await userEvent.type(within(addForm()).getByLabelText('Longitude'), '0');
    await userEvent.click(within(addForm()).getByRole('button', { name: 'Add point' }));

    expect(within(editor()).getByRole('status')).toHaveTextContent(/Latitude must be a number between -90 and 90/);
    expect(draft()).toBe(before);
    // Nothing is modal: the next edit goes straight through.
    press(map, 43.01, -8);
    expect(draft().points).toHaveLength(2);
    expect(within(editor()).getByRole('status')).not.toHaveTextContent(/Latitude must/);
  });

  it('selects points from the keyboard, removes the selected one, and keeps the rest', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    press(map, 43.02, -8);
    expect(editor()).toHaveTextContent('Selected: point 3 of 3');

    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    expect(editor()).toHaveTextContent('Selected: point 2 of 3');
    expect(pointFeatures(map).find((f) => f.properties.selected)?.properties.id).toBe('p1');

    await userEvent.click(screen.getByRole('button', { name: 'Remove point' }));

    expect(draft().points.map((p) => p.id)).toEqual(['p0', 'p2']);
    expect(editor()).toHaveTextContent('No point selected (2 in the track)');
    expect(routeFeatures(map)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Remove point' })).not.toBeInTheDocument();
  });

  it('selects a point by pressing it on the map', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);

    map.queryRenderedFeatures.mockReturnValue([{ properties: { id: 'p0' } }]);
    press(map, 43, -8);

    expect(editor()).toHaveTextContent('Selected: point 1 of 2');
    expect(draft().points).toHaveLength(2);
  });

  it('moves the selected point by typing where it should go, remembering where it was', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    const moveForm = () => within(editor()).getByRole('form', { name: 'Move the selected point' });

    // The fields start from where the point is.
    expect(within(moveForm()).getByLabelText('Latitude')).toHaveValue('43');
    await userEvent.clear(within(moveForm()).getByLabelText('Latitude'));
    await userEvent.type(within(moveForm()).getByLabelText('Latitude'), '43.5');
    await userEvent.click(within(moveForm()).getByRole('button', { name: 'Move point' }));

    expect(draft().points[0]).toMatchObject({ lat: 43.5, lon: -8, edit: { kind: 'added' } });
    expect(pointFeatures(map)[0]?.properties.id).toBe('p0');
  });

  it('moves the selected point to where the map is pressed, in move mode', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);

    await userEvent.click(screen.getByRole('radio', { name: /moves the selected point/ }));
    expect(within(editor()).getByRole('status')).toHaveTextContent('Press the map to move point 2 there.');
    press(map, 44, -9);

    expect(draft().points).toHaveLength(2);
    expect(draft().points[1]).toMatchObject({ lat: 44, lon: -9 });

    // Deselecting takes the map back to adding: there is nothing to move. And
    // it stays there: the next press adds and selects a point, and the press
    // after that adds another rather than moving it (review R1-C2).
    await userEvent.click(screen.getByRole('button', { name: 'Deselect' }));
    expect(screen.getByRole('radio', { name: /moves the selected point/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /adds a point/ })).toBeChecked();
    press(map, 45, -9);
    expect(draft().points).toHaveLength(3);
    expect(screen.getByRole('radio', { name: /adds a point/ })).toBeChecked();
    press(map, 46, -9);
    expect(draft().points).toHaveLength(4);
    expect(draft().points[3]).toMatchObject({ lat: 46, lon: -9 });
  });

  it('goes back to adding when the selected point is removed, and after starting over', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    await userEvent.click(screen.getByRole('radio', { name: /moves the selected point/ }));

    // Removing the selected point: the next two presses both add.
    await userEvent.click(screen.getByRole('button', { name: 'Remove point' }));
    expect(screen.getByRole('radio', { name: /adds a point/ })).toBeChecked();
    press(map, 44, -8);
    press(map, 45, -8);
    expect(draft().points.map((p) => [p.lat, p.lon])).toEqual([[43, -8], [44, -8], [45, -8]]);

    // Move mode again, then a new draft: it does not carry over.
    await userEvent.click(screen.getByRole('radio', { name: /moves the selected point/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const fresh = await readyMap();
    expect(screen.getByRole('radio', { name: /adds a point/ })).toBeChecked();
    press(fresh, 1, 1);
    press(fresh, 2, 2);
    expect(draft().points).toHaveLength(2);
  });

  it('does not pull the camera back while editing, but fits a new draft', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    const map = await readyMap();
    expect(map.fitBoundsCalls).toHaveLength(1);

    press(map, 43, -8);
    press(map, 43.01, -8);
    expect(map.fitBoundsCalls).toHaveLength(1);

    // Starting over unmounts the map with the draft; a new draft gets a new
    // map, fitted once to its first point (a centre, since one point has no
    // area) and then left alone as points are added.
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const fresh = await readyMap();
    expect(fresh).not.toBe(map);
    press(fresh, 1, 1);
    expect(fresh.easeToCalls).toHaveLength(1);
    press(fresh, 2, 2);
    press(fresh, 3, 3);
    expect(fresh.easeToCalls).toHaveLength(1);
    expect(fresh.fitBoundsCalls).toHaveLength(0);
  });

  it('leaves the activity a draft was copied from exactly as it was', async () => {
    const source = makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }, { lat: 10.002, lon: 20 }]);
    const before = JSON.stringify(source);
    const handed = draftFromActivity(source, { name: 'Copy' });
    if (!handed.ok) throw new Error('draft expected');
    act(() => useRouteDraftStore.getState().setDraft(handed.value));
    window.location.hash = '#/route-builder';
    render(<App />);
    const map = await readyMap();

    press(map, 11, 21);
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    const moveForm = within(editor()).getByRole('form', { name: 'Move the selected point' });
    await userEvent.clear(within(moveForm).getByLabelText('Longitude'));
    await userEvent.type(within(moveForm).getByLabelText('Longitude'), '25');
    await userEvent.click(within(moveForm).getByRole('button', { name: 'Move point' }));

    expect(JSON.stringify(source)).toBe(before);
    expect(draft().points.some((p) => p.lon === 25)).toBe(true);
  });

  it('says plainly that points are not dragged', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await readyMap();
    expect(within(editor()).getByRole('status')).toHaveTextContent(/Points are not dragged/);
  });
});

describe('discarding a section, with undo (AV-1105)', () => {
  const lapFeatures = (map: ReturnType<typeof latestMap>) =>
    (map.sources.get('activity-lap')?.data as { features: unknown[] }).features;
  const sectionGroup = () => within(editor()).getByRole('group', { name: 'Section' });
  const stretches = () =>
    within(screen.getByRole('region', { name: 'Planned track' })).queryByText('Stretches')?.nextSibling?.textContent;

  /** Five points zig-zagging north, so cutting the middle shortens the track; then selects point `n` (1-based). */
  async function fiveAndSelect(n: number) {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    for (let i = 0; i < 5; i += 1) press(map, 43 + i * 0.01, -8 + (i % 2) * 0.02);
    await userEvent.click(screen.getByRole('button', { name: 'Deselect' }));
    for (let i = 0; i < n; i += 1) await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    expect(editor()).toHaveTextContent(`Selected: point ${n} of 5`);
    return map;
  }

  it('marks a section from the selected point and shows it on the map before anything is cut', async () => {
    const map = await fiveAndSelect(2);
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    expect(sectionGroup()).toHaveTextContent('Section starts at point 2; mark where it ends');
    expect(lapFeatures(map)).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));

    expect(sectionGroup()).toHaveTextContent('Section: points 2 to 4 (3 points), shown on the map');
    expect(lapFeatures(map)).toHaveLength(1);
    expect(draft().points).toHaveLength(5);
    // Nothing has moved the camera for it.
    expect(map.fitBoundsCalls.length + map.easeToCalls.length).toBe(1);
  }, 20_000);

  it('reads the marks the same way whichever end was marked first', async () => {
    await fiveAndSelect(4);
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    expect(sectionGroup()).toHaveTextContent('Section: points 2 to 4 (3 points)');
  });

  it('discards the middle, joins the road either side, and updates the preview and distance', async () => {
    const map = await fiveAndSelect(2);
    const before = within(screen.getByRole('region', { name: 'Planned track' })).getByText('Distance').nextSibling!.textContent;
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));

    await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));

    expect(draft().points.map((p) => p.id)).toEqual(['p0', 'p3', 'p4']);
    expect(stretches()).toBe('1');
    expect(routeFeatures(map)).toHaveLength(1);
    expect(lapFeatures(map)).toEqual([]);
    expect(within(editor()).getByRole('status')).toHaveTextContent(/Discarded 2 points.*runs straight.*Undo takes it back/);
    const after = within(screen.getByRole('region', { name: 'Planned track' })).getByText('Distance').nextSibling!.textContent;
    expect(after).not.toBe(before);
    // The marks went with the points; no section is pending.
    expect(screen.queryByRole('button', { name: 'Discard section' })).not.toBeInTheDocument();
  });

  it('keeps a gap when asked, so the two sides are separate stretches', async () => {
    // A one-point section, the middle point: two points remain either side,
    // enough for a line on each.
    const map = await fiveAndSelect(3);
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    expect(sectionGroup()).toHaveTextContent('Section: points 3 to 3 (1 point)');
    await userEvent.click(screen.getByRole('checkbox', { name: /keep a gap/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));

    expect(draft().points.map((p) => p.segmentIndex)).toEqual([0, 0, 1, 1]);
    expect(stretches()).toBe('2');
    expect(routeFeatures(map)).toHaveLength(2);
    expect(within(editor()).getByRole('status')).toHaveTextContent(/A gap was kept/);
  });

  it('takes a discard back with Undo, and Undo is only offered when there is something to take back', async () => {
    await fiveAndSelect(1);
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    for (let i = 0; i < 4; i += 1) await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
    // The whole track: an empty draft, not a crash.
    expect(draft().points).toEqual([]);
    expect(editor()).toHaveTextContent('No points yet');
    expect(within(editor()).getByRole('status')).toHaveTextContent(/Discarded 5 points.*Nothing was on the other side/);

    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));
    expect(draft().points).toHaveLength(5);
    expect(within(editor()).getByRole('status')).toHaveTextContent('The last edit was taken back.');

    // Undo all the way back to the blank track, then there is nothing left.
    for (let i = 0; i < 5; i += 1) await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));
    expect(draft().points).toEqual([]);
    expect(screen.getByRole('button', { name: 'Undo last edit' })).toBeDisabled();
    // Sixteen presses and clicks: longer than the default budget on a loaded machine.
  }, 20_000);

  it('discards from the start and from the end without anything to join', async () => {
    await fiveAndSelect(1);
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
    expect(draft().points.map((p) => p.id)).toEqual(['p2', 'p3', 'p4']);

    // Now the last two of what is left: select the second, mark, then the last.
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
    expect(draft().points.map((p) => p.id)).toEqual(['p2']);
    expect(stretches()).toBe('1');
  });

  it('joins and splits stretches from the selected point', async () => {
    await fiveAndSelect(3);
    expect(editor()).toHaveTextContent('This point continues the stretch from the point before.');
    await userEvent.click(screen.getByRole('button', { name: 'Start a new stretch here' }));
    expect(stretches()).toBe('2');
    expect(editor()).toHaveTextContent('This point begins a stretch');

    await userEvent.click(screen.getByRole('button', { name: 'Join to the point before' }));
    expect(stretches()).toBe('1');
    expect(draft().points.map((p) => p.segmentIndex)).toEqual([0, 0, 0, 0, 0]);
  });

  it('forgets the marks with the draft they belonged to', async () => {
    await fiveAndSelect(2);
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await readyMap();
    expect(sectionGroup()).toHaveTextContent('Section: none marked');
  });
});

describe('marks never outlive their draft (AV-1105, review)', () => {
  it('does not resurrect a section when a new draft reuses the old point ids', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    expect(screen.getByRole('button', { name: 'Discard section' })).toBeInTheDocument();

    // A new draft whose points are again p0 and p1.
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const fresh = await readyMap();
    press(fresh, 1, 1);
    press(fresh, 2, 2);

    const group = within(editor()).getByRole('group', { name: 'Section' });
    expect(group).toHaveTextContent('Section: none marked');
    expect(screen.queryByRole('button', { name: 'Discard section' })).not.toBeInTheDocument();
    expect((fresh.sources.get('activity-lap')?.data as { features: unknown[] }).features).toEqual([]);
  });
});

describe('marks and undo (AV-1105, review)', () => {
  it('does not resurrect a section when a point is added after undoing an addition', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    expect(screen.getByRole('button', { name: 'Discard section' })).toBeInTheDocument();

    // Take the second point back, then add another somewhere else.
    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));
    const group = within(editor()).getByRole('group', { name: 'Section' });
    expect(group).toHaveTextContent('Section starts at point 1; mark where it ends');
    press(map, 50, -1);

    expect(draft().points.map((p) => p.id)).toEqual(['p0', 'p2']);
    expect(group).toHaveTextContent('Section starts at point 1; mark where it ends');
    expect(screen.queryByRole('button', { name: 'Discard section' })).not.toBeInTheDocument();
    expect((map.sources.get('activity-lap')?.data as { features: unknown[] }).features).toEqual([]);
  });
});

describe('undo and the live selection; one-point sections (AV-1105, review)', () => {
  it('does not bring back move mode for a point that was removed and then restored by undo', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    await userEvent.click(screen.getByRole('radio', { name: /moves the selected point/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove point' }));
    expect(screen.getByRole('radio', { name: /adds a point/ })).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));

    // The point is back; the selection and its move mode are not.
    expect(draft().points).toHaveLength(2);
    expect(editor()).toHaveTextContent('No point selected (2 in the track)');
    expect(screen.getByRole('radio', { name: /adds a point/ })).toBeChecked();
    press(map, 50, -1);
    expect(draft().points).toHaveLength(3);
    expect(draft().points[1]).toMatchObject({ lat: 43.01, lon: -8 });
  });

  it('keeps a live selection and its mode across an undo of some other edit', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('radio', { name: /moves the selected point/ }));
    press(map, 44, -9); // moves p0

    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));

    expect(editor()).toHaveTextContent('Selected: point 1 of 2');
    expect(screen.getByRole('radio', { name: /moves the selected point/ })).toBeChecked();
  });

  it('shows a one-point section on the map through its handle', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    press(map, 43, -8);
    press(map, 43.01, -8);
    press(map, 43.02, -8);
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deselect' }));

    expect(within(editor()).getByRole('group', { name: 'Section' })).toHaveTextContent('Section: points 2 to 2 (1 point), shown on the map');
    // No line can be drawn through one point, so the handle carries the mark.
    expect(pointFeatures(map).map((f) => f.properties.inSection)).toEqual([false, true, false]);
    expect(pointFeatures(map).map((f) => f.properties.selected)).toEqual([false, false, false]);
    expect(map.layers.find((layer) => layer.id === 'draft-point')).toBeDefined();
  });
});

describe('appending another track (AV-1106)', () => {
  const lastAdded = () => screen.getByRole('status', { name: 'Last track added' });
  const upload = async (file: File) => userEvent.upload(screen.getByTestId('track-input'), file);

  async function startWithGpx() {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });
    return draft().points.length;
  }

  it('keeps a joined track read-only until Edit this track is pressed', async () => {
    await startWithGpx();
    await upload(fixtureFile('route-with-elevation.gpx'));
    await waitFor(() => expect(draft().sources).toHaveLength(2));
    const map = await readyMap();
    const before = draft().points.length;

    expect(screen.queryByRole('region', { name: 'Edit points' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Draft map' })).toHaveTextContent('Map clicks do not change it.');
    press(map, 47, 8);
    expect(draft().points).toHaveLength(before);

    await userEvent.click(screen.getByRole('button', { name: 'Edit this track' }));
    expect(editor()).toBeInTheDocument();
    press(map, 47, 8);
    expect(draft().points).toHaveLength(before + 1);
  });

  it('appends a second GPX after the first, in order, and says how far it jumped', async () => {
    const before = await startWithGpx();
    const ids = draft().points.map((p) => p.id);
    await upload(fixtureFile('route-with-elevation.gpx'));

    await waitFor(() => expect(draft().points.length).toBeGreaterThan(before));
    expect(draft().points.slice(0, before).map((p) => p.id)).toEqual(ids);
    expect(draft().kind).toBe('copied');
    expect(lastAdded()).toHaveTextContent(/Added \d+ points from route-with-elevation\.gpx\. It starts .* as a stretch of its own/);
  });

  it('appends a TCX and a FIT through the same intake, warning when the start is far away', async () => {
    const before = await startWithGpx();
    await upload(fixtureFile('ride-minimal.tcx', 'application/vnd.garmin.tcx+xml'));
    await waitFor(() => expect(draft().points.length).toBeGreaterThan(before));
    // 51.5° to 51.4° north: about eleven kilometres.
    expect(lastAdded()).toHaveTextContent(/far apart, so it is a stretch of its own and nothing is drawn or counted across the jump/);
    expect(draft().sources.map((s) => s.fileName)).toEqual(['simple-route.gpx', 'ride-minimal.tcx']);

    const withTcx = draft().points.length;
    await upload(binaryFixtureFile('ride-with-sensors.fit'));
    await waitFor(() => expect(draft().points.length).toBeGreaterThan(withTcx));
    expect(draft().sources.map((s) => s.fileName)).toEqual(['simple-route.gpx', 'ride-minimal.tcx', 'ride-with-sensors.fit']);
    expect(lastAdded()).toHaveTextContent('ride-with-sensors.fit');
  });

  it('selects the join on request, where the reader can join the two', async () => {
    const before = await startWithGpx();
    await upload(fixtureFile('ride-minimal.tcx', 'application/vnd.garmin.tcx+xml'));
    await waitFor(() => expect(draft().points.length).toBeGreaterThan(before));

    await userEvent.click(screen.getByRole('button', { name: 'Edit this track' }));
    await userEvent.click(within(lastAdded()).getByRole('button', { name: 'Select the join' }));

    expect(editor()).toHaveTextContent(`Selected: point ${before + 1} of`);
    await userEvent.click(screen.getByRole('button', { name: 'Join to the point before' }));
    expect(new Set(draft().points.map((p) => p.segmentIndex)).size).toBe(1);
  });

  it('keeps the notice true after a join, a move of either end, and an undo (review R1-C1)', async () => {
    const before = await startWithGpx();
    await upload(fixtureFile('ride-minimal.tcx', 'application/vnd.garmin.tcx+xml'));
    await waitFor(() => expect(draft().points.length).toBeGreaterThan(before));
    const farText = lastAdded().querySelector('.route-draft__appended')?.textContent;
    expect(farText).toMatch(/far apart/);

    // Joined: the notice says the jump is now drawn and counted.
    await userEvent.click(screen.getByRole('button', { name: 'Edit this track' }));
    await userEvent.click(within(lastAdded()).getByRole('button', { name: 'Select the join' }));
    await userEvent.click(screen.getByRole('button', { name: 'Join to the point before' }));
    expect(lastAdded()).toHaveTextContent(/joined to the point before it: the .* between them is drawn and counted/);
    expect(lastAdded()).not.toHaveTextContent(/nothing is drawn/);

    // Undo the join: back to a break, with the same distance as before.
    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));
    expect(lastAdded().querySelector('.route-draft__appended')?.textContent).toBe(farText);

    // Move the first appended point next to the end of the first track: the
    // distance follows, and it is no longer far.
    const end = draft().points[before - 1]!;
    const moveForm = within(editor()).getByRole('form', { name: 'Move the selected point' });
    await userEvent.clear(within(moveForm).getByLabelText('Latitude'));
    await userEvent.type(within(moveForm).getByLabelText('Latitude'), String(end.lat + 0.001));
    await userEvent.clear(within(moveForm).getByLabelText('Longitude'));
    await userEvent.type(within(moveForm).getByLabelText('Longitude'), String(end.lon));
    await userEvent.click(within(moveForm).getByRole('button', { name: 'Move point' }));
    expect(lastAdded()).not.toHaveTextContent(/far apart/);
    expect(lastAdded()).toHaveTextContent(/It starts 1\d\d m from the point before it/);

    // Move the last point of the first track far away: the notice measures from it.
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    const endForm = within(editor()).getByRole('form', { name: 'Move the selected point' });
    await userEvent.clear(within(endForm).getByLabelText('Latitude'));
    await userEvent.type(within(endForm).getByLabelText('Latitude'), '45');
    await userEvent.click(within(endForm).getByRole('button', { name: 'Move point' }));
    expect(lastAdded()).toHaveTextContent(/far apart/);
  }, 20_000);

  it('refuses a track with no route, says so as such, and keeps the draft', async () => {
    await startWithGpx();
    const held = draft();
    await upload(binaryFixtureFile('treadmill-run.fit'));

    const failure = await screen.findByRole('region', { name: 'Track not imported' });
    const alert = within(failure).getByRole('alert');
    expect(alert).toHaveAttribute('data-error-code', 'no_route_points');
    expect(alert).toHaveTextContent(/^It has no route to add/);
    expect(failure).toHaveTextContent('Nothing of it was added to the planned track.');
    expect(draft()).toBe(held);
  });

  it('refuses a file that is not a track it can read, with its own reason, and keeps the draft', async () => {
    await startWithGpx();
    const held = draft();
    await upload(new File(['not a track at all'], 'notes.gpx', { type: 'application/gpx+xml' }));

    expect(await screen.findByRole('list', { name: 'Not used' })).toHaveTextContent(/notes\.gpx is not used\. ./);
    expect(draft()).toBe(held);
  });

  it('turns away an unsupported file type before reading it', async () => {
    await startWithGpx();
    const held = draft();
    // The picker's accept list would hide it; a drop does not, so the page's own check is what is tested.
    await userEvent.setup({ applyAccept: false }).upload(screen.getByTestId('track-input'), new File(['a,b'], 'route.csv', { type: 'text/csv' }));
    expect(await screen.findByText(/"route\.csv" is not supported/)).toBeInTheDocument();
    expect(draft()).toBe(held);
  });

  it('never replaces the draft by appending, and can be undone', async () => {
    const before = await startWithGpx();
    const id = draft().id;
    await upload(fixtureFile('route-with-elevation.gpx'));
    await waitFor(() => expect(draft().points.length).toBeGreaterThan(before));
    expect(draft().id).toBe(id);

    await userEvent.click(screen.getByRole('button', { name: 'Edit this track' }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo last edit' }));
    expect(draft().points).toHaveLength(before);
    // The notice goes with the points it described.
    expect(screen.queryByRole('status', { name: 'Last track added' })).not.toBeInTheDocument();
  });
});

describe('exporting the planned track (AV-1107)', () => {
  let saved: { fileName: string; blob: Blob }[] = [];
  beforeEach(() => {
    saved = [];
    const blobs = new Map<string, Blob>();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: (blob: Blob) => {
        const url = `blob:test/${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ fileName: this.download, blob: blobs.get(this.href)! });
    });
  });

  const exportRegion = () => screen.getByRole('region', { name: 'Export for a device' });

  it('offers no controls until the track is a route', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    const map = await readyMap();
    expect(exportRegion()).toHaveTextContent(/once the track is a route/);
    expect(within(exportRegion()).queryByRole('button')).not.toBeInTheDocument();

    press(map, 43, -8);
    expect(within(exportRegion()).queryByRole('button')).not.toBeInTheDocument();
    press(map, 43.01, -8);
    expect(within(exportRegion()).getByRole('button', { name: /Download/ })).toBeEnabled();
  });

  it('downloads a GPX named as a planned track, and says what it left out', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('route-with-elevation.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });

    await userEvent.click(within(exportRegion()).getByRole('button', { name: /Download .*-planned-track\.gpx/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.fileName).toMatch(/-planned-track\.gpx$/);
    const xml = await saved[0]!.blob.text();
    expect(xml).toContain('<trkpt');
    expect(xml).not.toContain('<time>');
    const written = within(exportRegion()).getByRole('status', { name: 'Planned track written' });
    expect(written).toHaveTextContent(saved[0]!.fileName);
    expect(written).toHaveTextContent(/Only the route was written/);
    expect(written).toHaveTextContent(/says where to go, not when/);
  });

  it('lists FIT and TCX as disabled, with the reason, and GPX as the choice', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });

    expect(within(exportRegion()).getByRole('radio', { name: /^GPX/ })).toBeChecked();
    for (const label of [/^FIT/, /^TCX/]) {
      const radio = within(exportRegion()).getByRole('radio', { name: label });
      expect(radio).toBeDisabled();
    }
    expect(exportRegion()).toHaveTextContent(/FIT is written as a recorded activity/);
    expect(exportRegion()).toHaveTextContent(/TCX is written as a recorded activity/);
  });

  it('warns about separate stretches when there are several', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await firstTrack(fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });
    await userEvent.upload(screen.getByTestId('track-input'), fixtureFile('route-with-elevation.gpx'));
    await waitFor(() => expect(new Set(draft().points.map((p) => p.segmentIndex)).size).toBe(2));

    await userEvent.click(within(exportRegion()).getByRole('button', { name: /Download/ }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(within(exportRegion()).getByRole('status', { name: 'Planned track written' })).toHaveTextContent(
      /2 separate track segments/,
    );
  });
});

describe('the stretch count in the summary (AV-1107, review)', () => {
  it('counts a stretch whose number comes back as a stretch of its own', async () => {
    const draft0: RouteDraft = {
      ...createBlankDraft({ id: 'r', name: 'Runs' }),
      points: [0, 0, 1, 1, 0, 0].map((segmentIndex, i) => ({
        id: `p${i}`,
        lat: 43 + i * 0.001,
        lon: -8,
        segmentIndex,
        origin: { kind: 'manual' as const },
      })),
      counters: { point: 6, source: 0 },
    };
    act(() => useRouteDraftStore.getState().setDraft(draft0));
    window.location.hash = '#/route-builder';
    render(<App />);
    const track = await screen.findByRole('region', { name: 'Planned track' });
    expect(within(track).getByText('Stretches').nextSibling).toHaveTextContent('3');
  });
});

describe('handles on a long track (AV-1108)', () => {
  const long = (n: number, split?: number): RouteDraft => ({
    ...createBlankDraft({ id: `long-${n}`, name: 'Long' }),
    points: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      lat: 43 + i * 0.0001,
      lon: -8,
      segmentIndex: split !== undefined && i >= split ? 1 : 0,
      origin: { kind: 'manual' as const },
    })),
    counters: { point: n, source: 0 },
  });

  it('draws every handle up to the limit', async () => {
    act(() => useRouteDraftStore.getState().setDraft(long(ALL_HANDLES_LIMIT)));
    window.location.hash = '#/route-builder';
    render(<App />);
    const map = await readyMap();
    expect(pointFeatures(map)).toHaveLength(ALL_HANDLES_LIMIT);
  });

  it('keeps only the selected point, stretch ends and section ends beyond it', async () => {
    act(() => useRouteDraftStore.getState().setDraft(long(10_000, 5_000)));
    window.location.hash = '#/route-builder';
    render(<App />);
    const map = await readyMap();
    // Two stretches: their four ends.
    expect(pointFeatures(map).map((f) => f.properties.id)).toEqual(['p0', 'p4999', 'p5000', 'p9999']);

    // Select the last point, step back, and mark a section: those points get handles.
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    const ids = pointFeatures(map).map((f) => f.properties.id);
    expect(ids).toEqual(['p0', 'p4999', 'p5000', 'p9997', 'p9998', 'p9999']);
    expect(pointFeatures(map).find((f) => f.properties.id === 'p9997')!.properties.selected).toBe(true);
    expect(pointFeatures(map).filter((f) => f.properties.inSection).map((f) => f.properties.id)).toEqual(['p9997', 'p9998']);
  }, 20_000);

  it('selects an interior point without a handle by pressing the route, and edits a section from there (review R1-C1)', async () => {
    act(() => useRouteDraftStore.getState().setDraft(long(10_000)));
    window.location.hash = '#/route-builder';
    render(<App />);
    const map = await readyMap();
    const held = draft();
    expect(pointFeatures(map).some((f) => f.properties.id === 'p5000')).toBe(false);

    // A press on the route line near point 5000: MapLibre reports the line
    // feature under the pointer, and the page picks the nearest point on it.
    const line = held.points.map((p) => [p.lon, p.lat]);
    map.queryRenderedFeatures.mockImplementation(((_point: unknown, options?: { layers?: string[] }) =>
      options?.layers?.includes('activity-route-line')
        ? [{ geometry: { type: 'LineString', coordinates: line }, properties: { featureIndex: 0 } }]
        : []) as never);
    act(() => map.emit('click', { point: { x: 0, y: 0 }, lngLat: { lng: -8, lat: 43 + 5000 * 0.0001 } }));

    expect(editor()).toHaveTextContent('Selected: point 5001 of 10000');
    expect(draft()).toBe(held);
    expect(pointFeatures(map).find((f) => f.properties.id === 'p5000')!.properties.selected).toBe(true);

    // And a section from there, two points long, discarded.
    await userEvent.click(screen.getByRole('button', { name: 'Section starts here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next point' }));
    await userEvent.click(screen.getByRole('button', { name: 'Section ends here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard section' }));
    expect(draft().points).toHaveLength(9_998);
    expect(draft().points.some((p) => p.id === 'p5000' || p.id === 'p5001')).toBe(false);
  }, 20_000);

  it('keeps a press on the line adding a point on a short track, where every point has a handle', async () => {
    act(() => useRouteDraftStore.getState().setDraft(long(10)));
    window.location.hash = '#/route-builder';
    render(<App />);
    const map = await readyMap();
    const line = draft().points.map((p) => [p.lon, p.lat]);
    map.queryRenderedFeatures.mockImplementation(((_point: unknown, options?: { layers?: string[] }) =>
      options?.layers?.includes('activity-route-line')
        ? [{ geometry: { type: 'LineString', coordinates: line }, properties: { featureIndex: 0 } }]
        : []) as never);
    act(() => map.emit('click', { point: { x: 0, y: 0 }, lngLat: { lng: -8, lat: 43.0005 } }));
    expect(draft().points).toHaveLength(11);
  });

  it('in move mode, a press on the line still moves the selected point of a long track (review R1-C1)', async () => {
    act(() => useRouteDraftStore.getState().setDraft(long(10_000)));
    window.location.hash = '#/route-builder';
    render(<App />);
    const map = await readyMap();
    const line = draft().points.map((p) => [p.lon, p.lat]);
    map.queryRenderedFeatures.mockImplementation(((_point: unknown, options?: { layers?: string[] }) =>
      options?.layers?.includes('activity-route-line')
        ? [{ geometry: { type: 'LineString', coordinates: line }, properties: { featureIndex: 0 } }]
        : []) as never);

    // The last point selected and moved onto the line, where point 5000 is.
    await userEvent.click(screen.getByRole('button', { name: 'Previous point' }));
    expect(editor()).toHaveTextContent('Selected: point 10000 of 10000');
    await userEvent.click(screen.getByRole('radio', { name: /moves the selected point/ }));
    act(() => map.emit('click', { point: { x: 0, y: 0 }, lngLat: { lng: -8, lat: 43.5 } }));

    expect(editor()).toHaveTextContent('Selected: point 10000 of 10000');
    expect(draft().points).toHaveLength(10_000);
    expect(draft().points[9_999]).toMatchObject({ id: 'p9999', lat: 43.5, lon: -8 });
  }, 20_000);
});

describe('one preview per edit (AV-1108)', () => {
  it('turns the draft into an activity once for each edit, shared by the map and the summary', async () => {
    vi.resetModules();
    let conversions = 0;
    vi.doMock('../domain/routeDraft', async () => {
      const actual = await vi.importActual<typeof import('../domain/routeDraft')>('../domain/routeDraft');
      return {
        ...actual,
        draftToActivity: (...args: Parameters<typeof actual.draftToActivity>) => {
          conversions += 1;
          return actual.draftToActivity(...args);
        },
      };
    });
    try {
      const { App: Fresh } = await import('./App');
      const { useRouteDraftStore: freshStore } = await import('../state/routeDraftStore');
      window.location.hash = '#/route-builder';
      render(<Fresh />);
      await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
      // Points typed rather than pressed on the map: the map is a lazy chunk,
      // and after the module reset its mocked MapLibre may be either module
      // instance. The count is of the page's work, the same either way.
      const type = async (lat: string) => {
        await userEvent.clear(within(addForm()).getByLabelText('Latitude'));
        await userEvent.type(within(addForm()).getByLabelText('Latitude'), lat);
        await userEvent.clear(within(addForm()).getByLabelText('Longitude'));
        await userEvent.type(within(addForm()).getByLabelText('Longitude'), '-8');
        await userEvent.click(within(addForm()).getByRole('button', { name: 'Add point' }));
      };
      await type('43');
      await type('43.01');

      const before = conversions;
      await type('43.02');
      expect(freshStore.getState().draft!.points).toHaveLength(3);
      expect(conversions - before).toBe(1);
    } finally {
      vi.doUnmock('../domain/routeDraft');
      vi.resetModules();
    }
  });
});
