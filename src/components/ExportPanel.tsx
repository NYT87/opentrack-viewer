import { useId, useMemo, useState } from 'react';
import type { Activity, ActivityPointRange, ActivityWarning } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import {
  EXPORT_FORMATS,
  exportActivity,
  getExportAvailability,
  type ExportFormat,
} from '../exporters';
import { isJoinedRecording } from '../domain/mergeTracks';

export interface ExportPanelProps {
  activity: Activity;
  /** The chart selection, when there is one (AV-509). */
  selectedRange?: ActivityPointRange;
}

interface Outcome {
  fileName: string;
  warnings: ActivityWarning[];
}

/**
 * AV-554. Writes the loaded activity to a file.
 *
 * The download is produced from a `Blob` built in this tab and handed to the
 * browser's own download mechanism: nothing is uploaded, and no server is
 * involved in producing the file (plan §5).
 */
export function ExportPanel({ activity, selectedRange }: ExportPanelProps) {
  const formatId = useId();
  /*
   * AV-555. An ordinary file defaults to its source format. A merged activity
   * prefers FIT so its lap boundaries survive. A rewrite is not a copy: every
   * export is serialized from the parsed activity.
   */
  const sourceFormat = EXPORT_FORMATS.find(
    (entry) => entry.format === activity.source.format,
  )?.format;
  // What the reader picked, if anything. The format actually offered is derived
  // below, because a pick can stop being writable (a section with no
  // coordinates cannot be a GPX) without the reader doing anything.
  const [picked, setFormat] = useState<ExportFormat | undefined>();
  const [wantsSection, setWantsSection] = useState(true);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const [error, setError] = useState<string | undefined>();
  // A format whose writer is loaded on demand (FIT) takes a moment the first
  // time. Without this the button looks inert on a slow connection.
  const [isWriting, setIsWriting] = useState(false);

  // Derived rather than synchronized: when the selection is cleared the choice
  // simply stops applying, with no state to keep in step.
  const exportsSection = Boolean(selectedRange) && wantsSection;

  /*
   * AV-555. A format this activity cannot be written to is offered as a
   * disabled option carrying its reason, rather than as a control that fails
   * on press. Computed for what is actually about to be written, so a section
   * with no coordinates disables GPX even when the whole ride has them.
   */
  const availability = useMemo(
    () => getExportAvailability(activity, exportsSection ? selectedRange : undefined),
    [activity, exportsSection, selectedRange],
  );
  /*
   * The format offered: the reader's pick while it can be written, then the
   * preferred format, source format, or first writable format. A file with
   * no coordinates used to open on "GPX (same format) — unavailable" over a
   * disabled button; now it opens on something it can write. Only when nothing
   * can be written does an unavailable format stay selected, with its reason.
   */
  const writable = (candidate: ExportFormat | undefined) =>
    availability.find((entry) => entry.format === candidate)?.available === true;
  // A merged activity has lap boundaries at its source files. FIT can carry
  // them; GPX cannot, even when the files that made the merge were GPX.
  const preferredFormat = isJoinedRecording(activity) ? 'fit' : sourceFormat;
  const format: ExportFormat = writable(picked)
    ? picked!
    : writable(preferredFormat)
      ? preferredFormat!
      : writable(sourceFormat)
        ? sourceFormat!
        : (availability.find((entry) => entry.available)?.format ?? picked ?? sourceFormat ?? EXPORT_FORMATS[0]!.format);
  const chosen = availability.find((entry) => entry.format === format);
  const isUnavailable = chosen?.available === false;
  const label = EXPORT_FORMATS.find((entry) => entry.format === format)?.label ?? format;
  const isRewrite = format === sourceFormat;

  const handleExport = async () => {
    setIsWriting(true);
    try {
      const result = await exportActivity(activity, {
        format,
        ...(exportsSection ? { range: selectedRange } : {}),
      });

      download(result.blob, result.fileName);
      setOutcome({ fileName: result.fileName, warnings: result.warnings });
      setError(undefined);
    } catch (thrown) {
      setOutcome(undefined);
      setError(
        thrown instanceof ActivityError
          ? thrown.message
          : 'The activity could not be exported.',
      );
    } finally {
      setIsWriting(false);
    }
  };

  return (
    <div className="export">
      <h2 className="export__title">Export</h2>
      <p className="export__body">
        Writes a new file from the activity you have open. The file is built in this tab and
        saved by your browser — nothing is uploaded.
      </p>

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
                {entry.format === sourceFormat ? `${entry.label} (same format)` : entry.label}
                {entry.available ? '' : ' — unavailable'}
              </option>
            ))}
          </select>
        </div>

        {selectedRange && (
          <fieldset className="export__field export__scope">
            <legend className="export__label">What to write</legend>
            <label className="export__choice">
              <input
                type="radio"
                name="export-scope"
                checked={!wantsSection}
                onChange={() => setWantsSection(false)}
              />
              Whole activity
            </label>
            <label className="export__choice">
              <input
                type="radio"
                name="export-scope"
                checked={wantsSection}
                onChange={() => setWantsSection(true)}
              />
              Selected section
            </label>
          </fieldset>
        )}

        <button
          type="button"
          className="button button--primary"
          onClick={() => void handleExport()}
          disabled={isWriting || isUnavailable}
        >
          {isWriting ? 'Writing…' : isRewrite ? `Rewrite as ${label}` : `Convert to ${label}`}
        </button>
      </div>

      <p className="export__hint">
        {isUnavailable
          ? chosen?.reason
          : isRewrite
            ? `Rewritten from the activity as this app read it, not copied from your ${label} file — so anything the parser could not represent is not carried over.`
            : `Converted through the same activity model every format is read into, rather than translated from ${activity.source.format.toUpperCase()} directly.`}
      </p>

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
            <>
              <p className="export__note">
                {outcome.warnings.length === 1
                  ? 'One thing this format could not carry:'
                  : `${outcome.warnings.length} things this format could not carry:`}
              </p>
              <ul className="export__warnings">
                {outcome.warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Hands the blob to the browser's download mechanism. The object URL is
 * revoked immediately afterwards: it holds the whole file in memory, and the
 * download has already taken its own reference by then.
 */
/**
 * Hands a blob to the browser's own download: an object URL on a temporary
 * anchor, revoked at once. Nothing is sent anywhere. Shared by every export.
 */
export function download(blob: Blob, fileName: string): void {
  if (typeof URL.createObjectURL !== 'function') return;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
