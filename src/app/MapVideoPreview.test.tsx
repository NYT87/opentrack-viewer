import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
const { useInteractionStore } = await import('../state/interactionStore');
const { useMapVideoStore } = await import('../state/mapVideoStore');
const { buildMapVideoModel } = await import('../mapVideo/model');
const { DEFAULT_MAP_VIDEO_SETTINGS, MAP_VIDEO_PROJECT_KIND } = await import('../mapVideo/project');
const { fixtureFile } = await import('../test/helpers/fixtures');
const { FakeMap, resetMapLibreMock } = await import('../test/helpers/maplibreMock');

const map = () => FakeMap.instances[FakeMap.instances.length - 1]!;
const lastJump = () => map().jumps[map().jumps.length - 1]!;
const readout = () => document.querySelector('.map-video-preview__time')!.textContent;
const scrubber = () => screen.getByRole('slider', { name: 'Position in the video' });
const frame = () => screen.getByRole('group', { name: /^Preview,/ });

/** Opens the page on a route and lets its map load. */
async function openWithRoute(fixture = 'route-with-elevation.gpx') {
  window.location.hash = '#/map-video';
  render(<App />);
  await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile(fixture));
  await waitFor(() => expect(FakeMap.instances.length).toBeGreaterThan(0));
  act(() => map().completeStyleLoad());
  await waitFor(() => expect(map().jumps.length).toBeGreaterThan(0));
}
const model = () => {
  const { activity, settings } = useMapVideoStore.getState();
  const built = buildMapVideoModel(activity!, settings);
  if (!built.ok) throw new Error(built.error);
  return built.model;
};

beforeEach(() => {
  window.location.hash = '';
  useMapVideoStore.setState(useMapVideoStore.getInitialState(), true);
  useInteractionStore.getState().setBasemapEnabled(true);
  resetMapLibreMock();
});

describe('the map video preview (AV-1204)', () => {
  it('shows the first frame, drawn from the model: the overview, and the marker at the start', async () => {
    await openWithRoute();
    const first = model().at(0);
    expect(lastJump()).toMatchObject({ center: first.camera.center, pitch: first.camera.pitch, bearing: first.camera.bearing });
    const marker = map().sources.get('map-video-marker')!.data as { features: { geometry: { coordinates: number[] } }[] };
    expect(marker.features[0]!.geometry.coordinates).toEqual(first.reveal.marker);
    expect(readout()).toBe('0:00.0 / 0:30.0');
    expect(screen.getByText(/The preview is a guide/)).toBeInTheDocument();
  });

  it('goes where the scrubber is put, and the camera and marker with it', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '15' } });
    expect(readout()).toBe('0:15.0 / 0:30.0');
    const moment = model().at(15);
    expect(lastJump()).toMatchObject({ center: moment.camera.center, bearing: moment.camera.bearing });
    expect(scrubber()).toHaveAttribute('aria-valuetext', '0:15.0 of 0:30.0');
  });

  it('plays and pauses', async () => {
    await openWithRoute();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(readout()).not.toBe('0:00.0 / 0:30.0'), { timeout: 2000 });
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const paused = readout();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readout()).toBe(paused);
  });

  it('is worked by keyboard: a frame, a second, the ends, and play', async () => {
    await openWithRoute();
    frame().focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
    expect(readout()).toBe('0:02.0 / 0:30.0');
    await userEvent.keyboard('{ArrowRight}');
    expect(Number(scrubber().getAttribute('value'))).toBeCloseTo(2 + 1 / 30, 6);
    await userEvent.keyboard('{End}');
    expect(readout()).toBe('0:30.0 / 0:30.0');
    await userEvent.keyboard('{Home}');
    expect(readout()).toBe('0:00.0 / 0:30.0');
    await userEvent.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('shows a changed setting at once, on the same map, without reading the file again', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '15' } });
    const tilt = screen.getByRole('spinbutton', { name: 'Tilt' });
    fireEvent.change(tilt, { target: { value: '20' } });
    expect(lastJump()).toMatchObject({ pitch: 20 });
    expect(FakeMap.instances).toHaveLength(1);
    await userEvent.click(screen.getByRole('checkbox', { name: /Keep north up/ }));
    expect(lastJump()).toMatchObject({ bearing: 0 });
  });

  it('takes the shape of the chosen size', async () => {
    await openWithRoute();
    expect(frame()).toHaveStyle({ aspectRatio: '1920 / 1080' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Size' }), 'Portrait, 1080 × 1920');
    expect(frame()).toHaveStyle({ aspectRatio: '1080 / 1920' });
    expect(frame()).toHaveAccessibleName(/1080 by 1920/);
  });

  it('holds 4K to a minute and to 30 frames a second', async () => {
    await openWithRoute();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Length' }), { target: { value: '120' } });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Frame rate' }), '60');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Size' }), '4K, 3840 × 2160');
    expect(useMapVideoStore.getState().settings).toMatchObject({ lengthSeconds: 60, output: { width: 3840, height: 2160, fps: 30 } });
    expect(screen.getByRole('option', { name: '60 a second (up to 1080p)' })).toBeDisabled();
  });

  it('says why, instead of a preview, when the privacy trim leaves too little', async () => {
    await openWithRoute();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Hide the first' }), { target: { value: '5000' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/privacy trim leaves less than 100 m/);
  });

  it('keeps its place in the video when another basemap makes a new map', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '12' } });
    await userEvent.click(screen.getByRole('radio', { name: /^Route only/ }));
    await waitFor(() => expect(FakeMap.instances).toHaveLength(2));
    await waitFor(() => expect(readout()).toBe('0:12.0 / 0:30.0'));
  });

  it('draws route only on a map that asks for nothing, and makes a new map to switch', async () => {
    await openWithRoute();
    const online = map();
    await userEvent.click(screen.getByRole('radio', { name: /^Route only/ }));
    await waitFor(() => expect(FakeMap.instances).toHaveLength(2));
    expect(online.removed).toBe(true);
    const style = map().options.style as { sources: object; layers: { type: string }[]; glyphs?: string; sprite?: string };
    expect(style.sources).toEqual({});
    expect(style.layers.map((layer) => layer.type)).toEqual(['background']);
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    expect(map().options.attributionControl).toBe(false);
  });
});

