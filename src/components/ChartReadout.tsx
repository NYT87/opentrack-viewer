import type { ReactNode } from 'react';
import type { ChartSeries, SeriesSample, SeriesXAxis } from '../domain/series';
import { MISSING, type UnitSystem } from '../domain/units';
import { X_AXIS_CAPTION, formatSeriesValue, formatXValue } from './chartFormat';

export interface ChartReadoutProps {
  /** The series the panel draws, in the order it draws them. */
  series: ChartSeries[];
  xAxis: SeriesXAxis;
  /** The shared cursor: hovered on a chart or the route, or stepped to by keyboard. */
  activePointIndex?: number;
  units?: UnitSystem;
  /**
   * What the figures describe: the whole activity, or the selected section
   * with its own figures and the way back out. Always present, so the row
   * keeps one height whether or not a section is selected.
   */
  scope: ReactNode;
  /** The x extent's largest value, so the position reads in the axis's unit. */
  scaleMax?: number;
  /** Whether there is a route to point at as well as the charts. */
  hasRoute?: boolean;
}

/**
 * The sample recorded at exactly this point, if the series has one. Samples
 * are in point order, so this is a binary search rather than a scan: it runs
 * on every pointer move, for every series, over files of 100,000 points.
 */
export function sampleAtPoint(series: ChartSeries, pointIndex: number): SeriesSample | undefined {
  const { samples } = series;
  let low = 0;
  let high = samples.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const sample = samples[middle]!;
    if (sample.pointIndex === pointIndex) return sample;
    if (sample.pointIndex < pointIndex) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

/**
 * TD-056. The instrument panel's readout: what every chart says at the one
 * point the reader is on. Each value is a caption over a figure, like the stat
 * grid, and a series with no reading at that point shows the missing marker
 * rather than a neighbour's value it did not record.
 *
 * Not a live region. It changes on every pointer move, and announcing each one
 * would drown a screen reader; a keyboard reader hears the value through the
 * focused chart's own slider value instead.
 */
export function ChartReadout({
  series,
  xAxis,
  activePointIndex,
  units = 'metric',
  scope,
  scaleMax,
  hasRoute = true,
}: ChartReadoutProps) {
  const readings =
    activePointIndex === undefined
      ? undefined
      : series.map((entry) => ({ entry, sample: sampleAtPoint(entry, activePointIndex) }));
  const x = readings?.find(({ sample }) => sample !== undefined)?.sample?.x;

  return (
    <div className="chart-readout">
      <div className="chart-readout__scope">{scope}</div>
      <section className="chart-readout__values" aria-label="Values at the cursor">
        {readings === undefined || x === undefined ? (
          <p className="chart-readout__hint">
            {hasRoute ? 'Point at a chart or the route' : 'Point at a chart'}, or focus one and use the
            arrow keys, to read values here.{' '}
            <span className="chart-readout__hint-more">
              Drag across a chart, or hold Shift with the arrows, to look at a section: Enter keeps it,
              Escape lets it go.
            </span>
          </p>
        ) : (
          <dl className="chart-readout__list">
            <div className="chart-readout__cell">
              <dt className="chart-readout__label">{X_AXIS_CAPTION[xAxis]}</dt>
              <dd className="chart-readout__value">{formatXValue(x, xAxis, units, scaleMax)}</dd>
            </div>
            {readings.map(({ entry, sample }) => (
              <div className="chart-readout__cell" key={entry.key}>
                <dt className="chart-readout__label">{entry.label}</dt>
                <dd className="chart-readout__value">
                  {sample ? formatSeriesValue(sample.y, entry, units) : MISSING}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

/** The readout's scope at rest: the whole activity, and how to narrow it. */
export function WholeActivityScope({ points }: { points: number }) {
  return (
    <p className="chart-readout__whole">
      <span className="chart-readout__whole-title">Whole activity</span> · {points} points
    </p>
  );
}
