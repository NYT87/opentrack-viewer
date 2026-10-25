import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Route Builder mounts a map, and jsdom has no WebGL.
vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, ScaleControl: class { setUnit() {} }, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {},
    ScaleControl: class { setUnit() {} },
    setWorkerUrl,
  };
});
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));

const { App } = await import('../app/App');
const { useActivityStore } = await import('../state/activityStore');
const { useRouteDraftStore } = await import('../state/routeDraftStore');
const { latestMap, resetMapLibreMock } = await import('../test/helpers/maplibreMock');

const T0 = Date.parse('2026-09-24T08:00:00Z');

/** A short GPX ride: `count` points, one a second from `fromSecond`, heading north from `lat0`. */
function gpxFile(fileName: string, fromSecond: number, count: number, { lat0 = 46, timed = true } = {}): File {
  const points = Array.from({ length: count }, (_, i) => {
    const lat = (lat0 + (i * 5) / 111_320).toFixed(7);
    const time = timed ? `<time>${new Date(T0 + (fromSecond + i) * 1000).toISOString()}</time>` : '';
    return `<trkpt lat="${lat}" lon="7.0000000"><ele>${100 + i}</ele>${time}</trkpt>`;
  }).join('');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">' +
    `<trk><name>Evening Ride</name><type>cycling</type><trkseg>${points}</trkseg></trk></gpx>`;
  return new File([xml], fileName, { type: 'application/gpx+xml' });
}

const mergeRegion = () => screen.getByRole('region', { name: 'Merge recorded tracks' });
const order = () => within(mergeRegion()).getByRole('list', { name: 'Files in the order they were recorded' });

beforeEach(() => {
  window.location.hash = '#/route-builder';
  useActivityStore.getState().clear();
  useRouteDraftStore.getState().clear();
  resetMapLibreMock();
});

