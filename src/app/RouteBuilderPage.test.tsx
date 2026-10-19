import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { App } = await import('./App');
const { ROUTES, TOOLS_ITEMS } = await import('./routes');
const { metadataForRoute } = await import('./seo');
const { useRouteDraftStore } = await import('../state/routeDraftStore');
const { useActivityStore } = await import('../state/activityStore');
const { useInteractionStore } = await import('../state/interactionStore');
const { draftFromActivity } = await import('../domain/routeDraft');
const { fixtureFile } = await import('../test/helpers/fixtures');
const { makeActivity } = await import('../test/helpers/activity');

beforeEach(() => {
  useRouteDraftStore.getState().clear();
  useActivityStore.getState().clear();
  useInteractionStore.setState({ unitSystem: 'metric' });
  window.location.hash = '';
});

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

    const empty = await screen.findByRole('region', { name: 'Nothing planned yet' });
    expect(empty).toHaveTextContent(/does not survive a reload/i);
    expect(within(empty).getByRole('button', { name: 'Start a blank track' })).toBeInTheDocument();
    expect(screen.getByTestId('route-builder-input')).toHaveAttribute(
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
    expect(screen.queryByRole('region', { name: 'Nothing planned yet' })).not.toBeInTheDocument();
    expect(useRouteDraftStore.getState().draft?.kind).toBe('blank');
  });

  it('starts over, back to the empty state', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByRole('region', { name: 'Nothing planned yet' })).toBeInTheDocument();
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
  });

  it('forgets a draft after a reload, which is a fresh store', async () => {
    useRouteDraftStore.getState().startBlank();
    useRouteDraftStore.getState().clear(); // what a reload does: nothing is persisted
    window.location.hash = '#/route-builder';
    render(<App />);
    expect(await screen.findByRole('region', { name: 'Nothing planned yet' })).toBeInTheDocument();
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
    expect(screen.queryByRole('region', { name: 'Nothing planned yet' })).not.toBeInTheDocument();
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
    await userEvent.upload(await screen.findByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));

    const track = await screen.findByRole('region', { name: 'Planned track' });
    expect(track).toHaveTextContent('Copied from a track');
    expect(track).toHaveTextContent(/simple-route\.gpx: \d+ of \d+ points used/);
    expect(useRouteDraftStore.getState().draft?.points.length).toBeGreaterThan(1);
    expect(useActivityStore.getState().activity).toBeUndefined();
  });

  it('adds a second track after the first as a separate stretch', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });
    const first = useRouteDraftStore.getState().draft!.points.length;

    expect(screen.getByRole('heading', { name: 'Add another track' })).toBeInTheDocument();
    await userEvent.upload(screen.getByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));

    await waitFor(() => expect(useRouteDraftStore.getState().draft!.points.length).toBe(first * 2));
    const track = screen.getByRole('region', { name: 'Planned track' });
    expect(within(track).getByText('Stretches').nextSibling).toHaveTextContent('2');
    expect(within(track).getAllByText(/simple-route\.gpx/)).toHaveLength(2);
  });

  it('adds a track to a blank one', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await userEvent.upload(screen.getByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));
    await waitFor(() => expect(useRouteDraftStore.getState().draft!.points.length).toBeGreaterThan(0));
    expect(useRouteDraftStore.getState().draft!.kind).toBe('appended');
    expect(screen.getByRole('region', { name: 'Planned track' })).toHaveTextContent('Built from imported tracks');
  });

  it('explains a file it cannot read, keeps what it holds, and offers another go', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start a blank track' }));
    await userEvent.upload(
      screen.getByTestId('route-builder-input'),
      new File(['<gpx><not closed'], 'broken.gpx', { type: 'application/gpx+xml' }),
    );

    const failure = await screen.findByRole('region', { name: 'Track not imported' });
    expect(within(failure).getByRole('alert')).toHaveTextContent(/./);
    expect(useRouteDraftStore.getState().draft?.points).toEqual([]);

    await userEvent.click(within(failure).getByRole('button', { name: 'Try another file' }));
    expect(await screen.findByTestId('route-builder-input')).toBeInTheDocument();
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
      await userEvent.upload(screen.getByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));
      await screen.findByRole('region', { name: 'Reading the track' });

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
      expect(await screen.findByRole('region', { name: 'Nothing planned yet' })).toBeInTheDocument();

      // Nor may it land in a draft started afterwards: a second stale parse,
      // left behind the same way, finds a new blank track and leaves it blank.
      await userEvent.upload(screen.getByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));
      await screen.findByRole('region', { name: 'Reading the track' });
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
    await userEvent.upload(await screen.findByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));
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
    await userEvent.upload(await screen.findByTestId('route-builder-input'), fixtureFile('simple-route.gpx'));
    await screen.findByRole('region', { name: 'Planned track' });
    expect(Object.keys(localStorage).filter((key) => key !== 'opentrack-viewer:theme')).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});
