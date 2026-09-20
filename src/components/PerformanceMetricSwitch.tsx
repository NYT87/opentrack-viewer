import type { PerformanceMetric } from '../domain/performance';

const LABELS: Record<PerformanceMetric, string> = {
  speed: 'Speed',
  pace: 'Pace',
};

const MODES: PerformanceMetric[] = ['speed', 'pace'];

export interface PerformanceMetricSwitchProps {
  activeMetric: PerformanceMetric;
  onChange: (metric: PerformanceMetric) => void;
}

/**
 * AV-908. Chooses between speed and pace for an activity whose file never said
 * which it was.
 *
 * Rendered only for those activities. A run already reads in pace and a ride in
 * speed because the file said so, and a control offering to change a settled
 * answer would be noise on every activity that is not a video.
 *
 * Switching re-reads nothing: the metric is applied to points and timestamps
 * already in memory, and the video it came from is long since closed.
 */
export function PerformanceMetricSwitch({
  activeMetric,
  onChange,
}: PerformanceMetricSwitchProps) {
  return (
    <div className="axis-switch" role="group" aria-label="Performance metric">
      <span className="axis-switch__label">Show</span>

      {MODES.map((metric) => (
        <button
          key={metric}
          type="button"
          className={`axis-switch__option${activeMetric === metric ? ' is-active' : ''}`}
          aria-pressed={activeMetric === metric}
          onClick={() => onChange(metric)}
        >
          {LABELS[metric]}
        </button>
      ))}
    </div>
  );
}
