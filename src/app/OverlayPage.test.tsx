import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
import { useActivityStore } from '../state/activityStore';
import { useInteractionStore } from '../state/interactionStore';
import { useOverlayStore } from '../state/overlayStore';
import { fixtureFile, readFixture } from '../test/helpers/fixtures';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { metadataForRoute } from './seo';
import { ROUTES } from './routes';

/** jsdom has no canvas: a recording stand-in sees what the page asks of one. */
let drawn: string[] = [];
let saved: { fileName: string; blob: Blob }[] = [];

beforeEach(() => {
  drawn = [];
  saved = [];
  useOverlayStore.getState().clear();
  useActivityStore.getState().clear();
  window.location.hash = '';

  const context = {
    clearRect: () => drawn.push('clear'),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => undefined,
    stroke: () => drawn.push('stroke'),
    fill: () => undefined,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => context) as unknown as HTMLCanvasElement['getContext'],
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback, type) {
    callback(new Blob(['png'], { type }));
  });

  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, 'createObjectURL', {
    value: (blob: Blob) => {
      const url = `blob:test/${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ fileName: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

const canvas = () => screen.getByTestId('overlay-canvas') as HTMLCanvasElement;
const upload = (name: string) => userEvent.upload(screen.getByTestId('file-input'), fixtureFile(name));

describe('Overlays page (AV-1002, AV-1009)', () => {
  it('is offered in the Tools menu and shows no viewer panels', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Overlays' }));

    expect(await screen.findByRole('heading', { name: 'Overlays' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Choose a route' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Route map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Activity charts' })).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/overlays');
  });

  it('has its own title, naming no route', () => {
    const metadata = metadataForRoute(ROUTES.overlays);
    expect(metadata.title).toMatch(/overlay/i);
    expect(metadata.description).toMatch(/nothing is uploaded/i);
  });

  it('draws a chosen file at the default size and saves it as a transparent PNG', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('route-with-elevation.gpx');

    await screen.findByRole('region', { name: 'Preview' });
    expect([canvas().width, canvas().height]).toEqual([1920, 1080]);
    // Cleared to transparent, then the route drawn: there is no background step.
    expect(drawn[0]).toBe('clear');
    expect(drawn).toContain('stroke');

    await userEvent.click(screen.getByRole('button', { name: 'Save as PNG' }));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.fileName).toBe('elevation-route-route-overlay.png');
    expect(saved[0]!.blob.type).toBe('image/png');
    expect(screen.getByRole('status')).toHaveTextContent('elevation-route-route-overlay.png');
  });

  it('follows the size preset and the custom dimensions', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('route-with-elevation.gpx');
    await screen.findByRole('region', { name: 'Preview' });

    await userEvent.selectOptions(screen.getByLabelText(/^Size/), 'portrait');
    expect([canvas().width, canvas().height]).toEqual([1080, 1920]);

    const width = screen.getByLabelText('Width');
    await userEvent.clear(width);
    await userEvent.type(width, '640');
    expect(canvas().width).toBe(640);
    expect(screen.getByLabelText(/^Size/)).toHaveValue('custom');
  });

  it('explains unusable settings and will not save them', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('route-with-elevation.gpx');
    await screen.findByRole('region', { name: 'Preview' });

    const width = screen.getByLabelText('Width');
    await userEvent.clear(width);
    await userEvent.type(width, '10');
    expect(screen.getByRole('alert')).toHaveTextContent(/width must be a whole number/);
    expect(screen.getByRole('button', { name: 'Save as PNG' })).toBeDisabled();

    await userEvent.clear(width);
    await userEvent.type(width, '800');
    const padding = screen.getByLabelText('Padding');
    await userEvent.clear(padding);
    await userEvent.type(padding, '500');
    expect(screen.getByRole('alert')).toHaveTextContent(/padding leaves no room/i);
    expect(screen.getByRole('button', { name: 'Save as PNG' })).toBeDisabled();
  });

  it('applies colour, width and marker choices to the drawing', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('route-with-elevation.gpx');
    await screen.findByRole('region', { name: 'Preview' });
    drawn = [];
    await userEvent.click(screen.getByLabelText('Mark the start and end'));
    expect(drawn).toContain('clear');
    expect(screen.getByLabelText('Mark the start and end')).not.toBeChecked();
  });

  it('rejects a file with no route, and lets another be chosen', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('no-location.gpx');
    expect(await screen.findByRole('alert')).toHaveTextContent(/GPS|route/i);
    expect(screen.getByRole('region', { name: 'Choose a route' })).toBeInTheDocument();

    await upload('route-with-elevation.gpx');
    expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
  });

  it('can go back to choosing a route', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('route-with-elevation.gpx');
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another route' }));
    expect(screen.getByRole('region', { name: 'Choose a route' })).toBeInTheDocument();
  });

  it('starts empty after a reload, because nothing is stored', () => {
    window.location.hash = '#/overlays';
    render(<App />);
    expect(screen.getByRole('region', { name: 'Choose a route' })).toBeInTheDocument();
    expect(localStorage.getItem('opentrack-viewer:overlay')).toBeNull();
  });

  it('makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    window.location.hash = '#/overlays';
    render(<App />);
    await upload('route-with-elevation.gpx');
    await userEvent.click(await screen.findByRole('button', { name: 'Save as PNG' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('handoff from the viewer (AV-1009)', () => {
  const open = async () => {
    const activity = await parseGpx(readFixture('route-with-elevation.gpx'), {
      fileName: 'route-with-elevation.gpx',
    });
    useActivityStore.getState().setActivity(activity);
    window.location.hash = '#/viewer';
    render(<App />);
    return activity;
  };

  it('opens the overlay page with the whole activity, leaving it open', async () => {
    const activity = await open();
    const snapshot = JSON.stringify(activity);
    await userEvent.click(await screen.findByRole('button', { name: 'Create route overlay' }));

    expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.queryByText(/selected section only/)).not.toBeInTheDocument();
    expect(useOverlayStore.getState().activity?.points).toHaveLength(activity.points.length);
    expect(JSON.stringify(useActivityStore.getState().activity)).toBe(snapshot);
  });

  it('hands over only the selected section when there is one', async () => {
    await open();
    useInteractionStore.getState().setSelectedRange?.({ startIndex: 1, endIndex: 2 });
    await userEvent.click(await screen.findByRole('button', { name: 'Create route overlay' }));

    expect(await screen.findByText(/selected section only/)).toBeInTheDocument();
    expect(useOverlayStore.getState().activity?.points).toHaveLength(2);
  });

  it('is disabled, with the reason, when the activity has no route', async () => {
    const base = await parseGpx(readFixture('route-with-elevation.gpx'), { fileName: 'x.gpx' });
    useActivityStore.getState().setActivity({
      ...base,
      points: [{ index: 0 }],
      streams: { ...base.streams, hasLocation: false },
    });
    window.location.hash = '#/viewer';
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Create route overlay' })).toBeDisabled();
    expect(screen.getByText(/no GPS coordinates, so there is no route to draw/)).toBeInTheDocument();
  });
});
