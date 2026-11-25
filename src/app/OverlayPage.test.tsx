import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

describe('previewing on a video (AV-1004)', () => {
  /** A context that accepts any drawing call and remembers the text it was given. */
  let spoken: string[] = [];
  beforeEach(() => {
    spoken = [];
    const context = new Proxy(
      {},
      {
        get: (_target, name) => {
          if (name === 'fillText') return (text: string) => spoken.push(text);
          if (name === 'measureText') return () => ({ width: 0 });
          return () => undefined;
        },
        set: () => true,
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => context) as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  });

  const withActivity = async (fixture = 'overlay-sync.gpx') => {
    const activity = await parseGpx(readFixture(fixture), { fileName: fixture });
    useOverlayStore.getState().setActivity(activity);
    window.location.hash = '#/overlays';
    render(<App />);
    return activity;
  };
  const videoFile = () => new File(['x'], 'ride.webm', { type: 'video/webm' });
  const loadVideo = async (duration = 4) => {
    await userEvent.upload(screen.getByTestId('file-input'), videoFile());
    const video = (await screen.findByTestId('overlay-video')) as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { value: duration, configurable: true });
    fireEvent.loadedMetadata(video);
    return video;
  };
  const section = () => within(screen.getByRole('region', { name: 'Video overlay' }));

  it('asks for a video once there is a route with a clock, and offers the templates', async () => {
    await withActivity();
    const video = section();
    expect(video.getByLabelText('Template')).toHaveValue('compact-hud');
    expect(video.getByRole('option', { name: 'Route inset' })).toBeInTheDocument();
    expect(video.getByRole('option', { name: 'Gauge dashboard' })).toBeInTheDocument();
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('plays the chosen file locally and shows its length', async () => {
    await withActivity();
    const video = await loadVideo(12);
    expect(video.getAttribute('src')).toMatch(/^blob:/);
    expect(await screen.findByText('0:00 / 0:12')).toBeInTheDocument();
  });

  it('draws the overlay for the frame being shown, and redraws on a seek', async () => {
    await withActivity();
    const video = await loadVideo();
    expect(spoken).toContain('DISTANCE');
    const atStart = [...spoken];

    spoken = [];
    video.currentTime = 3;
    fireEvent.seeked(video);
    expect(spoken).toContain('DISTANCE');
    expect(spoken).not.toEqual(atStart);
  });

  it('follows the scrub bar', async () => {
    await withActivity();
    const video = await loadVideo();
    fireEvent.change(screen.getByLabelText('Video position'), { target: { value: '2.5' } });
    expect(video.currentTime).toBeCloseTo(2.5, 5);
  });

  it('re-lines the telemetry when the offset changes', async () => {
    await withActivity();
    await loadVideo();
    const before = [...spoken];
    spoken = [];
    fireEvent.change(screen.getByLabelText('Offset (seconds)'), { target: { value: '4' } });
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken).not.toEqual(before);

    spoken = [];
    fireEvent.change(screen.getByLabelText('Offset (seconds)'), { target: { value: '500' } });
    // Past the end of the telemetry: nothing from it is drawn.
    expect(spoken).toEqual([]);
  });

  it('nudges the offset by a second each way, and ignores nonsense', async () => {
    await withActivity();
    await loadVideo();
    const offset = screen.getByLabelText('Offset (seconds)');
    await userEvent.click(screen.getByRole('button', { name: 'Telemetry earlier 1 s' }));
    expect(offset).toHaveValue(1);
    await userEvent.click(screen.getByRole('button', { name: 'Telemetry later 1 s' }));
    await userEvent.click(screen.getByRole('button', { name: 'Telemetry later 1 s' }));
    expect(offset).toHaveValue(-1);
    fireEvent.change(offset, { target: { value: '99999999' } });
    expect(Number((offset as HTMLInputElement).value)).toBeLessThanOrEqual(24 * 3600);
  });

  it('switches template and says which components it had to hide, and why', async () => {
    await withActivity();
    await loadVideo();
    await userEvent.selectOptions(screen.getByLabelText('Template'), 'gauge-dashboard');
    const hidden = within(screen.getByRole('list', { name: 'Hidden components' }));
    // The file has no power or pedal cadence, and a dial for either would be empty.
    expect(hidden.getByText(/Power is not in this activity/)).toBeInTheDocument();
    expect(hidden.getByText(/Pedal cadence is not in this activity/)).toBeInTheDocument();
    expect(spoken.some((t) => /bpm$/.test(t))).toBe(true);
  });

  it('switches the figures to imperial', async () => {
    await withActivity();
    await loadVideo();
    await userEvent.selectOptions(screen.getByLabelText('Units'), 'imperial');
    expect(spoken.some((t) => /ft$/.test(t))).toBe(true);
  });

  it('explains a video the browser cannot decode', async () => {
    await withActivity();
    const video = await loadVideo();
    fireEvent.error(video);
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot play that video/);
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('lets the video be swapped', async () => {
    await withActivity();
    await loadVideo();
    await userEvent.click(screen.getByRole('button', { name: 'Choose another video' }));
    expect(screen.queryByTestId('overlay-video')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-input')).toBeInTheDocument();
  });

  it('says so, and offers no video, for an activity with no timestamps', async () => {
    await withActivity('simple-route-no-time.gpx');
    expect(section().getByRole('note')).toHaveTextContent(/no timestamps to line up with a video/);
    expect(section().queryByLabelText('Template')).not.toBeInTheDocument();
    // The still route image is still there.
    expect(screen.getByRole('button', { name: 'Save as PNG' })).toBeInTheDocument();
  });

  it('keeps a handed-over video, and releases its object URL when it goes', async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true });
    const activity = await parseGpx(readFixture('overlay-sync.gpx'), { fileName: 'overlay-sync.gpx' });
    useOverlayStore.getState().setActivity(activity, { video: videoFile() });
    window.location.hash = '#/overlays';
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('overlay-video')).toBeInTheDocument();
    unmount();
    expect(revoke).toHaveBeenCalled();
  });

  it('makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await withActivity();
    await loadVideo();
    fireEvent.change(screen.getByLabelText('Video position'), { target: { value: '1' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
