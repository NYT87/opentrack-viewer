import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildXTicks, endpointFits, thinTicks } from '../domain/axis';
import type { ChartSeries, SeriesSample } from '../domain/series';
import { downsampleSeries, findNearestSample, seriesRuns } from '../domain/series';
import { type UnitSystem } from '../domain/units';
import {
  X_AXIS_LABEL,
  formatSeriesValue as formatY,
  formatTick,
  formatXValue,
  toDisplayY,
  yUnitLabel,
} from './chartFormat';

/** Cap on rendered points; the full series still backs every statistic (§14). */
const MAX_RENDERED_SAMPLES = 900;

/** PageUp and PageDown move the keyboard cursor this share of the chart (TD-056). */
const PAGE_STEP_FRACTION = 0.1;

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

/**
 * TD-056. The gutter a series needs on its own. The panel takes the widest of
 * its charts' and gives that one value to all of them, so every plot starts at
 * the same pixel and the shared cursor is one vertical line, not a ragged one.
 */
export function chartGutter(series: ChartSeries, units: UnitSystem = 'metric'): number {
  if (series.isEmpty) return 0;
  const rendered = downsampleSeries(series, MAX_RENDERED_SAMPLES);
  return measureGutter(buildGridLines(rendered, units).map((line) => line.label));
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

/** The x extent a chart is drawn over, in its axis's own units. */
export interface ChartXDomain {
  min: number;
  max: number;
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
  /**
   * TD-056. The x extent shared by every chart in the panel, so one vertical
   * line reads all of them. A series that starts late (a pace that needs a few
   * points of distance first) is drawn where it starts, not stretched to fill.
   * Left out, the chart spans its own series.
   */
  xDomain?: ChartXDomain;
  /** Escape on a focused chart with nothing pending: clear what it set. */
  onClear?: () => void;
  /**
   * TD-056. The left gutter shared by every chart in the panel. Left out, the
   * chart sizes its own from its labels.
   */
  gutter?: number;
  /** TD-056. Writes the x-axis labels; tick marks are drawn either way. */
  showXAxisLabels?: boolean;
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
  xDomain,
  onClear,
  gutter: sharedGutter,
  showXAxisLabels = true,
}: ActivityChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const descriptionId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(containerRef);

  const rendered = useMemo(
    () => downsampleSeries(series, MAX_RENDERED_SAMPLES),
    [series],
  );

  const gridLines = useMemo(() => buildGridLines(rendered, units), [rendered, units]);
  const ownGutter = useMemo(
    () => measureGutter(gridLines.map((line) => line.label)),
    [gridLines],
  );
  const gutter = Math.max(sharedGutter ?? 0, ownGutter);

  const plot = useMemo(
    () => ({
      left: gutter,
      right: width - PADDING.right,
      top: PADDING.top,
      bottom: CHART_HEIGHT - PADDING.bottom,
    }),
    [gutter, width],
  );

  const domainMin = xDomain?.min ?? series.xMin;
  const domainMax = xDomain?.max ?? series.xMax;
  const domain = useMemo(() => ({ min: domainMin, max: domainMax }), [domainMin, domainMax]);

  const scale = useMemo(() => buildScale(rendered, plot, domain), [rendered, plot, domain]);

  const xAxis = useMemo(() => {
    const available = plot.right - plot.left;
    const generated = buildXTicks(domain.min, domain.max, rendered.xAxis, units);
    const { ticks, labelled } = thinTicks(generated, domain.min, domain.max, available, MIN_X_LABEL_SPACING);
    return {
      ticks,
      labelled,
      // Endpoints stay unless an interval label is already sitting on them.
      showStart: endpointFits(domain.min, labelled, domain.min, domain.max, available, MIN_X_LABEL_SPACING),
      showEnd: endpointFits(domain.max, labelled, domain.min, domain.max, available, MIN_X_LABEL_SPACING),
    };
  }, [rendered, plot, units, domain]);

  /*
   * One line per recorded segment: where the recording was stopped — a pause,
   * or the gap between two merged files — nothing is drawn across, so a stop
   * never reads as a stretch of steady riding (TD-060).
   */
  const runs = useMemo(() => seriesRuns(rendered.samples), [rendered]);
  const runPath = useCallback(
    (run: SeriesSample[]) =>
      scale
        ? run
            .map((sample, index) => `${index === 0 ? 'M' : 'L'}${scale.x(sample.x).toFixed(2)} ${scale.y(sample.y).toFixed(2)}`)
            .join(' ')
        : '',
    [scale],
  );
  const path = useMemo(() => runs.map(runPath).join(' '), [runs, runPath]);

  const areaPath = useMemo(() => {
    if (!scale) return '';
    const baseline = plot.bottom;
    return runs
      .map((run) => {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        return `${runPath(run)} L${scale.x(last.x).toFixed(2)} ${baseline} L${scale.x(first.x).toFixed(2)} ${baseline} Z`;
      })
      .join(' ');
  }, [runs, runPath, scale, plot]);

  // Against time, a stop takes up room on the axis: it is shaded and named rather than left blank.
  const pauses = useMemo(() => {
    if (!scale || rendered.xAxis !== 'time') return [];
    return runs.slice(1).flatMap((run, index) => {
      const from = scale.x(runs[index]!.at(-1)!.x);
      const to = scale.x(run[0]!.x);
      const left = Math.max(plot.left, from);
      const right = Math.min(plot.right, to);
      return right - left >= 1 ? [{ key: run[0]!.pointIndex, left, right }] : [];
    });
  }, [runs, scale, rendered.xAxis, plot]);

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
      return Math.min(Math.max(scale.invertX(offsetX), domain.min), domain.max);
    },
    [scale, domain],
  );

  /*
   * TD-056. The keyboard's way through the chart, which the pointer has had
   * since AV-508: the arrows move the shared cursor sample by sample (so the
   * map marker and every other chart follow), Shift extends a section from
   * where it started, Enter keeps it, Escape lets go. The section being marked
   * lives here until it is kept; only a kept one reaches shared state.
   */
  const [keyBand, setKeyBand] = useState<{ anchor: number; to: number } | undefined>();

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      const samples = rendered.samples;
      if (samples.length === 0) return;
      const last = samples.length - 1;
      const current = activeSample ? samples.indexOf(activeSample) : -1;
      const page = Math.max(1, Math.round(samples.length * PAGE_STEP_FRACTION));
      // From no cursor, a step forward lands on the first sample and a step
      // back on the last, as a slider's ends would.
      const step = (delta: number) =>
        Math.min(last, Math.max(0, (current < 0 ? (delta > 0 ? -1 : last + 1) : current) + delta));

      let next: number | undefined;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = step(1);
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = step(-1);
          break;
        case 'PageUp':
          next = step(page);
          break;
        case 'PageDown':
          next = step(-page);
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        case 'Enter': {
          event.preventDefault();
          if (keyBand && keyBand.anchor !== keyBand.to) {
            onSelectRange?.({ start: Math.min(keyBand.anchor, keyBand.to), end: Math.max(keyBand.anchor, keyBand.to) });
          } else if (activeSample) {
            onSelectPoint?.(activeSample.pointIndex);
          }
          setKeyBand(undefined);
          return;
        }
        case 'Escape':
          event.preventDefault();
          if (keyBand) setKeyBand(undefined);
          else onClear?.();
          return;
        default:
          return;
      }

      event.preventDefault();
      const sample = samples[next]!;
      if (event.shiftKey) {
        const from = activeSample?.x ?? sample.x;
        setKeyBand((band) => ({ anchor: band?.anchor ?? from, to: sample.x }));
      } else {
        setKeyBand(undefined);
      }
      onHoverPoint?.(sample.pointIndex);
    },
    [rendered.samples, activeSample, keyBand, onSelectRange, onSelectPoint, onClear, onHoverPoint],
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

  const rangeText = `${series.label} from ${formatY(series.yMin, series, units)} to ${formatY(series.yMax, series, units)}, by ${X_AXIS_LABEL[series.xAxis].toLowerCase()}`;
  // Read as a sentence, so the two numbers cannot be confused: "at 142 ft,
  // elevation 358 ft" rather than "142 ft: 358 ft".
  const at = (x: number) =>
    series.xAxis === 'index' ? `at point ${Math.round(x)}` : `at ${formatXValue(x, series.xAxis, units, domain.max)}`;
  const valueText = activeSample
    ? `${at(activeSample.x)}, ${series.label.toLowerCase()} ${formatY(activeSample.y, series, units)}` +
      (keyBand ? `, marking a section from ${formatXValue(keyBand.anchor, series.xAxis, units, domain.max)}` : '')
    : 'No point selected';

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
          // TD-056. A slider over the activity: focusable, moved by the keys
          // handled above, and read back as the value at the cursor.
          role="slider"
          tabIndex={0}
          aria-label={`${series.label} chart`}
          aria-describedby={descriptionId}
          aria-orientation="horizontal"
          aria-valuemin={domain.min}
          aria-valuemax={domain.max}
          aria-valuenow={activeSample?.x ?? domain.min}
          aria-valuetext={valueText}
          data-testid={`${series.key}-chart-svg`}
          onKeyDown={handleKeyDown}
          onBlur={() => setKeyBand(undefined)}
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

          {pauses.map((pause) => (
            <g key={`pause-${pause.key}`} className="chart__pause" data-testid="chart-pause">
              <rect x={pause.left} y={plot.top} width={pause.right - pause.left} height={plot.bottom - plot.top} />
              {pause.right - pause.left >= 48 && (
                <text x={(pause.left + pause.right) / 2} y={plot.top + 12} textAnchor="middle">
                  Paused
                </text>
              )}
            </g>
          ))}

          {/* A flat series is a level line: filled to the baseline it read as a block. */}
          {!isEffectivelyFlat(series) && <path className="chart__area" d={areaPath} />}
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
            showXAxisLabels &&
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

          {scale && showXAxisLabels && xAxis.showStart && (
            <text
              className="chart__axis-label chart__axis-label--x is-endpoint"
              x={plot.left}
              y={plot.bottom + 18}
              textAnchor="start"
            >
              {formatXValue(domain.min, series.xAxis, units, domain.max)}
            </text>
          )}
          {scale && showXAxisLabels && xAxis.showEnd && (
            <text
              className="chart__axis-label chart__axis-label--x is-endpoint"
              x={plot.right}
              y={plot.bottom + 18}
              textAnchor="end"
            >
              {formatXValue(domain.max, series.xAxis, units, domain.max)}
            </text>
          )}

          {scale &&
            (() => {
              const band = drag
                ? {
                    start: domainAtOffset(drag.startX - drag.left),
                    end: domainAtOffset(drag.currentX - drag.left),
                  }
                : keyBand
                  ? { start: keyBand.anchor, end: keyBand.to }
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
      <p id={descriptionId} className="visually-hidden">
        {rangeText}. Arrow keys move along the activity. Hold Shift to mark a section, Enter keeps it,
        Escape clears it.
      </p>
    </section>
  );
}

interface Scale {
  x: (value: number) => number;
  y: (value: number) => number;
  invertX: (pixel: number) => number;
}

interface PlotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function buildScale(series: ChartSeries, plot: PlotBox, domain: ChartXDomain): Scale | undefined {
  if (series.samples.length === 0) return undefined;

  const innerWidth = Math.max(1, plot.right - plot.left);
  const innerHeight = Math.max(1, plot.bottom - plot.top);
  const flat = isEffectivelyFlat(series);
  const xRange = domain.max - domain.min || 1;
  // Pad a flat profile so the line sits mid-plot instead of on the axis.
  const yRange = series.yMax - series.yMin || 1;

  return {
    x: (value) => plot.left + ((value - domain.min) / xRange) * innerWidth,
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
    invertX: (pixel) => domain.min + ((pixel - plot.left) / innerWidth) * xRange,
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
