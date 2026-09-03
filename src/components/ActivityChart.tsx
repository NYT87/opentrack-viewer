import { useCallback, useMemo, useRef } from 'react';
import type { ChartSeries, SeriesSample, SeriesXAxis } from '../domain/series';
import { downsampleSeries, findNearestSample } from '../domain/series';
import {
  elevationUnitLabel,
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  paceUnitLabel,
  toDisplayElevation,
  toDisplayPace,
  type UnitSystem,
} from '../domain/units';

/** Cap on rendered points; the full series still backs every statistic (§14). */
const MAX_RENDERED_SAMPLES = 900;

/**
 * Y-axis presentation per series kind. Elevation and pace convert into the
 * user's unit system; everything else is plotted in the unit it was recorded in.
 */
function yUnitLabel(series: ChartSeries, units: UnitSystem): string {
  if (series.key === 'elevation') return elevationUnitLabel(units);
  if (series.key === 'pace') return paceUnitLabel(units);
  return series.unit;
}

function toDisplayY(value: number, series: ChartSeries, units: UnitSystem): number {
  if (series.key === 'elevation') return toDisplayElevation(value, units);
  if (series.key === 'pace') return toDisplayPace(value, units);
  return value;
}

function formatY(value: number, series: ChartSeries, units: UnitSystem): string {
  if (series.key === 'elevation') return formatElevation(value, units);
  if (series.key === 'pace') return formatPace(value, units);
  return `${Math.round(value)} ${series.unit}`;
}

