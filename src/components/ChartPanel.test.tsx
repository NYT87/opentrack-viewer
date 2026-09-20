import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChartPanel } from './ChartPanel';
import { makeActivity } from '../test/helpers/activity';
import { useInteractionStore } from '../state/interactionStore';

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

// The selection lives in the shared store now (AV-601), so it has to be reset
// or a focus from one test carries into the next.
beforeEach(() => {
  useInteractionStore.getState().reset();
});

const runWithCadence = makeActivity([
  { lat: 0, lon: 0.0001, elevationMeters: 100, runningCadenceSpm: 168, time: new Date('2024-01-01T10:00:00Z') },
  { lat: 0.00027, lon: 0.0001, elevationMeters: 105, runningCadenceSpm: 172, time: new Date('2024-01-01T10:00:10Z') },
  { lat: 0.00054, lon: 0.0001, elevationMeters: 110, runningCadenceSpm: 170, time: new Date('2024-01-01T10:00:20Z') },
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

  it('names the running cadence unit as strides per minute (AV-515)', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);

    const cadence = screen.getByRole('region', { name: 'Cadence chart' });
    expect(cadence).toHaveTextContent(/Cadence \(spm\)/);
    expect(cadence).toHaveTextContent(/strides per minute/i);
    expect(cadence).not.toHaveTextContent(/rpm/i);
  });

  it('explains why a run chart is unavailable instead of hiding it', () => {
    const ride = makeActivity(withBothAxes.points);
    ride.metadata.sport = 'cycling';
    render(<ChartPanel activity={ride} onXAxisChange={vi.fn()} />);

    // A file that said it was a ride is not asked again: pace and running
    // cadence do not apply to it, and it is told why rather than shown nothing.
    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent(
      /shown for running activities/i,
    );
    expect(screen.getByRole('region', { name: 'Cadence chart' })).toHaveTextContent(
      /shown for running activities/i,
    );
  });

  it('charts speed by default for a file that never said what it was (AV-908)', () => {
    // A kilometre in five minutes, and no sport: plausible enough to derive a
    // speed from, which `withBothAxes` at 55 km in ten minutes is not.
    const noSport = makeActivity([
      { lat: 0, lon: 0.0001, elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.0045, lon: 0.0001, elevationMeters: 12, time: new Date('2024-01-01T10:02:30Z') },
      { lat: 0.0089932, lon: 0.0001, elevationMeters: 14, time: new Date('2024-01-01T10:05:00Z') },
    ]);
    render(<ChartPanel activity={noSport} onXAxisChange={vi.fn()} />);

    // Asserted on what is drawn rather than on the unavailable chart's copy:
    // TD-028 says unavailable charts should not be rendered at all, and
    // AV-516 is the task that will stop rendering them.
    expect(screen.getByTestId('speed-chart-svg')).toBeInTheDocument();
    expect(screen.queryByTestId('pace-chart-svg')).not.toBeInTheDocument();
  });

  it('applies the x-axis to every chart in the panel', () => {
    render(<ChartPanel activity={runWithCadence} xAxisPreference="time" onXAxisChange={vi.fn()} />);

    for (const name of ['Elevation chart', 'Pace chart', 'Cadence chart']) {
      expect(screen.getByRole('region', { name })).toHaveTextContent(/x-axis: elapsed time/);
    }
  });
});

