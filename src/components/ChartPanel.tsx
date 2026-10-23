import { useMemo, useRef, useState } from 'react';
import type { Activity, ChartXAxisMode } from '../domain/activity';
import { domainFromPointRange, pointRangeFromDomain } from '../domain/range';
import { useInteractionStore } from '../state/interactionStore';
import { sliceActivity } from '../domain/activitySlice';
import { getVisibleCharts, type ActivityChartKind } from '../domain/charts';
import {
  buildSensorSeries,
  buildSeries,
  getXAxisAvailability,
  resolveXAxis,
  restrictSeries,
  type ChartSeries,
  type ChartSeriesKey,
} from '../domain/series';
import type { UnitSystem } from '../domain/units';
import { ActivityChart, chartGutter, type ChartRange, type ChartXDomain } from './ActivityChart';
import { ChartReadout, WholeActivityScope } from './ChartReadout';
import { SelectionSummary } from './SelectionSummary';
import { ChartXAxisSwitch } from './ChartXAxisSwitch';
import { PerformanceMetricSwitch } from './PerformanceMetricSwitch';
import {
  isPerformanceMetricSelectable,
  resolvePerformanceMetric,
} from '../domain/performance';

/**
 * AV-515. Running cadence is strides per minute — one foot — which is what
 * watches and foot pods report. Said once here rather than left for the reader
 * to infer from a bare number.
 */
const CADENCE_NOTE = 'Strides per minute: one foot, as watches and foot pods report it.';
const CYCLING_CADENCE_NOTE = 'Pedal revolutions per minute, as a crank or power meter reports it.';

const CHART_NOTES: Partial<Record<ActivityChartKind, string>> = {
  cadence: CADENCE_NOTE,
  cyclingCadence: CYCLING_CADENCE_NOTE,
};

export interface ChartPanelProps {
  activity: Activity;
  /** The user's session preference; may not be available for this activity. */
  xAxisPreference?: ChartXAxisMode;
  onXAxisChange: (mode: ChartXAxisMode) => void;
  units?: UnitSystem;
  activePointIndex?: number;
  onHoverPoint?: (pointIndex: number | undefined) => void;
  onSelectPoint?: (pointIndex: number | undefined) => void;
  /** Whether the activity has a route on the map, which the readout's hint names. */
  hasRoute?: boolean;
}

/**
 * AV-504. Owns the x-axis selection for every chart it renders, so the axis
 * applies consistently across the panel. Resolving the axis here also means
 * switching modes never re-parses the file: it only rebuilds series from the
 * already-normalized activity.
 */
