import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartPanel } from './ChartPanel';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';
import { makeActivity } from '../test/helpers/activity';
import { useInteractionStore } from '../state/interactionStore';
import { sliceActivity } from '../domain/activitySlice';
import { SelectionSummary } from './SelectionSummary';

const activity = parseGpx(readFixture('route-with-elevation.gpx'), {
  fileName: 'route-with-elevation.gpx',
});

beforeEach(() => {
  useInteractionStore.getState().reset();
});

const selectionOf = (from = activity, startIndex = 0, endIndex = 2) => {
  const sliced = sliceActivity(from, { startIndex, endIndex });
  if (!sliced.ok) throw sliced.error;
  return sliced.activity;
};

const panel = () => screen.getByRole('region', { name: 'Selected section summary' });

describe('SelectionSummary (AV-605)', () => {
  it('says plainly that it describes a section, and how much of one', () => {
    render(<SelectionSummary selection={selectionOf()} totalPoints={activity.points.length} />);

    expect(within(panel()).getByText('Selected section')).toBeInTheDocument();
    expect(within(panel()).getByText(`3 of ${activity.points.length} points`)).toBeInTheDocument();
  });

  it('reports distance, duration, elevation gain and the section’s bounds', () => {
    render(<SelectionSummary selection={selectionOf()} totalPoints={activity.points.length} />);

    for (const label of ['Distance', 'Duration', 'Elevation gain', 'Start', 'End']) {
      expect(within(panel()).getByText(label)).toBeInTheDocument();
    }
  });

  it('describes the section, not the whole activity', () => {
    const whole = activity.derived!;
    render(<SelectionSummary selection={selectionOf()} totalPoints={activity.points.length} />);

    const value = (label: string) =>
      within(panel()).getByText(label).parentElement?.querySelector('dd')?.textContent ?? '';

    // Three of four points, a minute apart: two minutes rather than the file's
    // three, and a shorter distance.
    const section = selectionOf().derived!;
    expect(section.distanceMeters!).toBeLessThan(whole.distanceMeters!);
    expect(value('Duration')).toBe('2:00');
    expect(whole.durationSeconds).toBe(180);
  });

  it('leaves file-level figures out: they describe the file, not the section', () => {
    render(<SelectionSummary selection={selectionOf()} totalPoints={activity.points.length} />);

    expect(within(panel()).queryByText('Points')).not.toBeInTheDocument();
  });

  it('explains a missing value the same way the activity summary does', () => {
    const noElevation = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 51.501, lon: -0.1, time: new Date('2024-01-01T10:00:10Z') },
      { lat: 51.502, lon: -0.1, time: new Date('2024-01-01T10:00:20Z') },
    ]);

    render(
      <SelectionSummary selection={selectionOf(noElevation)} totalPoints={3} />,
    );

    const gain = within(panel()).getByText('Elevation gain').parentElement?.querySelector('dd');
    expect(gain).toHaveTextContent('No elevation data');
  });

  it('follows the sport for its primary metric, as the summary does', () => {
    const ride = { ...activity, metadata: { ...activity.metadata, sport: 'cycling' as const } };
    const { rerender } = render(
      <SelectionSummary selection={selectionOf(ride)} totalPoints={4} />,
    );
    expect(within(panel()).getByText('Avg speed')).toBeInTheDocument();

    const run = { ...activity, metadata: { ...activity.metadata, sport: 'running' as const } };
    rerender(<SelectionSummary selection={selectionOf(run)} totalPoints={4} />);
    expect(within(panel()).getByText('Avg pace')).toBeInTheDocument();
  });

  it('uses the chosen unit system', () => {
    render(
      <SelectionSummary selection={selectionOf()} totalPoints={4} units="imperial" />,
    );

    const distance =
      within(panel()).getByText('Distance').parentElement?.querySelector('dd')?.textContent ?? '';
    expect(distance).toMatch(/mi$/);
  });
});

describe('the panel appears only for a selection (AV-605)', () => {
  const renderPanel = () => render(<ChartPanel activity={activity} onXAxisChange={vi.fn()} />);

  it('is absent until a section is selected', () => {
    renderPanel();

    expect(screen.queryByRole('region', { name: 'Selected section summary' })).not.toBeInTheDocument();
  });

  it('appears when a section is selected, beside the way back out', () => {
    useInteractionStore.getState().setSelectedRange({ startIndex: 0, endIndex: 2 });
    renderPanel();

    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset View' })).toBeInTheDocument();
  });

  it('Reset View takes the section figures away again', async () => {
    useInteractionStore.getState().setSelectedRange({ startIndex: 0, endIndex: 2 });
    renderPanel();
    expect(panel()).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Reset View' }));

    expect(screen.queryByRole('region', { name: 'Selected section summary' })).not.toBeInTheDocument();
  });
});