/** Pace ticks read as M:SS; other kinds are plain numbers. */
function formatTick(value: number, series: ChartSeries, units: UnitSystem, decimals: number): string {
  if (series.key === 'pace') {
    const total = Math.round(toDisplayPace(value, units));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  return toDisplayY(value, series, units).toFixed(decimals);
}

/** How each x-axis names itself in the chart header. */
const X_AXIS_LABEL: Record<SeriesXAxis, string> = {
  distance: 'Distance',
  time: 'Elapsed time',
  index: 'Point index (no distance or time available)',
};

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 240;
const PADDING = { top: 12, right: 12, bottom: 26, left: 52 };

export interface ActivityChartProps {
  series: ChartSeries;
  activePointIndex?: number;
  units?: UnitSystem;
  /** Shown under the title, e.g. the cadence unit caveat (AV-506). */
  note?: string;
  onHoverPoint?: (pointIndex: number | undefined) => void;
  onSelectPoint?: (pointIndex: number | undefined) => void;
}

/**
 * AV-502 / AV-505 / AV-506. Hand-rolled SVG so the chart stays dependency-free
 * and its hover model can map straight back to activity point indices
 * (AV-601). Renders any series kind; only the y-axis formatting varies.
 */
export function ActivityChart({
  series,
  activePointIndex,
  units = 'metric',
  note,
  onHoverPoint,
  onSelectPoint,
}: ActivityChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const rendered = useMemo(
    () => downsampleSeries(series, MAX_RENDERED_SAMPLES),
    [series],
  );

  const scale = useMemo(() => buildScale(rendered), [rendered]);

  const path = useMemo(() => {
    if (!scale || rendered.samples.length === 0) return '';
    return rendered.samples
      .map((sample, index) => {
        const command = index === 0 ? 'M' : 'L';
        return `${command}${scale.x(sample.x).toFixed(2)} ${scale.y(sample.y).toFixed(2)}`;
      })
      .join(' ');
  }, [rendered, scale]);

  const areaPath = useMemo(() => {
    if (!path || !scale) return '';
    const first = rendered.samples[0]!;
    const last = rendered.samples[rendered.samples.length - 1]!;
    const baseline = VIEWBOX_HEIGHT - PADDING.bottom;
    return `${path} L${scale.x(last.x).toFixed(2)} ${baseline} L${scale.x(first.x).toFixed(2)} ${baseline} Z`;
  }, [path, rendered.samples, scale]);

  const activeSample = useMemo(() => {
    if (activePointIndex === undefined) return undefined;
    // The rendered series is downsampled, so pick the nearest kept sample.
    let best: SeriesSample | undefined;
    let bestDelta = Infinity;
    for (const sample of rendered.samples) {
      const delta = Math.abs(sample.pointIndex - activePointIndex);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = sample;
      }
    }
    return best;
  }, [activePointIndex, rendered.samples]);

  const sampleAtClientX = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg || !scale) return undefined;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return undefined;
      const viewboxX = ((clientX - rect.left) / rect.width) * VIEWBOX_WIDTH;
      return findNearestSample(rendered, scale.invertX(viewboxX));
    },
    [rendered, scale],
  );

  if (series.isEmpty) {
    return (
      <section className="chart chart--empty" aria-label={`${series.label} chart`}>
        <h3 className="chart__title">{series.label}</h3>
        <p className="chart__empty">
          No {series.label.toLowerCase()} data in this activity, so there is nothing to chart.
        </p>
      </section>
    );
  }

  const gridLines = scale ? buildGridLines(rendered, scale, units) : [];

  return (
    <section className="chart" aria-label={`${series.label} chart`}>
      <header className="chart__header">
        <h3 className="chart__title">
          {series.label} ({yUnitLabel(series, units)})
        </h3>
        <p className="chart__meta">
          {formatY(series.yMin, series, units)} – {formatY(series.yMax, series, units)} · x-axis:{' '}
          {X_AXIS_LABEL[series.xAxis].toLowerCase()}
        </p>
      </header>
      {note && <p className="chart__note">{note}</p>}

      <svg
        ref={svgRef}
        className="chart__svg"
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${series.label} from ${formatY(series.yMin, series, units)} to ${formatY(series.yMax, series, units)}, by ${X_AXIS_LABEL[series.xAxis].toLowerCase()}`}
        data-testid="elevation-chart-svg"
        onMouseMove={(event) => onHoverPoint?.(sampleAtClientX(event.clientX)?.pointIndex)}
        onMouseLeave={() => onHoverPoint?.(undefined)}
        onClick={(event) => onSelectPoint?.(sampleAtClientX(event.clientX)?.pointIndex)}
      >
        {gridLines.map((line) => (
          <g key={line.value}>
            <line
              className="chart__grid"
              x1={PADDING.left}
              x2={VIEWBOX_WIDTH - PADDING.right}
              y1={line.y}
              y2={line.y}
            />
            <text className="chart__axis-label" x={PADDING.left - 8} y={line.y + 4} textAnchor="end">
              {line.label}
            </text>
          </g>
        ))}

        <path className="chart__area" d={areaPath} />
        <path className="chart__line" d={path} />

        {activeSample && scale && (
          <g className="chart__cursor" data-testid="chart-cursor">
            <line
              x1={scale.x(activeSample.x)}
              x2={scale.x(activeSample.x)}
              y1={PADDING.top}
              y2={VIEWBOX_HEIGHT - PADDING.bottom}
            />
            <circle cx={scale.x(activeSample.x)} cy={scale.y(activeSample.y)} r={5} />
          </g>
        )}
      </svg>

      <footer className="chart__footer">
        <span>{formatXValue(series.xMin, series.xAxis, units)}</span>
        <span>{formatXValue(series.xMax, series.xAxis, units)}</span>
      </footer>
    </section>
  );
}

interface Scale {
  x: (value: number) => number;
  y: (value: number) => number;
  invertX: (pixel: number) => number;
}

/** x values carry a different meaning per axis: meters, seconds, or an index. */
function formatXValue(value: number, axis: SeriesXAxis, units: UnitSystem): string {
  if (axis === 'distance') return formatDistance(value, units);
  if (axis === 'time') return formatDuration(value);
  return String(Math.round(value));
}

function buildScale(series: ChartSeries): Scale | undefined {
  if (series.samples.length === 0) return undefined;

  const innerWidth = VIEWBOX_WIDTH - PADDING.left - PADDING.right;
  const innerHeight = VIEWBOX_HEIGHT - PADDING.top - PADDING.bottom;
  const xRange = series.xMax - series.xMin || 1;
  // Pad a flat profile so the line sits mid-plot instead of on the axis.
  const yRange = series.yMax - series.yMin || 1;

  return {
    x: (value) => PADDING.left + ((value - series.xMin) / xRange) * innerWidth,
    y: (value) => {
      const fraction = (value - series.yMin) / yRange;
      // Pace is inverted so faster values sit at the top, as runners expect.
      return series.invertY
        ? PADDING.top + fraction * innerHeight
        : PADDING.top + innerHeight - fraction * innerHeight;
    },
    invertX: (pixel) => series.xMin + ((pixel - PADDING.left) / innerWidth) * xRange,
  };
}

function buildGridLines(
  series: ChartSeries,
  scale: Scale,
  units: UnitSystem,
): { value: number; y: number; label: string }[] {
  const steps = 4;
  const range = series.yMax - series.yMin || 1;
  // Ticks are labelled in the display unit, so the decision about decimals has
  // to be made there too: 2 m is 6.6 ft, and only one of those needs a decimal.
  const displayRange = Math.abs(
    toDisplayY(series.yMax, series, units) - toDisplayY(series.yMin, series, units),
  );
  // A narrow range (a flat route) would round every tick to the same integer,
  // so keep a decimal until the labels are actually distinct.
  const decimals = displayRange < steps ? 1 : 0;

  return Array.from({ length: steps + 1 }, (_, index) => {
    const value = series.yMin + (range * index) / steps;
    return { value, y: scale.y(value), label: formatTick(value, series, units, decimals) };
  });
}
