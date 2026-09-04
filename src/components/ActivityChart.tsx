import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildXTicks, endpointFits, thinTicks } from '../domain/axis';
import type { ChartSeries, SeriesSample, SeriesXAxis } from '../domain/series';
import { downsampleSeries, findNearestSample } from '../domain/series';
import {
  elevationUnitLabel,
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  paceUnitLabel,
  speedUnitLabel,
  toDisplaySpeed,
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
  if (series.key === 'speed') return speedUnitLabel(units);
  return series.unit;
}

function toDisplayY(value: number, series: ChartSeries, units: UnitSystem): number {
  if (series.key === 'elevation') return toDisplayElevation(value, units);
  if (series.key === 'pace') return toDisplayPace(value, units);
  if (series.key === 'speed') return toDisplaySpeed(value, units);
  return value;
}

function formatY(value: number, series: ChartSeries, units: UnitSystem): string {
  if (series.key === 'elevation') return formatElevation(value, units);
  if (series.key === 'pace') return formatPace(value, units);
  if (series.key === 'speed') return formatSpeed(value, units);
  return `${Math.round(value)} ${series.unit}`;
}

/** Pace ticks read as M:SS; other kinds are plain numbers. */
function formatTick(value: number, series: ChartSeries, units: UnitSystem, decimals: number): string {
  if (series.key === 'pace') {
    const total = Math.round(toDisplayPace(value, units));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  if (series.key === 'speed') return toDisplaySpeed(value, units).toFixed(decimals ? 1 : 0);
  return toDisplayY(value, series, units).toFixed(decimals);
}

/** How each x-axis names itself in the chart header. */
const X_AXIS_LABEL: Record<SeriesXAxis, string> = {
  distance: 'Distance',
  time: 'Elapsed time',
  index: 'Point index (no distance or time available)',
};

const CHART_HEIGHT = 190;
/** Used until the container reports its width, and in environments with no ResizeObserver. */
const FALLBACK_WIDTH = 800;

const AXIS_FONT_SIZE = 11;
/** Tabular numerals, so a per-character estimate is accurate enough to size a gutter. */
const AXIS_CHAR_WIDTH = AXIS_FONT_SIZE * 0.62;
/** Space between a y label and the plot area, so labels never touch it (AV-514). */
const Y_LABEL_GAP = 10;
const MIN_X_LABEL_SPACING = 64;

/**
 * AV-508. Below this many pixels a drag is a click, not a range selection —
 * so a slightly unsteady press selects a point rather than a sliver of the
 * activity nobody meant to choose.
 */
const MIN_DRAG_PIXELS = 8;

const PADDING = { top: 12, right: 14, bottom: 30 };

/**
 * AV-514. The gutter is sized from the widest label actually rendered, so
 * "1000 ft" and "9" both get exactly the room they need and neither is clipped
 * nor left pressed against the plot.
 */
function measureGutter(labels: string[]): number {
  const widest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.ceil(widest * AXIS_CHAR_WIDTH) + Y_LABEL_GAP;
}

/** Tracks the rendered width so ticks can be thinned against real pixels. */
function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/** A span of the chart's x-axis, in that axis's own units (AV-508). */
export interface ChartRange {
  start: number;
  end: number;
}

export interface ActivityChartProps {
  series: ChartSeries;
  activePointIndex?: number;
  units?: UnitSystem;
  /** Shown under the title, e.g. the cadence unit caveat (AV-506). */
  note?: string;
  /** The committed selection, shown until it is cleared (AV-508). */
  selectedRange?: ChartRange;
  onHoverPoint?: (pointIndex: number | undefined) => void;
  onSelectPoint?: (pointIndex: number | undefined) => void;
  onSelectRange?: (range: ChartRange) => void;
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
  selectedRange,
  onHoverPoint,
  onSelectPoint,
  onSelectRange,
}: ActivityChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(containerRef);

  const rendered = useMemo(
    () => downsampleSeries(series, MAX_RENDERED_SAMPLES),
    [series],
  );

  const gridLines = useMemo(() => buildGridLines(rendered, units), [rendered, units]);
  const gutter = useMemo(
    () => measureGutter(gridLines.map((line) => line.label)),
    [gridLines],
  );

  const plot = useMemo(
    () => ({
      left: gutter,
      right: width - PADDING.right,
      top: PADDING.top,
      bottom: CHART_HEIGHT - PADDING.bottom,
    }),
    [gutter, width],
  );

  const scale = useMemo(() => buildScale(rendered, plot), [rendered, plot]);

  const xAxis = useMemo(() => {
    const available = plot.right - plot.left;
    const generated = buildXTicks(rendered.xMin, rendered.xMax, rendered.xAxis, units);
    const { ticks, labelled } = thinTicks(
      generated,
      rendered.xMin,
      rendered.xMax,
      available,
      MIN_X_LABEL_SPACING,
    );
    return {
      ticks,
      labelled,
      // Endpoints stay unless an interval label is already sitting on them.
      showStart: endpointFits(rendered.xMin, labelled, rendered.xMin, rendered.xMax, available, MIN_X_LABEL_SPACING),
      showEnd: endpointFits(rendered.xMax, labelled, rendered.xMin, rendered.xMax, available, MIN_X_LABEL_SPACING),
    };
  }, [rendered, plot, units]);

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
    const baseline = plot.bottom;
    return `${path} L${scale.x(last.x).toFixed(2)} ${baseline} L${scale.x(first.x).toFixed(2)} ${baseline} Z`;
  }, [path, rendered.samples, scale, plot]);

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

  // AV-508. Pointer events rather than mouse events, so the same code path
  // serves mouse, pen and touch when a tablet build lands.
  // The chart's left offset is captured on pointerdown so the band can be drawn
  // during render without reading a ref.
  const [drag, setDrag] = useState<
    { startX: number; currentX: number; left: number } | undefined
  >();
  /** Set when a drag exceeded the threshold, to suppress the click that follows. */
  const draggedRef = useRef(false);

  const domainAtOffset = useCallback(
    (offsetX: number) => {
      if (!scale) return undefined;
      // A drag that runs past the plot selects up to the end, not beyond it.
      return Math.min(Math.max(scale.invertX(offsetX), series.xMin), series.xMax);
    },
    [scale, series.xMin, series.xMax],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    draggedRef.current = false;
    const left = event.currentTarget.getBoundingClientRect().left;
    setDrag({ startX: event.clientX, currentX: event.clientX, left });

    // Capture so the gesture survives the pointer leaving the chart. Attempted
    // last and guarded: it throws for a pointer the browser does not consider
    // active, and losing capture is far better than losing the gesture.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is an enhancement; the drag still works without it.
    }
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    setDrag((current) => (current ? { ...current, currentX: event.clientX } : current));
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      try {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      } catch {
        // Nothing to release: the capture attempt above was refused.
      }
      const current = drag;
      setDrag(undefined);
      if (!current) return;

      if (Math.abs(event.clientX - current.startX) < MIN_DRAG_PIXELS) return;

      draggedRef.current = true;
      const from = domainAtOffset(current.startX - current.left);
      const to = domainAtOffset(event.clientX - current.left);
      if (from === undefined || to === undefined || from === to) return;

      // A right-to-left drag means the same span as left-to-right.
      onSelectRange?.({ start: Math.min(from, to), end: Math.max(from, to) });
    },
    [drag, domainAtOffset, onSelectRange],
  );

  const sampleAtClientX = useCallback(
    (clientX: number) => {
      const svg = svgRef.current;
      if (!svg || !scale) return undefined;
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0) return undefined;
      // The viewBox is 1:1 with pixels, so no rescaling is needed here.
      return findNearestSample(rendered, scale.invertX(clientX - rect.left));
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

      <div className="chart__plot" ref={containerRef}>
        <svg
          ref={svgRef}
          className="chart__svg"
          width={width}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
          role="img"
          aria-label={`${series.label} from ${formatY(series.yMin, series, units)} to ${formatY(series.yMax, series, units)}, by ${X_AXIS_LABEL[series.xAxis].toLowerCase()}`}
          data-testid="elevation-chart-svg"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => setDrag(undefined)}
          onMouseMove={(event) => onHoverPoint?.(sampleAtClientX(event.clientX)?.pointIndex)}
          onMouseLeave={() => onHoverPoint?.(undefined)}
          onClick={(event) => {
            // A drag ends in a click too; only the small ones select a point.
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            onSelectPoint?.(sampleAtClientX(event.clientX)?.pointIndex);
          }}
        >
          {scale &&
            gridLines.map((line) => (
              <g key={line.value}>
                <line
                  className="chart__grid"
                  x1={plot.left}
                  x2={plot.right}
                  y1={scale.y(line.value)}
                  y2={scale.y(line.value)}
                />
                <text
                  className="chart__axis-label chart__axis-label--y"
                  x={plot.left - Y_LABEL_GAP + 4}
                  y={scale.y(line.value)}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {line.label}
                </text>
              </g>
            ))}

          <path className="chart__area" d={areaPath} />
          <path className="chart__line" d={path} />

          {/* AV-514: marks at every generated interval; labels only where they fit. */}
          {scale &&
            xAxis.ticks.map((tick) => (
              <line
                key={`mark-${tick.value}`}
                className="chart__tick"
                x1={scale.x(tick.value)}
                x2={scale.x(tick.value)}
                y1={plot.bottom}
                y2={plot.bottom + 4}
              />
            ))}

          {scale &&
            xAxis.labelled.map((tick) => (
              <text
                key={`label-${tick.value}`}
                className="chart__axis-label chart__axis-label--x"
                x={scale.x(tick.value)}
                y={plot.bottom + 18}
                textAnchor="middle"
              >
                {tick.label}
              </text>
            ))}

          {scale && xAxis.showStart && (
            <text
              className="chart__axis-label chart__axis-label--x is-endpoint"
              x={plot.left}
              y={plot.bottom + 18}
              textAnchor="start"
            >
              {formatXValue(series.xMin, series.xAxis, units)}
            </text>
          )}
          {scale && xAxis.showEnd && (
            <text
              className="chart__axis-label chart__axis-label--x is-endpoint"
              x={plot.right}
              y={plot.bottom + 18}
              textAnchor="end"
            >
              {formatXValue(series.xMax, series.xAxis, units)}
            </text>
          )}

          {scale &&
            (() => {
              const band = drag
                ? {
                    start: domainAtOffset(drag.startX - drag.left),
                    end: domainAtOffset(drag.currentX - drag.left),
                  }
                : selectedRange;
              if (!band || band.start === undefined || band.end === undefined) return null;

              const from = scale.x(Math.min(band.start, band.end));
              const to = scale.x(Math.max(band.start, band.end));
              if (Math.abs(to - from) < 1) return null;

              return (
                <rect
                  className="chart__selection"
                  data-testid="chart-selection"
                  x={from}
                  y={plot.top}
                  width={to - from}
                  height={plot.bottom - plot.top}
                />
              );
            })()}

          {activeSample && scale && (
            <g className="chart__cursor" data-testid="chart-cursor">
              <line
                x1={scale.x(activeSample.x)}
                x2={scale.x(activeSample.x)}
                y1={plot.top}
                y2={plot.bottom}
              />
              <circle cx={scale.x(activeSample.x)} cy={scale.y(activeSample.y)} r={5} />
            </g>
          )}
        </svg>
      </div>
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

