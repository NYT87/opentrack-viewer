import type { Activity } from '../domain/activity';
import { MISSING, type UnitSystem } from '../domain/units';
import { StatGrid } from './StatGrid';
import type { PerformanceMetric } from '../domain/performance';
import { buildSummaryStats } from './summaryStats';
import { activityTitle } from '../domain/activityTitle';

/** The id the viewer moves focus to once a file opens (TD-056). */
export const ACTIVITY_TITLE_ID = 'activity-title';

export interface SummaryPanelProps {
  activity: Activity;
  units?: UnitSystem;
  /** AV-908. The metric already resolved against this activity. */
  metric?: PerformanceMetric;
}

/**
 * AV-404. Renders derived stats only — no parser internals, no file paths, no
 * raw coordinates.
 *
 * Always describes the whole activity, never a chart selection: this is the
 * *activity* summary, and numbers that changed with a drag would make
 * "Distance" ambiguous at a glance. A selection gets its own panel (AV-605).
 */
/**
 * TD-057. The figures a reader checks first, set larger: how far, how long, and
 * how fast in the sport's own terms. The bike computer's primary fields.
 *
 * In order of preference: a file that cannot answer one (an indoor session has
 * no distance, so no pace either) leads with the next figure it can, rather
 * than opening on two large dashes.
 */
const LEAD_PREFERENCE = ['distance', 'duration', 'primary', 'movingTime', 'elevationGain', 'avgHeartRate', 'avgPower'];
const LEAD_COUNT = 3;

export function SummaryPanel({ activity, units = 'metric', metric }: SummaryPanelProps) {
  const stats = buildSummaryStats(activity, units, metric);
  const lead = LEAD_PREFERENCE.map((key) => stats.find((stat) => stat.key === key))
    .filter((stat): stat is NonNullable<typeof stat> => stat !== undefined && stat.value !== MISSING)
    .slice(0, LEAD_COUNT);
  const ledKeys = new Set(lead.map((stat) => stat.key));
  // The point count describes the file, not the effort, so it joins the
  // file's source line instead of sitting among the athlete's figures.
  const rest = stats.filter((stat) => !ledKeys.has(stat.key) && stat.key !== 'points');
  const points = stats.find((stat) => stat.key === 'points')?.value;

  return (
    <section className="summary" aria-label="Activity summary">
      <header className="summary__header">
        {/*
          TD-056. Where focus lands when a file opens, so a keyboard or screen
          reader user starts on what they opened rather than on the page body.
          Focusable from script only; it is not a tab stop.
        */}
        <h2 className="summary__title" id={ACTIVITY_TITLE_ID} tabIndex={-1}>
          {activityTitle(activity)}
        </h2>
        <p className="summary__source">
          {activity.source.format.toUpperCase()}
          {activity.source.fileName ? ` · ${activity.source.fileName}` : ''}
          {points ? ` · ${points} ${points === '1' ? 'point' : 'points'}` : ''}
        </p>
      </header>

      <StatGrid stats={lead} variant="lead" />
      <StatGrid stats={rest} />
    </section>
  );
}
