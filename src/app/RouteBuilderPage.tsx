import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Point } from 'geojson';
import { FileDropZone } from '../components/FileDropZone';
import { WarningList } from '../components/ErrorPanel';
import { MapPlaceholder } from '../components/MapPlaceholder';
import type { EditPointProperties } from '../components/ActivityMap';
import { toActivityError } from '../domain/errors';
import { EMPTY_ROUTE_GEOMETRY, activityToRouteGeoJSON, pointToGeoJSON } from '../domain/geojson';
import {
  draftToActivity,
  type DraftPlace,
  type DraftResult,
  type RouteDraft,
} from '../domain/routeDraft';
import { formatDistance, type UnitSystem } from '../domain/units';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useInteractionStore } from '../state/interactionStore';
import { useRouteDraftStore } from '../state/routeDraftStore';

// The map is a megabyte of MapLibre; loaded when a draft needs drawing, as the
// viewer loads it when a file does.
const ActivityMap = lazy(() =>
  import('../components/ActivityMap').then((module) => ({ default: module.ActivityMap })),
);

type Intake =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'error'; message: string };

/** What a press on the map does: adds a point at the end, or moves the selected one. */
type ClickMode = 'add' | 'move';

const KIND_LABEL: Record<RouteDraft['kind'], string> = {
  blank: 'A new planned track',
  copied: 'Copied from a track',
  appended: 'Built from imported tracks',
};

const NO_MARKER = pointToGeoJSON(undefined);

/**
 * AV-1102 / AV-1104. Where planned tracks are made: a page of its own, reached
 * from Tools. Route editing does not happen in the viewer, which shows what
 * was recorded.
 *
 * It holds one draft (`RouteDraft`, AV-1101) in memory. A draft arrives by
 * handoff from the viewer, or is started here — blank, or from a track file,
 * which is also all a reload leaves, since the handoff does not survive one.
 *
 * Editing (AV-1104) is by hand and by straight lines: a press on the map adds
 * a point at the end of the track or moves the one picked out, and the same
 * can be typed as coordinates. Points are not dragged — there is no drag
 * handle and nothing suggests one — because a drag has no keyboard form, and
 * a deliberate press-to-move does. Every edit goes through the model's own
 * operation, so a refused place is explained and changes nothing.
 */
