import type { Activity } from '../domain/activity';
import {
  MISSING,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  type UnitSystem,
} from '../domain/units';

export interface SummaryPanelProps {
  activity: Activity;
  units?: UnitSystem;
}

interface Stat {
  label: string;
  value: string;
  /** Why the value is absent, shown in place of a bare dash. */
  missingReason?: string;
}

/**
 * AV-404. Renders derived stats only — no parser internals, no file paths, no
 * raw coordinates.
 */
export function SummaryPanel({ activity, units = 'metric' }: SummaryPanelProps) {
  const derived = activity.derived;
  // Pace is a running convention. Anything else — cycling, or a file that never
  // said what it was — gets speed, which is meaningful for any movement.
  const usePace = activity.metadata.sport === 'running';
  const stats: Stat[] = [
    {
      label: 'Distance',
      value: formatDistance(derived?.distanceMeters, units),
      missingReason: activity.streams.hasLocation ? undefined : 'No GPS data',
    },
    {
      label: 'Duration',
      value: formatDuration(derived?.durationSeconds),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    {
      label: 'Moving time',
      value: formatDuration(derived?.movingDurationSeconds),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    {
      /*
       * The overview's primary performance metric is sport-aware: runners read
       * a workout in minutes per kilometre, riders in kilometres per hour. Only
       * one is shown, because every stat in this grid carries equal weight —
       * showing both would make both primary.
       */
      ...(usePace
        ? { label: 'Avg pace', value: formatPace(derived?.averagePaceSecondsPerKm, units) }
        : { label: 'Avg speed', value: formatSpeed(derived?.averageSpeedMetersPerSecond, units) }),
      missingReason: !(activity.streams.hasLocation && activity.streams.hasTime)
        ? 'Needs distance and timestamps'
        : /*
           * A run that covered no ground has no pace — you cannot spend a
           * finite time per kilometre without covering one — but it does have
           * the data needed to work that out, so the reason above would be a
           * lie. Speed has no such gap: standing still is 0 km/h.
           */
          usePace && derived?.averagePaceSecondsPerKm === undefined
          ? 'No distance covered'
          : undefined,
    },
    {
      label: 'Elevation gain',
      value: formatElevation(derived?.elevationGainMeters, units),
      missingReason: activity.streams.hasElevation ? undefined : 'No elevation data',
    },
    {
      label: 'Elevation loss',
      value: formatElevation(derived?.elevationLossMeters, units),
      missingReason: activity.streams.hasElevation ? undefined : 'No elevation data',
    },
    {
      label: 'Start',
      value: formatDateTime(derived?.startTime),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    {
      label: 'End',
      value: formatDateTime(derived?.endTime),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    { label: 'Points', value: String(derived?.pointCount ?? activity.points.length) },
  ];

  if (activity.streams.hasHeartRate) {
    stats.push({
      label: 'Avg heart rate',
      value: formatOptionalInt(derived?.averageHeartRateBpm, 'bpm'),
    });
  }
  if (activity.streams.hasPower) {
    stats.push({
      label: 'Avg power',
      value: formatOptionalInt(derived?.averagePowerWatts, 'W'),
    });
  }

  return (
    <section className="summary" aria-label="Activity summary">
      <header className="summary__header">
        <h2 className="summary__title">{activity.metadata.name ?? 'Untitled activity'}</h2>
        <p className="summary__source">
          {activity.source.format.toUpperCase()}
          {activity.source.fileName ? ` · ${activity.source.fileName}` : ''}
        </p>
      </header>

      <dl className="summary__grid">
        {stats.map((stat) => (
          <div key={stat.label} className="summary__stat">
            <dt className="summary__label">{stat.label}</dt>
            <dd className="summary__value">
              {stat.value === MISSING && stat.missingReason ? (
                <span className="summary__missing" title={stat.missingReason}>
                  {MISSING} <small>{stat.missingReason}</small>
                </span>
              ) : (
                stat.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function formatOptionalInt(value: number | undefined, unit: string): string {
  return Number.isFinite(value) ? `${Math.round(value as number)} ${unit}` : MISSING;
}
