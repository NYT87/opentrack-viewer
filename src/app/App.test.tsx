import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FakeMap, latestMap, resetMapLibreMock } from '../test/helpers/maplibreMock';

vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {},
    setWorkerUrl,
  };
});

const { App } = await import('./App');
const { useActivityStore } = await import('../state/activityStore');
const { useInteractionStore } = await import('../state/interactionStore');
const { fixtureFile } = await import('../test/helpers/fixtures');

/**
 * The map is constructed only once there is a route to draw, and it arrives
 * through a lazy import. Wait for that to settle either way: into a real map,
 * or into a placeholder that is no longer the Suspense fallback.
 */
async function settleMap(): Promise<void> {
  await waitFor(() => {
    const placeholder = screen.queryByTestId('map-placeholder');
    const isLoadingChunk = placeholder?.dataset.reason === 'loading';
    expect(FakeMap.instances.length > 0 || !isLoadingChunk).toBe(true);
  });
  const map = FakeMap.instances[FakeMap.instances.length - 1];
  if (map && !map.getSource('activity-route')) act(() => map.completeStyleLoad());
}

/** Settings is a modal, so it neither navigates nor unmounts the viewer. */
async function openSettings(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
  await screen.findByRole('dialog');
}

async function closeSettings(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));
}

async function loadFixture(name: string): Promise<void> {
  // The drop zone is only present before an activity is open, so swapping
  // files goes through "Close activity" first — the same route a user takes.
  const close = screen.queryByRole('button', { name: 'Close activity' });
  if (close) await userEvent.click(close);

  await userEvent.upload(screen.getByTestId('file-input'), fixtureFile(name));
  await waitFor(() =>
    expect(['ready', 'error']).toContain(useActivityStore.getState().status),
  );
  await settleMap();
}

