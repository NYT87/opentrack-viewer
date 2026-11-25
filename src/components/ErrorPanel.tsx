import type { ActivityError } from '../domain/errors';
import type { ActivityWarning } from '../domain/activity';

export function ErrorPanel({
  error,
  onDismiss,
  fileName,
}: {
  error: ActivityError;
  onDismiss?: () => void;
  /** Named, so a reader who has tried several files knows which one failed. */
  fileName?: string;
}) {
  return (
    <div className="panel panel--error" role="alert">
      <h3 className="panel__title">{fileName ? `Could not open ${fileName}` : 'Could not open this file'}</h3>
      <p className="panel__message">{error.message}</p>
      <p className="panel__hint">{error.hint}</p>
      {/* For a bug report, said as such: a bare code chip reads as something to act on. */}
      <p className="panel__code-line">
        Code for a bug report: <code className="panel__code">{error.code}</code>
      </p>
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
