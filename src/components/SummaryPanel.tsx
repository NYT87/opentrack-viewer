import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { StatGrid } from './StatGrid';
import { buildSummaryStats } from './summaryStats';

export interface SummaryPanelProps {
  activity: Activity;
  units?: UnitSystem;
}

/**
 * AV-404. Renders derived stats only — no parser internals, no file paths, no
 * raw coordinates.
 *
 * Always describes the whole activity, never a chart selection: this is the
 * *activity* summary, and numbers that changed with a drag would make
 * "Distance" ambiguous at a glance. A selection gets its own panel (AV-605).
 */
export function SummaryPanel({ activity, units = 'metric' }: SummaryPanelProps) {
  const stats = buildSummaryStats(activity, units);

  return (
    <section className="summary" aria-label="Activity summary">
      <header className="summary__header">
        <h2 className="summary__title">{activity.metadata.name ?? 'Untitled activity'}</h2>
        <p className="summary__source">
          {activity.source.format.toUpperCase()}
          {activity.source.fileName ? ` · ${activity.source.fileName}` : ''}
        </p>
      </header>

      <StatGrid stats={stats} />
    </section>
  );
}
