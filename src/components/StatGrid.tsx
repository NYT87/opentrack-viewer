import { MISSING } from '../domain/units';
import type { Stat } from './summaryStats';

/**
 * AV-404 / AV-605. Renders derived stats, explaining an absent value rather
 * than showing a bare dash. Shared by the activity summary and the selected
 * section so the two cannot drift apart.
 */
export function StatGrid({
  stats,
  variant = 'grid',
}: {
  stats: Stat[];
  /**
   * `inline`: the same captions over figures, set in one row that scrolls
   * sideways, for the selected section inside the chart readout (TD-056).
   * `lead`: the overview's first few figures, set larger (TD-057).
   */
  variant?: 'grid' | 'inline' | 'lead';
}) {
  return (
    <dl className={variant === 'grid' ? 'summary__grid' : `summary__grid summary__grid--${variant}`}>
      {stats.map((stat) => (
        <div key={stat.key} className="summary__stat">
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
  );
}
