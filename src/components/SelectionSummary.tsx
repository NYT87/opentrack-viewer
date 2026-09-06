import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { StatGrid } from './StatGrid';
import { buildSummaryStats } from './summaryStats';

export interface SelectionSummaryProps {
  /** The slice of the activity the chart selection describes. */
  selection: Activity;
  /** How many points the whole activity has, for context. */
  totalPoints: number;
  units?: UnitSystem;
}

/**
 * AV-605. What the selected section adds up to.
 *
 * A separate, labelled panel rather than figures inside the activity summary.
 * Making the summary's numbers change with a drag would leave "Distance"
 * ambiguous at a glance — the reader could no longer tell whether they were
 * looking at the ride or at a hill inside it. Two panels, each saying plainly
 * what it describes, answers the same question without that cost.
 *
 * Every figure is built by the same code as the activity summary, so a value is
 * formatted — and a missing one explained — identically in both.
 */
export function SelectionSummary({ selection, totalPoints, units }: SelectionSummaryProps) {
  const stats = buildSummaryStats(selection, units).filter((stat) => SHOWN.has(stat.key));
  const points = selection.derived?.pointCount ?? selection.points.length;

  return (
    <section className="selection-summary" aria-label="Selected section summary">
      <header className="selection-summary__header">
        <h3 className="selection-summary__title">Selected section</h3>
        <p className="selection-summary__scope">
          {points} of {totalPoints} points
        </p>
      </header>

      <StatGrid stats={stats} />
    </section>
  );
}

/**
 * The figures AV-605 asks for, plus the sport's primary performance metric —
 * the reason for selecting a climb in the first place is usually to ask how
 * fast it was climbed. Point counts and file metadata stay out: they describe
 * the file, not the section.
 */
const SHOWN = new Set([
  'distance',
  'duration',
  'movingTime',
  'primary',
  'elevationGain',
  'start',
  'end',
]);
