import type { Activity, ChartXAxisMode } from './activity';
import {
  isAmbiguousSport,
  resolvePerformanceMetric,
  type PerformanceMetric,
} from './performance';
import { getXAxisAvailability } from './series';

/** Every metric the chart panel knows how to plot. */
export type ActivityChartKind =
  | 'elevation'
  | 'pace'
  | 'speed'
  | 'cadence'
  | 'cyclingCadence'
  | 'heartRate'
  | 'power'
  | 'temperature';

export interface ActivityChartDefinition {
  kind: ActivityChartKind;
  label: string;
  available: boolean;
  unavailableReason?: string;
  defaultXAxisMode: ChartXAxisMode;
  supportedXAxisModes: ChartXAxisMode[];
}

/**
 * §18 guardrail: one chart panel, elevation first, then run pace/cadence when
 * the data supports them.
 *
 * AV-704: heart rate, power and temperature joined the list with FIT support.
 * Nothing about their availability rules changed to allow it — they were always
 * modelled here, and a GPX file with the same extensions gets the same charts.
 * Order runs from the shape of the route to the body to the environment.
 */
export const VISIBLE_CHART_KINDS: ActivityChartKind[] = [
  'elevation',
  'pace',
  'speed',
  'cadence',
  'cyclingCadence',
  'heartRate',
  'power',
  'temperature',
];

const LABELS: Record<ActivityChartKind, string> = {
  elevation: 'Elevation',
  pace: 'Pace',
  speed: 'Speed',
  cadence: 'Cadence',
  // Named apart from running cadence, because a ride shows both entries: the
  // running one explaining why it is empty, this one carrying the data. Two
  // charts called "Cadence" would be a puzzle rather than a pair.
  cyclingCadence: 'Pedal cadence',
  heartRate: 'Heart rate',
  power: 'Power',
  temperature: 'Temperature',
};

function isRunning(activity: Activity): boolean {
  return activity.metadata.sport === 'running';
}

function isCycling(activity: Activity): boolean {
  return activity.metadata.sport === 'cycling';
}

/**
 * AV-507. The single place that decides which charts an activity can show.
 * Every rule reads the normalized activity — never the source file format — so
 * a FIT run and a GPX run get the same answer.
 */
export function getChartAvailability(
  activity: Activity,
  /**
   * AV-908. The metric **already resolved**, not a raw preference.
   *
   * Resolved by the caller and passed in, because availability is often asked
   * about a focused slice while the choice belongs to the whole activity: a
   * selection too short to have a pace cannot answer "pace or speed", and
   * re-resolving against it would silently swap the chart under a switch still
   * pressed on the other one.
   */
  metric: PerformanceMetric = resolvePerformanceMetric(activity),
): ActivityChartDefinition[] {
  const axes = getXAxisAvailability(activity);
  const supportedXAxisModes = axes.filter((axis) => axis.available).map((axis) => axis.mode);
  const hasDistance = supportedXAxisModes.includes('distance');
  const hasTime = supportedXAxisModes.includes('time');
  const defaultXAxisMode: ChartXAxisMode = hasDistance ? 'distance' : 'time';
  const running = isRunning(activity);
  const cycling = isCycling(activity);

  /*
   * AV-908. A file that never said what it was gets whichever of the two the
   * reader asked for. A file that did say keeps exactly what it always showed:
   * this adds a choice where there was none, rather than re-opening settled
   * ones. A camera is the case in point — it records a moving track and cannot
   * know whether it was running, riding or driving.
   */
  const ambiguous = isAmbiguousSport(activity);
  const otherMetric = (kind: 'pace' | 'speed') =>
    `Showing ${kind === 'pace' ? 'speed' : 'pace'} for this activity. ` +
    `Switch to ${kind} to chart it.`;

  const define = (
    kind: ActivityChartKind,
    available: boolean,
    unavailableReason?: string,
  ): ActivityChartDefinition => ({
    kind,
    label: LABELS[kind],
    available,
    ...(available ? {} : { unavailableReason }),
    defaultXAxisMode,
    supportedXAxisModes,
  });

  const { streams } = activity;

  return [
    define(
      'elevation',
      streams.hasElevation,
      'This activity has no elevation data.',
    ),
    define(
      'pace',
      (running || (ambiguous && metric === 'pace')) && hasDistance && hasTime,
      ambiguous
        ? metric === 'pace'
          ? 'Pace needs both distance and timestamps.'
          : otherMetric('pace')
        : running
          ? 'Pace needs both distance and timestamps.'
          : 'Pace is shown for running activities.',
    ),
    define(
      // AV-513: speed answers for cycling what pace answers for running.
      'speed',
      (cycling || (ambiguous && metric === 'speed')) && (streams.hasSpeed || (hasDistance && hasTime)),
      ambiguous
        ? metric === 'speed'
          ? 'Speed needs recorded speed, or both distance and timestamps.'
          : otherMetric('speed')
        : cycling
          ? 'Speed needs recorded speed, or both distance and timestamps.'
          : 'Speed is shown for cycling activities.',
    ),
    define(
      'cadence',
      running && streams.hasRunningCadence,
      !running
        ? 'Cadence is shown for running activities.'
        : 'This activity has no cadence data.',
    ),
    define(
      // Pedal revolutions, for rides that record them.
      'cyclingCadence',
      cycling && streams.hasCyclingCadence,
      !cycling
        ? 'Pedal cadence is shown for cycling activities.'
        : 'This activity has no cadence data.',
    ),
    define('heartRate', streams.hasHeartRate, 'This activity has no heart rate data.'),
    define('power', streams.hasPower, 'This activity has no power data.'),
    define('temperature', streams.hasTemperature, 'This activity has no temperature data.'),
  ];
}

/** The charts the panel should render, in display order. */
export function getVisibleCharts(
  activity: Activity,
  metric?: PerformanceMetric,
): ActivityChartDefinition[] {
  const availability = getChartAvailability(activity, metric);
  return VISIBLE_CHART_KINDS.map(
    (kind) => availability.find((entry) => entry.kind === kind)!,
  );
}