describe('the project file (AV-1204, TD-066)', () => {
  it('applies an opened project to the activity open, and says it was made for another', async () => {
    await openWithRoute();
    const project = {
      kind: MAP_VIDEO_PROJECT_KIND,
      version: 1,
      activity: { fileName: 'other-ride.gpx', points: 12 },
      settings: { ...DEFAULT_MAP_VIDEO_SETTINGS, camera: { ...DEFAULT_MAP_VIDEO_SETTINGS.camera, pitch: 12 }, basemap: { source: 'route-only', style: 'positron' } },
    };
    const file = new File([JSON.stringify(project)], 'saved.json', { type: 'application/json' });
    await userEvent.upload(screen.getByTestId('map-video-project-input'), file);

    const region = screen.getByRole('region', { name: 'Project' });
    expect(await within(region).findByText(/made for other-ride\.gpx \(12 points\)/)).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Tilt' })).toHaveValue(12);
    expect(screen.getByRole('radio', { name: /^Route only/ })).toBeChecked();
  });

  it('refuses a file that is not a project, saying why', async () => {
    await openWithRoute();
    await userEvent.upload(screen.getByTestId('map-video-project-input'), new File(['{"kind":"something"}'], 'notes.json'));
    expect(await within(screen.getByRole('region', { name: 'Project' })).findByRole('alert')).toHaveTextContent(
      'Could not open notes.json. This file is not an OpenTrack map video project.',
    );
  });

  it('saves the settings and the file name, and nothing of the route', async () => {
    const blobs: Blob[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:saved';
    });
    URL.revokeObjectURL = vi.fn();
    try {
      await openWithRoute();
      await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
    } finally {
      URL.createObjectURL = original;
    }
    const json = await blobs[0]!.text();
    expect(JSON.parse(json).activity).toEqual({ fileName: 'route-with-elevation.gpx', points: expect.any(Number) });
    const { activity } = useMapVideoStore.getState();
    for (const point of activity!.points) expect(json).not.toContain(String(point.lat));
  });
});

