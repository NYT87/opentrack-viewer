import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SummaryPanel } from './SummaryPanel';
import { makeActivity } from '../test/helpers/activity';

const statValue = (label: string): string => {
  const term = screen.getByText(label);
  const definition = term.parentElement?.querySelector('dd');
  return definition?.textContent ?? '';
};

describe('SummaryPanel (AV-404)', () => {
  it('shows distance, duration, elevation and time bounds', () => {
    render(
      <SummaryPanel
        activity={makeActivity([
          { lat: 0, lon: 0.0001, elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
          { lat: 1, lon: 0.0001, elevationMeters: 60, time: new Date('2024-01-01T11:00:00Z') },
        ])}
      />,
    );

    expect(statValue('Distance')).toMatch(/km$/);
    expect(statValue('Duration')).toBe('1:00:00');
    expect(statValue('Elevation gain')).toBe('50 m');
    expect(statValue('Points')).toBe('2');
  });

  it('explains missing values instead of showing a bare dash', () => {
    render(<SummaryPanel activity={makeActivity([{ lat: 51.5, lon: -0.1 }, { lat: 51.6, lon: -0.2 }])} />);

    expect(statValue('Duration')).toContain('No timestamps');
    expect(statValue('Elevation gain')).toContain('No elevation data');
  });

  it('marks distance as unavailable without GPS', () => {
    render(
      <SummaryPanel
        activity={makeActivity([
          { heartRateBpm: 100, time: new Date('2024-01-01T10:00:00Z') },
          { heartRateBpm: 150, time: new Date('2024-01-01T10:30:00Z') },
        ])}
      />,
    );

    expect(statValue('Distance')).toContain('No GPS data');
  });

  it('shows sensor summaries only when the stream exists', () => {
    const withHeartRate = makeActivity([
      { lat: 0, lon: 0.0001, heartRateBpm: 100 },
      { lat: 1, lon: 0.0001, heartRateBpm: 140 },
    ]);
    const { rerender } = render(<SummaryPanel activity={withHeartRate} />);
    expect(statValue('Avg heart rate')).toBe('120 bpm');

    rerender(<SummaryPanel activity={makeActivity([{ lat: 0, lon: 0.0001 }, { lat: 1, lon: 0.0001 }])} />);
    expect(screen.queryByText('Avg heart rate')).not.toBeInTheDocument();
  });

  it('uses imperial units when requested', () => {
    render(
      <SummaryPanel
        units="imperial"
        activity={makeActivity([
          { lat: 0, lon: 0.0001, elevationMeters: 0 },
          { lat: 1, lon: 0.0001, elevationMeters: 304.8 },
        ])}
      />,
    );

    expect(statValue('Distance')).toMatch(/mi$/);
    expect(statValue('Elevation gain')).toBe('1000 ft');
  });

  it('does not expose parser internals', () => {
    const activity = makeActivity([{ lat: 0, lon: 0.0001 }, { lat: 1, lon: 0.0001 }]);
    const { container } = render(<SummaryPanel activity={activity} />);

    expect(within(container).queryByText(/parserVersion/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('test-activity');
  });
});
