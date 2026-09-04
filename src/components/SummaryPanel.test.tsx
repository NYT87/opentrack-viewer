import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SummaryPanel } from './SummaryPanel';
import { makeActivity } from '../test/helpers/activity';
import type { ActivitySport } from '../domain/activity';

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

  it('shows average speed, and in the chosen units', () => {
    const activity = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      // ~111 km in one hour: 111 km/h, which is 69 mph.
      { lat: 1, lon: 0.0001, time: new Date('2024-01-01T11:00:00Z') },
    ]);

    const metric = render(<SummaryPanel activity={activity} />);
    expect(statValue('Avg speed')).toMatch(/^111\.\d km\/h$/);
    metric.unmount();

    render(<SummaryPanel activity={activity} units="imperial" />);
    expect(statValue('Avg speed')).toMatch(/^69\.\d mph$/);
  });

  describe('sport-aware primary metric', () => {
    /** A kilometre in five minutes: 5:00 /km, which is 12 km/h. */
    const oneKilometreInFiveMinutes = (sport?: ActivitySport) => {
      const activity = makeActivity([
        { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
        // 0.0089932 degrees of latitude is ~1000 m.
        { lat: 0.0089932, lon: 0.0001, time: new Date('2024-01-01T10:05:00Z') },
      ]);
      return { ...activity, metadata: { ...activity.metadata, sport } };
    };

    it('shows average pace for a run, never average speed', () => {
      render(<SummaryPanel activity={oneKilometreInFiveMinutes('running')} />);

      expect(statValue('Avg pace')).toMatch(/^5:0\d \/km$/);
      expect(screen.queryByText('Avg speed')).not.toBeInTheDocument();
    });

    it('shows average speed for a ride, never average pace', () => {
      render(<SummaryPanel activity={oneKilometreInFiveMinutes('cycling')} />);

      expect(statValue('Avg speed')).toMatch(/^12\.\d km\/h$/);
      expect(screen.queryByText('Avg pace')).not.toBeInTheDocument();
    });

    it('falls back to average speed when the file never said what the sport was', () => {
      render(<SummaryPanel activity={oneKilometreInFiveMinutes(undefined)} />);

      expect(statValue('Avg speed')).toMatch(/^12\.\d km\/h$/);
      expect(screen.queryByText('Avg pace')).not.toBeInTheDocument();
    });

    it('shows a run pace per mile in imperial', () => {
      render(<SummaryPanel activity={oneKilometreInFiveMinutes('running')} units="imperial" />);

      // 5:00 /km is a little over 8 minutes per mile.
      expect(statValue('Avg pace')).toMatch(/^8:0\d \/mi$/);
    });

    it('explains a run that covered no ground, rather than blaming missing data', () => {
      // Both streams are present and usable; the runner simply never moved.
      const onTheSpot = makeActivity([
        { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
        { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:10:00Z') },
      ]);
      render(
        <SummaryPanel
          activity={{ ...onTheSpot, metadata: { ...onTheSpot.metadata, sport: 'running' } }}
        />,
      );

      expect(statValue('Avg pace')).toContain('No distance covered');
      expect(statValue('Avg pace')).not.toContain('Needs distance and timestamps');
      // The data it does have is still reported.
      expect(statValue('Duration')).toBe('10:00');
    });

    it('shows a stationary ride zero speed, which is a real answer', () => {
      const onTheSpot = makeActivity([
        { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
        { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:10:00Z') },
      ]);
      render(
        <SummaryPanel
          activity={{ ...onTheSpot, metadata: { ...onTheSpot.metadata, sport: 'cycling' } }}
        />,
      );

      expect(statValue('Avg speed')).toBe('0.0 km/h');
    });

    it('explains a missing average pace rather than showing a bare dash', () => {
      const noTime = makeActivity([{ lat: 51.5, lon: -0.1 }, { lat: 51.6, lon: -0.2 }]);
      render(
        <SummaryPanel
          activity={{ ...noTime, metadata: { ...noTime.metadata, sport: 'running' } }}
        />,
      );

      expect(statValue('Avg pace')).toContain('Needs distance and timestamps');
    });
  });

  it('explains a missing average speed rather than showing a bare dash', () => {
    render(<SummaryPanel activity={makeActivity([{ lat: 51.5, lon: -0.1 }, { lat: 51.6, lon: -0.2 }])} />);

    expect(statValue('Avg speed')).toContain('Needs distance and timestamps');
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
