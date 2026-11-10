import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The viewer and Route Builder mount maps, and jsdom has no WebGL.
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

const { App } = await import('./App');
const { useActivityStore } = await import('../state/activityStore');
const { useInteractionStore } = await import('../state/interactionStore');
const { useMapVideoStore, mapVideoRefusal } = await import('../state/mapVideoStore');
const { fixtureFile } = await import('../test/helpers/fixtures');
const { makeActivity } = await import('../test/helpers/activity');
const { FakeMap, resetMapLibreMock } = await import('../test/helpers/maplibreMock');

/** A GPX of one track with these points, each `[lat, lon]` or null for a point with no location. */
function gpx(fileName: string, points: ([number, number] | null)[], fromSecond = 0): File {
  const body = points
    .map((point, i) => {
      const time = `<time>${new Date(Date.UTC(2026, 10, 10, 8, 0, fromSecond + i)).toISOString()}</time>`;
      return point ? `<trkpt lat="${point[0]}" lon="${point[1]}">${time}</trkpt>` : '';
    })
    .join('');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">' +
    `<trk><name>Lap of the lake</name><trkseg>${body}</trkseg></trk></gpx>`;
  return new File([xml], fileName, { type: 'application/gpx+xml' });
}

const slot = () => screen.getByRole('region', { name: 'Activity' });
const mapChoice = () => screen.queryByRole('group', { name: 'Map' });

const goToMapVideo = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Map video' }));
};

beforeEach(() => {
  window.location.hash = '';
  useActivityStore.getState().clear();
  useMapVideoStore.setState(useMapVideoStore.getInitialState(), true);
  useInteractionStore.getState().setBasemapEnabled(true);
  resetMapLibreMock();
});

describe('reaching the map video page (AV-1202)', () => {
  it('is offered in the Tools menu, and routes to its own page', async () => {
    render(<App />);
    await goToMapVideo();

    expect(window.location.hash).toBe('#/map-video');
    expect(screen.getByRole('heading', { level: 2, name: 'Map video' })).toBeInTheDocument();
    expect(document.title).toMatch(/^Make a map video/);
  });

  it('opens on its file slot, with nothing else until there is an activity', () => {
    window.location.hash = '#/map-video';
    render(<App />);

    expect(within(slot()).getByTestId('map-video-activity-input')).toBeInTheDocument();
    expect(mapChoice()).not.toBeInTheDocument();
    // None of the viewer: no map, no charts, no export.
    expect(screen.queryByRole('region', { name: 'Activity summary' })).not.toBeInTheDocument();
    expect(FakeMap.instances).toHaveLength(0);
  });

  it('shows the file slot on a reload, when the handoff is gone', () => {
    // A reload is a fresh store: nothing handed over survives it.
    window.location.hash = '#/map-video';
    render(<App />);
    expect(within(slot()).getByTestId('map-video-activity-input')).toBeInTheDocument();
  });
});

