import { useMemo, useState } from 'react';
import type { ActivityWarning } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import type { RouteDraft } from '../domain/routeDraft';
import type { ExportFormat } from '../exporters';
import { exportPlannedTrack, hasExportableRoute, plannedTrackFileStem, plannedTrackFormats } from '../exporters/plannedTrack';
import { WarningList } from './ErrorPanel';
import { download } from './ExportPanel';

/**
 * AV-1107. Route Builder's export. Controls only once the draft is a route —
 * two joined points — and then every format of the registry is listed, those
 * a plan cannot be written to disabled with their reason (TD-054). The file
 * is built in this tab and handed to the browser's download; nothing is sent.
 */
export function PlannedTrackExport({ draft }: { draft: RouteDraft }) {
  const formats = useMemo(() => plannedTrackFormats(draft), [draft]);
  const firstAvailable = formats.find((entry) => entry.available)?.format;
  const [format, setFormat] = useState<ExportFormat>('gpx');
  const [outcome, setOutcome] = useState<{ fileName: string; warnings: ActivityWarning[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!hasExportableRoute(draft)) {
    return (
      <section className="prose" aria-label="Export for a device">
        <h3 className="prose__title">Export</h3>
        <p>Export appears once the track is a route: at least two points joined in one stretch.</p>
      </section>
    );
  }

  const chosen = formats.find((entry) => entry.format === format);
  const effective = chosen?.available ? format : firstAvailable;

  const write = async () => {
    if (!effective) return;
    setBusy(true);
    try {
      const result = await exportPlannedTrack(draft, effective);
      download(result.blob, result.fileName);
      setOutcome({ fileName: result.fileName, warnings: result.warnings });
      setError(undefined);
    } catch (thrown) {
      setOutcome(undefined);
      setError(thrown instanceof ActivityError ? thrown.message : 'The planned track could not be written.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="prose" aria-label="Export for a device">
      <h3 className="prose__title">Export</h3>
      <p>
        Writes the planned track as a file for a watch, a bike computer or a phone. It is written in
        this tab and saved by your browser; nothing is uploaded.
      </p>
      <fieldset className="editor__modes">
        <legend className="summary__label">Format</legend>
        {formats.map((entry) => (
          <label key={entry.format} className="editor__mode">
            <input
              type="radio"
              name="planned-format"
              value={entry.format}
              checked={effective === entry.format}
              disabled={!entry.available}
              onChange={() => setFormat(entry.format)}
            />
            {entry.label}
            {!entry.available && <span className="export__note"> — {entry.reason}</span>}
          </label>
        ))}
      </fieldset>
      <p className="video__actions">
        <button type="button" className="button button--primary" onClick={() => void write()} disabled={!effective || busy}>
          {busy ? 'Writing…' : `Download ${plannedTrackFileStem(draft)}.${effective ?? 'gpx'}`}
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
      {outcome && (
        <div role="status" aria-label="Planned track written">
          <p>Saved {outcome.fileName}.</p>
          <WarningList warnings={outcome.warnings} />
        </div>
      )}
    </section>
  );
}
