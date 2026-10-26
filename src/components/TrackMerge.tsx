import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../app/routes';
import type { Activity, ActivityWarning } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { activityToRouteGeoJSON, pointToGeoJSON } from '../domain/geojson';
import { assessMergeSource, mergeTracks, type MergePart, type MergeResult, type MergeSource } from '../domain/mergeTracks';
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
 * Route Builder's one way in for track files (AV-1102, AV-1109, TD-060): one
 * file or several, and what they become is decided by the files.
 *
 * - **All recorded, with timestamps:** one recording, in the order they were
 *   recorded, by their own clocks. Two or more are merged, the time between
 *   them kept as a pause; one is itself. Its figures, its map, its download,
 *   the viewer, or a route copy to edit.
 * - **Any without timestamps** (a planned route, a KML): there is no clock to
 *   order them by, so the files picked together go into the planned track as
 *   places, in the order they were added.
 * - **A planned track already open:** files are added to it.
 *
 * The files are read in this tab and held in memory for as long as the page
 * is open; the recording is worked out again from them on every change.
 */
export function TrackMerge({
  onEditActivity,
  draftId,
  onPlannedTrack,
}: {
  onEditActivity: (activity: Activity) => string | undefined;
  /** The planned track open now, if any: files picked while it is open go into it. */
  draftId: string | undefined;
  /**
   * Files for the planned track, read, in the order added, and the planned
   * track they were picked for. Returns false when that track has since been
   * replaced, so nothing was added.
   */
  onPlannedTrack: (sources: MergeSource[], forDraftId: string | undefined) => boolean;
}) {
  const units = useInteractionStore((state) => state.unitSystem);
  const [entries, setEntries] = useState<Entry[]>([]);
  /** What happened to the last files sent to the planned track, said once. */
  const [planned, setPlanned] = useState<string | undefined>();
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

  const addFiles = async (files: File[]) => {
    const forDraftId = draftId;
    const batch = files.map((file) => ({ key: nextKey.current++, fileName: file.name }));
    setPlanned(undefined);
    setEntries((current) => [...current, ...batch.map((entry) => ({ ...entry, status: 'reading' as const }))]);
    const read = await Promise.all(
      files.map(async (file, index): Promise<Entry> => {
        const { key } = batch[index]!;
        try {
          const { activity } = await parseActivityFile(file);
          return { key, fileName: file.name, status: 'ready', activity };
        } catch (error) {
          return { key, fileName: file.name, status: 'refused', message: toActivityError(error, 'unsupported_format').message };
        }
      }),
    );
    if (!live.current) return;
    const readable = read.filter((entry): entry is Extract<Entry, { status: 'ready' }> => entry.status === 'ready');
    const untimed = readable.filter((entry) => assessMergeSource(entry.activity) !== undefined);
    const toPlannedTrack = readable.length > 0 && (forDraftId !== undefined || untimed.length > 0);
    // A file removed while it was being read stays removed.
    const settle = (keep: (entry: Entry) => boolean) =>
      setEntries((current) =>
        current.flatMap((entry) => {
          const done = read.find((settled) => settled.key === entry.key);
          if (!done) return [entry];
          return keep(done) ? [done] : [];
        }),
      );
    if (!toPlannedTrack) {
      settle(() => true);
      return;
    }
    // The planned track takes the readable ones; a file that could not be read is still said.
    settle((entry) => entry.status === 'refused');
    const sources = readable.map((entry) => ({ fileName: entry.fileName, activity: entry.activity }));
    const added = onPlannedTrack(sources, forDraftId);
    const names = sources.map((source) => source.fileName).join(', ');
    setPlanned(
      !added
        ? `${names} ${sources.length === 1 ? 'was' : 'were'} not added: the planned track changed while ${sources.length === 1 ? 'it was' : 'they were'} read.`
        : forDraftId !== undefined
          ? `${names} ${sources.length === 1 ? 'was' : 'were'} added to the planned track above.`
          : `${untimed.map((entry) => entry.fileName).join(', ')} ${untimed.length === 1 ? 'has' : 'have'} no timestamps, so ${sources.length === 1 ? 'it went' : 'the files went'} into the planned track above as places to edit, in the order added.`,
    );
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
    <section className="prose merge" aria-label="Add tracks">
      <h3 className="prose__title">{draftId ? 'Add tracks to the planned track' : 'Add tracks'}</h3>
      {draftId ? (
        <p>
          Each file is added after the points already here, as a stretch of its own: the end of one and the start of the
          next are not joined until you join them. Only places are kept, not heart rate, power or the device.
        </p>
      ) : (
        <p>
          One file or several. Recordings with timestamps become one activity, in the order they were recorded: two or
          more are joined, and the time between them is kept as a pause, counted in elapsed time but not in moving time,
          with each recording ending a lap. A file without timestamps, such as a planned route, goes into a planned
          track instead, as places to edit. Everything is read in this tab; nothing is uploaded.
        </p>
      )}
      <FileDropZone
        acceptedExtensions={SUPPORTED_FORMATS}
        onFiles={(files) => void addFiles(files)}
        testId="track-input"
        multiple
      />
      {planned && <p role="status">{planned}</p>}
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
        <ul className="merge__refused" aria-label="Not used">
          {refused.map((entry) => (
            <li key={entry.key}>
              <span>
                <strong>{entry.fileName}</strong> is not used. {entry.message}
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
  // One file on its own is a recording, not a merge: no pauses between files, nothing joined.
  const joined = parts.length > 1;

  return (
    <div className="merge__result" role="group" aria-label={joined ? 'The merged activity' : 'The recording'}>
      <h4 className="merge__title">{activity.metadata.name}</h4>
      <dl className="summary__grid">
        <Stat label="Points" value={activity.points.length.toLocaleString()} />
        <Stat label="Laps" value={(activity.laps?.length ?? 0).toLocaleString()} />
        <Stat label="Distance" value={formatDistance(derived.distanceMeters, units)} />
        <Stat label="Elapsed" value={formatDuration(derived.durationSeconds)} />
        <Stat label="Moving time" value={formatDuration(derived.movingDurationSeconds)} />
        {joined && (
          <Stat label={pauses.length === 1 ? 'Pause' : `Pauses (${pauses.length})`} value={formatDuration(paused)} />
        )}
        <Stat label="Avg speed (moving)" value={formatSpeed(derived.averageMovingSpeedMetersPerSecond, units)} />
        <Stat label="Elevation gain" value={formatElevation(derived.elevationGainMeters, units)} />
        <Stat label="Elevation loss" value={formatElevation(derived.elevationLossMeters, units)} />
      </dl>
      {joined && <ul className="merge__pauses" aria-label="Pauses between the files">
        {pauses.map((pause) => (
          <li key={pause.after}>
            Paused {formatDuration(pause.seconds)} between {parts[pause.after]!.fileName} and{' '}
            {parts[pause.after + 1]!.fileName}, {formatDateTime(pause.startTime)} to{' '}
            {formatDateTime(pause.endTime)}
            {pause.jumpMeters !== undefined && `; the next starts ${formatDistance(pause.jumpMeters, units)} away`}.
          </li>
        ))}
      </ul>}
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

      <p>
        The map is a preview. Clicking it does not add points. To change the route, edit a copy; the recording stays
        available for download. A route copy keeps places, elevation, times{joined ? ' and pauses' : ''}, but leaves out
        sensor readings, laps and device details.
      </p>

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
  const [format, setFormat] = useState<ExportFormat>('fit');
  const [outcome, setOutcome] = useState<{ fileName: string; warnings: ActivityWarning[] }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chosen = formats.find((entry) => entry.format === format);
  const effective = chosen?.available ? format : formats.find((entry) => entry.available)?.format;
  const stem = mergedTrackFileStem(activity);
  const fitAvailable = formats.some((entry) => entry.format === 'fit' && entry.available);
  const pauseCount = (activity.events ?? []).filter((event) => event.type === 'pause').length;
  const thePauses = pauseCount === 1 ? 'the pause' : 'the pauses';

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
    <div className="merge__export" role="group" aria-label={pauseCount > 0 ? 'Export the merged activity' : 'Export the recording'}>
      {pauseCount > 0 ? (
        <p>Each recording ends a lap. FIT keeps the laps, and its timer stops at each pause: it is the file to upload to Garmin Connect or Strava. GPX keeps each recording as a track segment, with no laps and no timer.</p>
      ) : (
        <p>FIT keeps the laps and the timer, for Garmin Connect or Strava; GPX keeps the track and its times.</p>
      )}
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
            {entry.available && entry.format === 'gpx' && pauseCount > 0 && (
              <span className="export__note"> — not for Garmin Connect or Strava</span>
            )}
          </label>
        ))}
      </fieldset>
      {/*
        A GPX has no timer, so an app that counts time from it counts the pause
        as time stood still: the average speed falls and the chart goes flat.
        Said beside the download, where it is chosen, not only above it.
      */}
      {effective === 'gpx' && pauseCount > 0 && (
        <div className="merge__gpx-warning" role="note" aria-label="Before uploading this GPX">
          <p>
            <strong>Not for Garmin Connect or Strava.</strong> They read a GPX without its pauses: {thePauses} between
            the files would count as time standing still, lowering the average speed and flattening the chart. Use this
            GPX for maps and planners{fitAvailable ? ', and upload the FIT' : ''}.
          </p>
          {fitAvailable && (
            <button type="button" className="button" onClick={() => setFormat('fit')}>
              Use FIT instead
            </button>
          )}
        </div>
      )}
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
