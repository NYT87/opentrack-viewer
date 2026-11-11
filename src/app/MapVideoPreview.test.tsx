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
const { maxFollowOffsetMeters } = await import('../mapVideo/keyframes');
const { jpegWithExif } = await import('../test/helpers/exifFixture');
const { photoInput } = await import('../mapVideo/readPhoto');
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
  const { activity, settings, photos } = useMapVideoStore.getState();
  const built = buildMapVideoModel(activity!, settings, photos.map((photo) => photoInput(photo, activity!.metadata.utcOffsetMinutes)));
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

  it('takes a number typed a digit at a time, and holds one beyond its limits only once the field is left (AV-1210)', async () => {
    await openWithRoute();
    const zoom = screen.getByRole('spinbutton', { name: 'Zoom' });
    // "1" is below the zoom's 10–17 on the way to "12": the field keeps it as typed, and the 12 arrives.
    await userEvent.clear(zoom);
    await userEvent.type(zoom, '12');
    expect(zoom).toHaveValue(12);
    expect(useMapVideoStore.getState().settings.camera.zoom).toBe(12);
    // Beyond the limit, it is held to it when the field is left.
    await userEvent.clear(zoom);
    await userEvent.type(zoom, '30');
    expect(useMapVideoStore.getState().settings.camera.zoom).toBe(12);
    await userEvent.tab();
    expect(useMapVideoStore.getState().settings.camera.zoom).toBe(17);
    expect(zoom).toHaveValue(17);

    // The same in a keyframe's fields.
    await userEvent.click(screen.getByRole('button', { name: 'Add keyframe here' }));
    const keyframeZoom = within(screen.getByRole('region', { name: 'Camera keyframes' })).getByRole('spinbutton', { name: 'Zoom' });
    await userEvent.clear(keyframeZoom);
    await userEvent.type(keyframeZoom, '13');
    await userEvent.tab();
    expect(useMapVideoStore.getState().settings.keyframes[0]!.zoom).toBe(13);
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

describe('camera keyframes on the page (AV-1206)', () => {
  const keyframesRegion = () => screen.getByRole('region', { name: 'Camera keyframes' });
  const rows = () => within(keyframesRegion()).queryAllByRole('listitem');

  /** Moves the preview's map as a reader's drag would, then adds a keyframe from it. */
  async function addFromView(view: Record<string, unknown>) {
    map().view = { ...map().view, ...view };
    await userEvent.click(screen.getByRole('button', { name: 'Add keyframe here' }));
  }

  it('adds a keyframe from the view the reader moved the map to, at the moment showing', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '10' } });
    const marker = model().at(10).reveal.marker;
    await addFromView({ zoom: 15.2, pitch: 30, bearing: 90, center: marker });

    const [keyframe] = useMapVideoStore.getState().settings.keyframes;
    // jsdom lays nothing out, so the preview is the video's own width and the zoom is the map's.
    expect(keyframe).toMatchObject({ seconds: 10, mode: 'follow', zoom: 15.2, pitch: 30, bearing: 90 });
    expect(Math.hypot(keyframe!.offset.east, keyframe!.offset.north)).toBeLessThan(1e-6);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveAccessibleName('Keyframe 1, at 0:10.0');
    // The preview now plays it.
    expect(lastJump()).toMatchObject({ zoom: 15.2, pitch: 30, bearing: 90 });
  });

  it('brings a keyframe nearer the marker when the view would lose it, and says so', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '10' } });
    const [lon, lat] = model().at(10).reveal.marker;
    await addFromView({ zoom: 16, pitch: 0, bearing: 0, center: [lon + 0.05, lat] });
    expect(within(keyframesRegion()).getByRole('status')).toHaveTextContent('Brought closer to the marker');
    const [keyframe] = useMapVideoStore.getState().settings.keyframes;
    // Asked for about 3.5 km east; held to what a 1080-pixel frame at zoom 16 keeps in view.
    expect(keyframe!.offset.east).toBeCloseTo(maxFollowOffsetMeters(16, 0, lat, { width: 1920, height: 1080 }), 3);
    expect(keyframe!.offset.east).toBeLessThan(300);
  });

  it('moves, edits and deletes keyframes, each change undoable', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '8' } });
    await addFromView({ zoom: 14, pitch: 10, bearing: 0, center: model().at(8).reveal.marker });
    fireEvent.change(scrubber(), { target: { value: '20' } });
    await addFromView({ zoom: 16, pitch: 40, bearing: 0, center: model().at(20).reveal.marker });
    expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual(['Keyframe 1, at 0:08.0', 'Keyframe 2, at 0:20.0']);

    // Moved past the other: the list follows the time.
    fireEvent.change(within(rows()[0]!).getByRole('spinbutton', { name: 'At' }), { target: { value: '24' } });
    expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual(['Keyframe 1, at 0:20.0', 'Keyframe 2, at 0:24.0']);

    fireEvent.change(within(rows()[0]!).getByRole('spinbutton', { name: 'Zoom' }), { target: { value: '12' } });
    expect(useMapVideoStore.getState().settings.keyframes.find((k) => k.seconds === 20)!.zoom).toBe(12);
    await userEvent.click(within(rows()[0]!).getByRole('checkbox', { name: 'Turns with the route' }));
    expect(useMapVideoStore.getState().settings.keyframes.find((k) => k.seconds === 20)!.bearing).toBeNull();

    await userEvent.click(within(rows()[1]!).getByRole('button', { name: 'Delete' }));
    expect(rows()).toHaveLength(1);

    const undo = within(keyframesRegion()).getByRole('button', { name: 'Undo' });
    await userEvent.click(undo);
    expect(rows()).toHaveLength(2);
    await userEvent.click(undo);
    await userEvent.click(undo);
    await userEvent.click(undo);
    expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual(['Keyframe 1, at 0:08.0', 'Keyframe 2, at 0:20.0']);
  });

  it('goes to a keyframe\'s moment, and marks keyframes on the scrubber', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '18' } });
    await addFromView({ zoom: 15, pitch: 0, bearing: 0, center: model().at(18).reveal.marker });
    fireEvent.change(scrubber(), { target: { value: '3' } });
    await userEvent.click(within(rows()[0]!).getByRole('button', { name: 'Go to' }));
    expect(readout()).toBe('0:18.0 / 0:30.0');
    const ticks = document.getElementById(scrubber().getAttribute('list')!)!;
    expect([...ticks.querySelectorAll('option')].map((option) => option.getAttribute('value'))).toEqual(['18']);
  });

  it('offers no keyframe while playing, when the frames move the map', async () => {
    await openWithRoute();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.queryByRole('button', { name: 'Add keyframe here' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Add keyframe here' })).toBeInTheDocument();
  });
});

