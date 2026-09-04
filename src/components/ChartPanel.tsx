import type { Activity, ChartXAxisMode } from '../domain/activity';
import { domainFromPointRange, pointRangeFromDomain } from '../domain/range';
import { useInteractionStore } from '../state/interactionStore';
import { sliceActivity } from '../domain/activitySlice';
import { getVisibleCharts, type ActivityChartKind } from '../domain/charts';
import {
  buildSeries,
  getXAxisAvailability,
  resolveXAxis,
  restrictSeries,
  type ChartSeriesKey,
} from '../domain/series';
import type { UnitSystem } from '../domain/units';
import { ActivityChart, type ChartRange } from './ActivityChart';
import { ChartXAxisSwitch } from './ChartXAxisSwitch';

/**
 * AV-515. Running cadence is strides per minute — one foot — which is what
 * watches and foot pods report. Said once here rather than left for the reader
 * to infer from a bare number.
 */
const CADENCE_NOTE = 'Strides per minute: one foot, as watches and foot pods report it.';

function UnavailableChart({
  kind,
  label,
  reason,
}: {
  kind: ActivityChartKind;
  label: string;
  reason?: string;
}) {
  return (
    <section className="chart chart--empty" aria-label={`${label} chart`} data-kind={kind}>
      <h3 className="chart__title">{label}</h3>
      <p className="chart__empty">{reason}</p>
    </section>
  );
}

export interface ChartPanelProps {
  activity: Activity;
  /** The user's session preference; may not be available for this activity. */
  xAxisPreference?: ChartXAxisMode;
  onXAxisChange: (mode: ChartXAxisMode) => void;
  units?: UnitSystem;
  activePointIndex?: number;
  onHoverPoint?: (pointIndex: number | undefined) => void;
  onSelectPoint?: (pointIndex: number | undefined) => void;
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
}: ChartPanelProps) {
  // Declared before the selection so the focus can be derived from it below.
  const availabilitySourceFor = (source: Activity) => ({
    availability: getXAxisAvailability(source),
    resolved: resolveXAxis(source, xAxisPreference),
    charts: getVisibleCharts(source),
  });

  /**
   * AV-508 / AV-509 / AV-601. The selection lives in shared state, in
   * `point.index` terms rather than as a span of whichever axis was showing.
   * That is what lets it survive a switch between distance and time, and what
   * lets the map follow it (AV-604). Loading a file resets it.
   */
  const pointRange = useInteractionStore((state) => state.selectedRange);
  const setSelectedRange = useInteractionStore((state) => state.setSelectedRange);

  /**
   * AV-511. A valid selection produces a focused activity, and the charts are
   * then drawn from it: availability is recalculated against the slice, so a
   * section without cadence stops offering a cadence chart.
   */
  const focus = pointRange ? sliceActivity(activity, pointRange) : undefined;
  const focused = focus?.ok ? focus.activity : undefined;
  const { availability, resolved, charts } = availabilitySourceFor(focused ?? activity);

  // Only drawn as a band when not focused: once the charts *are* the section,
  // highlighting the whole width would say nothing.
  const selectedRange: ChartRange | undefined = pointRange
    ? domainFromPointRange(activity, resolved.axis, pointRange)
    : undefined;

  const handleSelectRange = (range: ChartRange) => {
    // Mapped against the full activity: axis values stay absolute while
    // focused, so a selection made inside a focus is still resolvable.
    setSelectedRange(pointRangeFromDomain(activity, resolved.axis, range.start, range.end));
  };

  const resetView = () => setSelectedRange(undefined);

  return (
    <section className="chart-panel" aria-label="Activity charts">
      <header className="chart-panel__header">
        <ChartXAxisSwitch
          availability={availability}
          activeMode={resolved.axis}
          onChange={onXAxisChange}
        />
        {resolved.fallbackReason && (
          <p className="chart-panel__notice" role="status">
            {resolved.fallbackReason}
          </p>
        )}
      </header>

      {/*
        AV-511 / AV-512. States plainly that this is a view of a section, not a
        change to the file, and offers the way back.
      */}
      {focused && (
        <div className="focus-bar" role="status">
          <span className="focus-bar__text">
            Showing a selected section of this activity. Your file is unchanged.
          </span>
          <button type="button" className="button" onClick={resetView}>
            Reset View
          </button>
        </div>
      )}

      {focus && !focus.ok && (
        <p className="chart-panel__notice" role="status">
          {focus.error.hint}
        </p>
      )}

      {charts.map((chart) =>
        chart.available ? (
          <ActivityChart
            key={chart.kind}
            series={(() => {
              const series = buildSeries(activity, chart.kind as ChartSeriesKey, resolved);
              return pointRange && focused ? restrictSeries(series, pointRange) : series;
            })()}
            units={units}
            note={chart.kind === 'cadence' ? CADENCE_NOTE : undefined}
            activePointIndex={activePointIndex}
            {...(focused ? {} : { selectedRange })}
            onHoverPoint={onHoverPoint}
            onSelectPoint={onSelectPoint}
            onSelectRange={handleSelectRange}
          />
        ) : (
          <UnavailableChart key={chart.kind} kind={chart.kind} label={chart.label} reason={chart.unavailableReason} />
        ),
      )}
    </section>
  );
}
