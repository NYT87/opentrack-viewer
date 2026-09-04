import type { Activity, ChartXAxisMode } from './activity';
import { getXAxisAvailability } from './series';

/** Every metric the chart panel knows how to plot. */
export type ActivityChartKind =
  | 'elevation'
  | 'pace'
  | 'speed'
  | 'cadence'
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
 * the data supports them. Heart rate, power and temperature are modelled here
 * so availability is uniform, but are not offered in the UI yet — they arrive
 * with the FIT sensor work (AV-704).
 */
export const VISIBLE_CHART_KINDS: ActivityChartKind[] = [
  'elevation',
  'pace',
  'speed',
  'cadence',
];

const LABELS: Record<ActivityChartKind, string> = {
  elevation: 'Elevation',
  pace: 'Pace',
  speed: 'Speed',
  cadence: 'Cadence',
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
export function getChartAvailability(activity: Activity): ActivityChartDefinition[] {
  const axes = getXAxisAvailability(activity);
  const supportedXAxisModes = axes.filter((axis) => axis.available).map((axis) => axis.mode);
  const hasDistance = supportedXAxisModes.includes('distance');
  const hasTime = supportedXAxisModes.includes('time');
  const defaultXAxisMode: ChartXAxisMode = hasDistance ? 'distance' : 'time';
  const running = isRunning(activity);
  const cycling = isCycling(activity);

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
      running && hasDistance && hasTime,
      !running
        ? 'Pace is shown for running activities.'
        : 'Pace needs both distance and timestamps.',
    ),
    define(
      // AV-513: speed answers for cycling what pace answers for running.
      'speed',
      cycling && (streams.hasSpeed || (hasDistance && hasTime)),
      !cycling
        ? 'Speed is shown for cycling activities.'
        : 'Speed needs recorded speed, or both distance and timestamps.',
    ),
    define(
      'cadence',
      running && streams.hasRunningCadence,
      !running
        ? 'Cadence is shown for running activities.'
        : 'This activity has no cadence data.',
    ),
    define('heartRate', streams.hasHeartRate, 'This activity has no heart rate data.'),
    define('power', streams.hasPower, 'This activity has no power data.'),
    define('temperature', streams.hasTemperature, 'This activity has no temperature data.'),
  ];
}

/** The charts the panel should render, in display order. */
export function getVisibleCharts(activity: Activity): ActivityChartDefinition[] {
  const availability = getChartAvailability(activity);
  return VISIBLE_CHART_KINDS.map(
    (kind) => availability.find((entry) => entry.kind === kind)!,
  );
}
