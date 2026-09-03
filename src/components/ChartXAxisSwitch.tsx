import type { ChartXAxisMode } from '../domain/activity';
import type { XAxisAvailability } from '../domain/series';

const LABELS: Record<ChartXAxisMode, string> = {
  distance: 'Distance',
  time: 'Time',
};

export interface ChartXAxisSwitchProps {
  availability: XAxisAvailability[];
  /** The axis actually in use, which may differ from the user's preference. */
  activeMode: ChartXAxisMode | 'index';
  onChange: (mode: ChartXAxisMode) => void;
}

/**
 * AV-504. Chooses the x-axis for every chart in the panel. Modes the loaded
 * activity cannot support are disabled with the reason attached, rather than
 * hidden — a missing control is harder to understand than a disabled one.
 */
export function ChartXAxisSwitch({ availability, activeMode, onChange }: ChartXAxisSwitchProps) {
  return (
    <div className="axis-switch" role="group" aria-label="Chart x-axis">
      <span className="axis-switch__label">X-axis</span>

      {availability.map((entry) => (
        <button
          key={entry.mode}
          type="button"
          className={`axis-switch__option${activeMode === entry.mode ? ' is-active' : ''}`}
          disabled={!entry.available}
          aria-pressed={activeMode === entry.mode}
          title={entry.reason}
          onClick={() => onChange(entry.mode)}
        >
          {LABELS[entry.mode]}
        </button>
      ))}
    </div>
  );
}
