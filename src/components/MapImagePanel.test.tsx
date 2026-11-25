import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MapImagePanel } from './MapImagePanel';
import { useMapImageStore } from '../state/mapImageStore';
import { useInteractionStore } from '../state/interactionStore';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import type { MapImageRenderInput } from '../mapImage/render';

// MapLibre is not drawn here: the browser test draws it. The stub says what the preview was given.
vi.mock('./MapImagePreview', () => ({
  default: ({ plan }: { plan: { width: number; height: number; mapHeight: number; camera: { bearing: number; zoom: number } } }) => (
    <p data-testid="preview" data-zoom={plan.camera.zoom}>
      {plan.width}×{plan.height}, map {plan.mapHeight}, heading {plan.camera.bearing}
    </p>
  ),
}));

const flat = activityThrough(straightNorth(3000, 20, 5));
const hilly = activityThrough(straightNorth(3000, 20, 5).map((point) => ({ ...point, elevation: 100 + point.north / 30 })));

beforeEach(() => {
  useMapImageStore.setState(useMapImageStore.getInitialState());
  useInteractionStore.setState({ basemapEnabled: true });
});

function setup(activity = flat) {
  const renderImage = vi.fn(async (input: MapImageRenderInput) => {
    void input;
    return { blob: new Blob([new Uint8Array(2048)], { type: 'image/png' }), requests: 12 };
  });
  const save = vi.fn();
  render(<MapImagePanel activity={activity} units="metric" readerTimeZone="UTC" render={renderImage} save={save} />);
  return { renderImage, save, panel: screen.getByRole('region', { name: 'Map image' }) };
}

describe('the map image\u2019s privacy trim (AV-1022, TD-091)', () => {
  it('writes the share of the route each end hides beside it, and keeps the metres', async () => {
    const { panel } = setup();
    const first = within(panel).getByRole('spinbutton', { name: 'Hide the first' });
    expect(first).toHaveAccessibleDescription(/0 % of the route/);
    fireEvent.change(first, { target: { value: '300' } });
    // The road is 3 km: 300 m is a tenth of it.
    await waitFor(() => expect(first).toHaveAccessibleDescription('m — 10 % of the route'));
    expect(within(panel).getByText('— 10 % of the route')).toBeInTheDocument();
    expect(useMapImageStore.getState().settings.privacyTrim.startMeters).toBe(300);
    fireEvent.change(within(panel).getByRole('spinbutton', { name: 'Hide the last' }), { target: { value: '45' } });
    await waitFor(() => expect(within(panel).getByText('— 1.5 % of the route')).toBeInTheDocument());
  });
});