export function RouteBuilderPage() {
  const draft = useRouteDraftStore((state) => state.draft);
  const startBlank = useRouteDraftStore((state) => state.startBlank);
  const importTrack = useRouteDraftStore((state) => state.importTrack);
  const addPointToDraft = useRouteDraftStore((state) => state.addPoint);
  const removePointFromDraft = useRouteDraftStore((state) => state.removePoint);
  const movePointInDraft = useRouteDraftStore((state) => state.movePoint);
  const clear = useRouteDraftStore((state) => state.clear);
  const unitSystem = useInteractionStore((state) => state.unitSystem);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);

  const [intake, setIntake] = useState<Intake>({ status: 'idle' });
  /*
   * What the reader picked out, and what a press on the map does. Both belong
   * to one draft: a selection outlives nothing — a point removed, or a draft
   * replaced, is no longer selected — and losing the selection by any road
   * (deselect, remove, start over) puts the map back to adding, so the next
   * press cannot move something the reader did not pick. Validity is derived,
   * not synced, so there is never a render in between.
   */
  const [wanted, setWanted] = useState<{ draftId?: string; id?: string; mode: ClickMode }>({
    mode: 'add',
  });
  const sameDraft = draft !== undefined && wanted.draftId === draft.id;
  const selectedId =
    sameDraft && wanted.id && draft.points.some((point) => point.id === wanted.id)
      ? wanted.id
      : undefined;
  const mode: ClickMode = sameDraft && selectedId ? wanted.mode : 'add';
  // Selecting keeps the mode only while a selection was live; coming from no
  // selection (after a remove, a deselect, a new draft) always starts in add.
  const setSelectedId = useCallback(
    (id: string | undefined) =>
      setWanted((current) => ({
        draftId: draft?.id,
        id,
        mode: id !== undefined && selectedId !== undefined ? current.mode : 'add',
      })),
    [draft?.id, selectedId],
  );
  const setMode = (next: ClickMode) =>
    setWanted((current) => ({ ...current, draftId: draft?.id, mode: next }));
  /** Why the last edit was refused, if it was. Shown, never blocking. */
  const [notice, setNotice] = useState<string | undefined>(undefined);

  /*
   * The parse cannot be stopped, but its result can be refused. Each read
   * takes a token; leaving the page retires every token, so a parse that
   * finishes after the reader has gone — and perhaps come back and started
   * over — writes nothing into the draft they now have.
   */
  const readToken = useRef(0);
  useEffect(
    () => () => {
      readToken.current = -1;
    },
    [],
  );

  const track = useMemo(() => (draft ? draftToActivity(draft) : undefined), [draft]);
  const route = useMemo(
    () => (track?.ok ? activityToRouteGeoJSON(track.value) : EMPTY_ROUTE_GEOMETRY),
    [track],
  );
  const editPoints = useMemo(() => draftPointsToGeoJSON(draft, selectedId), [draft, selectedId]);

  const report = (result: DraftResult<RouteDraft>): boolean => {
    setNotice(result.ok ? undefined : result.error.message);
    return result.ok;
  };

  const addPoint = (place: DraftPlace) => {
    const result = addPointToDraft(place);
    if (report(result) && result.ok) {
      setSelectedId(result.value.points[result.value.points.length - 1]?.id);
    }
  };

  const handleMapClick = useCallback(
    (place: { lat: number; lon: number }) => {
      if (mode === 'move' && selectedId) {
        report(movePointInDraft(selectedId, place));
        return;
      }
      const result = addPointToDraft(place);
      if (report(result) && result.ok) {
        setSelectedId(result.value.points[result.value.points.length - 1]?.id);
      }
    },
    // `report` only sets state, so it is not a dependency worth tracking.
    [mode, selectedId, movePointInDraft, addPointToDraft, setSelectedId],
  );
  const handlePointClick = useCallback((id: string) => setSelectedId(id), [setSelectedId]);

  const handleFile = async (file: File) => {
    const token = ++readToken.current;
    setIntake({ status: 'reading', fileName: file.name });
    try {
      // The viewer's own intake: GPX, FIT, TCX and KML, read in this tab.
      const { activity } = await parseActivityFile(file);
      if (readToken.current !== token) return;
      const result = importTrack(activity);
      setIntake(
        result.ok ? { status: 'idle' } : { status: 'error', message: result.error.message },
      );
    } catch (error) {
      if (readToken.current !== token) return;
      setIntake({
        status: 'error',
        message: toActivityError(error, 'unsupported_format').message,
      });
    }
  };

  const busy = intake.status === 'reading';

  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Route Builder</h2>
          <p className="page__intro">
            Plan a track: start a blank one, or begin from a GPX, FIT, TCX or KML route, then add,
            move and remove points by hand. It is built in this browser tab; nothing is uploaded,
            stored or sent anywhere.
          </p>
        </header>

        {!draft && !busy && (
          <section className="prose" aria-label="Nothing planned yet">
            <h3 className="prose__title">Nothing planned yet</h3>
            <p>
              Start a blank track, or import a route to begin from. A track handed over from the
              viewer lives in memory only and does not survive a reload — if you came back here
              after one, start again below.
            </p>
            <p className="video__actions">
              <button type="button" className="button button--primary" onClick={() => startBlank()}>
                Start a blank track
              </button>
            </p>
          </section>
        )}

        {busy && (
          <section className="prose" aria-label="Reading the track">
            <h3 className="prose__title">Reading {intake.fileName}</h3>
            <p>Parsing happens in this tab.</p>
          </section>
        )}

        {intake.status === 'error' && (
          <section className="prose" aria-label="Track not imported">
            <h3 className="prose__title">That track could not be imported</h3>
            <p role="alert">{intake.message}</p>
            <p>
              <button type="button" className="button" onClick={() => setIntake({ status: 'idle' })}>
                Try another file
              </button>
            </p>
          </section>
        )}

        {draft && !busy && (
          <>
            <DraftSummary draft={draft} units={unitSystem} onClear={clear} />

            <section className="box" aria-label="Draft map">
              <Suspense fallback={<MapPlaceholder reason="loading" />}>
                <ActivityMap
                  route={route}
                  marker={NO_MARKER}
                  basemapEnabled={basemapEnabled}
                  editPoints={editPoints}
                  onPointClick={handlePointClick}
                  onMapClick={handleMapClick}
                  fitKey={draft.id}
                />
              </Suspense>
            </section>

            <PointEditor
              draft={draft}
              selectedId={selectedId}
              mode={mode}
              notice={notice}
              onSelect={setSelectedId}
              onMode={setMode}
              onAdd={addPoint}
              onMove={(id, place) => report(movePointInDraft(id, place))}
              onRemove={(id) => report(removePointFromDraft(id))}
            />
          </>
        )}

        {!busy && intake.status !== 'error' && (
          <section className="prose" aria-label="Import a track">
            <h3 className="prose__title">{draft ? 'Add another track' : 'Import a track'}</h3>
            <p>
              {draft
                ? 'It is added after the points already here, as a separate stretch: the end of one and the start of the next are not joined.'
                : 'The route becomes the first points of a new planned track. Only its places are kept, not heart rate, power or the device that recorded it.'}
            </p>
            <FileDropZone
              acceptedExtensions={SUPPORTED_FORMATS}
              onFile={(file) => void handleFile(file)}
              testId="route-builder-input"
            />
          </section>
        )}
      </div>
    </main>
  );
}

