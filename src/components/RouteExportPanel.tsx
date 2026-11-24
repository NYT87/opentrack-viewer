import { useId, useMemo, useState } from 'react';
import type { ActivityWarning } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { canExportDraft, draftToActivity, plannedFileBaseName, type RouteDraft } from '../domain/routeDraft';
import { EXPORT_FORMATS, exportActivity, getExportAvailability, type ExportFormat } from '../exporters';
import { download } from './ExportPanel';

/**
 * What a planned route cannot carry, said before the file is written rather
 * than after. A route has a shape and an elevation profile; it was never
 * timed, so there is nothing else to omit *from* it — but a plan copied from a
 * recording is easy to assume still has the recording's data.
 */
const PLAN_NOTE =
  'A planned route carries its points and elevation only. Timestamps, heart rate, power, ' +
  'laps and device details are never included.';

/**
 * AV-1107. Writes the draft to a file for another device.
 *
 * It goes through the same exporter registry as the viewer's export, so a
 * format is offered here only when its writer can represent the route.
 * Nothing is uploaded: the file is a `Blob` built in this tab and saved by the
 * browser.
 */
export function RouteExportPanel({ draft }: { draft: RouteDraft }) {
  const formatId = useId();
  const [format, setFormat] = useState<ExportFormat>('gpx');
  const [outcome, setOutcome] = useState<{ fileName: string; warnings: ActivityWarning[] }>();
  const [error, setError] = useState<string>();
  const [isWriting, setIsWriting] = useState(false);

  const ready = canExportDraft(draft);
  const activity = useMemo(() => draftToActivity(draft), [draft]);
  const availability = useMemo(() => getExportAvailability(activity), [activity]);
  const chosen = availability.find((entry) => entry.format === format);
  const label = EXPORT_FORMATS.find((entry) => entry.format === format)?.label ?? format;

  /** The registry's reasons speak of "this activity"; here it is a plan. */
  const reasonFor = (reason?: string) => reason?.replace('this activity has', 'a planned route has');

  const handleExport = async () => {
    setIsWriting(true);
    try {
      const result = await exportActivity(activity, { format, baseName: plannedFileBaseName(draft) });
      download(result.blob, result.fileName);
      setOutcome({ fileName: result.fileName, warnings: result.warnings });
      setError(undefined);
    } catch (thrown) {
      setOutcome(undefined);
      setError(thrown instanceof ActivityError ? thrown.message : 'The route could not be exported.');
    } finally {
      setIsWriting(false);
    }
  };

  return (
    <div className="export">
      <h3 className="export__title">Export route</h3>
      <p className="export__body">
        Saves this route as a file you can copy to a watch, bike computer or phone. It is built in
        this tab and saved by your browser — nothing is uploaded.
      </p>

      {!ready && <p className="export__hint">Add at least two points to export a route.</p>}

      <div className="export__controls">
        <div className="export__field">
          <label className="export__label" htmlFor={formatId}>
            Format
          </label>
          <select
            id={formatId}
            className="select"
            value={format}
            onChange={(event) => setFormat(event.target.value as ExportFormat)}
          >
            {availability.map((entry) => (
              <option key={entry.format} value={entry.format} disabled={!entry.available}>
                {entry.label}
                {entry.available ? '' : ' — unavailable'}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void handleExport()}
          disabled={!ready || isWriting || chosen?.available === false}
        >
          {isWriting ? 'Writing…' : `Export as ${label}`}
        </button>
      </div>

      <p className="export__hint">
        {chosen?.available === false ? reasonFor(chosen.reason) : PLAN_NOTE}
      </p>
      {availability.some((entry) => !entry.available) && chosen?.available !== false && (
        <p className="export__hint">
          {availability
            .filter((entry) => !entry.available)
            .map((entry) => `${entry.label}: ${reasonFor(entry.reason)}`)
            .join(' ')}
        </p>
      )}

      {error && (
        <p className="export__error" role="alert">
          {error}
        </p>
      )}

      {outcome && (
        <div className="export__result" role="status">
          <p className="export__saved">
            Saved <strong>{outcome.fileName}</strong>.
          </p>
          {outcome.warnings.length > 0 && (
            <ul className="export__warnings">
              {outcome.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