describe('figures over the map (AV-1207)', () => {
  const editor = () => screen.getByRole('region', { name: 'Figures over the map' });

  it('places figures with the custom canvas editor, at the video\'s size, with none of its own exports', async () => {
    await openWithRoute();
    expect(within(editor()).queryByRole('group', { name: 'Resolution' })).not.toBeInTheDocument();
    expect(within(editor()).queryByRole('button', { name: /Export|Make/ })).not.toBeInTheDocument();
    expect(within(editor()).getByRole('group', { name: /^Canvas preview, 1920 by 1080 pixels/ })).toBeInTheDocument();

    await userEvent.selectOptions(within(editor()).getByRole('combobox', { name: 'Add' }), 'metric:heartRate');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Add to the canvas' }));
    const overlay = useMapVideoStore.getState().settings.overlay;
    expect(overlay?.components.map((component) => component.source)).toEqual([{ kind: 'metric', metric: 'heartRate' }]);
    // And it is drawn: the preview's figures layer is over the map, under the credit.
    expect(screen.getByTestId('map-video-figures')).toBeInTheDocument();
  });

  it('follows the paused preview\'s moment, and moves the preview from its own scrubber', async () => {
    await openWithRoute();
    fireEvent.change(scrubber(), { target: { value: '15' } });
    await waitFor(() => expect(within(editor()).getByRole('timer', { name: 'Canvas time shown' })).toHaveTextContent('0:15 / 0:30'));
    expect(within(editor()).queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    fireEvent.change(within(editor()).getByRole('slider', { name: 'Canvas time' }), { target: { value: '21' } });
    await waitFor(() => expect(readout()).toBe('0:21.0 / 0:30.0'));
  });

  it('opens a project\'s figures in the editor', async () => {
    await openWithRoute();
    const project = {
      kind: MAP_VIDEO_PROJECT_KIND,
      version: 1,
      activity: { fileName: 'route-with-elevation.gpx', points: 4 },
      settings: {
        overlay: {
          version: 2,
          name: 'Figures',
          components: [{ id: 'speed', type: 'text', visible: true, unitMode: 'auto', style: {}, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, source: { kind: 'metric', metric: 'speed' } }],
        },
      },
    };
    await userEvent.upload(screen.getByTestId('map-video-project-input'), new File([JSON.stringify(project)], 'figures.json'));
    await waitFor(() => expect(within(editor()).getByRole('button', { name: 'Speed' })).toBeInTheDocument());
    expect(useMapVideoStore.getState().settings.overlay?.components).toHaveLength(1);
  });

  it('offers the summary card only with an outro to show it in', async () => {
    await openWithRoute();
    const card = () => screen.getByRole('checkbox', { name: /Show the totals on a card/ });
    expect(card()).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pull back to the whole route' }));
    expect(card()).toBeDisabled();
    expect(card()).toHaveAccessibleName(/turn the outro on first/);
  });
});

describe('photos along the route (AV-1208)', () => {
  const photosRegion = () => screen.getByRole('region', { name: 'Photos' });
  const row = (name: string) => within(photosRegion()).getByRole('listitem', { name });
  /** A photo file: EXIF as a camera writes it, in a file the stub below decodes (or not). */
  const photo = (name: string, exif: Parameters<typeof jpegWithExif>[0] = {}) => new File([jpegWithExif(exif)], name, { type: 'image/jpeg' });

  beforeEach(() => {
    // jsdom decodes no images: a stand-in that does, refusing a file named as damaged.
    globalThis.createImageBitmap = vi.fn(async (source: unknown, options?: ImageBitmapOptions) => {
      if (source instanceof File && source.name.includes('damaged')) throw new Error('decode');
      return { width: options?.resizeWidth ?? 4000, height: options?.resizeHeight ?? 3000, close: vi.fn() } as unknown as ImageBitmap;
    }) as unknown as typeof createImageBitmap;
  });

  it('places a photo by when it was taken, and lets it go again', async () => {
    await openWithRoute();
    // The ride runs 10:00 to 10:03 UTC; this was taken at 10:01:30.
    await userEvent.upload(screen.getByTestId('map-video-photo-input'), photo('IMG_1.jpg', { dateTimeOriginal: '2024:01:01 10:01:30', offsetTimeOriginal: '+00:00' }));
    await waitFor(() => expect(row('IMG_1.jpg')).toHaveTextContent(/Shown at 0:\d\d\.\d, .* along the route\./));
    expect(within(row('IMG_1.jpg')).getByRole('combobox', { name: 'Placed' })).toHaveValue('time');
    expect(model().timeline.holds).toHaveLength(1);

    await userEvent.click(within(row('IMG_1.jpg')).getByRole('button', { name: 'Remove' }));
    expect(within(photosRegion()).queryByRole('listitem')).not.toBeInTheDocument();
    expect(useMapVideoStore.getState().photos).toHaveLength(0);
  });

  it('moves a photo by the camera clock offset', async () => {
    await openWithRoute();
    // The camera's clock read 10:11:30 for 10:01:30: ten minutes ahead.
    await userEvent.upload(screen.getByTestId('map-video-photo-input'), photo('IMG_2.jpg', { dateTimeOriginal: '2024:01:01 10:11:30', offsetTimeOriginal: '+00:00' }));
    await waitFor(() => expect(row('IMG_2.jpg')).toHaveTextContent(/Left out: Taken at 10:11 UTC, outside the activity/));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Camera clock ahead of the activity by' }), { target: { value: '600' } });
    expect(row('IMG_2.jpg')).toHaveTextContent(/Shown at/);
  });

  it('places by hand, at the marker, a photo that says neither when nor where', async () => {
    await openWithRoute();
    await userEvent.upload(screen.getByTestId('map-video-photo-input'), photo('drawing.jpg'));
    await waitFor(() => expect(row('drawing.jpg')).toHaveTextContent(/Left out: Not placed yet/));
    fireEvent.change(scrubber(), { target: { value: '15' } });
    await userEvent.click(within(row('drawing.jpg')).getByRole('button', { name: 'Place at the marker' }));
    // At the place the marker was at 0:15; the 3 s it now waits there leave less time for the riding before it.
    expect(row('drawing.jpg')).toHaveTextContent(/Shown at 0:1[0-5]\.\d/);
    expect(useMapVideoStore.getState().settings.photos.items).toEqual([{ name: 'drawing.jpg', method: 'hand', handMeters: expect.any(Number) }]);
  });

  it('lists a photo it cannot decode, with the reason, and leaves it out', async () => {
    await openWithRoute();
    await userEvent.upload(screen.getByTestId('map-video-photo-input'), photo('damaged.jpg', { dateTimeOriginal: '2024:01:01 10:01:30', offsetTimeOriginal: '+00:00' }));
    await waitFor(() => expect(row('damaged.jpg')).toHaveTextContent('Left out: It could not be decoded'));
    expect(model().timeline.holds).toHaveLength(0);
  });

  it('saves photos by name only, and asks for them again when the project is opened', async () => {
    const blobs: Blob[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:saved';
    });
    URL.revokeObjectURL = vi.fn();
    try {
      await openWithRoute();
      await userEvent.upload(
        screen.getByTestId('map-video-photo-input'),
        photo('IMG_1.jpg', { dateTimeOriginal: '2024:01:01 10:01:30', offsetTimeOriginal: '+00:00', lat: 51.5, lon: -0.002 }),
      );
      await waitFor(() => expect(row('IMG_1.jpg')).toHaveTextContent(/Shown at/));
      await userEvent.selectOptions(within(row('IMG_1.jpg')).getByRole('combobox', { name: 'Placed' }), 'position');
      await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
    } finally {
      URL.createObjectURL = original;
    }
    const json = await blobs[0]!.text();
    expect(JSON.parse(json).settings.photos.items).toEqual([{ name: 'IMG_1.jpg', method: 'position' }]);
    expect(json).not.toMatch(/10:01|2024|-0\.002|"lat"|"lon"/);

    useMapVideoStore.getState().removePhoto(useMapVideoStore.getState().photos[0]!.id);
    await userEvent.upload(screen.getByTestId('map-video-project-input'), new File([json], 'saved.json'));
    expect(await within(photosRegion()).findByText(/The project names a photo not added yet: IMG_1\.jpg/)).toBeInTheDocument();
  });
});

