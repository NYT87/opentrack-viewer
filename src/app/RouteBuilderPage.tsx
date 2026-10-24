import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeatureCollection, Point } from 'geojson';
import { FileDropZone } from '../components/FileDropZone';
import { WarningList } from '../components/ErrorPanel';
import { MapPlaceholder } from '../components/MapPlaceholder';
import { PlannedTrackExport } from '../components/PlannedTrackExport';
import { TrackMerge } from '../components/TrackMerge';
import type { EditPointProperties } from '../components/ActivityMap';
import type { Activity } from '../domain/activity';
import { toActivityError } from '../domain/errors';
import { EMPTY_ROUTE_GEOMETRY, activityToRouteGeoJSON, pointToGeoJSON } from '../domain/geojson';
import {
  appendJump,
  beginsStretch,
  draftToActivity,
  sectionBounds,
  stretchLengths,
  type DraftPlace,
  type DraftResult,
  type DraftSection,
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
  | { status: 'error'; message: string; code: string };

/**
 * AV-1106. What the last append was: which file, how many points, and the
 * first of them. Only that is remembered; where the jump is, how long it is
 * and whether it is still a break are read from the draft as it is now, so a
 * join, a move or an undo can never leave the notice describing a track that
 * no longer exists.
 */
interface Appended {
  draftId: string;
  fileName: string;
  firstId: string;
  added: number;
}

/** What a press on the map does: adds a point at the end, or moves the selected one. */
type ClickMode = 'add' | 'move';

const KIND_LABEL: Record<RouteDraft['kind'], string> = {
  blank: 'A new planned track',
  copied: 'Copied from a track',
  appended: 'Built from imported tracks',
};

const NO_MARKER = pointToGeoJSON(undefined);

/**
 * AV-1102 / AV-1104 / AV-1105. Where planned tracks are made: a page of its
 * own, reached from Tools. Route editing does not happen in the viewer, which
 * shows what was recorded.
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
 *
 * A section (AV-1105) is marked from the selected point — where it starts,
 * where it ends — shown on the map before anything happens to it, and then
 * discarded with the cut joined or kept as a gap. Every edit can be taken
 * back: there are no confirmation dialogs, there is Undo.
 */
export function RouteBuilderPage() {
  const draft = useRouteDraftStore((state) => state.draft);
  const canUndo = useRouteDraftStore((state) => state.history.length > 0);
  const startBlank = useRouteDraftStore((state) => state.startBlank);
  const importTrack = useRouteDraftStore((state) => state.importTrack);
  const addPointToDraft = useRouteDraftStore((state) => state.addPoint);
  const removePointFromDraft = useRouteDraftStore((state) => state.removePoint);
  const movePointInDraft = useRouteDraftStore((state) => state.movePoint);
  const discardSectionOfDraft = useRouteDraftStore((state) => state.discardSection);
  const joinBeforeInDraft = useRouteDraftStore((state) => state.joinBefore);
  const splitBeforeInDraft = useRouteDraftStore((state) => state.splitBefore);
  const undo = useRouteDraftStore((state) => state.undo);
  const clear = useRouteDraftStore((state) => state.clear);
  const unitSystem = useInteractionStore((state) => state.unitSystem);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);

  const [intake, setIntake] = useState<Intake>({ status: 'idle' });
  const [appended, setAppended] = useState<Appended | undefined>(undefined);
  /*
   * What the reader picked out, what a press on the map does, and the marks
   * of a section. All belong to one draft: a selection outlives nothing — a
   * point removed, or a draft replaced, is no longer selected — and losing the
   * selection by any road (deselect, remove, start over) puts the map back to
   * adding, so the next press cannot move something the reader did not pick.
   * Validity is derived, not synced, so there is never a render in between.
   */
  const [wanted, setWanted] = useState<{
    draftId?: string;
    id?: string;
    mode: ClickMode;
    fromId?: string;
    toId?: string;
  }>({ mode: 'add' });
  const sameDraft = draft !== undefined && wanted.draftId === draft.id;
  const has = (id: string | undefined) =>
    sameDraft && id !== undefined && draft.points.some((point) => point.id === id) ? id : undefined;
  const selectedId = has(wanted.id);
  const mode: ClickMode = sameDraft && selectedId ? wanted.mode : 'add';
  const markFrom = has(wanted.fromId);
  const markTo = has(wanted.toId);
  const marks = useMemo<DraftSection | undefined>(
    () => (markFrom && markTo ? { fromId: markFrom, toId: markTo } : undefined),
    [markFrom, markTo],
  );
  /** Why the last edit was refused, or what the last discard did. Shown, never blocking. */
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // Nothing of a previous draft's state carries into this one: ids restart at
  // `p0` for every draft, so a mark left behind would otherwise name a point
  // in a track it was never made on. Every write starts from a clean slate
  // when the draft has changed.
  const forThisDraft = useCallback(
    (current: typeof wanted) =>
      current.draftId === draft?.id ? current : { draftId: draft?.id, mode: 'add' as const },
    [draft?.id],
  );
  // Selecting keeps the mode only while a selection was live; coming from no
  // selection (after a remove, a deselect, a new draft) always starts in add.
  const setSelectedId = useCallback(
    (id: string | undefined) =>
      setWanted((current) => {
        const scoped = forThisDraft(current);
        return {
          ...scoped,
          draftId: draft?.id,
          id,
          mode: id !== undefined && selectedId !== undefined ? scoped.mode : 'add',
        };
      }),
    [draft?.id, selectedId, forThisDraft],
  );
  const setMode = (next: ClickMode) =>
    setWanted((current) => ({ ...forThisDraft(current), draftId: draft?.id, mode: next }));
  const setMarks = (fromId: string | undefined, toId: string | undefined) =>
    setWanted((current) => ({ ...forThisDraft(current), draftId: draft?.id, fromId, toId }));

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
  const section = useMemo(() => {
    if (!draft || !marks) return undefined;
    const bounds = sectionBounds(draft, marks);
    if (!bounds.ok) return undefined;
    const points = draft.points.slice(bounds.value.start, bounds.value.end + 1);
    const preview = draftToActivity({ ...draft, points });
    return {
      ...bounds.value,
      count: points.length,
      // Drawn as the lap layer is: in its own colour, without moving the camera.
      geometry: preview.ok ? activityToRouteGeoJSON(preview.value) : EMPTY_ROUTE_GEOMETRY,
    };
  }, [draft, marks]);
  // The handles carry the section too: the line above needs two points to
  // draw, and a one-point section would otherwise be "shown" by nothing.
  const editPoints = useMemo(
    () => draftPointsToGeoJSON(draft, selectedId, section),
    [draft, selectedId, section],
  );

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
  /*
   * AV-1108. Above the handle limit most points have no handle to press, so a
   * press on the route line picks the nearest point instead — and is not also
   * an add. The route's point indices are the draft's: the preview activity
   * numbers its points in draft order. Below the limit every point has a
   * handle, and a press on the line keeps adding a point, as it always did.
   * In move mode a press on the line still moves the selected point: that is
   * what the reader asked a press to do, and a point put back on the track is
   * the commonest move there is.
   */
  const thinned = (draft?.points.length ?? 0) > ALL_HANDLES_LIMIT && mode !== 'move';
  const handleRouteClick = useCallback(
    (pointIndex: number | undefined) => {
      const id = pointIndex === undefined ? undefined : draft?.points[pointIndex]?.id;
      if (id) setSelectedId(id);
    },
    [draft, setSelectedId],
  );

  const discard = (keepGap: boolean) => {
    if (!marks || !section) return;
    const result = discardSectionOfDraft(marks, { keepGap });
    if (!result.ok) {
      setNotice(result.error.message);
      return;
    }
    const joined = section.start > 0 && section.start < result.value.points.length;
    setNotice(
      `Discarded ${section.count} point${section.count === 1 ? '' : 's'}. ${
        joined
          ? keepGap
            ? 'A gap was kept where they were.'
            : 'The track now runs straight from the point before to the point after.'
          : 'Nothing was on the other side of the cut to join.'
      } Undo takes it back.`,
    );
    setMarks(undefined, undefined);
  };

  const undoLast = () => {
    if (!undo()) return;
    setNotice('The last edit was taken back.');
    // A selection or a mark on a point the restored draft does not have is
    // dropped now, not left to be found valid again later. (The store also
    // never reuses an id after an undo; this keeps the page honest on its own.)
    // From what was *live* before the undo, not what was stored: a selection
    // that removal had already ended (and its move mode with it) must not come
    // back with the point, or the next press would move a point nobody picked.
    const restored = useRouteDraftStore.getState().draft;
    const exists = (id: string | undefined) =>
      id !== undefined && restored?.points.some((point) => point.id === id) ? id : undefined;
    const id = exists(selectedId);
    setWanted({
      draftId: draft?.id,
      id,
      mode: id ? mode : 'add',
      fromId: exists(markFrom),
      toId: exists(markTo),
    });
  };

  const handleFile = async (file: File) => {
    const token = ++readToken.current;
    setIntake({ status: 'reading', fileName: file.name });
    try {
      // The viewer's own intake: GPX, FIT, TCX and KML, read in this tab.
      const { activity } = await parseActivityFile(file);
      if (readToken.current !== token) return;
      const before = useRouteDraftStore.getState().draft;
      const result = importTrack(activity);
      if (!result.ok) {
        setIntake({ status: 'error', message: result.error.message, code: result.error.code });
        return;
      }
      setIntake({ status: 'idle' });
      const jump = before ? appendJump(before, result.value) : undefined;
      setAppended(
        jump && before
          ? {
              draftId: result.value.id,
              fileName: file.name,
              firstId: jump.firstId,
              added: result.value.points.length - before.points.length,
            }
          : undefined,
      );
    } catch (error) {
      if (readToken.current !== token) return;
      const failure = toActivityError(error, 'unsupported_format');
      setIntake({ status: 'error', message: failure.message, code: failure.code });
    }
  };

  const busy = intake.status === 'reading';

  // The append notice, read from the current draft: the first appended point
  // and the point now before it, how far apart they are, and whether a line
  // joins them. Gone when the point is gone or nothing precedes it.
  const appendedNow = useMemo(() => {
    if (!draft || !appended || appended.draftId !== draft.id) return undefined;
    const at = draft.points.findIndex((point) => point.id === appended.firstId);
    if (at <= 0) return undefined;
    const jump = appendJump({ ...draft, points: draft.points.slice(0, at) }, draft);
    if (!jump) return undefined;
    return { ...appended, ...jump, joined: !beginsStretch(draft, appended.firstId) };
  }, [draft, appended]);

  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Route Builder</h2>
          <p className="page__intro">
            Plan a track: start a blank one, or begin from a GPX, FIT, TCX or KML route, then add,
            move and remove points by hand, or cut a whole section out. It is built in this browser
            tab; nothing is uploaded, stored or sent anywhere.
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
            <p role="alert" data-error-code={intake.code}>
              {intake.code === 'no_route_points'
                ? `It has no route to add: ${intake.message}`
                : intake.message}
            </p>
            {draft && <p>The planned track is as it was.</p>}
            <p>
              <button type="button" className="button" onClick={() => setIntake({ status: 'idle' })}>
                Try another file
              </button>
            </p>
          </section>
        )}

        {draft && !busy && (
          <>
            <DraftSummary
              draft={draft}
              track={track?.ok ? track.value : undefined}
              units={unitSystem}
              onClear={clear}
            />

            <section className="box" aria-label="Draft map">
              <Suspense fallback={<MapPlaceholder reason="loading" />}>
                <ActivityMap
                  route={route}
                  lapRoute={section?.geometry}
                  marker={NO_MARKER}
                  basemapEnabled={basemapEnabled}
                  editPoints={editPoints}
                  onPointClick={handlePointClick}
                  onMapClick={handleMapClick}
                  onRouteClick={thinned ? handleRouteClick : undefined}
                  fitKey={draft.id}
                />
              </Suspense>
            </section>

            <PointEditor
              draft={draft}
              selectedId={selectedId}
              mode={mode}
              notice={notice}
              canUndo={canUndo}
              marks={{ fromId: markFrom, toId: markTo }}
              section={section}
              onSelect={setSelectedId}
              onMode={setMode}
              onAdd={addPoint}
              onMove={(id, place) => report(movePointInDraft(id, place))}
              onRemove={(id) => report(removePointFromDraft(id))}
              onJoin={(id) => report(joinBeforeInDraft(id))}
              onSplit={(id) => report(splitBeforeInDraft(id))}
              onMark={setMarks}
              onDiscard={discard}
              onUndo={undoLast}
            />

            <PlannedTrackExport draft={draft} />
          </>
        )}

        {!busy && intake.status !== 'error' && (
          <section className="prose" aria-label="Import a track">
            <h3 className="prose__title">{draft ? 'Add another track' : 'Import a track'}</h3>
            <p>
              {draft
                ? 'It is added after the points already here, as a separate stretch: the end of one and the start of the next are not joined until you join them.'
                : 'The route becomes the first points of a new planned track. Only its places are kept, not heart rate, power or the device that recorded it.'}
            </p>
            {appendedNow && (
              <div className="editor__selected" role="status" aria-label="Last track added">
                <span className="route-draft__appended">
                  {`Added ${appendedNow.added} point${appendedNow.added === 1 ? '' : 's'} from ${appendedNow.fileName}. `}
                  {appendedNow.joined
                    ? `It is joined to the point before it: the ${formatDistance(appendedNow.meters, unitSystem)} between them is drawn and counted.`
                    : appendedNow.far
                      ? `It starts ${formatDistance(appendedNow.meters, unitSystem)} from the point before it — far apart, so it is a stretch of its own and nothing is drawn or counted across the jump. If it is one road, join them.`
                      : `It starts ${formatDistance(appendedNow.meters, unitSystem)} from the point before it, as a stretch of its own; nothing is drawn or counted across the jump until you join them.`}
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={() => setSelectedId(appendedNow.firstId)}
                >
                  Select the join
                </button>
              </div>
            )}
            <FileDropZone
              acceptedExtensions={SUPPORTED_FORMATS}
              onFile={(file) => void handleFile(file)}
              testId="route-builder-input"
            />
          </section>
        )}

        <TrackMerge />
      </div>
    </main>
  );
}

