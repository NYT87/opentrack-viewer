import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The viewer and the map video page mount maps, and jsdom has no WebGL.
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
const { useOverlayStore } = await import('../state/overlayStore');
const { useMapVideoStore } = await import('../state/mapVideoStore');
const { useCleanupStore } = await import('../state/cleanupStore');
const { useInteractionStore } = await import('../state/interactionStore');
const { resetMapLibreMock } = await import('../test/helpers/maplibreMock');
const { makeActivity } = await import('../test/helpers/activity');

const T0 = new Date('2024-01-01T10:00:00Z').getTime();
const M_PER_DEG_LON = 111_194.9 * Math.cos((45 * Math.PI) / 180);

/** 40 s eastbound at 5 m/s (195 m) with a kilometre-wide GPS spike at point 10. */
const spiked = () =>
  makeActivity(
    Array.from({ length: 40 }, (_, i) => ({
      time: new Date(T0 + i * 1000),
      lat: i === 10 ? 45.009 : 45,
      lon: 7 + (i * 5) / M_PER_DEG_LON,
    })),
  );

beforeEach(() => {
  window.location.hash = '';
  useActivityStore.getState().clear();
  useOverlayStore.getState().clear();
  useMapVideoStore.setState(useMapVideoStore.getInitialState(), true);
  useCleanupStore.getState().reset();
  useInteractionStore.getState().setBasemapEnabled(false);
  useInteractionStore.getState().setUnitSystem('metric');
  resetMapLibreMock();
});

const goToTool = async (name: string) => {
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name }));
};

describe('the clean-up across the pages (AV-1024)', () => {
  it('feeds the viewer’s figures and warnings, and gives the raw ones back when switched off', async () => {
    const raw = spiked();
    act(() => useActivityStore.getState().setActivity(raw));
    window.location.hash = '#/viewer';
    render(<App />);

    const overview = screen.getByRole('region', { name: 'Activity overview' });
    const distanceBefore = within(overview).getByText('Distance').nextElementSibling!.textContent;
    expect(distanceBefore).toMatch(/km/);

    await userEvent.click(screen.getByRole('switch', { name: 'Clean up the telemetry' }));
    expect(within(overview).getByText('Distance').nextElementSibling!.textContent).toBe('195 m');
    expect(within(overview).getByText(/Cleaned: 1 point dropped, smoothing none\./)).toBeInTheDocument();
    expect(screen.getByTestId('cleanup-dropped')).toHaveTextContent('Dropped 1 point');
    // Switching a setting is not a new file: focus and the live region are not those of an opened activity.
    expect(useActivityStore.getState().activity).toBe(raw);
    expect(raw.points).toHaveLength(40);

    await userEvent.click(screen.getByRole('switch', { name: 'Clean up the telemetry' }));
    expect(within(overview).getByText('Distance').nextElementSibling!.textContent).toBe(distanceBefore);
    expect(within(overview).queryByText(/Cleaned:/)).not.toBeInTheDocument();
  });

  it('clears the chart selection when the points change under it', async () => {
    act(() => useActivityStore.getState().setActivity(spiked()));
    window.location.hash = '#/viewer';
    render(<App />);
    act(() => useInteractionStore.getState().setSelectedRange({ startIndex: 5, endIndex: 20 }));
    await userEvent.click(screen.getByRole('switch', { name: 'Clean up the telemetry' }));
    expect(useInteractionStore.getState().selectedRange).toBeUndefined();
  });

  it('puts the cleaned activity on the overlay page, with its one-line note', async () => {
    const raw = spiked();
    act(() => useOverlayStore.getState().setActivity(raw, 'hand'));
    act(() => useCleanupStore.getState().update({ enabled: true }));
    render(<App />);
    await goToTool('Overlays');

    expect(await screen.findByTestId('cleanup-note')).toHaveTextContent('Telemetry clean-up is on: 1 point dropped.');
    // The store still holds the raw activity.
    expect(useOverlayStore.getState().source.activity).toBe(raw);
  });

  it('puts the cleaned activity on the map video page, with its one-line note', async () => {
    const raw = spiked();
    act(() => useMapVideoStore.getState().setActivity(raw, 'hand'));
    act(() => useCleanupStore.getState().update({ enabled: true }));
    render(<App />);
    await goToTool('Map video');

    expect((await screen.findAllByTestId('cleanup-note'))[0]).toHaveTextContent('Telemetry clean-up is on: 1 point dropped.');
    expect(useMapVideoStore.getState().activity).toBe(raw);
  });

  it('says nothing on either page when the clean-up is off', async () => {
    act(() => useOverlayStore.getState().setActivity(spiked(), 'hand'));
    render(<App />);
    await goToTool('Overlays');
    await screen.findByRole('heading', { name: 'Overlays' });
    expect(screen.queryByTestId('cleanup-note')).not.toBeInTheDocument();
  });
});
