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

export interface Stat {
  /** Stable across activities, so a panel can pick the ones it wants. */
  key: string;
  label: string;
  value: string;
  /** Why the value is absent, shown in place of a bare dash. */
  missingReason?: string;
}

/**
 * AV-404 / AV-605. The one place derived stats become display strings.
 *
 * Shared so that a panel describing a selected section formats every figure —
 * and explains every missing one — exactly as the activity summary does, rather
 * than growing its own conventions.
 */
export function buildSummaryStats(activity: Activity, units: UnitSystem = 'metric'): Stat[] {
  const derived = activity.derived;
  // Pace is a running convention. Anything else — cycling, or a file that never
  // said what it was — gets speed, which is meaningful for any movement.
  const usePace = activity.metadata.sport === 'running';
  const stats: Stat[] = [
    {
      key: 'distance',
      label: 'Distance',
      value: formatDistance(derived?.distanceMeters, units),
      missingReason: activity.streams.hasLocation ? undefined : 'No GPS data',
    },
    {
      key: 'duration',
      label: 'Duration',
      value: formatDuration(derived?.durationSeconds),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    {
      key: 'movingTime',
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
        ? { key: 'primary', label: 'Avg pace', value: formatPace(derived?.averagePaceSecondsPerKm, units) }
        : { key: 'primary', label: 'Avg speed', value: formatSpeed(derived?.averageSpeedMetersPerSecond, units) }),
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
      key: 'elevationGain',
      label: 'Elevation gain',
      value: formatElevation(derived?.elevationGainMeters, units),
      missingReason: activity.streams.hasElevation ? undefined : 'No elevation data',
    },
    {
      key: 'elevationLoss',
      label: 'Elevation loss',
      value: formatElevation(derived?.elevationLossMeters, units),
      missingReason: activity.streams.hasElevation ? undefined : 'No elevation data',
    },
    {
      key: 'start',
      label: 'Start',
      value: formatDateTime(derived?.startTime),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    {
      key: 'end',
      label: 'End',
      value: formatDateTime(derived?.endTime),
      missingReason: activity.streams.hasTime ? undefined : 'No timestamps',
    },
    { key: 'points', label: 'Points', value: String(derived?.pointCount ?? activity.points.length) },
  ];

  if (activity.streams.hasHeartRate) {
    stats.push({
      key: 'avgHeartRate',
      label: 'Avg heart rate',
      value: formatOptionalInt(derived?.averageHeartRateBpm, 'bpm'),
    });
  }
  if (activity.streams.hasPower) {
    stats.push({
      key: 'avgPower',
      label: 'Avg power',
      value: formatOptionalInt(derived?.averagePowerWatts, 'W'),
    });
  }
  return stats;
}

function formatOptionalInt(value: number | undefined, unit: string): string {
  return Number.isFinite(value) ? `${Math.round(value as number)} ${unit}` : MISSING;
}