describe('ChartPanel range selection (AV-508)', () => {
  const drag = (svg: Element, from: number, to: number) => {
    fireEvent.pointerDown(svg, { clientX: from, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: to, pointerId: 1 });
  };

  it('focuses every chart in the panel on the selection (AV-511)', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);
    const charts = screen.getAllByTestId('elevation-chart-svg');
    const fullWidth = charts[0]!.getAttribute('width');

    drag(charts[0]!, 100, 400);

    // The charts now *are* the section, so the highlight band is redundant.
    expect(screen.queryByTestId('chart-selection')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset View' })).toBeInTheDocument();
    // Same canvas, fewer samples: every chart redrew.
    expect(screen.getAllByTestId('elevation-chart-svg')[0]!.getAttribute('width')).toBe(fullWidth);
  });

  it('keeps the focus across an x-axis switch (AV-509)', () => {
    const { rerender } = render(
      <ChartPanel activity={runWithCadence} xAxisPreference="distance" onXAxisChange={vi.fn()} />,
    );
    drag(screen.getAllByTestId('elevation-chart-svg')[0]!, 100, 400);
    expect(screen.getByRole('button', { name: 'Reset View' })).toBeInTheDocument();

    // Stored as point indices, so the focus survives and re-projects onto time.
    rerender(
      <ChartPanel activity={runWithCadence} xAxisPreference="time" onXAxisChange={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Reset View' })).toBeInTheDocument();
    expect(screen.getAllByText(/x-axis: elapsed time/).length).toBeGreaterThan(0);
  });

  it('restricts the charts to the selected section, keeping absolute axis values (AV-511)', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);
    const chart = () => screen.getAllByTestId('elevation-chart-svg')[0]!;
    const pointsIn = (svg: Element) =>
      (svg.querySelector('.chart__line')!.getAttribute('d') ?? '').split('L').length;

    const before = pointsIn(chart());

    drag(chart(), 200, 420);

    // Fewer plotted points: the chart is drawing the section, not the whole.
    expect(pointsIn(chart())).toBeLessThan(before);
    // The axis keeps absolute values, so the section does not restart at zero.
    const endpoints = [...chart().querySelectorAll('.is-endpoint')].map((n) => n.textContent);
    expect(endpoints.some((label) => label !== '0 m')).toBe(true);
  });

  it('recalculates chart availability for the focused section (AV-511)', () => {
    // Cadence only exists in the first half of this activity.
    const partial = makeActivity([
      { lat: 0, lon: 0.0001, elevationMeters: 100, runningCadenceSpm: 168, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.0004, lon: 0.0001, elevationMeters: 105, runningCadenceSpm: 170, time: new Date('2024-01-01T10:00:10Z') },
      { lat: 0.0008, lon: 0.0001, elevationMeters: 110, time: new Date('2024-01-01T10:00:20Z') },
      { lat: 0.0012, lon: 0.0001, elevationMeters: 115, time: new Date('2024-01-01T10:00:30Z') },
    ]);
    partial.metadata.sport = 'running';

    render(<ChartPanel activity={partial} onXAxisChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Cadence chart' })).toHaveTextContent(/168/);

    // Focus the cadence-free tail.
    drag(screen.getAllByTestId('elevation-chart-svg')[0]!, 500, 780);

    expect(screen.getByRole('region', { name: 'Cadence chart' })).toHaveTextContent(
      /no cadence data/i,
    );
  });

  it('says the file is unchanged, and Reset View restores the full activity (AV-511, AV-512)', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);
    const pointsIn = () =>
      (screen
        .getAllByTestId('elevation-chart-svg')[0]!
        .querySelector('.chart__line')!
        .getAttribute('d') ?? '').split('L').length;
    const before = pointsIn();

    // No Reset View until there is something to reset.
    expect(screen.queryByRole('button', { name: 'Reset View' })).not.toBeInTheDocument();

    drag(screen.getAllByTestId('elevation-chart-svg')[0]!, 200, 420);
    expect(screen.getByRole('status')).toHaveTextContent(/file is unchanged/i);

    fireEvent.click(screen.getByRole('button', { name: 'Reset View' }));

    expect(pointsIn()).toBe(before);
    expect(screen.queryByRole('button', { name: 'Reset View' })).not.toBeInTheDocument();
  });

  it('explains a selection too short to focus rather than blanking the charts', () => {
    render(<ChartPanel activity={withBothAxes} onXAxisChange={vi.fn()} />);

    // withBothAxes has two points; a narrow drag lands on just one of them.
    drag(screen.getAllByTestId('elevation-chart-svg')[0]!, 100, 130);

    expect(screen.getAllByTestId('elevation-chart-svg').length).toBeGreaterThan(0);
  });

  it('drops the focus when the shared selection is cleared', () => {
    // Loading a file resets the interaction store, which is what clears a
    // selection made against the previous activity.
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);
    drag(screen.getAllByTestId('elevation-chart-svg')[0]!, 100, 400);
    expect(screen.getByRole('button', { name: 'Reset View' })).toBeInTheDocument();

    act(() => useInteractionStore.getState().reset());

    expect(screen.queryByRole('button', { name: 'Reset View' })).not.toBeInTheDocument();
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

describe('sensor streams from a video (AV-905)', () => {
  const withSensors = () => {
    const activity = makeActivity([
      { lat: 0, lon: 0.0001, elevationMeters: 100, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.5, lon: 0.0001, elevationMeters: 150, time: new Date('2024-01-01T10:05:00Z') },
      { lat: 1, lon: 0.0001, elevationMeters: 120, time: new Date('2024-01-01T10:10:00Z') },
    ]);
    activity.sensorStreams = [
      {
        key: 'ACCL',
        label: 'Acceleration',
        unit: 'm/s²',
        display: 'chart',
        note: 'Total acceleration the camera felt, gravity included.',
        sampleRateHz: 200,
        sourceSampleCount: 600,
        valuesByPoint: [9.8, 11.2, 10.1],
      },
      {
        key: 'CORI',
        label: 'Camera orientation',
        display: 'hidden',
        sampleRateHz: 30,
        sourceSampleCount: 90,
      },
    ];
    return activity;
  };

  it('charts a stream the parser aligned to the points', () => {
    render(<ChartPanel activity={withSensors()} onXAxisChange={vi.fn()} />);

    const chart = screen.getByRole('region', { name: 'Acceleration chart' });
    expect(chart).toHaveTextContent(/Acceleration \(m\/s²\)/);
  });

  it('carries the caveat that makes the numbers readable', () => {
    render(<ChartPanel activity={withSensors()} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Acceleration chart' })).toHaveTextContent(
      /gravity included/i,
    );
  });

  it('does not chart a stream that is only declared', () => {
    render(<ChartPanel activity={withSensors()} onXAxisChange={vi.fn()} />);

    expect(
      screen.queryByRole('region', { name: 'Camera orientation chart' }),
    ).not.toBeInTheDocument();
  });

  it('drops a sensor chart the focused section has no samples for', async () => {
    const activity = withSensors();
    activity.sensorStreams![0]!.valuesByPoint = [9.8, undefined, undefined];
    render(<ChartPanel activity={activity} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Acceleration chart' })).toBeInTheDocument();

    // Focus on the two points the stream says nothing about. An empty chart
    // here would claim the section had acceleration data and none to show.
    act(() => {
      useInteractionStore.getState().setSelectedRange({ startIndex: 1, endIndex: 2 });
    });

    expect(
      screen.queryByRole('region', { name: 'Acceleration chart' }),
    ).not.toBeInTheDocument();
  });

  it('converts camera temperature to the chosen unit system', () => {
    const activity = withSensors();
    activity.sensorStreams = [
      {
        key: 'TMPC',
        label: 'Camera temperature',
        unit: '°C',
        display: 'chart',
        sourceSampleCount: 11,
        valuesByPoint: [50, 52, 51],
      },
    ];

    render(<ChartPanel activity={activity} units="imperial" onXAxisChange={vi.fn()} />);

    // A reader who chose imperial wants Fahrenheit from every temperature on
    // the page, not only from the one whose series key happens to say so.
    expect(screen.getByRole('region', { name: 'Camera temperature chart' })).toHaveTextContent(
      /Camera temperature \(°F\)/,
    );
  });

  it('adds nothing for an activity that carries no sensor streams', () => {
    render(<ChartPanel activity={withBothAxes} onXAxisChange={vi.fn()} />);

    expect(screen.queryByRole('region', { name: 'Acceleration chart' })).not.toBeInTheDocument();
  });
});

describe('choosing speed or pace (AV-908)', () => {
  const ambiguous = () => {
    const activity = makeActivity([
      { lat: 0, lon: 0.0001, elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.0045, lon: 0.0001, elevationMeters: 12, time: new Date('2024-01-01T10:02:30Z') },
      { lat: 0.0089932, lon: 0.0001, elevationMeters: 14, time: new Date('2024-01-01T10:05:00Z') },
    ]);
    activity.metadata.sport = 'unknown';
    return activity;
  };

  // `reset()` deliberately keeps session preferences, the way it keeps the
  // x-axis — so a choice made in one test would otherwise carry into the next.
  beforeEach(() => {
    useInteractionStore.setState({ performanceMetric: undefined });
  });

  const metricButton = (name: 'Speed' | 'Pace') =>
    within(screen.getByRole('group', { name: 'Performance metric' })).getByRole('button', { name });

  it('offers the switch for a file that never said what it was', () => {
    render(<ChartPanel activity={ambiguous()} onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'Performance metric' })).toBeInTheDocument();
    expect(metricButton('Speed')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not offer it for a run, whose file already answered', () => {
    render(<ChartPanel activity={runWithCadence} onXAxisChange={vi.fn()} />);

    expect(screen.queryByRole('group', { name: 'Performance metric' })).not.toBeInTheDocument();
  });

  it('swaps which chart is drawn when the reader switches', async () => {
    render(<ChartPanel activity={ambiguous()} onXAxisChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Speed chart' })).toBeInTheDocument();

    await userEvent.click(metricButton('Pace'));

    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent(/Pace \(\/km\)/);
    // And the one it replaced is no longer drawn. Whether it leaves a
    // placeholder behind is TD-028's question, and AV-516's to answer.
    expect(screen.queryByTestId('speed-chart-svg')).not.toBeInTheDocument();
  });

  it('keeps the focused section reading the way the switch says', async () => {
    /*
     * A camera records its own speed, so speed is chartable from the points
     * alone. Pace is not: the last two points share a timestamp, so a
     * selection covering them spans no time. Resolved against the slice, the
     * question "pace or speed" gets a different answer from the one the switch
     * is showing.
     */
    const sameInstant = new Date('2024-01-01T10:05:00Z');
    const activity = makeActivity([
      { lat: 0, lon: 0.0001, speedMetersPerSecond: 3, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.0045, lon: 0.0001, speedMetersPerSecond: 4, time: sameInstant },
      { lat: 0.0089932, lon: 0.0001, speedMetersPerSecond: 5, time: sameInstant },
    ]);
    activity.metadata.sport = 'unknown';

    render(<ChartPanel activity={activity} onXAxisChange={vi.fn()} />);
    await userEvent.click(metricButton('Pace'));

    act(() => {
      useInteractionStore.getState().setSelectedRange({ startIndex: 1, endIndex: 2 });
    });

    expect(metricButton('Pace')).toHaveAttribute('aria-pressed', 'true');
    // A drawn chart has an svg; an unavailable one does not. The bug drew
    // speed here, under a switch still pressed on pace.
    expect(screen.queryByTestId('speed-chart-svg')).not.toBeInTheDocument();
  });

  it('formats the chosen metric in the active unit system', async () => {
    render(<ChartPanel activity={ambiguous()} units="imperial" onXAxisChange={vi.fn()} />);

    expect(screen.getByRole('region', { name: 'Speed chart' })).toHaveTextContent(/Speed \(mph\)/);

    await userEvent.click(metricButton('Pace'));

    expect(screen.getByRole('region', { name: 'Pace chart' })).toHaveTextContent(/Pace \(\/mi\)/);
  });
});
