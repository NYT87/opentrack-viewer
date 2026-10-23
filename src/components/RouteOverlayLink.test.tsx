import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RouteOverlayLink } from './RouteOverlayLink';
import { ROUTES } from '../app/routes';
import { useOverlayStore } from '../state/overlayStore';
import { makeActivity } from '../test/helpers/activity';

const ride = makeActivity(
  Array.from({ length: 10 }, (_, i) => ({ lat: 10 + i * 0.001, lon: 20 + i * 0.002 })),
);

beforeEach(() => {
  useOverlayStore.getState().clear();
  useOverlayStore.setState({ controls: useOverlayStore.getInitialState().controls });
});

type Range = { startIndex: number; endIndex: number } | undefined;

const tree = (activity = ride, selectedRange?: Range) => (
  <MemoryRouter initialEntries={[ROUTES.viewer]}>
    <Routes>
      <Route path={ROUTES.viewer} element={<RouteOverlayLink activity={activity} selectedRange={selectedRange} />} />
      <Route path={ROUTES.overlays} element={<p>overlay page</p>} />
    </Routes>
  </MemoryRouter>
);

function setup(activity = ride, selectedRange?: Range) {
  return render(tree(activity, selectedRange));
}

const gappy = makeActivity([
  { lat: 10, lon: 20 },
  { lat: 10.001, lon: 20.001 },
  { elevationMeters: 1 },
  { elevationMeters: 2 },
  { lat: 10.004, lon: 20.004 },
]);

describe('RouteOverlayLink (AV-1009)', () => {
  it('hands the whole activity to the overlay page by default', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Create route overlay' }));
    expect(screen.getByText('overlay page')).toBeInTheDocument();
    const { source } = useOverlayStore.getState();
    expect(source.activity).toBe(ride);
    expect(source.focusedSection).toBeUndefined();
    expect(source.activityOrigin).toBe('hand');
    expect(source.video).toBeUndefined();
  });

  it('offers the selected section, unticked, and still hands over the whole activity until it is chosen', async () => {
    setup(ride, { startIndex: 2, endIndex: 6 });
    const choice = screen.getByRole('checkbox', { name: /Use only the selected section/ });
    expect(choice).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Create route overlay' }));
    expect(useOverlayStore.getState().source.activity).toBe(ride);
    expect(useOverlayStore.getState().source.focusedSection).toBeUndefined();
  });

  it('hands over the focused slice when that is chosen, marked as a section, leaving the source untouched', async () => {
    setup(ride, { startIndex: 2, endIndex: 6 });
    await userEvent.click(screen.getByRole('checkbox', { name: /Use only the selected section/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create route overlay' }));
    const { source } = useOverlayStore.getState();
    expect(source.focusedSection).toBe(true);
    expect(source.activity).not.toBe(ride);
    expect(source.activity!.points.map((point) => point.index)).toEqual([2, 3, 4, 5, 6]);
    expect(ride.points).toHaveLength(10);
  });

  it('does not offer a section that has no locations to draw', () => {
    setup(gappy, { startIndex: 2, endIndex: 3 });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('is disabled, with the reason, for an activity with no route', () => {
    setup(makeActivity([{ elevationMeters: 1 }, { elevationMeters: 2 }]));
    expect(screen.getByRole('button', { name: 'Create route overlay' })).toBeDisabled();
    expect(screen.getByText(/no route to draw/)).toBeInTheDocument();
  });

  it('lets go of a video held from before, so the route image is what opens', async () => {
    useOverlayStore.getState().setVideo({ file: new File(['x'], 'old.mp4') });
    useOverlayStore.getState().setMedia({ width: 1920, height: 1080, durationSeconds: 10 });
    useOverlayStore.getState().setOffsetSeconds(3);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Create route overlay' }));
    const state = useOverlayStore.getState();
    expect(state.source.video).toBeUndefined();
    expect(state.media).toBeUndefined();
    expect(state.offsetSeconds).toBe(0);
    expect(state.source.activity).toBe(ride);
  });

  it('does not quietly hand over the whole activity when the section asked for goes away', async () => {
    const view = setup(gappy, { startIndex: 0, endIndex: 1 });
    await userEvent.click(screen.getByRole('checkbox', { name: /Use only the selected section/ }));

    // The selection moves to a stretch with no locations.
    view.rerender(tree(gappy, { startIndex: 2, endIndex: 3 }));
    const choice = screen.getByRole('checkbox', { name: /Use only the selected section/ });
    expect(choice).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent(/no usable locations/);
    const create = screen.getByRole('button', { name: 'Create route overlay' });
    expect(create).toBeDisabled();
    await userEvent.click(create);
    expect(useOverlayStore.getState().source.activity).toBeUndefined();
    expect(screen.queryByText('overlay page')).not.toBeInTheDocument();

    // Unticking is the way back to the whole activity, on purpose.
    await userEvent.click(choice);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create route overlay' }));
    expect(useOverlayStore.getState().source.activity).toBe(gappy);
    expect(useOverlayStore.getState().source.focusedSection).toBeUndefined();
  });

  it('does the same when the selection is cleared altogether', async () => {
    const view = setup(ride, { startIndex: 2, endIndex: 6 });
    await userEvent.click(screen.getByRole('checkbox', { name: /Use only the selected section/ }));
    act(() => view.rerender(tree(ride, undefined)));
    expect(screen.getByRole('button', { name: 'Create route overlay' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/no longer selected/);
  });
});
