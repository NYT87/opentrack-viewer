import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../app/routes';
import type { Activity, ActivityWarning } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { activityToRouteGeoJSON, pointToGeoJSON } from '../domain/geojson';
import { assessMergeSource, mergeTracks, type MergePart, type MergeResult } from '../domain/mergeTracks';
import {
  formatDateTime,
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
  type UnitSystem,
} from '../domain/units';
import type { ExportFormat } from '../exporters';
import { exportMergedTrack, mergedTrackFileStem, mergedTrackFormats } from '../exporters/mergedTrack';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useActivityStore } from '../state/activityStore';
import { useInteractionStore } from '../state/interactionStore';
import { WarningList } from './ErrorPanel';
import { download } from './ExportPanel';
import { FileDropZone } from './FileDropZone';
import { MapPlaceholder } from './MapPlaceholder';

const ActivityMap = lazy(() =>
  import('./ActivityMap').then((module) => ({ default: module.ActivityMap })),
);

const NO_MARKER = pointToGeoJSON(undefined);

/** A file the reader chose, from the moment it is chosen to the moment it is read. */
type Entry =
  | { key: number; fileName: string; status: 'reading' }
  | { key: number; fileName: string; status: 'ready'; activity: Activity }
  | { key: number; fileName: string; status: 'refused'; message: string };

/**
 * AV-1109 (TD-060). Route Builder's merge: two or more recorded track files
 * made into one timed activity, the gaps between them kept as pauses.
 *
 * It sits beside the planned track rather than inside it, because it is the
 * other thing: a planned track is places with no times, and a merge is a
 * recording, times and all. The files are read in this tab, held in memory
 * for as long as the page is open, and the merge is worked out again from
 * them on every change, so what is shown is never out of step with the list.
 */
