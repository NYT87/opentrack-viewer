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
import { readZip } from '../test/helpers/zip';
import { useOverlayTemplateStore } from '../state/overlayTemplateStore';
import { fixtureFile, readFixture } from '../test/helpers/fixtures';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { metadataForRoute } from './seo';
import { ROUTES } from './routes';

/** jsdom has no canvas: a recording stand-in sees what the page asks of one. */
let drawn: string[] = [];
let saved: { fileName: string; blob: Blob }[] = [];
const saved_downloads_ref = { get current() { return saved; } };

beforeEach(() => {
  drawn = [];
  saved = [];
  useOverlayStore.getState().clear();
  useOverlayTemplateStore.setState({ selectedId: 'compact-hud', units: undefined, saved: {} });
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
    const templates = within(video.getByLabelText('Template'));
    expect(templates.getByRole('option', { name: 'Route inset' })).toBeInTheDocument();
    expect(templates.getByRole('option', { name: 'Gauge dashboard' })).toBeInTheDocument();
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

describe('customizing the template (AV-1005)', () => {
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
  });

  const open = async (fixture = 'overlay-sync.gpx') => {
    const activity = await parseGpx(readFixture(fixture), { fileName: fixture });
    useOverlayStore.getState().setActivity(activity, { video: new File(['x'], 'v.webm', { type: 'video/webm' }) });
    window.location.hash = '#/overlays';
    render(<App />);
    const video = (await screen.findByTestId('overlay-video')) as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { value: 4, configurable: true });
    fireEvent.loadedMetadata(video);
    return video;
  };
  const saved = (id = 'compact-hud') => useOverlayTemplateStore.getState().saved[id]!;
  const component = (id: string, templateId = 'compact-hud') => saved(templateId).components.find((c) => c.id === id)!;
  const setRange = (name: string, value: number) =>
    fireEvent.change(screen.getByLabelText(name), { target: { value: String(value) } });
  const editor = () => within(screen.getByRole('group', { name: 'Customize template' }));

  it('turns a component off and on, and the frame follows', async () => {
    await open();
    expect(spoken).toContain('DISTANCE');
    await userEvent.click(screen.getByLabelText('Show Distance readout'));
    spoken = [];
    fireEvent.seeked(screen.getByTestId('overlay-video'));
    expect(spoken).not.toContain('DISTANCE');
    expect(component('distance').visible).toBe(false);

    await userEvent.click(screen.getByLabelText('Show Distance readout'));
    spoken = [];
    fireEvent.seeked(screen.getByTestId('overlay-video'));
    expect(spoken).toContain('DISTANCE');
  });

  it('enables a component the data can support, and one it cannot is hidden with the reason', async () => {
    await open();
    await userEvent.click(screen.getByLabelText('Show Heart rate readout'));
    fireEvent.seeked(screen.getByTestId('overlay-video'));
    expect(spoken).toContain('HEART RATE');

    await userEvent.selectOptions(screen.getByLabelText('Template'), 'gauge-dashboard');
    expect(await screen.findByText(/hidden: Power is not in this activity/)).toBeInTheDocument();
  });

  it('moves and resizes a component, and keeps it inside the frame', async () => {
    await open();
    setRange('Speed readout left', 50);
    expect(component('speed').box.x).toBeCloseTo(0.5, 5);
    setRange('Speed readout width', 90);
    const { box } = component('speed');
    expect(box.width).toBeCloseTo(0.9, 5);
    expect(box.x + box.width).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('changes colours, text size, background and label', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Speed readout colour'), { target: { value: '#ff0000' } });
    fireEvent.change(screen.getByLabelText('Speed readout accent colour'), { target: { value: '#00ff00' } });
    setRange('Speed readout text size', 150);
    await userEvent.selectOptions(screen.getByLabelText('Speed readout background'), 'none');
    fireEvent.change(screen.getByLabelText('Speed readout label'), { target: { value: 'Velocity' } });

    expect(component('speed')).toMatchObject({
      label: 'Velocity',
      style: { color: '#ff0000', accentColor: '#00ff00', fontScale: 1.5, backgroundColor: 'transparent' },
    });
  });

  it('keeps edits for the session across switching templates, and discards them on reset', async () => {
    await open();
    await userEvent.click(screen.getByLabelText('Show Distance readout'));
    await userEvent.selectOptions(screen.getByLabelText('Template'), 'route-inset');
    expect(screen.queryByLabelText('Show Distance readout')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Template'), 'compact-hud');
    expect(screen.getByLabelText('Show Distance readout')).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Reset template' }));
    expect(screen.getByLabelText('Show Distance readout')).toBeChecked();
    expect(useOverlayTemplateStore.getState().saved['compact-hud']).toBeUndefined();
  });

  it('keeps the edits when the units change, and stores nothing on the device', async () => {
    await open();
    setRange('Speed readout left', 40);
    await userEvent.selectOptions(screen.getByLabelText('Units'), 'imperial');
    expect(component('speed').box.x).toBeCloseTo(0.4, 5);
    expect(saved().units).toBe('imperial');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('adds a component, listing what the activity cannot supply', async () => {
    await open();
    const measurement = screen.getByLabelText('Measurement');
    expect(within(measurement).getByRole('option', { name: 'Power (not in this activity)' })).toBeInTheDocument();
    expect(within(measurement).getByRole('option', { name: 'Heart rate' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Component type'), 'gauge');
    await userEvent.selectOptions(measurement, 'metric:heartRate');
    await userEvent.click(screen.getByRole('button', { name: 'Add component' }));
    expect(saved().components.at(-1)).toMatchObject({ type: 'gauge', binding: { kind: 'metric', metric: 'heartRate' } });
    expect(screen.getByLabelText('Show Heart rate gauge')).toBeChecked();
  });

  it('adds a route inset or progress bar without asking what it shows', async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText('Component type'), 'route');
    expect(screen.queryByLabelText('Measurement')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add component' }));
    expect(saved().components.at(-1)!.type).toBe('route');
  });

  it('removes a component', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Elevation readout' }));
    expect(saved().components.map((c) => c.id)).not.toContain('elevation');
    expect(screen.queryByLabelText('Show Elevation readout')).not.toBeInTheDocument();
  });

  describe('the project file', () => {
    it('saves the template as JSON a person can keep', async () => {
      await open();
      setRange('Speed readout left', 50);
      await userEvent.click(screen.getByRole('button', { name: 'Save project file' }));

      expect(saved_files()).toHaveLength(1);
      const file = saved_files()[0]!;
      expect(file.fileName).toBe('compact-hud-overlay-template.json');
      const parsed = JSON.parse(await file.blob.text());
      expect(parsed).toMatchObject({ format: 'opentrack-overlay', version: 1 });
      expect(parsed.template.components.find((c: { id: string }) => c.id === 'speed').box.x).toBeCloseTo(0.5, 5);
      // The template and nothing else: no figures, no route, no file names.
      expect(await file.blob.text()).not.toMatch(/overlay-sync|"lat"|"lon"|Overlay Sync/);
    });

    it('loads a saved file back, as the same template', async () => {
      await open();
      setRange('Speed readout left', 50);
      await userEvent.click(screen.getByRole('button', { name: 'Save project file' }));
      const text = await saved_files()[0]!.blob.text();

      await userEvent.click(screen.getByRole('button', { name: 'Reset template' }));
      expect(component_exists('speed')).toBe(false);

      await userEvent.upload(
        screen.getByTestId('project-input'),
        new File([text], 'look.json', { type: 'application/json' }),
      );
      expect(await screen.findByRole('option', { name: 'Compact HUD (loaded)' })).toBeInTheDocument();
      expect(useOverlayTemplateStore.getState().selectedId).toBe('custom');
      expect(component('speed', 'custom').box.x).toBeCloseTo(0.5, 5);
    });

    it('says what is wrong with a file it cannot use, and changes nothing', async () => {
      await open();
      const before = JSON.stringify(useOverlayTemplateStore.getState());
      await userEvent.upload(screen.getByTestId('project-input'), new File(['{"nope":1}'], 'x.json'));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/could not be loaded/);
      expect(alert).toHaveTextContent(/not an OpenTrack overlay project/);
      expect(JSON.stringify(useOverlayTemplateStore.getState())).toBe(before);

      const bad = JSON.stringify({
        format: 'opentrack-overlay',
        version: 1,
        template: { name: 'x', units: 'metric', components: [{ id: 'a', type: 'text', visible: true, box: { x: 2, y: 0, width: 1, height: 1 }, style: { color: 'url(x)', accentColor: 'red', backgroundColor: 'red', fontScale: 1 }, binding: { kind: 'metric', metric: 'speed' } }] },
      });
      await userEvent.upload(screen.getByTestId('project-input'), new File([bad], 'y.json'));
      await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/must be/));
      expect(useOverlayTemplateStore.getState().selectedId).toBe('compact-hud');
    });

    it('can be loaded again after a failure', async () => {
      await open();
      await userEvent.upload(screen.getByTestId('project-input'), new File(['nope'], 'x.json'));
      await screen.findByRole('alert');
      await userEvent.click(screen.getByRole('button', { name: 'Save project file' }));
      const text = await saved_files()[0]!.blob.text();
      await userEvent.upload(screen.getByTestId('project-input'), new File([text], 'x.json'));
      await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });
  });

  it('shows the controls inside the Customize group', async () => {
    await open();
    expect(editor().getByRole('button', { name: 'Save project file' })).toBeInTheDocument();
    expect(editor().getByRole('button', { name: 'Reset template' })).toBeInTheDocument();
  });

  // Helpers that read the captured downloads from the shared stub.
  function saved_files() {
    return saved_downloads_ref.current;
  }
  function component_exists(id: string) {
    return Boolean(useOverlayTemplateStore.getState().saved['compact-hud']?.components.some((c) => c.id === id));
  }
});

describe('saving the overlay as frames (AV-1006)', () => {
  beforeEach(() => {
    const context = new Proxy(
      {},
      {
        get: (_target, name) => (name === 'measureText' ? () => ({ width: 0 }) : () => undefined),
        set: () => true,
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => context) as unknown as HTMLCanvasElement['getContext'],
    );
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  });

  const open = async () => {
    const activity = await parseGpx(readFixture('overlay-sync.gpx'), { fileName: 'overlay-sync.gpx' });
    useOverlayStore.getState().setActivity(activity, { video: new File(['x'], 'private-name.webm', { type: 'video/webm' }) });
    window.location.hash = '#/overlays';
    render(<App />);
    const video = (await screen.findByTestId('overlay-video')) as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    fireEvent.loadedMetadata(video);
    return screen.findByRole('region', { name: 'Export overlay frames' });
  };
  const panel = (el: HTMLElement) => within(el);

  it('defaults to the video\'s own size and length, and says how many frames that is', async () => {
    const region = panel(await open());
    expect(region.getByLabelText('Frame width')).toHaveValue(640);
    expect(region.getByLabelText('Frame height')).toHaveValue(360);
    expect(region.getByLabelText('Export from')).toHaveValue(0);
    expect(region.getByLabelText('Export to')).toHaveValue(4);
    expect(region.getByText(/120 frames, in one zip file/)).toBeInTheDocument();
  });

  it('is not offered until there is a video', async () => {
    const activity = await parseGpx(readFixture('overlay-sync.gpx'), { fileName: 'overlay-sync.gpx' });
    useOverlayStore.getState().setActivity(activity);
    window.location.hash = '#/overlays';
    render(<App />);
    await screen.findByRole('region', { name: 'Video overlay' });
    expect(screen.queryByRole('region', { name: 'Export overlay frames' })).not.toBeInTheDocument();
  });

  it('follows the frame rate and the range', async () => {
    const region = panel(await open());
    fireEvent.change(region.getByLabelText(/Frame rate/), { target: { value: '10' } });
    expect(region.getByText(/40 frames/)).toBeInTheDocument();
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '2' } });
    expect(region.getByText(/20 frames/)).toBeInTheDocument();
  });

  it('says which setting is wrong and will not start', async () => {
    const region = panel(await open());
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '0' } });
    expect(region.getByRole('alert')).toHaveTextContent(/after its start/);
    expect(region.getByRole('button', { name: 'Save PNG frames (zip)' })).toBeDisabled();

    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '4' } });
    fireEvent.change(region.getByLabelText('Frame width'), { target: { value: '99999' } });
    expect(region.getByRole('alert')).toHaveTextContent(/at most 4096/);
    fireEvent.change(region.getByLabelText('Frame width'), { target: { value: '' } });
    expect(region.getByRole('button', { name: 'Save PNG frames (zip)' })).toBeDisabled();
  });

  it('warns that a long export arrives as several zip files', async () => {
    const region = panel(await open());
    fireEvent.change(region.getByLabelText(/Frame rate/), { target: { value: '120' } });
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '100' } });
    expect(region.getByText(/in at least 8 zip files/)).toBeInTheDocument();
  });

  it('saves a zip of numbered transparent frames at the chosen size', async () => {
    const region = panel(await open());
    fireEvent.change(region.getByLabelText(/Frame rate/), { target: { value: '10' } });
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '1' } });
    await userEvent.click(region.getByRole('button', { name: 'Save PNG frames (zip)' }));

    expect(await region.findByText(/Saved 10 frames/)).toBeInTheDocument();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.fileName).toBe('overlay-frames-part-01.zip');
    const files = await readZip(saved[0]!.blob);
    expect(files.filter((f) => f.name.endsWith('.png'))).toHaveLength(10);
    expect(files[0]!.name).toBe('overlay_000001.png');
    const readme = new TextDecoder().decode(files.find((f) => f.name === 'README.txt')!.data);
    expect(readme).toContain('10 fps');
    expect(readme).toContain('640 x 360');
    // Named for what it is, never for the video it was made beside.
    expect(saved[0]!.fileName).not.toMatch(/private-name/);
    expect(readme).not.toMatch(/private-name/);
  });

  it('can be stopped, and says what was kept', async () => {
    const region = panel(await open());
    fireEvent.change(region.getByLabelText(/Frame rate/), { target: { value: '100' } });
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '40' } });
    await userEvent.click(region.getByRole('button', { name: 'Save PNG frames (zip)' }));
    await region.findByRole('progressbar', { name: 'Export progress' });
    await userEvent.click(region.getByRole('button', { name: 'Stop' }));

    expect(await region.findByText(/Stopped\./)).toBeInTheDocument();
    expect(region.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(region.getByRole('button', { name: 'Save PNG frames (zip)' })).toBeEnabled();
  });

  it('says so when the browser cannot draw the images', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => null) as unknown as HTMLCanvasElement['getContext'],
    );
    const region = panel(await open());
    await userEvent.click(region.getByRole('button', { name: 'Save PNG frames (zip)' }));
    expect(await region.findByRole('alert')).toHaveTextContent(/cannot draw images/);
    expect(saved).toHaveLength(0);
  });

  it('uses the telemetry offset set above', async () => {
    const region = panel(await open());
    fireEvent.change(screen.getByLabelText('Offset (seconds)'), { target: { value: '3' } });
    fireEvent.change(region.getByLabelText(/Frame rate/), { target: { value: '4' } });
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '1' } });
    await userEvent.click(region.getByRole('button', { name: 'Save PNG frames (zip)' }));
    await region.findByText(/Saved 4 frames/);
    expect(saved).toHaveLength(1);
  });

  it('makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const region = panel(await open());
    fireEvent.change(region.getByLabelText(/Frame rate/), { target: { value: '5' } });
    fireEvent.change(region.getByLabelText('Export to'), { target: { value: '1' } });
    await userEvent.click(region.getByRole('button', { name: 'Save PNG frames (zip)' }));
    await region.findByText(/Saved 5 frames/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