/** The draft's points as map features, the selected one flagged for the layer's paint. */
function draftPointsToGeoJSON(
  draft: RouteDraft | undefined,
  selectedId: string | undefined,
): FeatureCollection<Point, EditPointProperties> {
  return {
    type: 'FeatureCollection',
    features: (draft?.points ?? []).map((point) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: { id: point.id, selected: point.id === selectedId },
    })),
  };
}

/** A typed coordinate, or `NaN` for anything that is not a number — which the model refuses. */
function readNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

function PointEditor({
  draft,
  selectedId,
  mode,
  notice,
  onSelect,
  onMode,
  onAdd,
  onMove,
  onRemove,
}: {
  draft: RouteDraft;
  selectedId: string | undefined;
  mode: ClickMode;
  notice: string | undefined;
  onSelect: (id: string | undefined) => void;
  onMode: (mode: ClickMode) => void;
  onAdd: (place: DraftPlace) => void;
  onMove: (id: string, place: DraftPlace) => void;
  onRemove: (id: string) => void;
}) {
  const [addLat, setAddLat] = useState('');
  const [addLon, setAddLon] = useState('');
  const [addElevation, setAddElevation] = useState('');

  const selectedIndex = selectedId ? draft.points.findIndex((p) => p.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? draft.points[selectedIndex] : undefined;

  const submitAdd = (event: React.FormEvent) => {
    event.preventDefault();
    const elevation = addElevation.trim() === '' ? undefined : readNumber(addElevation);
    onAdd({
      lat: readNumber(addLat),
      lon: readNumber(addLon),
      ...(elevation !== undefined ? { elevationMeters: elevation } : {}),
    });
  };

  const selectByOffset = (offset: number) => {
    if (draft.points.length === 0) return;
    const base = selectedIndex === -1 ? (offset > 0 ? -1 : draft.points.length) : selectedIndex;
    const next = (base + offset + draft.points.length) % draft.points.length;
    onSelect(draft.points[next]?.id);
  };

  return (
    <section className="prose editor" aria-label="Edit points">
      <h3 className="prose__title">Edit points</h3>

      <fieldset className="editor__modes">
        <legend className="summary__label">A press on the map</legend>
        <label className="editor__mode">
          <input
            type="radio"
            name="map-click"
            value="add"
            checked={mode === 'add'}
            onChange={() => onMode('add')}
          />
          adds a point at the end
        </label>
        <label className="editor__mode">
          <input
            type="radio"
            name="map-click"
            value="move"
            checked={mode === 'move'}
            disabled={!selected}
            onChange={() => onMode('move')}
          />
          moves the selected point there
        </label>
      </fieldset>

      <form className="editor__fields" onSubmit={submitAdd} aria-label="Add a point by coordinates">
        <label className="editor__field">
          <span className="summary__label">Latitude</span>
          <input inputMode="decimal" value={addLat} onChange={(e) => setAddLat(e.target.value)} />
        </label>
        <label className="editor__field">
          <span className="summary__label">Longitude</span>
          <input inputMode="decimal" value={addLon} onChange={(e) => setAddLon(e.target.value)} />
        </label>
        <label className="editor__field">
          <span className="summary__label">Elevation (m, optional)</span>
          <input
            inputMode="decimal"
            value={addElevation}
            onChange={(e) => setAddElevation(e.target.value)}
          />
        </label>
        <button type="submit" className="button">
          Add point
        </button>
      </form>

      <div className="editor__selected">
        <span className="summary__label">
          {selected
            ? `Selected: point ${selectedIndex + 1} of ${draft.points.length}`
            : draft.points.length > 0
              ? `No point selected (${draft.points.length} in the track)`
              : 'No points yet'}
        </span>
        <button
          type="button"
          className="button"
          onClick={() => selectByOffset(-1)}
          disabled={draft.points.length === 0}
        >
          Previous point
        </button>
        <button
          type="button"
          className="button"
          onClick={() => selectByOffset(1)}
          disabled={draft.points.length === 0}
        >
          Next point
        </button>
        {selected && (
          <>
            <button type="button" className="button" onClick={() => onRemove(selected.id)}>
              Remove point
            </button>
            <button type="button" className="button" onClick={() => onSelect(undefined)}>
              Deselect
            </button>
          </>
        )}
      </div>

      {selected && (
        // Keyed by the point and where it is, so the fields start from the
        // point's own place each time the selection or the point changes.
        <MoveForm
          key={`${selected.id}:${selected.lat}:${selected.lon}`}
          lat={selected.lat}
          lon={selected.lon}
          onMove={(place) => onMove(selected.id, place)}
        />
      )}

      <p className="editor__status" role="status">
        {notice ??
          (mode === 'move' && selected
            ? `Press the map to move point ${selectedIndex + 1} there.`
            : 'Press the map to add a point at the end of the track, or type a place above. Points are not dragged: to move one, select it and press where it should go, or type its new place.')}
      </p>
    </section>
  );
}

/**
 * Where to move the selected point, typed. Its fields start from the point's
 * place (the parent keys it by that), so a small correction is a small edit.
 */
function MoveForm({
  lat,
  lon,
  onMove,
}: {
  lat: number;
  lon: number;
  onMove: (place: DraftPlace) => void;
}) {
  const [moveLat, setMoveLat] = useState(String(lat));
  const [moveLon, setMoveLon] = useState(String(lon));

  return (
    <form
      className="editor__fields"
      aria-label="Move the selected point"
      onSubmit={(event) => {
        event.preventDefault();
        onMove({ lat: readNumber(moveLat), lon: readNumber(moveLon) });
      }}
    >
      <label className="editor__field">
        <span className="summary__label">Latitude</span>
        <input inputMode="decimal" value={moveLat} onChange={(e) => setMoveLat(e.target.value)} />
      </label>
      <label className="editor__field">
        <span className="summary__label">Longitude</span>
        <input inputMode="decimal" value={moveLon} onChange={(e) => setMoveLon(e.target.value)} />
      </label>
      <button type="submit" className="button">
        Move point
      </button>
    </form>
  );
}

function DraftSummary({
  draft,
  units,
  onClear,
}: {
  draft: RouteDraft;
  units: UnitSystem;
  onClear: () => void;
}) {
  const track = useMemo(() => {
    const result = draftToActivity(draft);
    return result.ok ? result.value : undefined;
  }, [draft]);
  const segments = new Set(draft.points.map((point) => point.segmentIndex ?? 0)).size;

  return (
    <section className="prose" aria-label="Planned track">
      <h3 className="prose__title">{draft.name}</h3>
      <dl className="summary__grid">
        <div className="summary__stat">
          <dt className="summary__label">Started as</dt>
          <dd className="summary__value">{KIND_LABEL[draft.kind]}</dd>
        </div>
        <div className="summary__stat">
          <dt className="summary__label">Points</dt>
          <dd className="summary__value">{draft.points.length}</dd>
        </div>
        {draft.points.length > 0 && (
          <div className="summary__stat">
            <dt className="summary__label">Stretches</dt>
            <dd className="summary__value">{segments}</dd>
          </div>
        )}
        {track && (
          <div className="summary__stat">
            <dt className="summary__label">Distance</dt>
            <dd className="summary__value">{formatDistance(track.derived?.distanceMeters, units)}</dd>
          </div>
        )}
      </dl>
      {draft.points.length === 0 && (
        <p>
          This track has no points yet. Press the map, or type a place below, to add the first
          one; or import a route to begin from.
        </p>
      )}
      {draft.sources.length > 0 && (
        // File names are the reader's and can be anything: a long one with no
        // space in it must wrap, not push a phone screen sideways.
        <ul className="route-draft__sources">
          {draft.sources.map((source) => (
            <li key={source.id}>
              {source.fileName ?? source.name ?? 'A track'}: {source.usedPointCount} of{' '}
              {source.sourcePointCount} points used
            </li>
          ))}
        </ul>
      )}
      {track && <WarningList warnings={track.warnings} />}
      <p>
        This draft is held in memory in this tab and is gone on a reload.
      </p>
      <p className="video__actions">
        <button type="button" className="button" onClick={onClear}>
          Start over
        </button>
      </p>
    </section>
  );
}