/**
 * AV-1108. Above this many points a handle on every one is noise — they merge
 * into a solid line at any zoom that shows the track — and every edit would
 * send them all to the map again. A long track keeps handles for the points
 * that matter: the selected one, the ends of every stretch, and a section's
 * ends; the rest are picked with a press on the line, which selects the
 * nearest point, or reached with Previous and Next, as from the keyboard.
 */
export const ALL_HANDLES_LIMIT = 2000;

/** The draft's points as map features, the selected one flagged for the layer's paint. */
function draftPointsToGeoJSON(
  draft: RouteDraft | undefined,
  selectedId: string | undefined,
  section: { start: number; end: number } | undefined,
): FeatureCollection<Point, EditPointProperties> {
  const points = draft?.points ?? [];
  const everyPoint = points.length <= ALL_HANDLES_LIMIT;
  const features: FeatureCollection<Point, EditPointProperties>['features'] = [];
  points.forEach((point, index) => {
    const selected = point.id === selectedId;
    const inSection = section !== undefined && index >= section.start && index <= section.end;
    const keep =
      everyPoint ||
      selected ||
      (section !== undefined && (index === section.start || index === section.end)) ||
      index === 0 ||
      index === points.length - 1 ||
      (point.segmentIndex ?? 0) !== (points[index - 1]?.segmentIndex ?? 0) ||
      (point.segmentIndex ?? 0) !== (points[index + 1]?.segmentIndex ?? 0);
    if (!keep) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
      properties: { id: point.id, selected, inSection },
    });
  });
  return { type: 'FeatureCollection', features };
}

