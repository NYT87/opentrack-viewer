import type { Activity, ChartXAxisMode } from '../domain/activity';
import { getVisibleCharts, type ActivityChartKind } from '../domain/charts';
import { buildSeries, getXAxisAvailability, resolveXAxis, type ChartSeriesKey } from '../domain/series';
import type { UnitSystem } from '../domain/units';
import { ActivityChart } from './ActivityChart';
import { ChartXAxisSwitch } from './ChartXAxisSwitch';

/**
 * AV-506. GPX and FIT both record running cadence in a single field, but
 * devices disagree on whether it counts one foot or two. The value is shown as
 * recorded and the unit is named explicitly rather than silently doubled, so a
 * reader can tell which convention their device used.
 */
const CADENCE_NOTE =
  'Shown as recorded. Some devices report strides per minute (one foot) rather than steps per minute.';

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
  const availability = getXAxisAvailability(activity);
  const resolved = resolveXAxis(activity, xAxisPreference);
  const charts = getVisibleCharts(activity);

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

      {charts.map((chart) =>
        chart.available ? (
          <ActivityChart
            key={chart.kind}
            series={buildSeries(activity, chart.kind as ChartSeriesKey, resolved)}
            units={units}
            note={chart.kind === 'cadence' ? CADENCE_NOTE : undefined}
            activePointIndex={activePointIndex}
            onHoverPoint={onHoverPoint}
            onSelectPoint={onSelectPoint}
          />
        ) : (
          <UnavailableChart key={chart.kind} kind={chart.kind} label={chart.label} reason={chart.unavailableReason} />
        ),
      )}
    </section>
  );
}
