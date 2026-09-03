import type { ActivityError } from '../domain/errors';
import type { ActivityWarning } from '../domain/activity';

export function ErrorPanel({ error, onDismiss }: { error: ActivityError; onDismiss?: () => void }) {
  return (
    <div className="panel panel--error" role="alert">
      <h3 className="panel__title">Could not open this file</h3>
      <p className="panel__message">{error.message}</p>
      <p className="panel__hint">{error.hint}</p>
      <code className="panel__code">{error.code}</code>
      {onDismiss && (
        <button type="button" className="button" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Parser warnings never block the route; they are listed alongside it (§15). */
export function WarningList({ warnings }: { warnings: ActivityWarning[] }) {
  const visible = warnings.filter((warning) => warning.severity !== 'info');
  const infoCount = warnings.length - visible.length;
  if (warnings.length === 0) return null;

  return (
    <details className="warnings">
      <summary className="warnings__summary">
        {visible.length > 0
          ? `${visible.length} parser warning${visible.length === 1 ? '' : 's'}`
          : `${infoCount} parser note${infoCount === 1 ? '' : 's'}`}
      </summary>
      <ul className="warnings__list">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`} className={`warnings__item is-${warning.severity}`}>
            {warning.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