describe('App vertical slice (AV-304)', () => {
  beforeEach(() => {
    resetMapLibreMock();
    useActivityStore.getState().clear();
    // Every test here exercises the viewer; the homepage is a separate route
    // now, and HashRouter would otherwise keep the previous test's location.
    window.location.hash = '#/viewer';
    useInteractionStore.setState({ unitSystem: 'metric', basemapEnabled: true });
  });

  it('shows an empty state that does not imply upload', () => {
    render(<App />);

    expect(screen.getByText(/no activity open/i)).toBeInTheDocument();
    expect(screen.getByText(/never sent to a server/i)).toBeInTheDocument();
  });

  it('does not construct a map until an activity is loaded', () => {
    render(<App />);

    expect(FakeMap.instances).toHaveLength(0);
    // AV-004: no map region at all before an activity is ready, not even a
    // placeholder standing in for one.
    expect(screen.queryByTestId('map-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('does not import the map module until a route exists', () => {
    // MapLibre is the bulk of the bundle; the lazy chunk must stay unfetched
    // while the app is idle. A pending Suspense boundary would show the
    // 'loading' placeholder instead of the idle one.
    render(<App />);

    expect(screen.queryByTestId('map-placeholder')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Activity overview' })).not.toBeInTheDocument();
  });

  it('keeps derived viewer state referentially stable for React snapshots', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(<App />);
      await loadFixture('route-with-elevation.gpx');

      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining('The result of getSnapshot should be cached'),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('constructs the map once a route is available', async () => {
    render(<App />);
    expect(FakeMap.instances).toHaveLength(0);

    await loadFixture('route-with-elevation.gpx');

    expect(FakeMap.instances).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId('map-placeholder')).not.toBeInTheDocument());
  });

  it('shows the placeholder, not a map, for an activity with no route', async () => {
    render(<App />);

    await loadFixture('no-location.gpx');

    expect(FakeMap.instances).toHaveLength(0);
    expect(screen.getByTestId('map-placeholder')).toHaveTextContent(/no route to display/i);
    // The activity is still usable: stats and chart come from the other streams.
    expect(screen.getByTestId('elevation-chart-svg')).toBeInTheDocument();
  });

  it('hides the file drop zone once an activity is open', async () => {
    render(<App />);
    expect(screen.getByTestId('file-input')).toBeInTheDocument();

    await loadFixture('route-with-elevation.gpx');

    // Changing files goes through "Close activity" rather than swapping the
    // file out from under the loaded map and charts.
    expect(screen.queryByTestId('file-input')).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing is uploaded/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close activity' })).toBeInTheDocument();
  });

  it('brings the drop zone back after closing the activity', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');

    await userEvent.click(screen.getByRole('button', { name: 'Close activity' }));

    expect(screen.getByTestId('file-input')).toBeInTheDocument();
    expect(screen.getByText(/no activity open/i)).toBeInTheDocument();
  });

  it('keeps the drop zone available while a parse is failing', async () => {
    render(<App />);

    await loadFixture('malformed.gpx');

    // No activity was opened, so the user can pick another file straight away.
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('tears the map down when the activity is closed', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');
    const map = latestMap();

    await userEvent.click(screen.getByRole('button', { name: 'Close activity' }));

    expect(map.removed).toBe(true);
    expect(screen.queryByTestId('map-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('parses a dropped GPX file and pushes the route to the map', async () => {
    render(<App />);

    await loadFixture('route-with-elevation.gpx');

    const source = latestMap().getSource('activity-route');
    const data = source?.data as { features: { geometry: { coordinates: number[][] } }[] };
    expect(data.features[0]?.geometry.coordinates).toHaveLength(4);
    expect(latestMap().fitBoundsCalls.length).toBeGreaterThan(0);
  });

  it('renders summary stats for the loaded activity', async () => {
    render(<App />);

    await loadFixture('route-with-elevation.gpx');

    expect(screen.getByText('Elevation Route')).toBeInTheDocument();
    expect(screen.getByText('Elevation gain')).toBeInTheDocument();
    // 180 s of elapsed time, formatted as M:SS.
    expect(screen.getAllByText('3:00').length).toBeGreaterThan(0);
  });

  it('renders the elevation chart for a file with elevation', async () => {
    render(<App />);

    await loadFixture('route-with-elevation.gpx');

    expect(screen.getByTestId('elevation-chart-svg')).toBeInTheDocument();
  });

  it('switches the chart x-axis and keeps the choice across files (AV-504)', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');
    expect(screen.getByText(/x-axis: distance/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Time' }));
    expect(screen.getByText(/x-axis: elapsed time/)).toBeInTheDocument();

    // The preference is a session setting, so the next file keeps it.
    await loadFixture('flat-route.gpx');
    expect(screen.getByText(/x-axis: elapsed time/)).toBeInTheDocument();
  });

  it('falls back per activity without discarding the preference', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');
    await userEvent.click(screen.getByRole('button', { name: 'Time' }));

    // This fixture has no timestamps, so the time axis cannot be built.
    await loadFixture('simple-route-no-time.gpx');
    expect(screen.getByRole('button', { name: 'Time' })).toBeDisabled();
    expect(useInteractionStore.getState().chartXAxisMode).toBe('time');
  });

  it('shows the chart empty state for a file without elevation', async () => {
    render(<App />);

    await loadFixture('simple-route.gpx');

    // AV-507 explains the absence per chart rather than hiding the panel.
    expect(screen.getByRole('region', { name: 'Elevation chart' })).toHaveTextContent(
      /no elevation data/i,
    );
    // The fixture is a run with distance and time, so pace is charted (AV-505):
    // 111 m every 60 s is 9:00 /km.
    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent('9:00 /km');
    // ...but it carries no cadence, so that chart explains its absence (AV-507).
    expect(screen.getByRole('region', { name: 'Cadence chart' })).toHaveTextContent(
      /no cadence data/i,
    );
  });

  it('switches every displayed unit when the unit system changes', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');

    // Scoped to the summary: the chart's x-axis switch also has a "Distance".
    const distance = () =>
      screen
        .getByRole('region', { name: 'Activity summary' })
        .querySelector('.summary__stat dd');
    expect(distance()).toHaveTextContent(/m$/);
    expect(screen.getByText('Elevation (m)')).toBeInTheDocument();

    await openSettings();
    await userEvent.selectOptions(screen.getByLabelText('Units'), 'imperial');
    await closeSettings();

    expect(distance()).toHaveTextContent(/ft$|mi$/);
    expect(screen.getByText('Elevation (ft)')).toBeInTheDocument();
  });

  it('keeps the chosen unit system across a new file', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');
    await openSettings();
    await userEvent.selectOptions(screen.getByLabelText('Units'), 'imperial');
    await closeSettings();

    await loadFixture('flat-route.gpx');

    expect(screen.getByText('Elevation (ft)')).toBeInTheDocument();
  });

  it('reports a malformed file with an actionable error', async () => {
    render(<App />);

    await loadFixture('malformed.gpx');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/could not open this file/i);
    expect(alert).toHaveTextContent('invalid_gpx_xml');
  });

  it('makes no network request while loading a file', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network')));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      render(<App />);
      await loadFixture('route-with-elevation.gpx');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('map and chart synchronization (Epic E6)', () => {
  beforeEach(() => {
    resetMapLibreMock();
    useActivityStore.getState().clear();
    // Every test here exercises the viewer; the homepage is a separate route
    // now, and HashRouter would otherwise keep the previous test's location.
    window.location.hash = '#/viewer';
    useInteractionStore.setState({ unitSystem: 'metric', basemapEnabled: true });
  });

  it('moves the map marker when the chart reports a hover (AV-602)', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');

    act(() => useInteractionStore.getState().setHoveredPoint(2, 'chart'));

    const marker = latestMap().getSource('activity-marker')?.data as {
      features: { geometry: { coordinates: number[] }; properties: { index: number } }[];
    };
    expect(marker.features).toHaveLength(1);
    expect(marker.features[0]?.properties.index).toBe(2);
  });

  it('moves the chart cursor when the map reports a hover (AV-603)', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');
    const map = latestMap();

    map.queryRenderedFeatures.mockReturnValue([
      {
        properties: { featureIndex: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 51.5],
            [0, 51.501],
            [0, 51.502],
            [0, 51.503],
          ],
        },
      },
    ]);

    act(() =>
      map.emit(
        'mousemove',
        { point: { x: 5, y: 5 }, lngLat: { lng: 0, lat: 51.5021 } },
        'activity-route-line',
      ),
    );

    expect(useInteractionStore.getState().hoveredPointIndex).toBe(2);
    expect(screen.getByTestId('chart-cursor')).toBeInTheDocument();
  });

  it('clears the marker when the hover ends', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');

    act(() => useInteractionStore.getState().setHoveredPoint(1, 'chart'));
    act(() => useInteractionStore.getState().setHoveredPoint(undefined));

    const marker = latestMap().getSource('activity-marker')?.data as { features: unknown[] };
    expect(marker.features).toHaveLength(0);
  });

  it('resets interaction state when a new file is loaded (AV-601)', async () => {
    render(<App />);
    await loadFixture('route-with-elevation.gpx');
    act(() => useInteractionStore.getState().setSelectedPoint(3));

    await loadFixture('simple-route.gpx');

    expect(useInteractionStore.getState().selectedPointIndex).toBeUndefined();
    expect(useInteractionStore.getState().hoveredPointIndex).toBeUndefined();
  });
});
