import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { StatGrid } from './StatGrid';
import type { PerformanceMetric } from '../domain/performance';
import { buildSummaryStats } from './summaryStats';

export interface SelectionSummaryProps {
  /** The slice of the activity the chart selection describes. */
  selection: Activity;
  /** How many points the whole activity has, for context. */
  totalPoints: number;
  units?: UnitSystem;
  /**
   * AV-908. The metric already resolved against the *whole* activity, so a
   * short selection reads the same way as the charts above it.
   */
  metric?: PerformanceMetric;
  /** AV-512. Clears the selection; the button sits at the end of the row. */
  onReset?: () => void;
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
export function SelectionSummary({
  selection,
  totalPoints,
  units,
  metric,
  onReset,
}: SelectionSummaryProps) {
  const stats = buildSummaryStats(selection, units, metric).filter((stat) => SHOWN.has(stat.key));
  const points = selection.derived?.pointCount ?? selection.points.length;

  /*
   * TD-056. One row of the sticky chart readout rather than a panel inserted
   * above the charts: selecting no longer pushes the chart just used down the
   * page, and the section's figures and the way back out stay on screen while
   * the charts scroll under them.
   */
  return (
    <section className="selection-summary" aria-label="Selected section summary">
      <header className="selection-summary__header">
        <h3 className="selection-summary__title">Selected section</h3>
        <p className="selection-summary__scope">
          {points} of {totalPoints} points
        </p>
        {/* AV-512: said where the narrowed view is, not left for the reader to infer. */}
        <p className="selection-summary__note">Your file is unchanged.</p>
      </header>

      <StatGrid stats={stats} variant="inline" />

      {onReset && (
        <button type="button" className="button selection-summary__reset" onClick={onReset}>
          Reset View
        </button>
      )}
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