interface PlotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function buildScale(series: ChartSeries, plot: PlotBox): Scale | undefined {
  if (series.samples.length === 0) return undefined;

  const innerWidth = Math.max(1, plot.right - plot.left);
  const innerHeight = Math.max(1, plot.bottom - plot.top);
  const flat = isEffectivelyFlat(series);
  const xRange = series.xMax - series.xMin || 1;
  // Pad a flat profile so the line sits mid-plot instead of on the axis.
  const yRange = series.yMax - series.yMin || 1;

  return {
    x: (value) => plot.left + ((value - series.xMin) / xRange) * innerWidth,
    y: (value) => {
      // A near-constant series is drawn as the flat line it is, mid-plot,
      // rather than having its noise stretched across the whole height.
      if (flat) return plot.top + innerHeight / 2;
      const fraction = (value - series.yMin) / yRange;
      // Pace is inverted so faster values sit at the top, as runners expect.
      return series.invertY
        ? plot.top + fraction * innerHeight
        : plot.top + innerHeight - fraction * innerHeight;
    },
    invertX: (pixel) => series.xMin + ((pixel - plot.left) / innerWidth) * xRange,
  };
}

/**
 * True when a series barely varies — a steady ride at 28.8 km/h, a flat run.
 * Spreading such a series over the full plot height would draw sensor noise as
 * if it were terrain, and label every gridline with the same number.
 */
