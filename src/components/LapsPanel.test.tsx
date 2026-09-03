import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LapsPanel, hasUsefulLaps } from './LapsPanel';
import type { ActivityLap } from '../domain/activity';

const laps: ActivityLap[] = [
  {
    index: 0,
    distanceMeters: 1000,
    durationSeconds: 300,
    startTime: new Date('2024-01-01T10:00:00Z'),
  },
  // No explicit duration: it has to come from the lap's own bounds.
  {
    index: 1,
    distanceMeters: 1000,
    startTime: new Date('2024-01-01T10:05:00Z'),
    endTime: new Date('2024-01-01T10:10:30Z'),
  },
  // Nothing but a position: every column must degrade, not guess.
  { index: 2 },
];

const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('hasUsefulLaps (AV-406)', () => {
  it('rejects absent or contentless laps', () => {
    expect(hasUsefulLaps(undefined)).toBe(false);
    expect(hasUsefulLaps([])).toBe(false);
    expect(hasUsefulLaps([{ index: 0 }, { index: 1 }])).toBe(false);
  });

  it('accepts laps carrying distance, duration or a start time', () => {
    expect(hasUsefulLaps([{ index: 0, distanceMeters: 500 }])).toBe(true);
    expect(hasUsefulLaps([{ index: 0, durationSeconds: 60 }])).toBe(true);
    expect(hasUsefulLaps([{ index: 0, startTime: new Date() }])).toBe(true);
  });
});

describe('LapsPanel (AV-406)', () => {
  it('lists one row per lap, numbered from one', () => {
    render(<LapsPanel laps={laps} />);

    expect(rows()).toHaveLength(3);
    expect(within(rows()[0]!).getByRole('rowheader')).toHaveTextContent('1');
    expect(within(rows()[2]!).getByRole('rowheader')).toHaveTextContent('3');
  });

  it('shows distance and duration for a complete lap', () => {
    render(<LapsPanel laps={laps} />);

    expect(rows()[0]).toHaveTextContent('1.00 km');
    expect(rows()[0]).toHaveTextContent('5:00');
  });

  it('derives duration from the lap bounds when it is not given', () => {
    render(<LapsPanel laps={laps} />);

    expect(rows()[1]).toHaveTextContent('5:30');
  });

  it('marks missing values rather than inventing them', () => {
    render(<LapsPanel laps={laps} />);

    // A lap with neither distance nor timing shows the missing marker twice.
    expect(within(rows()[2]!).getAllByText('—')).toHaveLength(2);
  });

  it('follows the unit system', () => {
    render(<LapsPanel laps={laps} units="imperial" />);

    expect(rows()[0]).toHaveTextContent('0.62 mi');
  });

  it('tags rows so lap highlighting can hook in later', () => {
    render(<LapsPanel laps={laps} />);

    expect(rows()[1]).toHaveAttribute('data-lap-index', '1');
  });
});
