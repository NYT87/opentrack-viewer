import { MISSING } from '../domain/units';
import type { Stat } from './summaryStats';

/**
 * AV-404 / AV-605. Renders derived stats, explaining an absent value rather
 * than showing a bare dash. Shared by the activity summary and the selected
 * section so the two cannot drift apart.
 */
export function StatGrid({ stats }: { stats: Stat[] }) {
  return (
    <dl className="summary__grid">
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