describe('the export panel after the M10 review (TD-073)', () => {
  const panel = () => screen.getByRole('region', { name: 'Make the video' });

  it('offers a still where the browser has no video encoder', async () => {
    await openWithRoute();
    expect(within(panel()).getByRole('alert')).toHaveTextContent(/no video encoder/);
    expect(within(panel()).getByRole('button', { name: /^Save a still of 0:00\.0 \(PNG\)$/ })).toBeEnabled();
  });

  it('will not ask OpenFreeMap for more tiles than its terms allow, and says which zoom fits', async () => {
    // 2,000 points due north, 333 m apart: a 666 km ride, at zoom 14, where OpenFreeMap's tiles are finest.
    const body = Array.from({ length: 2000 }, (_, i) => `<trkpt lat="${(40 + i * 0.003).toFixed(4)}" lon="7"><time>${new Date(Date.UTC(2026, 10, 1, 8, 0, i * 20)).toISOString()}</time></trkpt>`).join('');
    const long = new File(
      [`<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`],
      'long-ride.gpx',
      { type: 'application/gpx+xml' },
    );
    window.location.hash = '#/map-video';
    render(<App />);
    await userEvent.upload(screen.getByTestId('map-video-activity-input'), long);
    await waitFor(() => expect(FakeMap.instances.length).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Zoom' }), { target: { value: '14' } });
    const alert = await within(panel()).findByText(/would ask OpenFreeMap for about [\d,]+ map tiles, more than the 3,000/);
    // The zoom that fits is looked for once the settings are still.
    expect(alert).toHaveTextContent(/Finding a zoom that fits/);
    await waitFor(() => expect(alert).toHaveTextContent(/At zoom 1[0-3](\.5)? \(Camera, above\) it would be about [\d,]+\./), { timeout: 5000 });
    await userEvent.click(screen.getByRole('radio', { name: /^Route only/ }));
    expect(within(panel()).queryByText(/would ask OpenFreeMap/)).not.toBeInTheDocument();
  });
});