describe('MapImagePanel (AV-1013)', () => {
  it('offers the details the activity has, and the others disabled with the reason', async () => {
    const { panel } = setup();
    const details = within(panel).getByRole('group', { name: 'Details below the map' });
    expect(within(details).getByRole('checkbox', { name: 'Distance' })).toBeChecked();
    expect(within(details).getByRole('checkbox', { name: /Average heart rate/ })).toBeDisabled();
    expect(within(details).getByText(/records no heart rate/)).toBeInTheDocument();
    expect(within(details).getByRole('checkbox', { name: /Elevation profile/ })).toBeDisabled();
    // A detail taken away shrinks the panel: the map grows.
    const before = Number(/map (\d+)/.exec((await screen.findByTestId('preview')).textContent!)![1]);
    await userEvent.click(within(details).getByRole('checkbox', { name: 'Distance' }));
    await userEvent.click(within(details).getByRole('checkbox', { name: 'Moving time' }));
    await userEvent.click(within(details).getByRole('checkbox', { name: 'Average pace' }));
    await waitFor(() => expect(Number(/map (\d+)/.exec(screen.getByTestId('preview').textContent!)![1])).toBeGreaterThan(before));
  });

  it('offers the elevation profile where the activity records elevation', () => {
    const { panel } = setup(hilly);
    expect(within(panel).getByRole('checkbox', { name: 'Elevation profile' })).toBeEnabled();
  });

  it('saves the image as drawn, with its settings, and says what it made', async () => {
    const { panel, renderImage, save } = setup();
    await userEvent.click(within(panel).getByRole('radio', { name: /JPEG/ }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save the image' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toBe('map-image.jpg');
    const input = renderImage.mock.calls[0]![0];
    expect(input.settings).toMatchObject({ layout: 'panel', format: 'jpeg', output: { width: 1080, height: 1350 } });
    // Fitted, not moved: no camera of the reader's.
    expect(input.settings.camera).toBeUndefined();
    expect(await within(panel).findByText(/Saved map-image\.jpg \(2(\.0)? KB\)\. The map took 12 requests\./)).toBeInTheDocument();
  });

  it('turns the map by its buttons, and fits it again on request, at the heading it has', async () => {
    const { panel, renderImage } = setup();
    await userEvent.click(within(panel).getByRole('button', { name: 'Turn right' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Turn right' }));
    expect(within(panel).getByRole('spinbutton', { name: 'Heading' })).toHaveValue(30);
    expect(screen.getByTestId('preview')).toHaveTextContent('heading 30');
    await userEvent.click(within(panel).getByRole('button', { name: 'Zoom in' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Fit to the route' }));
    expect(screen.getByTestId('preview')).toHaveTextContent('heading 30');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save the image' }));
    await waitFor(() => expect(renderImage).toHaveBeenCalled());
    expect(renderImage.mock.calls[0]![0].settings.camera).toMatchObject({ bearing: 30 });
  });

  it('never offers MapTiler, whose terms forbid a saved image of its map, and draws OpenFreeMap for a MapTiler choice made before (TD-079)', async () => {
    useMapImageStore.setState({ basemapChosen: true, settings: { ...useMapImageStore.getState().settings, basemap: { source: 'maptiler', style: 'liberty', maptilerStyle: 'satellite' } } });
    const { panel, renderImage } = setup();
    expect(within(panel).queryByRole('radio', { name: /MapTiler/ })).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('MapTiler key')).not.toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: /^Online map/ })).toBeChecked();
    await userEvent.click(within(panel).getByRole('button', { name: 'Save the image' }));
    await waitFor(() => expect(renderImage).toHaveBeenCalled());
    expect(renderImage.mock.calls[0]![0].settings.basemap.source).toBe('online');
  });

  it('will not save a size past the limits', async () => {
    const { panel } = setup();
    const width = within(panel).getByRole('spinbutton', { name: 'Width' });
    const height = within(panel).getByRole('spinbutton', { name: 'Height' });
    await userEvent.clear(width);
    await userEvent.type(width, '4096');
    await userEvent.clear(height);
    await userEvent.type(height, '4096');
    expect(await within(panel).findByRole('alert')).toHaveTextContent('at most 4K’s pixels');
    expect(within(panel).getByRole('button', { name: 'Save the image' })).toBeDisabled();
    // The preview keeps the last size it could draw.
    expect(screen.getByTestId('preview').textContent).not.toContain('4096×4096');
  });

  it('keeps the camera where it is while a size past the limits is typed, and moves it from there', async () => {
    const { panel } = setup();
    const zoom = () => Number(screen.getByTestId('preview').getAttribute('data-zoom'));
    const height = within(panel).getByRole('spinbutton', { name: 'Height' });
    await userEvent.clear(height);
    await userEvent.type(height, '3000');
    await userEvent.click(within(panel).getByRole('button', { name: 'Zoom in' }));
    const before = zoom();
    // At once, so no width on the way (384) is drawn.
    fireEvent.change(within(panel).getByRole('spinbutton', { name: 'Width' }), { target: { value: '3840' } });
    expect(await within(panel).findByRole('alert')).toHaveTextContent('at most 4K’s pixels');
    expect(zoom()).toBeCloseTo(before, 6);
    // Each press is one step (half a level) from where the map is, not from a width that cannot be drawn.
    await userEvent.click(within(panel).getByRole('button', { name: 'Zoom in' }));
    expect(zoom()).toBeCloseTo(before + 0.5, 6);
    await userEvent.click(within(panel).getByRole('button', { name: 'Zoom out' }));
    expect(zoom()).toBeCloseTo(before, 6);
    expect(useMapImageStore.getState().view?.width).toBe(1080);
  });

  it('opens again at the default size when a size past the limits was left typed', () => {
    useMapImageStore.getState().updateSettings({ output: { width: 4000, height: 4000 } });
    setup();
    expect(screen.getByTestId('preview')).toHaveTextContent(/^1080×1350/);
    expect(screen.getByRole('alert')).toHaveTextContent('at most 4K’s pixels');
  });

  it('places elements over the map with the canvas editor, as a still: no clock and no live figures', async () => {
    const { panel } = setup();
    await userEvent.click(within(panel).getByRole('radio', { name: /map filling the image/ }));
    const editor = screen.getByRole('region', { name: 'Over the map' });
    expect(within(editor).queryByRole('slider', { name: 'Canvas time' })).not.toBeInTheDocument();
    const add = within(editor).getByLabelText('Add', { exact: true });
    const options = within(add).getAllByRole('option').map((option) => option.textContent);
    expect(options).toContain('Rectangle');
    expect(options).not.toContain('Speed gauge');
    expect(options.some((option) => option?.startsWith('Speed'))).toBe(false);
    // No panel: the map is the whole image.
    expect(screen.getByTestId('preview')).toHaveTextContent('1080×1350, map 1350');
  });

  it('keeps what was placed on the canvas when the layout is switched away and back (TD-088)', async () => {
    const { panel } = setup();
    const canvas = () => within(panel).getByRole('radio', { name: /map filling the image/ });
    await userEvent.click(canvas());
    const editor = () => screen.getByRole('region', { name: 'Over the map' });
    await userEvent.selectOptions(within(editor()).getByLabelText('Add', { exact: true }), 'Rectangle');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Add to the canvas' }));
    await waitFor(() => expect(useMapImageStore.getState().settings.overlay).toHaveLength(1));
    // To the panel and back to the canvas, twice: the rectangle is still there, and still stored.
    for (let round = 0; round < 2; round += 1) {
      await userEvent.click(within(panel).getByRole('radio', { name: /panel of details below/ }));
      expect(screen.queryByRole('region', { name: 'Over the map' })).not.toBeInTheDocument();
      await userEvent.click(canvas());
      expect(within(editor()).getAllByText(/Rectangle/).length).toBeGreaterThan(0);
      expect(useMapImageStore.getState().settings.overlay).toHaveLength(1);
    }
  });

  it('offers the route and the elevation profile in the canvas\'s Add menu, under "Along the route" (TD-088)', async () => {
    const { panel } = setup(hilly);
    await userEvent.click(within(panel).getByRole('radio', { name: /map filling the image/ }));
    const add = within(screen.getByRole('region', { name: 'Over the map' })).getByLabelText('Add', { exact: true });
    const along = within(add).getByRole('group', { name: 'Along the route' });
    const options = within(along).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Route with position', 'Elevation profile']);
    expect(options.every((option) => !(option as HTMLOptionElement).disabled)).toBe(true);
  });

  it('draws geometry on the free canvas for an activity with no timestamps, and offers no live figure (TD-088)', async () => {
    const untimed = activityThrough(straightNorth(3000, 20, 5).map((place) => ({ north: place.north, east: place.east, elevation: 100 + place.north / 30 })));
    const { panel } = setup(untimed);
    await userEvent.click(within(panel).getByRole('radio', { name: /map filling the image/ }));
    const add = within(screen.getByRole('region', { name: 'Over the map' })).getByLabelText('Add', { exact: true });
    const along = within(add).getByRole('group', { name: 'Along the route' });
    const options = within(along).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Route with position', 'Elevation profile']);
    expect(options.every((option) => !(option as HTMLOptionElement).disabled)).toBe(true);
    expect(within(add).queryByRole('option', { name: /^Speed/ })).not.toBeInTheDocument();
  });
});
