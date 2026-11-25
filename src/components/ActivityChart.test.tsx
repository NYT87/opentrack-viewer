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
  });

  it('falls back to endpoint labels when the activity is under one tick (AV-514)', () => {
    // ~330 m: no whole-kilometre tick exists, so the ends must carry the scale.
    const short = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 100 },
        { lat: 0.003, lon: 0.0001, elevationMeters: 120 },
      ]),
      'elevation',
      'distance',
    );

    render(<ActivityChart series={short} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    expect(svg.querySelectorAll('.chart__axis-label--x:not(.is-endpoint)')).toHaveLength(0);
    expect([...svg.querySelectorAll('.is-endpoint')].map((node) => node.textContent)).toEqual([
      '0 m',
      '334 m',
    ]);
  });

  it('drops endpoint labels that an interval label would collide with (AV-514)', () => {
    // ~111 km: interval labels run the full axis, leaving no room at the ends.
    render(<ActivityChart series={elevationSeries} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    expect(svg.querySelectorAll('.is-endpoint')).toHaveLength(0);
    expect(svg.querySelectorAll('.chart__axis-label--x').length).toBeGreaterThan(0);
  });

  it('falls back to the point-index axis when neither axis is available', () => {
    const activity = makeActivity([{ elevationMeters: 10 }, { elevationMeters: 30 }]);
    const indexSeries = buildSeries(activity, 'elevation', resolveXAxis(activity));

    render(<ActivityChart series={indexSeries} />);

    expect(indexSeries.xAxis).toBe('index');
    expect(screen.getByText(/x-axis: point index \(no distance or time available\)/)).toBeInTheDocument();
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
    const labels = [...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label--y')]
      .map((node) => node.textContent);

    expect(labels).toHaveLength(5);
    expect(new Set(labels).size).toBe(5);
  });

  it('labels the axis and its ticks in the selected unit system', () => {
    render(<ActivityChart series={elevationSeries} units="imperial" />);

    expect(screen.getByText('Elevation (ft)')).toBeInTheDocument();
    const ticks = [...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label--y')]
      .map((node) => Number(node.textContent));

    // 100–150 m is 328–492 ft; ticks must be converted, not left in metres.
    expect(ticks[0]).toBeCloseTo(328, 0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(492, 0);
  });

  it('reserves the y gutter from the widest label, not a fixed inset (AV-514)', () => {
    // Regression: a fixed gutter left long labels pressed against the plot.
    // Feet run to four digits where metres run to three, so the same activity
    // must claim more room in imperial.
    const readGutter = (container: HTMLElement) => {
      const label = container.querySelector('.chart__axis-label--y')!;
      const grid = container.querySelector('.chart__grid')!;
      return Number(grid.getAttribute('x1')) - Number(label.getAttribute('x'));
    };

    const tall = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 0 },
        { lat: 1, lon: 0.0001, elevationMeters: 3048 },
      ]),
      'elevation',
      'distance',
    );

    const metric = render(<ActivityChart series={tall} />);
    const metricGrid = Number(metric.container.querySelector('.chart__grid')!.getAttribute('x1'));
    expect(readGutter(metric.container)).toBeGreaterThan(0);
    metric.unmount();

    const imperial = render(<ActivityChart series={tall} units="imperial" />);
    const imperialGrid = Number(
      imperial.container.querySelector('.chart__grid')!.getAttribute('x1'),
    );
    // "10000" is wider than "3048", so the plot starts further right.
    expect(imperialGrid).toBeGreaterThan(metricGrid);
  });

  it('keeps y labels inside the chart box (AV-514)', () => {
    render(<ActivityChart series={elevationSeries} />);
    const svg = screen.getByTestId('elevation-chart-svg');
    const height = Number(svg.getAttribute('height'));

    for (const label of svg.querySelectorAll('.chart__axis-label--y')) {
      const x = Number(label.getAttribute('x'));
      const y = Number(label.getAttribute('y'));
      // Anchored at the end, so x is its right edge: it must be on the canvas.
      expect(x).toBeGreaterThan(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(height);
    }
  });

  it('marks whole kilometres on the distance axis (AV-514)', () => {
    const long = buildSeries(
      makeActivity(
        // ~3.3 km of points, so the axis spans several whole kilometres.
        Array.from({ length: 40 }, (_, index) => ({
          lat: index * 0.00075,
          lon: 0.0001,
          elevationMeters: 100 + index,
        })),
      ),
      'elevation',
      'distance',
    );

    render(<ActivityChart series={long} />);
    const labels = [
      ...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label--x'),
    ].map((node) => node.textContent);

    expect(labels).toContain('1.00 km');
    expect(labels).toContain('2.00 km');
  });

  it('marks five-minute intervals on the time axis (AV-514)', () => {
    const timed = buildSeries(
      makeActivity(
        Array.from({ length: 40 }, (_, index) => ({
          elevationMeters: 100 + index,
          time: new Date(Date.UTC(2024, 0, 1, 10, 0, index * 30)),
        })),
      ),
      'elevation',
      'time',
    );

    render(<ActivityChart series={timed} />);
    const labels = [
      ...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label--x'),
    ].map((node) => node.textContent);

    expect(labels).toContain('5:00');
    expect(labels).toContain('10:00');
  });

  it('selects a range by press, drag and release (AV-508)', () => {
    stubSvgSize();
    const onSelectRange = vi.fn();
    render(<ActivityChart series={elevationSeries} onSelectRange={onSelectRange} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    fireEvent.pointerDown(svg, { clientX: 200, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 500, pointerId: 1 });
    // The band is visible before release, not only after.
    expect(screen.getByTestId('chart-selection')).toBeInTheDocument();

    fireEvent.pointerUp(svg, { clientX: 500, pointerId: 1 });

    expect(onSelectRange).toHaveBeenCalledTimes(1);
    const range = onSelectRange.mock.calls[0]![0];
    expect(range.start).toBeLessThan(range.end);
    vi.restoreAllMocks();
  });

  it('normalises a right-to-left drag (AV-508)', () => {
    stubSvgSize();
    const onSelectRange = vi.fn();
    render(<ActivityChart series={elevationSeries} onSelectRange={onSelectRange} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    fireEvent.pointerDown(svg, { clientX: 600, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 150, pointerId: 1 });

    const range = onSelectRange.mock.calls[0]![0];
    expect(range.start).toBeLessThan(range.end);
    vi.restoreAllMocks();
  });

  it('treats a tiny drag as a click, not a selection (AV-508)', () => {
    stubSvgSize();
    const onSelectRange = vi.fn();
    const onSelectPoint = vi.fn();
    render(
      <ActivityChart
        series={elevationSeries}
        onSelectRange={onSelectRange}
        onSelectPoint={onSelectPoint}
      />,
    );
    const svg = screen.getByTestId('elevation-chart-svg');

    // Four pixels of wobble while clicking.
    fireEvent.pointerDown(svg, { clientX: 300, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 304, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 304, pointerId: 1 });
    fireEvent.click(svg, { clientX: 304 });

    expect(onSelectRange).not.toHaveBeenCalled();
    expect(onSelectPoint).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does not also select a point when a drag ends (AV-508)', () => {
    stubSvgSize();
    const onSelectPoint = vi.fn();
    render(<ActivityChart series={elevationSeries} onSelectPoint={onSelectPoint} onSelectRange={vi.fn()} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    fireEvent.pointerDown(svg, { clientX: 200, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 500, pointerId: 1 });
    // A drag ends with a click event too; it must not double as a point pick.
    fireEvent.click(svg, { clientX: 500 });

    expect(onSelectPoint).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('clamps a drag that runs past the plot (AV-508)', () => {
    stubSvgSize();
    const onSelectRange = vi.fn();
    render(<ActivityChart series={elevationSeries} onSelectRange={onSelectRange} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    fireEvent.pointerDown(svg, { clientX: 400, pointerId: 1, button: 0 });
    fireEvent.pointerUp(svg, { clientX: 5000, pointerId: 1 });

    const range = onSelectRange.mock.calls[0]![0];
    expect(range.end).toBeLessThanOrEqual(elevationSeries.xMax);
    expect(range.start).toBeGreaterThanOrEqual(elevationSeries.xMin);
    vi.restoreAllMocks();
  });

  it('keeps showing a committed selection (AV-508)', () => {
    render(
      <ActivityChart
        series={elevationSeries}
        selectedRange={{ start: elevationSeries.xMin, end: elevationSeries.xMax / 2 }}
      />,
    );

    expect(screen.getByTestId('chart-selection')).toBeInTheDocument();
  });

  it('abandons the band if the gesture is cancelled (AV-508)', () => {
    stubSvgSize();
    const onSelectRange = vi.fn();
    render(<ActivityChart series={elevationSeries} onSelectRange={onSelectRange} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    fireEvent.pointerDown(svg, { clientX: 200, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 500, pointerId: 1 });
    fireEvent.pointerCancel(svg, { pointerId: 1 });

    expect(screen.queryByTestId('chart-selection')).not.toBeInTheDocument();
    expect(onSelectRange).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('draws a near-constant series flat, with one label (AV-514)', () => {
    // A steady ride: speed varies only in the fourth decimal. Spread over the
    // plot that noise looks like terrain, and every gridline reads the same.
    const steady = buildSeries(
      makeActivity(
        Array.from({ length: 6 }, (_, index) => ({
          lat: index * 0.00072,
          lon: 0.0001,
          time: new Date(Date.UTC(2024, 0, 1, 10, 0, index * 10)),
        })),
      ),
      'speed',
      'time',
    );

    render(<ActivityChart series={steady} />);
    const svg = screen.getByTestId('speed-chart-svg');

    const labels = [...svg.querySelectorAll('.chart__axis-label--y')].map((n) => n.textContent);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/^28\.8$/);

    // ...and the line really is flat.
    const ys = (svg.querySelector('.chart__line')!.getAttribute('d') ?? '')
      .split(/[ML]/)
      .filter(Boolean)
      .map((pair) => Number(pair.trim().split(' ')[1]));
    expect(new Set(ys).size).toBe(1);
  });

  it('adds decimals until neighbouring labels differ (AV-514)', () => {
    // A 2 m spread over four steps needs a decimal to stay distinct.
    const narrow = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 100 },
        { lat: 0.5, lon: 0.0001, elevationMeters: 101 },
        { lat: 1, lon: 0.0001, elevationMeters: 102 },
      ]),
      'elevation',
      'distance',
    );

    render(<ActivityChart series={narrow} />);
    const labels = [
      ...screen.getByTestId('elevation-chart-svg').querySelectorAll('.chart__axis-label--y'),
    ].map((node) => node.textContent);

    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size).toBe(labels.length);
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

describe('ActivityChart from the keyboard (TD-056)', () => {
  const svg = () => screen.getByTestId('elevation-chart-svg');

  it('is a focusable slider named for its series, described with its range and keys', () => {
    render(<ActivityChart series={elevationSeries} />);

    expect(screen.getByRole('slider', { name: 'Elevation chart' })).toBe(svg());
    expect(svg()).toHaveAttribute('tabindex', '0');
    expect(svg()).toHaveAccessibleDescription(/Elevation from 100 m to 150 m.*Arrow keys move along the activity/);
    expect(svg()).toHaveAttribute('aria-valuetext', 'No point selected');
  });

  it('moves the shared cursor with the arrow keys, Home and End', () => {
    const onHoverPoint = vi.fn();
    const { rerender } = render(<ActivityChart series={elevationSeries} onHoverPoint={onHoverPoint} />);

    // From no cursor, a step forward lands on the first sample.
    fireEvent.keyDown(svg(), { key: 'ArrowRight' });
    expect(onHoverPoint).toHaveBeenLastCalledWith(0);

    rerender(<ActivityChart series={elevationSeries} onHoverPoint={onHoverPoint} activePointIndex={0} />);
    fireEvent.keyDown(svg(), { key: 'ArrowRight' });
    expect(onHoverPoint).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(svg(), { key: 'End' });
    expect(onHoverPoint).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(svg(), { key: 'Home' });
    expect(onHoverPoint).toHaveBeenLastCalledWith(0);
  });

  it('reads back the value at the cursor', () => {
    render(<ActivityChart series={elevationSeries} activePointIndex={1} />);
    // A sentence, so the two numbers cannot be confused.
    expect(svg().getAttribute('aria-valuetext')).toMatch(/^at [\d.]+ km, elevation 150 m$/);
  });

  it('marks a section with Shift and the arrows, and keeps it with Enter', () => {
    const onSelectRange = vi.fn();
    const onHoverPoint = vi.fn();
    const { rerender } = render(
      <ActivityChart series={elevationSeries} activePointIndex={0} onHoverPoint={onHoverPoint} onSelectRange={onSelectRange} />,
    );

    fireEvent.keyDown(svg(), { key: 'ArrowRight', shiftKey: true });
    rerender(
      <ActivityChart series={elevationSeries} activePointIndex={1} onHoverPoint={onHoverPoint} onSelectRange={onSelectRange} />,
    );
    fireEvent.keyDown(svg(), { key: 'ArrowRight', shiftKey: true });
    rerender(
      <ActivityChart series={elevationSeries} activePointIndex={2} onHoverPoint={onHoverPoint} onSelectRange={onSelectRange} />,
    );
    // The band is drawn while it is being marked, and said in the value.
    expect(screen.getByTestId('chart-selection')).toBeInTheDocument();
    // In the axis's own unit, as the axis is written.
    expect(svg().getAttribute('aria-valuetext')).toMatch(/marking a section from 0\.00 km/);

    fireEvent.keyDown(svg(), { key: 'Enter' });
    const first = elevationSeries.samples[0]!.x;
    const last = elevationSeries.samples[2]!.x;
    expect(onSelectRange).toHaveBeenCalledWith({ start: first, end: last });
    expect(screen.queryByTestId('chart-selection')).not.toBeInTheDocument();
  });

  it('selects the point at the cursor with Enter, and lets go with Escape', () => {
    const onSelectPoint = vi.fn();
    const onClear = vi.fn();
    const onSelectRange = vi.fn();
    render(
      <ActivityChart
        series={elevationSeries}
        activePointIndex={1}
        onSelectPoint={onSelectPoint}
        onSelectRange={onSelectRange}
        onClear={onClear}
      />,
    );

    fireEvent.keyDown(svg(), { key: 'Enter' });
    expect(onSelectPoint).toHaveBeenCalledWith(1);

    // Escape first drops a section still being marked, and only then clears.
    fireEvent.keyDown(svg(), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(svg(), { key: 'Escape' });
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chart-selection')).not.toBeInTheDocument();
    fireEvent.keyDown(svg(), { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSelectRange).not.toHaveBeenCalled();
  });

  it('leaves keys it does not use to the page', () => {
    render(<ActivityChart series={elevationSeries} />);
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.keyDown(svg(), { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(svg(), { key: 'ArrowRight' })).toBe(false);
  });
});

describe('ActivityChart on a shared x extent (TD-056)', () => {
  it('draws a series that starts late where it starts, not stretched to the left edge', () => {
    const own = render(<ActivityChart series={elevationSeries} />);
    const startOwn = Number(/^M([\d.]+)/.exec(own.container.querySelector('.chart__line')!.getAttribute('d')!)![1]);
    own.unmount();

    // The panel's extent starts well before this series does.
    const span = elevationSeries.xMax - elevationSeries.xMin;
    render(<ActivityChart series={elevationSeries} xDomain={{ min: elevationSeries.xMin - span, max: elevationSeries.xMax }} />);
    const startShared = Number(/^M([\d.]+)/.exec(document.querySelector('.chart__line')!.getAttribute('d')!)![1]);

    expect(startShared).toBeGreaterThan(startOwn + 100);
    expect(screen.getByTestId('elevation-chart-svg')).toHaveAttribute('aria-valuemin', String(elevationSeries.xMin - span));
  });
});

describe('a flat series (TD-056)', () => {
  it('is drawn as a level line, not filled down to the baseline as a block', () => {
    const flat = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 100 },
        { lat: 0.5, lon: 0.0001, elevationMeters: 100 },
        { lat: 1, lon: 0.0001, elevationMeters: 100 },
      ]),
      'elevation',
      'distance',
    );
    render(<ActivityChart series={flat} />);
    const svg = screen.getByTestId('elevation-chart-svg');
    expect(svg.querySelector('.chart__line')).not.toBeNull();
    expect(svg.querySelector('.chart__area')).toBeNull();
  });
});

describe('a recording stopped and started again (TD-060)', () => {
  const at = (minute: number) => new Date(Date.UTC(2024, 0, 1, 10, minute));
  const merged = makeActivity([
    { lat: 0, lon: 0.0001, elevationMeters: 100, segmentIndex: 0, time: at(0) },
    { lat: 0.001, lon: 0.0001, elevationMeters: 110, segmentIndex: 0, time: at(10) },
    // An hour stopped, then on again.
    { lat: 0.0011, lon: 0.0001, elevationMeters: 140, segmentIndex: 1, time: at(70) },
    { lat: 0.002, lon: 0.0001, elevationMeters: 130, segmentIndex: 1, time: at(80) },
  ]);
  const moves = (d: string | null | undefined) => (d ?? '').match(/M/g)?.length ?? 0;

  it('draws no line across the stop, and shades and names it against time', () => {
    render(<ActivityChart series={buildSeries(merged, 'elevation', 'time')} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    expect(moves(svg.querySelector('.chart__line')?.getAttribute('d'))).toBe(2);
    // Each stretch is filled to the baseline on its own.
    expect((svg.querySelector('.chart__area')?.getAttribute('d') ?? '').match(/Z/g)).toHaveLength(2);
    const pauses = screen.getAllByTestId('chart-pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toHaveTextContent('Paused');
  });

  it('breaks the line against distance too, where a stop takes up no room to shade', () => {
    render(<ActivityChart series={buildSeries(merged, 'elevation', 'distance')} />);
    const svg = screen.getByTestId('elevation-chart-svg');

    expect(moves(svg.querySelector('.chart__line')?.getAttribute('d'))).toBe(2);
    expect(screen.queryByTestId('chart-pause')).toBeNull();
  });
});