/** A typed coordinate, or `NaN` for anything that is not a number — which the model refuses. */
function readNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

interface SectionView {
  start: number;
  end: number;
  count: number;
}

function PointEditor({
  draft,
  selectedId,
  mode,
  notice,
  canUndo,
  marks,
  section,
  onSelect,
  onMode,
  onAdd,
  onMove,
  onRemove,
  onJoin,
  onSplit,
  onMark,
  onDiscard,
  onUndo,
}: {
  draft: RouteDraft;
  selectedId: string | undefined;
  mode: ClickMode;
  notice: string | undefined;
  canUndo: boolean;
  marks: { fromId: string | undefined; toId: string | undefined };
  section: SectionView | undefined;
  onSelect: (id: string | undefined) => void;
  onMode: (mode: ClickMode) => void;
  onAdd: (place: DraftPlace) => void;
  onMove: (id: string, place: DraftPlace) => void;
  onRemove: (id: string) => void;
  onJoin: (id: string) => void;
  onSplit: (id: string) => void;
  onMark: (fromId: string | undefined, toId: string | undefined) => void;
  onDiscard: (keepGap: boolean) => void;
  onUndo: () => void;
}) {
  const [addLat, setAddLat] = useState('');
  const [addLon, setAddLon] = useState('');
  const [addElevation, setAddElevation] = useState('');
  const [keepGap, setKeepGap] = useState(false);

  const selectedIndex = selectedId ? draft.points.findIndex((p) => p.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? draft.points[selectedIndex] : undefined;
  const indexOf = (id: string | undefined) =>
    id === undefined ? -1 : draft.points.findIndex((p) => p.id === id);
  const startsStretch = selected ? beginsStretch(draft, selected.id) : false;

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
          <input
            className="input"
            inputMode="decimal"
            value={addLat}
            onChange={(e) => setAddLat(e.target.value)}
          />
        </label>
        <label className="editor__field">
          <span className="summary__label">Longitude</span>
          <input
            className="input"
            inputMode="decimal"
            value={addLon}
            onChange={(e) => setAddLon(e.target.value)}
          />
        </label>
        <label className="editor__field">
          <span className="summary__label">Elevation (m, optional)</span>
          <input
            className="input"
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

      {selected && selectedIndex > 0 && (
        // A stretch is where a line is drawn without a break. An import starts
        // its own; whether the end of one track and the start of the next are
        // really one road is the reader's to say (TD-048).
        <div className="editor__selected">
          <span className="summary__label">
            {startsStretch
              ? 'This point begins a stretch: no line joins it to the point before.'
              : 'This point continues the stretch from the point before.'}
          </span>
          {startsStretch ? (
            <button type="button" className="button" onClick={() => onJoin(selected.id)}>
              Join to the point before
            </button>
          ) : (
            <button type="button" className="button" onClick={() => onSplit(selected.id)}>
              Start a new stretch here
            </button>
          )}
        </div>
      )}

      <div className="editor__selected" role="group" aria-label="Section">
        <span className="summary__label">
          {section
            ? `Section: points ${section.start + 1} to ${section.end + 1} (${section.count} point${section.count === 1 ? '' : 's'}), shown on the map`
            : marks.fromId
              ? `Section starts at point ${indexOf(marks.fromId) + 1}; mark where it ends`
              : marks.toId
                ? `Section ends at point ${indexOf(marks.toId) + 1}; mark where it starts`
                : 'Section: none marked. Select a point and mark where a section starts and ends.'}
        </span>
        {selected && (
          <>
            <button type="button" className="button" onClick={() => onMark(selected.id, marks.toId)}>
              Section starts here
            </button>
            <button type="button" className="button" onClick={() => onMark(marks.fromId, selected.id)}>
              Section ends here
            </button>
          </>
        )}
        {(marks.fromId || marks.toId) && (
          <button type="button" className="button" onClick={() => onMark(undefined, undefined)}>
            Clear marks
          </button>
        )}
        {section && (
          <>
            <label className="editor__mode">
              <input
                type="checkbox"
                checked={keepGap}
                onChange={(event) => setKeepGap(event.target.checked)}
              />
              keep a gap where the section was
            </label>
            <button type="button" className="button" onClick={() => onDiscard(keepGap)}>
              Discard section
            </button>
          </>
        )}
      </div>

      <p className="editor__status" role="status">
        {notice ??
          (mode === 'move' && selected
            ? `Press the map to move point ${selectedIndex + 1} there.`
            : 'Press the map to add a point at the end of the track, or type a place above. Points are not dragged: to move one, select it and press where it should go, or type its new place.')}
      </p>

      <p className="video__actions">
        <button type="button" className="button" onClick={onUndo} disabled={!canUndo}>
          Undo last edit
        </button>
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
        <input
          className="input"
          inputMode="decimal"
          value={moveLat}
          onChange={(e) => setMoveLat(e.target.value)}
        />
      </label>
      <label className="editor__field">
        <span className="summary__label">Longitude</span>
        <input
          className="input"
          inputMode="decimal"
          value={moveLon}
          onChange={(e) => setMoveLon(e.target.value)}
        />
      </label>
      <button type="submit" className="button">
        Move point
      </button>
    </form>
  );
}

function DraftSummary({
  draft,
  track,
  units,
  onClear,
}: {
  draft: RouteDraft;
  /** The draft as an activity, computed once by the page for the map and this summary alike. */
  track: Activity | undefined;
  units: UnitSystem;
  onClear: () => void;
}) {
  const segments = stretchLengths(draft.points).length;

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
