import type { ActivityLap } from '../domain/activity';
import { MISSING, formatDistance, formatDuration, type UnitSystem } from '../domain/units';
import { useInteractionStore } from '../state/interactionStore';

export interface LapsPanelProps {
  /**
   * Laps that can be picked out on the map. A lap whose points straddle a
   * pause has no line to draw; its row still shows its figures, but offers no
   * control, because a control that does nothing is worse than none.
   *
   * Omitted means every lap can be highlighted, which is what a caller with no
   * map to draw on wants.
   */
  highlightable?: ReadonlySet<number>;
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
 * A row is a toggle, not a link: pressing it picks that lap out on the map and
 * pressing it again puts it back. It deliberately does **not** move the map —
 * a lap is a marker within the activity, not a request to look somewhere else,
 * which is what separates it from a chart range selection.
 */
/** Why a lap can carry figures and still have nothing to show on the map. */
const NOT_DRAWABLE =
  'This lap has no continuous stretch of route to highlight: its points sit either side of a ' +
  'recording gap.';

export function LapsPanel({ laps, units = 'metric', highlightable }: LapsPanelProps) {
  const selectedLapIndex = useInteractionStore((state) => state.selectedLapIndex);
  const setSelectedLapIndex = useInteractionStore((state) => state.setSelectedLapIndex);
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
            {laps.map((lap) => {
              const isSelected = lap.index === selectedLapIndex;
              const canHighlight = highlightable?.has(lap.index) ?? true;
              return (
              <tr
                key={lap.index}
                data-lap-index={lap.index}
                className={isSelected ? 'laps__row is-selected' : 'laps__row'}
              >
                <th scope="row">
                  {canHighlight ? (
                    <button
                      type="button"
                      className="laps__select"
                      aria-pressed={isSelected}
                      // The cell shows a number; the name says what pressing it
                      // does, so the control is not just "1" to a screen reader.
                      aria-label={`${isSelected ? 'Stop highlighting' : 'Highlight'} lap ${lap.index + 1}`}
                      onClick={() => setSelectedLapIndex(isSelected ? undefined : lap.index)}
                    >
                      {lap.index + 1}
                    </button>
                  ) : (
                    <span className="laps__number" title={NOT_DRAWABLE}>
                      {lap.index + 1}
                    </span>
                  )}
                </th>
                <td>{formatDistance(lap.distanceMeters, units)}</td>
                <td>{lapDuration(lap) === undefined ? MISSING : formatDuration(lapDuration(lap))}</td>
                {showCalories && (
                  <td>{lap.caloriesKcal === undefined ? MISSING : `${Math.round(lap.caloriesKcal)}`}</td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
