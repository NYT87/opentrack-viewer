import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CustomTrackLink } from './CustomTrackLink';
import { ROUTES } from '../app/routes';
import { useRouteDraftStore } from '../state/routeDraftStore';
import { useActivityStore } from '../state/activityStore';
import { makeActivity } from '../test/helpers/activity';

const ride = makeActivity(
  Array.from({ length: 10 }, (_, i) => ({
    lat: 10 + i * 0.001,
    lon: 20 + i * 0.002,
    elevationMeters: 100 + i,
    heartRateBpm: 120 + i,
  })),
);

beforeEach(() => {
  useRouteDraftStore.getState().clear();
  useActivityStore.getState().clear();
});

type Range = { startIndex: number; endIndex: number } | undefined;

const tree = (activity = ride, selectedRange?: Range) => (
  <MemoryRouter initialEntries={[ROUTES.viewer]}>
    <Routes>
      <Route
        path={ROUTES.viewer}
        element={<CustomTrackLink activity={activity} selectedRange={selectedRange} />}
      />
      <Route path={ROUTES.routeBuilder} element={<p>route builder page</p>} />
    </Routes>
  </MemoryRouter>
);

const setup = (activity = ride, selectedRange?: Range) => render(tree(activity, selectedRange));
const button = () => screen.getByRole('button', { name: 'Create custom track' });

const gappy = makeActivity([
  { lat: 10, lon: 20 },
  { lat: 10.001, lon: 20.001 },
  { elevationMeters: 1 },
  { elevationMeters: 2 },
  { lat: 10.004, lon: 20.004 },
]);

describe('CustomTrackLink (AV-1103)', () => {
  it('copies the whole route into a draft and opens Route Builder', async () => {
    setup();

    await userEvent.click(button());

    expect(screen.getByText('route builder page')).toBeInTheDocument();
    const draft = useRouteDraftStore.getState().draft!;
    expect(draft.kind).toBe('copied');
    expect(draft.points).toHaveLength(10);
    expect(draft.points[0]).toMatchObject({ lat: 10, lon: 20, elevationMeters: 100 });
  });

  it('hands over the shape Route Builder expects: a draft, not an activity', async () => {
    setup();
    await userEvent.click(button());

    const draft = useRouteDraftStore.getState().draft!;
    // One source, the activity, with every point offered and every one used.
    expect(draft.sources).toHaveLength(1);
    expect(draft.sources[0]).toMatchObject({ sourcePointCount: 10, usedPointCount: 10 });
    expect(draft.points.every((point) => point.origin.kind === 'activity')).toBe(true);
    // Place and order only (TD-048): nothing of the recording's sensors.
    expect(JSON.stringify(draft)).not.toContain('heartRate');
  });

  it('leaves the viewed activity exactly as it was', async () => {
    useActivityStore.getState().setActivity(ride);
    const before = JSON.stringify(ride);
    setup();

    await userEvent.click(button());

    expect(JSON.stringify(ride)).toBe(before);
    expect(useActivityStore.getState().activity).toBe(ride);
    // And the draft shares nothing with it: a point edited later cannot reach back.
    const draft = useRouteDraftStore.getState().draft!;
    expect(draft.points[0]).not.toBe(ride.points[0]);
  });

  it('is disabled, with the model\'s own reason, for an activity with no route', () => {
    setup(makeActivity([{ elevationMeters: 1 }, { elevationMeters: 2 }]));

    expect(button()).toBeDisabled();
    expect(screen.getByText(/no route to take from them/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers the selected section, unticked, and copies the whole route until it is chosen', async () => {
    setup(ride, { startIndex: 2, endIndex: 5 });
    const box = screen.getByRole('checkbox', { name: 'Copy only the selected section' });
    expect(box).not.toBeChecked();

    await userEvent.click(button());

    expect(useRouteDraftStore.getState().draft?.points).toHaveLength(10);
  });

  it('copies only the section when that is chosen', async () => {
    setup(ride, { startIndex: 2, endIndex: 5 });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy only the selected section' }));

    await userEvent.click(button());

    const draft = useRouteDraftStore.getState().draft!;
    expect(draft.points).toHaveLength(4);
    expect(draft.points[0]).toMatchObject({ lat: 10.002, origin: { kind: 'activity', pointIndex: 2 } });
    expect(draft.sources[0]).toMatchObject({ sourcePointCount: 4, usedPointCount: 4 });
  });

  it('does not offer a section with no locations to copy', () => {
    setup(gappy, { startIndex: 2, endIndex: 3 });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(button()).toBeEnabled();
  });

  it('does not quietly copy the whole route when the section asked for goes away', async () => {
    const { rerender } = setup(gappy, { startIndex: 0, endIndex: 1 });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy only the selected section' }));

    // The selection moves to the unlocated stretch.
    rerender(tree(gappy, { startIndex: 2, endIndex: 3 }));

    expect(button()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/no usable locations, or is no longer selected/i);

    // Unticking is the explicit way back to the whole activity.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy only the selected section' }));
    expect(button()).toBeEnabled();
  });

  it('replaces a draft already held in Route Builder', async () => {
    useRouteDraftStore.getState().startBlank('Old plan');
    setup();

    await userEvent.click(button());

    expect(useRouteDraftStore.getState().draft?.kind).toBe('copied');
  });

  it('stores nothing on the device', async () => {
    setup();
    await userEvent.click(button());

    expect(Object.keys(localStorage).filter((key) => key !== 'opentrack-viewer:theme')).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});