export function TrackMerge({ onEditActivity }: { onEditActivity: (activity: Activity) => string | undefined }) {
  const units = useInteractionStore((state) => state.unitSystem);
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextKey = useRef(0);
  /**
   * Parses that finish after the page has gone write nothing. Set on every
   * mount, not only the first: StrictMode mounts, unmounts and mounts again in
   * development, and a flag only ever cleared would discard every file.
   */
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const addFile = async (file: File) => {
    const key = nextKey.current++;
    setEntries((current) => [...current, { key, fileName: file.name, status: 'reading' }]);
    let settled: Entry;
    try {
      const { activity } = await parseActivityFile(file);
      const refusal = assessMergeSource(activity);
      settled = refusal
        ? { key, fileName: file.name, status: 'refused', message: refusal.message }
        : { key, fileName: file.name, status: 'ready', activity };
    } catch (error) {
      settled = { key, fileName: file.name, status: 'refused', message: toActivityError(error, 'unsupported_format').message };
    }
    if (!live.current) return;
    // A file removed while it was being read stays removed.
    setEntries((current) => current.map((entry) => (entry.key === key ? settled : entry)));
  };

  const remove = (key: number) => setEntries((current) => current.filter((entry) => entry.key !== key));

  // Worked out again whenever the list changes, and only then.
  const { ready, result } = useMemo(() => {
    const ready = entries.filter((entry): entry is Extract<Entry, { status: 'ready' }> => entry.status === 'ready');
    const result: MergeResult | undefined =
      ready.length > 0
        ? mergeTracks(ready.map((entry) => ({ fileName: entry.fileName, activity: entry.activity })))
        : undefined;
    return { ready, result };
  }, [entries]);
  const reading = entries.filter((entry) => entry.status === 'reading').length;
  const refused = entries.filter((entry): entry is Extract<Entry, { status: 'refused' }> => entry.status === 'refused');
  const keyOf = (part: MergePart) => ready[part.sourceIndex]?.key;

  return (
    <section className="prose merge" aria-label="Merge recorded tracks">
      <h3 className="prose__title">Merge recorded tracks</h3>
      <p>
        Make one activity of a ride saved in parts: two or more recordings of the same outing. They
        are put in the order they were recorded, by their own clocks, and the time between them is
        kept as a pause: it counts in elapsed time, not in moving time, and adds no distance.
        Unlike the planned track above, a merge keeps every time. It is worked out in this tab;
        nothing is uploaded.
      </p>
      <FileDropZone
        acceptedExtensions={SUPPORTED_FORMATS}
        onFile={(file) => void addFile(file)}
        testId="merge-input"
        multiple
      />
      {reading > 0 && (
        <p role="status">
          Reading {reading} file{reading === 1 ? '' : 's'} in this tab…
        </p>
      )}

      {result && result.parts.length > 0 && (
        <MergeOrder
          parts={result.parts}
          units={units}
          overlap={!result.ok && result.error.code === 'merge_overlap' ? result.error.between : undefined}
          onRemove={(part) => {
            const key = keyOf(part);
            if (key !== undefined) remove(key);
          }}
        />
      )}

      {refused.length > 0 && (
        <ul className="merge__refused" aria-label="Not in the merge">
          {refused.map((entry) => (
            <li key={entry.key}>
              <span>
                <strong>{entry.fileName}</strong> is not in the merge. {entry.message}
              </span>
              <button type="button" className="button" aria-label={`Remove ${entry.fileName}`} onClick={() => remove(entry.key)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {result && !result.ok && result.error.code === 'merge_overlap' && (
        <p role="alert" className="merge__problem">
          {overlapSentence(result.parts, result.error.between, result.error.overlapSeconds)}
        </p>
      )}
      {((result && !result.ok && result.error.code === 'merge_needs_two') ||
        (!result && entries.length > 0 && reading === 0)) && (
        <p className="merge__hint">Add at least one more recorded track with timestamps to merge.</p>
      )}

      {result?.ok && <MergedActivity result={result} units={units} onEditActivity={onEditActivity} />}
    </section>
  );
}

function overlapSentence(parts: MergePart[], [a, b]: [number, number], seconds: number): string {
  const first = parts[a]!;
  const second = parts[b]!;
  if (first.startTime.getTime() === second.startTime.getTime() && first.endTime.getTime() === second.endTime.getTime()) {
    return `${first.fileName} and ${second.fileName} cover exactly the same time: they look like the same recording. Remove one of them to merge.`;
  }
  return `${second.fileName} starts at ${formatDateTime(second.startTime, { seconds: true })}, before ${first.fileName} ends at ${formatDateTime(first.endTime, { seconds: true })}: they overlap by ${formatDuration(seconds)}. Overlapping recordings are not merged, because both cannot be the ride at the same moment. Remove one, or trim it in its own app first.`;
}

function MergeOrder({
  parts,
  units,
  overlap,
  onRemove,
}: {
  parts: MergePart[];
  units: UnitSystem;
  overlap?: [number, number];
  onRemove: (part: MergePart) => void;
}) {
  return (
    <ol className="merge__order" aria-label="Files in the order they were recorded">
      {parts.map((part, index) => (
        <li key={part.sourceIndex} className={overlap?.includes(index) ? 'merge__file is-overlapping' : 'merge__file'}>
          <span className="merge__name">{part.fileName}</span>
          <span className="merge__facts">
            {formatDateTime(part.startTime)} to {formatDateTime(part.endTime)} · {formatDuration(part.durationSeconds)} ·{' '}
            {formatDistance(part.distanceMeters, units)} · {part.pointCount.toLocaleString()} points
          </span>
          {/* "Remove" to see, the file to hear: the row already shows its name. */}
          <button type="button" className="button" aria-label={`Remove ${part.fileName}`} onClick={() => onRemove(part)}>
            Remove
          </button>
        </li>
      ))}
    </ol>
  );
}

function MergedActivity({ result, units, onEditActivity }: {
  result: Extract<MergeResult, { ok: true }>;
  units: UnitSystem;
  onEditActivity: (activity: Activity) => string | undefined;
}) {
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);
  const setActivity = useActivityStore((state) => state.setActivity);
  const navigate = useNavigate();
  const { activity, pauses, parts } = result;
  const derived = activity.derived!;
  const paused = pauses.reduce((total, pause) => total + pause.seconds, 0);
  const route = useMemo(() => activityToRouteGeoJSON(activity), [activity]);
  const [editError, setEditError] = useState<string | undefined>();

  return (
    <div className="merge__result" role="group" aria-label="The merged activity">
      <h4 className="merge__title">{activity.metadata.name}</h4>
      <dl className="summary__grid">
        <Stat label="Points" value={activity.points.length.toLocaleString()} />
        <Stat label="Distance" value={formatDistance(derived.distanceMeters, units)} />
        <Stat label="Elapsed" value={formatDuration(derived.durationSeconds)} />
        <Stat label="Moving time" value={formatDuration(derived.movingDurationSeconds)} />
        <Stat label={pauses.length === 1 ? 'Pause' : `Pauses (${pauses.length})`} value={formatDuration(paused)} />
        <Stat label="Avg speed (moving)" value={formatSpeed(derived.averageMovingSpeedMetersPerSecond, units)} />
        <Stat label="Elevation gain" value={formatElevation(derived.elevationGainMeters, units)} />
        <Stat label="Elevation loss" value={formatElevation(derived.elevationLossMeters, units)} />
      </dl>
      <ul className="merge__pauses" aria-label="Pauses between the files">
        {pauses.map((pause) => (
          <li key={pause.after}>
            Paused {formatDuration(pause.seconds)} between {parts[pause.after]!.fileName} and{' '}
            {parts[pause.after + 1]!.fileName}, {formatDateTime(pause.startTime)} to{' '}
            {formatDateTime(pause.endTime)}
            {pause.jumpMeters !== undefined && `; the next starts ${formatDistance(pause.jumpMeters, units)} away`}.
          </li>
        ))}
      </ul>
      {result.warnings.length > 0 && (
        <ul className="merge__notes" aria-label="About this merge">
          {result.warnings.map((warning) => (
            <li key={`${warning.code}-${warning.message}`} className={`is-${warning.severity}`}>
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      <div className="box box--map">
        <Suspense fallback={<MapPlaceholder reason="loading" />}>
          <ActivityMap route={route} marker={NO_MARKER} basemapEnabled={basemapEnabled} fitKey={activity.id} />
        </Suspense>
      </div>

      <p>The merged map is a preview. Clicking it does not add points. To change the route, edit a copy; the merged recording stays available for download. A route copy keeps places, elevation, times and pauses, but leaves out sensor readings, laps and device details.</p>

      <p className="video__actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            // In memory, as every handoff is: the viewer shows it until a reload.
            setActivity(activity);
            navigate(ROUTES.viewer);
          }}
        >
          Open in the viewer
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setEditError(onEditActivity(activity))}
        >
          Edit a route copy
        </button>
      </p>
      {editError && <p role="alert">{editError}</p>}
      <MergedExport activity={activity} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary__stat">
      <dt className="summary__label">{label}</dt>
      <dd className="summary__value">{value}</dd>
    </div>
  );
}

function MergedExport({ activity }: { activity: Activity }) {
  const formats = useMemo(() => mergedTrackFormats(activity), [activity]);
  const [format, setFormat] = useState<ExportFormat>('gpx');
  const [outcome, setOutcome] = useState<{ fileName: string; warnings: ActivityWarning[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chosen = formats.find((entry) => entry.format === format);
  const effective = chosen?.available ? format : formats.find((entry) => entry.available)?.format;
  const stem = mergedTrackFileStem(activity);

  const write = async () => {
    if (!effective) return;
    setBusy(true);
    try {
      const written = await exportMergedTrack(activity, effective);
      download(written.blob, written.fileName);
      setOutcome({ fileName: written.fileName, warnings: written.warnings });
      setError(undefined);
    } catch (thrown) {
      setOutcome(undefined);
      setError(thrown instanceof ActivityError ? thrown.message : 'The merged track could not be written.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="merge__export" role="group" aria-label="Export the merged activity">
      <fieldset className="editor__modes">
        <legend className="summary__label">Format</legend>
        {formats.map((entry) => (
          <label key={entry.format} className="editor__mode">
            <input
              type="radio"
              name="merged-format"
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
          {busy ? 'Writing…' : `Download ${stem}.${effective ?? 'gpx'}`}
        </button>
      </p>
      {error && <p role="alert">{error}</p>}
      {outcome && (
        <div role="status" aria-label="Merged activity written">
          <p>Saved {outcome.fileName}.</p>
          <WarningList warnings={outcome.warnings} />
        </div>
      )}
    </div>
  );
}
