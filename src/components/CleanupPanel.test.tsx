import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CleanupNote, CleanupPanel } from './CleanupPanel';
import { cleanActivity, DEFAULT_CLEANUP_SETTINGS } from '../domain/cleanup';
import { useCleanupStore } from '../state/cleanupStore';
import { makeActivity } from '../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z').getTime();
const M_PER_DEG_LON = 111_194.9 * Math.cos((45 * Math.PI) / 180);

/** 30 s eastbound at 5 m/s, with a GPS spike at point 10 and an elevation spike at point 20. */
const ride = () =>
  makeActivity(
    Array.from({ length: 30 }, (_, i) => ({
      time: new Date(T0 + i * 1000),
      lat: i === 10 ? 45.009 : 45,
      lon: 7 + (i * 5) / M_PER_DEG_LON,
      elevationMeters: i === 20 ? 300 : 100,
    })),
  );

beforeEach(() => {
  useCleanupStore.getState().reset();
});

describe('CleanupPanel (AV-1024)', () => {
  it('starts off, with every setting labelled and the dependent ones disabled', () => {
    render(<CleanupPanel activity={ride()} units="metric" />);
    const panel = screen.getByTestId('cleanup-panel');
    expect(within(panel).getByRole('heading', { name: 'Telemetry clean-up' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Clean up the telemetry' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Drop impossible points' })).toBeDisabled();
    expect(screen.getByLabelText('Stopped below (m/s)')).toHaveValue(0.5);
    expect(screen.getByLabelText('Shortest stop (s)')).toHaveValue(0);
    expect(screen.getByLabelText('Smoothing')).toHaveValue('none');
    expect(screen.queryByTestId('cleanup-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('cleanup-dropped')).toBeEmptyDOMElement();
  });

  it('turns on from the keyboard, announces the points dropped politely, and shows raw against cleaned', async () => {
    const user = userEvent.setup();
    render(<CleanupPanel activity={ride()} units="metric" />);
    const toggle = screen.getByRole('switch', { name: 'Clean up the telemetry' });
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');

    expect(useCleanupStore.getState().settings.enabled).toBe(true);
    const dropped = screen.getByTestId('cleanup-dropped');
    expect(dropped).toHaveAttribute('aria-live', 'polite');
    expect(dropped).toHaveTextContent('Dropped 2 points: 1 for an implausible speed, 1 for an elevation spike.');

    const table = screen.getByTestId('cleanup-table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Figure', 'Raw', 'Cleaned']);
    const row = (name: string) => within(table).getByRole('row', { name: new RegExp(name) });
    for (const name of ['Distance', 'Moving time', 'Average speed', 'Maximum speed', 'Elevation gain']) expect(row(name)).toBeInTheDocument();
    // The spike's out-and-back is in the raw distance and not in the cleaned one.
    const cells = within(row('Distance')).getAllByRole('cell');
    expect(cells[0]!.textContent).not.toBe(cells[1]!.textContent);
    expect(cells[1]).toHaveTextContent('145 m');
  });

  it('changes the pause setting and the smoothing, each by its labelled control', async () => {
    const user = userEvent.setup();
    render(<CleanupPanel activity={ride()} units="metric" />);
    await user.click(screen.getByRole('switch', { name: 'Clean up the telemetry' }));

    const minStop = screen.getByLabelText('Shortest stop (s)');
    await user.clear(minStop);
    await user.type(minStop, '12');
    expect(useCleanupStore.getState().settings.pause.minStopSeconds).toBe(12);

    await user.selectOptions(screen.getByLabelText('Smoothing'), 'movingAverage');
    expect(useCleanupStore.getState().settings.smoothing.method).toBe('movingAverage');
    const window = screen.getByLabelText('Window (seconds, 0 to 30)');
    await user.clear(window);
    await user.type(window, '20');
    expect(useCleanupStore.getState().settings.smoothing.strength).toBe(20);
    expect(screen.getByTestId('cleanup-table').querySelector('caption')).toHaveTextContent('moving average over 20 s');

    await user.selectOptions(screen.getByLabelText('Smoothing'), 'kalman');
    expect(screen.getByLabelText('Strength (0 to 30)')).toBeInTheDocument();
  });

  it('says so when the outlier filter is off, and counts nothing dropped', async () => {
    const user = userEvent.setup();
    render(<CleanupPanel activity={ride()} units="metric" />);
    await user.click(screen.getByRole('switch', { name: 'Clean up the telemetry' }));
    await user.click(screen.getByRole('checkbox', { name: 'Drop impossible points' }));
    expect(screen.getByTestId('cleanup-dropped')).toHaveTextContent('The outlier filter is off: no points were dropped.');
  });

  it('keeps the raw activity: turning it off again empties the counts and the table', async () => {
    const user = userEvent.setup();
    const activity = ride();
    render(<CleanupPanel activity={activity} units="metric" />);
    const toggle = screen.getByRole('switch', { name: 'Clean up the telemetry' });
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByTestId('cleanup-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('cleanup-dropped')).toBeEmptyDOMElement();
    expect(activity.points).toHaveLength(30);
  });
});

describe('CleanupNote (AV-1024)', () => {
  it('says nothing for an activity that was not cleaned, and the count for one that was', () => {
    const raw = ride();
    const { rerender } = render(<CleanupNote activity={raw} />);
    expect(screen.queryByTestId('cleanup-note')).not.toBeInTheDocument();

    const cleaned = cleanActivity(raw, { ...DEFAULT_CLEANUP_SETTINGS, enabled: true }).activity;
    rerender(<CleanupNote activity={cleaned} />);
    expect(screen.getByTestId('cleanup-note')).toHaveTextContent('Telemetry clean-up is on: 2 points dropped.');

    rerender(<CleanupNote activity={cleaned} exporting />);
    expect(screen.getByTestId('cleanup-note')).toHaveTextContent('This export holds cleaned telemetry: 2 points dropped.');
  });
});