describe('reading a file (AV-1202)', () => {
  it('reads a route file with the viewer\'s intake and offers the map choice', async () => {
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('simple-route.gpx'));

    expect(await within(slot()).findByText('simple-route.gpx')).toBeInTheDocument();
    expect(useMapVideoStore.getState().origin).toBe('hand');
    const choice = mapChoice()!;
    expect(within(choice).getByRole('radio', { name: /^Online map/ })).toBeChecked();
    expect(within(choice).getByRole('radio', { name: /^Online map/ })).toHaveAccessibleName(
      /server learns which area the video shows/,
    );
    expect(within(choice).getByRole('radio', { name: /^Route only/ })).toHaveAccessibleName(/nothing is fetched/);
  });

  it('starts on route only when the app\'s basemap tiles are turned off', async () => {
    useInteractionStore.getState().setBasemapEnabled(false);
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('simple-route.gpx'));

    await within(slot()).findByText('simple-route.gpx');
    expect(within(mapChoice()!).getByRole('radio', { name: /^Route only/ })).toBeChecked();
  });

  it('keeps the map choice when the activity is removed and another chosen', async () => {
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('simple-route.gpx'));
    await userEvent.click(await screen.findByRole('radio', { name: /^Route only/ }));

    await userEvent.click(within(slot()).getByRole('button', { name: 'Remove' }));
    expect(mapChoice()).not.toBeInTheDocument();
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('route-with-elevation.gpx'));

    await within(slot()).findByText('route-with-elevation.gpx');
    expect(within(mapChoice()!).getByRole('radio', { name: /^Route only/ })).toBeChecked();
  });

  it('refuses a file with no locations, saying why', async () => {
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('no-location.gpx'));

    const alert = await within(slot()).findByRole('alert');
    expect(alert).toHaveTextContent('Could not open no-location.gpx');
    expect(alert).toHaveTextContent(/no route to follow/);
    expect(useMapVideoStore.getState().activity).toBeUndefined();
    expect(mapChoice()).not.toBeInTheDocument();
  });

  it('refuses a file with a single located point: a place, not a route', async () => {
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), gpx('one-fix.gpx', [[46, 7]]));

    expect(await within(slot()).findByRole('alert')).toHaveTextContent(/only one point with a location/);
  });

  it('refuses a file it cannot parse, and keeps the activity it had', async () => {
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('simple-route.gpx'));
    await within(slot()).findByText('simple-route.gpx');

    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('malformed.gpx'));

    expect(await within(slot()).findByRole('alert')).toHaveTextContent('Could not open malformed.gpx');
    expect(within(slot()).getByText('simple-route.gpx')).toBeInTheDocument();
  });

  it('makes no network request while reading, and makes the map only once there is an activity', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network')));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      window.location.hash = '#/map-video';
      render(<App />);
      expect(FakeMap.instances).toHaveLength(0);
      await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('route-with-elevation.gpx'));
      await within(slot()).findByText('route-with-elevation.gpx');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // The map, and with it any tile, comes after the notice above it was on the page.
    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));
    expect(FakeMap.instances[0]!.options.style).toBe('https://tiles.openfreemap.org/styles/liberty');
  });
});

describe('handing an activity over (AV-1202)', () => {
  it('takes the viewer\'s activity with "Make a map video", and leaves the viewer as it was', async () => {
    window.location.hash = '#/viewer';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('file-input'), fixtureFile('route-with-elevation.gpx'));
    await screen.findByText('Elevation Route');

    await userEvent.click(screen.getByRole('button', { name: 'Make a map video' }));

    await waitFor(() => expect(window.location.hash).toBe('#/map-video'));
    expect(within(slot()).getByText('route-with-elevation.gpx')).toBeInTheDocument();
    expect(within(slot()).getByText('From the file viewer.')).toBeInTheDocument();
    expect(useMapVideoStore.getState().activity).toBe(useActivityStore.getState().activity);
    expect(window.localStorage.getItem('opentrack-viewer:map-video')).toBeNull();
  });

  it('offers no map video for an activity without a route', async () => {
    window.location.hash = '#/viewer';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('file-input'), fixtureFile('no-location.gpx'));
    await screen.findByRole('region', { name: 'Activity summary' });

    expect(screen.queryByRole('button', { name: 'Make a map video' })).not.toBeInTheDocument();
  });

  it('takes Route Builder\'s merged activity', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    const along = (from: number) => Array.from({ length: 10 }, (_, i): [number, number] => [46 + (from + i) / 20_000, 7]);
    await userEvent.upload(screen.getByTestId('track-input'), [gpx('a.gpx', along(0)), gpx('b.gpx', along(10), 100)]);
    const merged = await screen.findByRole('group', { name: 'The merged activity' });

    await userEvent.click(within(merged).getByRole('button', { name: 'Make a map video' }));

    await waitFor(() => expect(window.location.hash).toBe('#/map-video'));
    expect(within(slot()).getByText('From Route Builder.')).toBeInTheDocument();
    expect(useMapVideoStore.getState().activity?.points).toHaveLength(20);
  });
});

describe('what can become a map video', () => {
  it('needs two located points, wherever they are in the file', () => {
    expect(mapVideoRefusal(makeActivity([{}, { lat: 1, lon: 2 }, {}, { lat: 1.001, lon: 2 }]))).toBeUndefined();
    expect(mapVideoRefusal(makeActivity([{}, { lat: 1, lon: 2 }]))?.message).toMatch(/only one point/);
    expect(mapVideoRefusal(makeActivity([{}, {}]))?.code).toBe('no_location_stream');
  });
});
