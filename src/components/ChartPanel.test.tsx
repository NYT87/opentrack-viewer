import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartPanel } from './ChartPanel';
import { makeActivity } from '../test/helpers/activity';

const withBothAxes = makeActivity([
  { lat: 0, lon: 0.0001, elevationMeters: 100, time: new Date('2024-01-01T10:00:00Z') },
  { lat: 0.5, lon: 0.0001, elevationMeters: 150, time: new Date('2024-01-01T10:05:00Z') },
  { lat: 1, lon: 0.0001, elevationMeters: 120, time: new Date('2024-01-01T10:10:00Z') },
]);

const timeOnly = makeActivity([
  { elevationMeters: 100, time: new Date('2024-01-01T10:00:00Z') },
  { elevationMeters: 150, time: new Date('2024-01-01T10:05:00Z') },
]);

const axisButton = (name: 'Distance' | 'Time') => screen.getByRole('button', { name });

const runWithCadence = makeActivity([
  { lat: 0, lon: 0.0001, elevationMeters: 100, cadenceRpm: 168, time: new Date('2024-01-01T10:00:00Z') },
  { lat: 0.00027, lon: 0.0001, elevationMeters: 105, cadenceRpm: 172, time: new Date('2024-01-01T10:00:10Z') },
  { lat: 0.00054, lon: 0.0001, elevationMeters: 110, cadenceRpm: 170, time: new Date('2024-01-01T10:00:20Z') },
]);
runWithCadence.metadata.sport = 'running';

describe('ChartPanel chart selection (AV-505, AV-506, AV-507)', () => {
  it('renders elevation, pace and cadence for a run that has them all', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Elevation chart' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Pace chart' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cadence chart' })).toBeInTheDocument();
  });

  it('formats pace as minutes per unit distance', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent(/Pace \(\/km\)/);
  });

  it('switches pace units with the unit system', () => {
    render(<ChartPanel activity={runWithCadence} units="imperial" onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent(/Pace \(\/mi\)/);
  });

  it('spells out the cadence unit caveat rather than guessing (AV-506)', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Cadence chart' })).toHaveTextContent(
      /strides per minute/i,
    );
  });

  it('explains why a run chart is unavailable instead of hiding it', () => {
    render(<ChartPanel activity={withBothAxes} onXAxisChange={vi.fn()} />);

    // withBothAxes has no sport, so the run charts do not apply.
    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent(
      /shown for running activities/i,
    );
    expect(screen.getByRole('region', { name: 'Cadence chart' })).toHaveTextContent(
      /shown for running activities/i,
    );
  });

  it('applies the x-axis to every chart in the panel', () => {
    render(<ChartPanel activity={runWithCadence} xAxisPreference="time" onXAxisChange={vi.fn()} />);

    for (const name of ['Elevation chart', 'Pace chart', 'Cadence chart']) {
      expect(screen.getByRole('region', { name })).toHaveTextContent(/x-axis: elapsed time/);
    }
  });
});

describe('ChartPanel x-axis switch (AV-504)', () => {
  it('exposes a distance and a time option', () => {
    render(<ChartPanel activity={withBothAxes} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'Chart x-axis' })).toBeInTheDocument();
    expect(axisButton('Distance')).toBeEnabled();
    expect(axisButton('Time')).toBeEnabled();
  });

  it('defaults to distance when distance is available', () => {
    render(<ChartPanel activity={withBothAxes} onXAxisChange={vi.fn()} />);

    expect(axisButton('Distance')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/x-axis: distance/)).toBeInTheDocument();
  });

  it('applies the selected mode to the chart', () => {
    render(<ChartPanel activity={withBothAxes} xAxisPreference="time" onXAxisChange={vi.fn()} />);

    expect(axisButton('Time')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/x-axis: elapsed time/)).toBeInTheDocument();
  });

  it('reports the chosen mode to the caller', async () => {
    const onXAxisChange = vi.fn();
    render(<ChartPanel activity={withBothAxes} onXAxisChange={onXAxisChange} />);

    await userEvent.click(axisButton('Time'));

    expect(onXAxisChange).toHaveBeenCalledWith('time');
  });

  it('disables an unavailable mode and explains why', () => {
    render(<ChartPanel activity={timeOnly} onXAxisChange={vi.fn()} />);

    const distance = axisButton('Distance');
    expect(distance).toBeDisabled();
    expect(distance).toHaveAttribute('title', expect.stringMatching(/no distance or GPS/i));
    // ...and the chart falls back to the axis that does work.
    expect(screen.getByText(/x-axis: elapsed time/)).toBeInTheDocument();
  });

  it('explains a fallback when the preferred mode is unavailable', () => {
    render(<ChartPanel activity={timeOnly} xAxisPreference="distance" onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent(/no distance or GPS/i);
    expect(axisButton('Time')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no fallback notice when the preference is honoured', () => {
    render(<ChartPanel activity={withBothAxes} xAxisPreference="time" onXAxisChange={vi.fn()} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('rebuilds the series from the normalized activity, never the source file', () => {
    // AV-504: switching axes must not re-parse. The panel is a pure function of
    // the already-normalized activity, so rendering either mode touches no
    // parser and no file.
    const { rerender } = render(
      <ChartPanel activity={withBothAxes} xAxisPreference="distance" onXAxisChange={vi.fn()} />,
    );
    expect(screen.getByText(/x-axis: distance/)).toBeInTheDocument();

    rerender(<ChartPanel activity={withBothAxes} xAxisPreference="time" onXAxisChange={vi.fn()} />);

    expect(screen.getByText(/x-axis: elapsed time/)).toBeInTheDocument();
    expect(withBothAxes.source.fileName).toBeUndefined();
  });
});
