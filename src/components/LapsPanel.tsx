import type { ActivityLap } from '../domain/activity';
import { MISSING, formatDistance, formatDuration, type UnitSystem } from '../domain/units';

export interface LapsPanelProps {
  laps: ActivityLap[];
  units?: UnitSystem;
}

/** A lap is worth listing only if it carries something beyond its position. */
export function hasUsefulLaps(laps: ActivityLap[] | undefined): laps is ActivityLap[] {
  return (
    Array.isArray(laps) &&
    laps.some(
      (lap) =>
        Number.isFinite(lap.distanceMeters) ||
        Number.isFinite(lap.durationSeconds) ||
        lap.startTime instanceof Date,
    )
  );
}

/** Duration comes from the field when present, otherwise from the lap's bounds. */
function lapDuration(lap: ActivityLap): number | undefined {
  if (Number.isFinite(lap.durationSeconds)) return lap.durationSeconds;
  if (lap.startTime instanceof Date && lap.endTime instanceof Date) {
    return (lap.endTime.getTime() - lap.startTime.getTime()) / 1000;
  }
  return undefined;
}

/**
 * AV-406. Lists recorded laps. Every column is read from the normalized lap —
 * nothing is inferred or filled in, so a lap with no distance shows the missing
 * marker rather than a number the file never contained.
 *
 * Rows carry `data-lap-index` so lap-to-map/chart highlighting can hook in
 * later without restructuring this.
 */
export function LapsPanel({ laps, units = 'metric' }: LapsPanelProps) {
  // Only formats that state calories get the column, rather than a row of
  // dashes for every GPX file.
  const showCalories = laps.some((lap) => Number.isFinite(lap.caloriesKcal));
  return (
    <section className="laps" aria-label="Laps">
      <h3 className="laps__title">Laps</h3>

      <div className="laps__scroll">
        <table className="laps__table">
          <thead>
            <tr>
              <th scope="col">Lap</th>
              <th scope="col">Distance</th>
              <th scope="col">Time</th>
              {showCalories && <th scope="col">Calories</th>}
            </tr>
          </thead>
          <tbody>
            {laps.map((lap) => (
              <tr key={lap.index} data-lap-index={lap.index}>
                <th scope="row">{lap.index + 1}</th>
                <td>{formatDistance(lap.distanceMeters, units)}</td>
                <td>{lapDuration(lap) === undefined ? MISSING : formatDuration(lapDuration(lap))}</td>
                {showCalories && (
                  <td>{lap.caloriesKcal === undefined ? MISSING : `${Math.round(lap.caloriesKcal)}`}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