export function ChartPanel({
  activity,
  xAxisPreference,
  onXAxisChange,
  units,
  activePointIndex,
  onHoverPoint,
  onSelectPoint,
  hasRoute = true,
}: ChartPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  /** The chart a section was kept from, where focus returns when it is let go. */
  const originRef = useRef<Element | null>(null);
  /** Said once a section is let go, so Reset View is heard as well as seen. */
  const [releasedNote, setReleasedNote] = useState('');
  // Declared before the selection so the focus can be derived from it below.
  /*
   * AV-908. Speed or pace, for a file that never said which. Read here rather
   * than passed in because it changes which charts exist, and it is resolved
   * against the activity on every render — switching touches no `Activity` and
   * re-reads no file (TD-006).
   */
  const metricPreference = useInteractionStore((state) => state.performanceMetric);
  const setPerformanceMetric = useInteractionStore((state) => state.setPerformanceMetric);

  /*
   * Resolved once, from the whole activity. Availability below is asked about
   * the focused slice when there is one, and a slice too short to have a pace
   * would answer this question differently — leaving the charts showing speed
   * under a switch still pressed on pace.
   */
  const metric = resolvePerformanceMetric(activity, metricPreference);

  /**
   * AV-508 / AV-509 / AV-601. The selection lives in shared state, in
   * `point.index` terms rather than as a span of whichever axis was showing.
   * That is what lets it survive a switch between distance and time, and what
   * lets the map follow it (AV-604). Loading a file resets it.
   */
  const pointRange = useInteractionStore((state) => state.selectedRange);
  const setSelectedRange = useInteractionStore((state) => state.setSelectedRange);

  /*
   * Everything the panel draws, derived once per change of activity, axis,
   * metric or selection — never on a hover. The cursor moves on every pointer
   * event, and rebuilding every series of a 100,000-point file each time it did
   * was the panel's largest cost.
   */
  const view = useMemo(() => {
    /**
     * AV-511. A valid selection produces a focused activity, and the charts are
     * then drawn from it: availability is recalculated against the slice, so a
     * section without cadence stops offering a cadence chart.
     */
    const focus = pointRange ? sliceActivity(activity, pointRange) : undefined;
    const focused = focus?.ok ? focus.activity : undefined;
    const source = focused ?? activity;
    const resolved = resolveXAxis(source, xAxisPreference);

    /*
     * AV-905. Streams with no `ActivityPoint` field of their own, already
     * reduced to one value per point by the parser. They render through the
     * same chart as everything else, because by this stage there is nothing
     * left about them that differs.
     */
    const focusSeries = (series: ChartSeries) =>
      pointRange && focused ? restrictSeries(series, pointRange) : series;

    /*
     * AV-516 / TD-028. Only charts the data supports are drawn. An unavailable
     * chart gets no title, no message and no space: a box per absence made a
     * sparse file look broken, and told a rider that pace is for runners.
     */
    const drawn: { key: string; series: ChartSeries; note?: string }[] = getVisibleCharts(source, metric)
      .filter((chart) => chart.available)
      .map((chart) => ({
        key: chart.kind,
        series: focusSeries(buildSeries(activity, chart.kind as ChartSeriesKey, resolved)),
        note: CHART_NOTES[chart.kind],
      }));

    /*
     * Narrowed to the focus *before* deciding whether to show them, the same way
     * availability is recalculated against the slice: a section that no
     * acceleration sample falls in should lose the chart, not show an empty one.
     * Built from the whole activity and then restricted, so the axis keeps
     * absolute values (AV-511).
     */
    for (const stream of activity.sensorStreams ?? []) {
      if (stream.display !== 'chart') continue;
      const series = focusSeries(buildSensorSeries(activity, stream, resolved));
      if (!series.isEmpty) drawn.push({ key: stream.key, series, note: stream.note });
    }

    /*
     * TD-056. One x extent for every chart, so one vertical line reads all of
     * them. Each series used to span its own samples: a pace that starts a few
     * points in was stretched to fill, and its cursor sat somewhere else.
     */
    let xDomain: ChartXDomain | undefined;
    for (const { series } of drawn) {
      if (series.isEmpty) continue;
      xDomain = {
        min: Math.min(xDomain?.min ?? Infinity, series.xMin),
        max: Math.max(xDomain?.max ?? -Infinity, series.xMax),
      };
    }

    // TD-056. One left gutter for every chart, so each plot starts at the same
    // pixel and the shared cursor is one vertical line.
    const gutter = drawn.reduce((widest, { series }) => Math.max(widest, chartGutter(series, units)), 0);

    return {
      focus,
      focused,
      gutter,
      resolved,
      availability: getXAxisAvailability(source),
      drawn,
      xDomain,
      // Only drawn as a band when not focused: once the charts *are* the
      // section, highlighting the whole width would say nothing.
      selectedRange: pointRange ? domainFromPointRange(activity, resolved.axis, pointRange) : undefined,
    };
  }, [activity, pointRange, xAxisPreference, metric, units]);

  const { focus, focused, gutter, resolved, availability, drawn, xDomain, selectedRange } = view;

  const handleSelectRange = (range: ChartRange) => {
    originRef.current = document.activeElement;
    setReleasedNote('');
    // Mapped against the full activity: axis values stay absolute while
    // focused, so a selection made inside a focus is still resolvable.
    setSelectedRange(pointRangeFromDomain(activity, resolved.axis, range.start, range.end));
  };

  /*
   * TD-056. Reset View lives in the section row it clears, so pressing it
   * unmounts it. Focus goes back to the chart the section was kept from (or
   * the first chart), never to the page body, and the release is said.
   */
  const resetView = () => {
    const origin = originRef.current;
    const target =
      origin && origin.isConnected && panelRef.current?.contains(origin)
        ? origin
        : panelRef.current?.querySelector('[role="slider"]');
    if (target instanceof HTMLElement || target instanceof SVGElement) target.focus();
    setSelectedRange(undefined);
    setReleasedNote('Showing the whole activity.');
  };

  // Escape on a chart lets go of the most recent thing kept: the section, or
  // failing that the selected point.
  const clearFromChart = () => (pointRange ? resetView() : onSelectPoint?.(undefined));

  return (
    <section className="chart-panel" aria-label="Activity charts" ref={panelRef}>
      {/*
        AV-512, TD-056. Said when a section is kept or let go, since a keyboard
        reader's Enter or Escape otherwise changes the charts in silence.
        Always mounted, so the change of text is what is heard.
      */}
      <p className="visually-hidden" role="status">
        {focused
          ? `Showing a selected section: ${focused.derived?.pointCount ?? focused.points.length} of ${activity.points.length} points. Your file is unchanged.`
          : releasedNote}
      </p>
      <header className="chart-panel__header">
        <ChartXAxisSwitch
          availability={availability}
          activeMode={resolved.axis}
          onChange={onXAxisChange}
        />
        {isPerformanceMetricSelectable(activity) && (
          <PerformanceMetricSwitch activeMetric={metric} onChange={setPerformanceMetric} />
        )}
        {resolved.fallbackReason && (
          <p className="chart-panel__notice" role="status">
            {resolved.fallbackReason}
          </p>
        )}
      </header>

      {focus && !focus.ok && (
        <p className="chart-panel__notice" role="status">
          {focus.error.hint}
        </p>
      )}

      {drawn.length > 0 && (
        <ChartReadout
          series={drawn.map(({ series }) => series)}
          xAxis={resolved.axis}
          activePointIndex={activePointIndex}
          units={units}
          scaleMax={xDomain?.max}
          hasRoute={hasRoute}
          scope={
            focused ? (
              /*
                AV-511 / AV-512 / AV-605. A view of a section, said as one: its
                own figures, that the file is unchanged, and the way back out,
                all in the sticky readout where the reader is looking.
              */
              <SelectionSummary
                selection={focused}
                totalPoints={activity.points.length}
                units={units}
                metric={metric}
                onReset={resetView}
              />
            ) : (
              <WholeActivityScope points={activity.points.length} />
            )
          }
        />
      )}

      {drawn.map(({ key, series, note }, index) => (
        <ActivityChart
          key={key}
          series={series}
          units={units}
          note={note}
          activePointIndex={activePointIndex}
          {...(focused ? {} : { selectedRange })}
          xDomain={xDomain}
          gutter={gutter}
          // With one shared x extent the axis reads the same on every chart;
          // it is written once, under the last, and the others keep its ticks.
          showXAxisLabels={index === drawn.length - 1}
          onHoverPoint={onHoverPoint}
          onSelectPoint={onSelectPoint}
          onSelectRange={handleSelectRange}
          onClear={clearFromChart}
        />
      ))}
    </section>
  );
}
