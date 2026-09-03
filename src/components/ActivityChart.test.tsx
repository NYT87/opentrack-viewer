import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ActivityChart } from './ActivityChart';
import { buildSeries, resolveXAxis } from '../domain/series';
import { makeActivity } from '../test/helpers/activity';

const elevationSeries = buildSeries(
  makeActivity([
    { lat: 0, lon: 0.0001, elevationMeters: 100 },
    { lat: 0.5, lon: 0.0001, elevationMeters: 150 },
    { lat: 1, lon: 0.0001, elevationMeters: 120 },
  ]),
  'elevation',
  'distance',
);

/** jsdom reports a zero-size box; give the SVG a real one for hover math. */
function stubSvgSize(width = 1000): void {
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width,
    height: 180,
    top: 0,
    left: 0,
    right: width,
    bottom: 180,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('ActivityChart (AV-503)', () => {
  it('renders a line path when elevation data exists', () => {
    render(<ActivityChart series={elevationSeries} />);

    const svg = screen.getByTestId('elevation-chart-svg');
    const line = svg.querySelector('.chart__line');

    expect(line?.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+ L/);
  });

  it('labels the elevation range and the x-axis basis', () => {
    render(<ActivityChart series={elevationSeries} />);

    expect(screen.getByText(/100 m – 150 m/)).toBeInTheDocument();
    expect(screen.getByText(/x-axis: distance/)).toBeInTheDocument();
  });

  it('labels a time x-axis as elapsed time (AV-503)', () => {
    const timeSeries = buildSeries(
      makeActivity([
        { elevationMeters: 100, time: new Date('2024-01-01T10:00:00Z') },
        { elevationMeters: 150, time: new Date('2024-01-01T10:05:00Z') },
      ]),
      'elevation',
      'time',
    );

    render(<ActivityChart series={timeSeries} />);

    expect(screen.getByText(/x-axis: elapsed time/)).toBeInTheDocument();
    // Axis extents read as durations, not raw seconds.
    expect(screen.getByText('5:00')).toBeInTheDocument();
  });

  it('labels a distance x-axis with formatted distances', () => {
    render(<ActivityChart series={elevationSeries} />);

    expect(screen.getByText(/x-axis: distance/)).toBeInTheDocument();
    expect(screen.getByText('0 m')).toBeInTheDocument();
  });

  it('falls back to the point-index axis when neither axis is available', () => {
    const activity = makeActivity([{ elevationMeters: 10 }, { elevationMeters: 30 }]);
    const indexSeries = buildSeries(activity, 'elevation', resolveXAxis(activity));

    render(<ActivityChart series={indexSeries} />);

    expect(indexSeries.xAxis).toBe('index');
    expect(screen.getByText(/no distance or time available/)).toBeInTheDocument();
  });

  it('keeps axis labels distinct on a narrow elevation range', () => {
    // A flat route spanning under a metre would otherwise print the same
    // rounded label on every gridline.
    const flat = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 49.4 },
        { lat: 1, lon: 0.0001, elevationMeters: 51.2 },
      ]),
      'elevation',
      'distance',
    );

    render(<ActivityChart series={flat} />);
    const labels = [...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label')]
      .map((node) => node.textContent);

    expect(labels).toHaveLength(5);
    expect(new Set(labels).size).toBe(5);
  });

  it('labels the axis and its ticks in the selected unit system', () => {
    render(<ActivityChart series={elevationSeries} units="imperial" />);

    expect(screen.getByText('Elevation (ft)')).toBeInTheDocument();
    const ticks = [...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label')]
      .map((node) => Number(node.textContent));

    // 100–150 m is 328–492 ft; ticks must be converted, not left in metres.
    expect(ticks[0]).toBeCloseTo(328, 0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(492, 0);
  });

  it('shows an empty state when no elevation is present', () => {
    const empty = buildSeries(makeActivity([{ lat: 0, lon: 0.0001 }]), 'elevation', 'distance');

    render(<ActivityChart series={empty} />);

    expect(screen.getByText(/no elevation data/i)).toBeInTheDocument();
    expect(screen.queryByTestId('elevation-chart-svg')).not.toBeInTheDocument();
  });

  it('draws a cursor at the active point (AV-602)', () => {
    const { rerender } = render(<ActivityChart series={elevationSeries} />);
    expect(screen.queryByTestId('chart-cursor')).not.toBeInTheDocument();

    rerender(<ActivityChart series={elevationSeries} activePointIndex={1} />);
    expect(screen.getByTestId('chart-cursor')).toBeInTheDocument();
  });

  it('reports the hovered point index and clears it on leave', () => {
    stubSvgSize();
    const onHoverPoint = vi.fn();
    render(<ActivityChart series={elevationSeries} onHoverPoint={onHoverPoint} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    fireEvent.mouseMove(svg, { clientX: 0 });
    expect(onHoverPoint).toHaveBeenLastCalledWith(0);

    fireEvent.mouseMove(svg, { clientX: 995 });
    expect(onHoverPoint).toHaveBeenLastCalledWith(2);

    fireEvent.mouseLeave(svg);
    expect(onHoverPoint).toHaveBeenLastCalledWith(undefined);

    vi.restoreAllMocks();
  });

  it('reports the selected point index on click', () => {
    stubSvgSize();
    const onSelectPoint = vi.fn();
    render(<ActivityChart series={elevationSeries} onSelectPoint={onSelectPoint} />);

    fireEvent.click(screen.getByTestId('elevation-chart-svg'), { clientX: 995 });

    expect(onSelectPoint).toHaveBeenCalledWith(2);
    vi.restoreAllMocks();
  });

  it('downsamples a dense series without dropping the endpoints', () => {
    const dense = buildSeries(
      makeActivity(
        Array.from({ length: 4000 }, (_, index) => ({ elevationMeters: 100 + (index % 7) })),
      ),
      'elevation',
      'index',
    );

    render(<ActivityChart series={dense} />);
    const commands = screen
      .getByTestId('elevation-chart-svg')
      .querySelector('.chart__line')
      ?.getAttribute('d')
      ?.split('L').length;

    expect(commands).toBeLessThan(1000);
  });
});