describe('styling the map, the route and the marker (AV-1205)', () => {
  const attribution = () => document.querySelector('.map-video-preview__frame .map-video-preview__attribution');

  it('draws the map\'s credit in the frame, with no setting to remove it', async () => {
    await openWithRoute();
    expect(attribution()).toHaveTextContent('OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
    expect(screen.queryByRole('checkbox', { name: /attribution|credit/i })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'dark');
    await waitFor(() => expect(map().options.style).toBe('https://tiles.openfreemap.org/styles/dark'));
    expect(attribution()).toHaveTextContent('OpenFreeMap');
  });

  it('credits no one on route only, and offers no terrain there, saying why', async () => {
    await openWithRoute();
    await userEvent.click(screen.getByRole('radio', { name: /^Route only/ }));
    expect(attribution()).toBeNull();
    expect(screen.getByRole('checkbox', { name: /3D terrain/ })).toBeDisabled();
    expect(screen.getByText('Terrain needs a map: route only fetches nothing.')).toBeInTheDocument();
  });

  it('draws terrain from AWS Terrain Tiles, credited in the frame, with the hills exaggerated as asked', async () => {
    await openWithRoute();
    await userEvent.click(screen.getByRole('checkbox', { name: /3D terrain/ }));
    await waitFor(() => expect(FakeMap.instances).toHaveLength(2));
    act(() => map().completeStyleLoad());
    await waitFor(() => expect(map().terrain).toEqual({ source: 'map-video-dem', exaggeration: 1.5 }));
    expect(map().sourceSpecs.get('map-video-dem')).toMatchObject({
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
    });
    // The map holds the centre to the ground, so the marker stays in the middle of the frame (TD-068).
    expect(map().options.centerClampedToGround).toBe(true);
    expect(lastJump()).not.toHaveProperty('elevation');
    expect(attribution()).toHaveTextContent(/Terrain: Mapzen, AWS Open Data/);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Hills exaggerated' }), { target: { value: '2.5' } });
    expect(map().terrain).toEqual({ source: 'map-video-dem', exaggeration: 2.5 });
    expect(FakeMap.instances).toHaveLength(2);
  });

  it('asks MapTiler only with a key, which never reaches the project file', async () => {
    await openWithRoute();
    await userEvent.click(screen.getByRole('radio', { name: /^MapTiler/ }));
    await waitFor(() => expect(typeof map().options.style).toBe('object'));
    expect(screen.getByText(/Type your key to see the map/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('MapTiler key'), 'k3y');
    await waitFor(() => expect(map().options.style).toBe('https://api.maptiler.com/maps/satellite/style.json?key=k3y'));
    expect(attribution()).toHaveTextContent('© MapTiler © OpenStreetMap contributors');
    expect(JSON.stringify(useMapVideoStore.getState().settings)).not.toContain('k3y');
    expect(window.localStorage.getItem('opentrack-viewer:map-video')).toBeNull();
  });

  it('colours the line by a recorded value, and disables what the file lacks, with the reason', async () => {
    await openWithRoute('simple-route.gpx');
    const bare = screen.getByRole('combobox', { name: 'Colour' });
    expect(within(bare).getByRole('option', { name: 'Elevation (not recorded)' })).toBeDisabled();
    expect(within(bare).getByRole('option', { name: 'Heart rate (not recorded)' })).toBeDisabled();
    expect(screen.getByText(/Heart rate: This activity records no heart rate/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), fixtureFile('route-with-elevation.gpx'));
    const colour = await screen.findByRole('combobox', { name: 'Colour' });
    await waitFor(() => expect(within(colour).getByRole('option', { name: 'Elevation' })).toBeEnabled());
    act(() => map().completeStyleLoad());
    await userEvent.selectOptions(colour, 'elevation');
    const paint = map().paintProperties['map-video-reveal.line-color'] as unknown[];
    expect(paint[0]).toBe('match');
    expect(screen.getByRole('paragraph', { name: 'Route colours' })).toBeInTheDocument();
    fireEvent.change(scrubber(), { target: { value: '27' } });
    const reveal = map().sources.get('map-video-reveal')!.data as { features: { properties: { bin: number } }[] };
    expect(new Set(reveal.features.map((feature) => feature.properties.bin)).size).toBeGreaterThan(1);
  });

  it('sets the line\'s width, casing and the rest of the route', async () => {
    await openWithRoute();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Line width' }), { target: { value: '10' } });
    expect(map().paintProperties['map-video-reveal.line-width']).toBe(10);
    await userEvent.click(screen.getByRole('checkbox', { name: 'A darker edge along the line' }));
    expect(map().layoutProperties['map-video-reveal-casing']).toBe('none');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show the route still to come, dimmed' }));
    expect((map().sources.get('map-video-rest')!.data as { features: unknown[] }).features).toHaveLength(0);
  });

  it('turns the arrow with the route, and draws the trail and the start and finish', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '15' } });
    await userEvent.click(screen.getByRole('radio', { name: 'An arrow pointing the way' }));
    // jsdom has no canvas to draw the icon on, so the map falls back to the dot: the layer is chosen, and the turn set.
    const marker = map().sources.get('map-video-marker')!.data as { features: { properties: { rotate: number } }[] };
    expect(typeof marker.features[0]!.properties.rotate).toBe('number');
    expect(map().layoutProperties['map-video-marker-icon.icon-size']).toBeCloseTo(18 / 96, 9);
    await userEvent.click(screen.getByRole('checkbox', { name: 'A fading trail behind it' }));
    const trail = map().sources.get('map-video-trail')!.data as { features: { geometry: { coordinates: unknown[] } }[] };
    expect(trail.features[0]!.geometry.coordinates.length).toBeGreaterThan(1);
    expect(map().sourceSpecs.get('map-video-trail')).toMatchObject({ lineMetrics: true });
    const ends = map().sources.get('map-video-ends')!.data as { features: { properties: { end: string } }[] };
    expect(ends.features.map((feature) => feature.properties.end)).toEqual(['start', 'finish']);
    await userEvent.click(screen.getByRole('checkbox', { name: /Start and finish markers/ }));
    expect((map().sources.get('map-video-ends')!.data as { features: unknown[] }).features).toHaveLength(0);
  });

  it('takes a custom size in even pixels, and says when it is too large', async () => {
    await openWithRoute();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Size' }), 'Custom');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Width' }), { target: { value: '1281' } });
    expect(useMapVideoStore.getState().settings.output.width % 2).toBe(0);
    expect(frame()).toHaveStyle({ aspectRatio: `${useMapVideoStore.getState().settings.output.width} / 1080` });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Width' }), { target: { value: '4096' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Height' }), { target: { value: '4096' } });
    expect(screen.getByText('The size is larger than 4K (3840 × 2160 pixels).')).toBeInTheDocument();
  });
});