function isEffectivelyFlat(series: ChartSeries): boolean {
  const span = series.yMax - series.yMin;
  const magnitude = Math.max(Math.abs(series.yMax), Math.abs(series.yMin), 1);
  return span <= magnitude * 0.005;
}

function buildGridLines(
  series: ChartSeries,
  units: UnitSystem,
): { value: number; label: string }[] {
  const steps = 4;
  const range = series.yMax - series.yMin || 1;
  // Ticks are labelled in the display unit, so the decision about decimals has
  // to be made there too: 2 m is 6.6 ft, and only one of those needs a decimal.
  const displayRange = Math.abs(
    toDisplayY(series.yMax, series, units) - toDisplayY(series.yMin, series, units),
  );

  // One honest label beats five identical ones.
  if (isEffectivelyFlat(series)) {
    return [{ value: series.yMin, label: formatTick(series.yMin, series, units, 1) }];
  }

  // A narrow range (a flat route) would round every tick to the same integer,
  // so add decimals until adjacent labels can actually differ.
  const step = displayRange / steps;
  const decimals = step >= 1 ? 0 : Math.min(2, Math.ceil(-Math.log10(step)));

  return Array.from({ length: steps + 1 }, (_, index) => {
    const value = series.yMin + (range * index) / steps;
    return { value, label: formatTick(value, series, units, decimals) };
  });
}