describe('merging recorded tracks from Route Builder (AV-1109)', () => {
  it('orders the files by their own clocks, whatever order they were chosen in, and merges them', async () => {
    render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [
      gpxFile('later.gpx', 3600, 20),
      gpxFile('earlier.gpx', 0, 30),
    ]);

    const merged = await within(mergeRegion()).findByRole('group', { name: 'The merged activity' });
    expect(within(order()).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^earlier\.gpx.+30 points/),
      expect.stringMatching(/^later\.gpx.+20 points/),
    ]);
    expect(within(merged).getByRole('heading', { name: 'Evening Ride (merged)' })).toBeInTheDocument();
    expect(within(merged).getByText('Points').nextElementSibling).toHaveTextContent('50');
    // 0:29 of riding, then 3600 − 29 seconds before the second file starts.
    expect(within(merged).getByText('Pause').nextElementSibling).toHaveTextContent('59:31');
    expect(within(merged).getByText('Elapsed').nextElementSibling).toHaveTextContent('1:00:19');
    expect(within(merged).getByRole('list', { name: 'Pauses between the files' })).toHaveTextContent(
      /Paused 59:31 between earlier\.gpx and later\.gpx/,
    );
  });

  it('offers GPX and FIT, keeps TCX with its reason, and writes a file named as merged', async () => {
    render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [gpxFile('a.gpx', 0, 10), gpxFile('b.gpx', 100, 10)]);
    const exporter = await within(mergeRegion()).findByRole('group', { name: 'Export the merged activity' });

    expect(within(exporter).getByRole('radio', { name: /^GPX/ })).toBeEnabled();
    expect(within(exporter).getByRole('radio', { name: /^FIT/ })).toBeEnabled();
    expect(within(exporter).getByRole('radio', { name: /^FIT/ })).toBeChecked();
    expect(within(exporter).getByRole('radio', { name: /^TCX/ })).toBeDisabled();
    expect(exporter).toHaveTextContent(/TCX is written as one lap .+ riding/);

    await userEvent.click(within(exporter).getByRole('radio', { name: /^GPX/ }));
    await userEvent.click(within(exporter).getByRole('button', { name: 'Download Evening-Ride-merged.gpx' }));
    expect(await within(exporter).findByRole('status', { name: 'Merged activity written' })).toHaveTextContent(
      'Saved Evening-Ride-merged.gpx.',
    );
    await userEvent.click(within(exporter).getByRole('radio', { name: /^FIT/ }));
    expect(within(exporter).getByRole('button', { name: 'Download Evening-Ride-merged.fit' })).toBeInTheDocument();
  });

  it('refuses a file with no timestamps, with the reason, and leaves it out of the order', async () => {
    render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [
      gpxFile('timed.gpx', 0, 10),
      gpxFile('untimed.gpx', 0, 10, { timed: false }),
    ]);

    const refused = await within(mergeRegion()).findByRole('list', { name: 'Not in the merge' });
    expect(refused).toHaveTextContent(/untimed\.gpx is not in the merge\. It has no timestamps/);
    expect(within(order()).getAllByRole('listitem')).toHaveLength(1);
    expect(mergeRegion()).toHaveTextContent('Add at least one more recorded track with timestamps to merge.');
    expect(within(mergeRegion()).queryByRole('group', { name: 'The merged activity' })).not.toBeInTheDocument();

    await userEvent.click(within(refused).getByRole('button', { name: 'Remove untimed.gpx' }));
    expect(within(mergeRegion()).queryByRole('list', { name: 'Not in the merge' })).not.toBeInTheDocument();
  });

  it('refuses overlapping files, says which and by how much, and merges once one is removed', async () => {
    render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [
      gpxFile('first.gpx', 0, 60),
      gpxFile('second.gpx', 30, 60),
      gpxFile('third.gpx', 600, 10),
    ]);

    const alert = await within(mergeRegion()).findByRole('alert');
    expect(alert).toHaveTextContent(/second\.gpx starts at .+, before first\.gpx ends at .+: they overlap by 0:29/);
    expect(within(order()).getAllByRole('listitem').filter((item) => item.classList.contains('is-overlapping'))).toHaveLength(2);
    expect(within(mergeRegion()).queryByRole('group', { name: 'The merged activity' })).not.toBeInTheDocument();

    await userEvent.click(within(order()).getByRole('button', { name: 'Remove second.gpx' }));
    expect(within(mergeRegion()).queryByRole('alert')).not.toBeInTheDocument();
    expect(await within(mergeRegion()).findByRole('group', { name: 'The merged activity' })).toHaveTextContent(/70/);
  });

  it('opens the merge in the viewer, in memory, as one activity', async () => {
    render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [gpxFile('a.gpx', 0, 10), gpxFile('b.gpx', 100, 10)]);
    const merged = await within(mergeRegion()).findByRole('group', { name: 'The merged activity' });

    await userEvent.click(within(merged).getByRole('button', { name: 'Open in the viewer' }));
    await waitFor(() => expect(window.location.hash).toBe('#/viewer'));
    const activity = useActivityStore.getState().activity;
    expect(activity?.points).toHaveLength(20);
    expect(activity?.metadata.name).toBe('Evening Ride (merged)');
    expect(window.localStorage.length).toBe(0);
  });

  it('keeps the merged map read-only and creates an editable route only on request', async () => {
    render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [gpxFile('a.gpx', 0, 10), gpxFile('b.gpx', 100, 10)]);
    const merged = await within(mergeRegion()).findByRole('group', { name: 'The merged activity' });
    await waitFor(() => expect(latestMap()).toBeDefined());
    const map = latestMap();
    act(() => map.completeStyleLoad());

    act(() => map.emit('click', { point: { x: 0, y: 0 }, lngLat: { lng: 8, lat: 47 } }));
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
    expect(within(merged).getByRole('button', { name: 'Download Evening-Ride-merged.fit' })).toBeEnabled();

    await userEvent.click(within(merged).getByRole('button', { name: 'Edit a route copy' }));
    expect(useRouteDraftStore.getState().draft?.points).toHaveLength(20);
    expect(screen.getByRole('region', { name: 'Edit points' })).toBeInTheDocument();
    expect(within(merged).getByRole('button', { name: 'Download Evening-Ride-merged.fit' })).toBeEnabled();
  });

  it('merges under StrictMode, as the app runs in development, where effects mount twice', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await userEvent.upload(screen.getByTestId('merge-input'), [gpxFile('a.gpx', 0, 10), gpxFile('b.gpx', 100, 10)]);
    expect(await within(mergeRegion()).findByRole('group', { name: 'The merged activity' })).toBeInTheDocument();
    expect(within(mergeRegion()).queryByText(/Reading \d+ file/)).not.toBeInTheDocument();
  });

  it('writes nothing when a file finishes reading after the page has gone', async () => {
    const { unmount } = render(<App />);
    await userEvent.upload(screen.getByTestId('merge-input'), [gpxFile('a.gpx', 0, 10)]);
    unmount();
    // Rendering again starts empty: nothing of the unmounted page's files came back.
    render(<App />);
    expect(within(mergeRegion()).queryByRole('list', { name: 'Files in the order they were recorded' })).not.toBeInTheDocument();
  });

  it('takes several files from one drop, and names the ones it does not read', async () => {
    render(<App />);
    await userEvent.upload(
      screen.getByTestId('merge-input'),
      [gpxFile('a.gpx', 0, 10), new File(['x'], 'notes.txt', { type: 'text/plain' })],
      { applyAccept: false },
    );
    expect(await within(mergeRegion()).findByRole('alert')).toHaveTextContent('"notes.txt" is not supported.');
    expect(await within(order()).findAllByRole('listitem')).toHaveLength(1);
  });
});
