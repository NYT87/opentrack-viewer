import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { RouteExportPanel } from '../components/RouteExportPanel';
import { FileDropZone } from '../components/FileDropZone';
import { MapPlaceholder } from '../components/MapPlaceholder';
import type { Activity } from '../domain/activity';
import { toActivityError } from '../domain/errors';
import { parseActivityFile } from '../parsers';
import type { Coordinate } from '../domain/activity';
import {
  addPoint,
  appendActivity,
  createBlankDraft,
  discardSection,
  draftDistanceMeters,
  movePoint,
  nudgePoint,
  removePoint,
  type EditResult,
  type NudgeDirection,
  type RouteDraft,
} from '../domain/routeDraft';
import { formatDistance } from '../domain/units';
import { useInteractionStore } from '../state/interactionStore';
import { useRouteDraftStore } from '../state/routeDraftStore';

/** MapLibre is the largest dependency; it loads when a route is being edited. */
const RouteEditorMap = lazy(() =>
  import('../components/RouteEditorMap').then((module) => ({ default: module.RouteEditorMap })),
);

/** One press of an arrow button moves the selected point this far. */
const NUDGE_METERS = 10;

const NUDGES: { direction: NudgeDirection; label: string; symbol: string }[] = [
  { direction: 'north', label: 'Nudge north', symbol: '↑' },
  { direction: 'west', label: 'Nudge west', symbol: '←' },
  { direction: 'east', label: 'Nudge east', symbol: '→' },
  { direction: 'south', label: 'Nudge south', symbol: '↓' },
];

/**
 * AV-1102 / AV-1104. Where a planned route is made.
 *
 * It owns a *draft*, never a loaded activity: whatever was open in the viewer
 * is copied in by the handoff (AV-1103) and stays as it was. Nothing here
 * uploads or stores anything — the draft lives in memory and a reload starts
 * the page empty.
 *
 * Everything the pointer can do on the map has a button here that does the
 * same: pick a point with Previous/Next, move it with the nudge arrows, remove
 * it with Delete. Dragging is the fast way, not the only way.
 */
export function RouteBuilderPage() {
  const draft = useRouteDraftStore((state) => state.draft);
  const canUndo = useRouteDraftStore((state) => state.past.length > 0);
  const canRedo = useRouteDraftStore((state) => state.future.length > 0);
  const startBlank = useRouteDraftStore((state) => state.startBlank);
  const applyEdit = useRouteDraftStore((state) => state.applyEdit);
  const undo = useRouteDraftStore((state) => state.undo);
  const redo = useRouteDraftStore((state) => state.redo);
  const clear = useRouteDraftStore((state) => state.clear);
  const unitSystem = useInteractionStore((state) => state.unitSystem);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);

  const [selectedIndex, setSelectedIndex] = useState<number | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  /** Where a marked section begins; its other end is the selected point. */
  const [sectionStart, setSectionStart] = useState<number | undefined>();
  const [keepGap, setKeepGap] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  /** An imported track that starts far from the route's end, awaiting a choice. */
  const [pendingJoin, setPendingJoin] = useState<
    { activity: Activity; gapMeters: number; base: RouteDraft } | undefined
  >();

  const distance = useMemo(() => (draft ? draftDistanceMeters(draft) : 0), [draft]);
  const pointCount = draft?.points.length ?? 0;
  // A selection that no longer exists (after undo, say) selects nothing.
  const selected =
    selectedIndex !== undefined && selectedIndex < pointCount ? selectedIndex : undefined;

  // A marked section needs both ends to exist; after an undo one may not.
  const section = useMemo(
    () =>
      sectionStart !== undefined && sectionStart < pointCount && selected !== undefined
        ? { start: Math.min(sectionStart, selected), end: Math.max(sectionStart, selected) }
        : undefined,
    [sectionStart, selected, pointCount],
  );
  const sectionDistance = useMemo(() => {
    if (!draft || !section) return 0;
    return draftDistanceMeters({ ...draft, points: draft.points.slice(section.start, section.end + 1) });
  }, [draft, section]);

  /** Applies an edit, or says why not without interrupting the editing. */
  const commit = useCallback(
    (result: EditResult, next?: (count: number) => number | undefined): boolean => {
      if (!result.ok) {
        setNotice(result.error.message);
        return false;
      }
      setNotice(undefined);
      applyEdit(result.draft);
      if (next) setSelectedIndex(next(result.draft.points.length));
      return true;
    },
    [applyEdit],
  );

  const handleAdd = useCallback(
    (coordinate: Coordinate) => {
      if (!draft) return;
      commit(addPoint(draft, coordinate), (count) => count - 1);
    },
    [draft, commit],
  );

  const handleMove = useCallback(
    (index: number, coordinate: Coordinate) => {
      if (!draft) return;
      commit(movePoint(draft, index, coordinate), () => index);
    },
    [draft, commit],
  );

  const handleSelect = useCallback(
    (index: number | undefined, options?: { extend: boolean }) => {
      setNotice(undefined);
      // Shift-click means "to here": the point that was selected becomes the
      // start of a section, unless one is already being marked.
      if (options?.extend && selected !== undefined && sectionStart === undefined) {
        setSectionStart(selected);
      }
      setSelectedIndex(index);
    },
    [selected, sectionStart],
  );

  const handleDiscardSection = () => {
    if (!draft || !section) return;
    const { start } = section;
    if (
      commit(discardSection(draft, section.start, section.end, { keepGap }), (count) =>
        count === 0 ? undefined : Math.min(start, count - 1),
      )
    ) {
      setSectionStart(undefined);
    }
  };

  const handleDelete = () => {
    if (!draft || selected === undefined) return;
    commit(removePoint(draft, selected), (count) =>
      count === 0 ? undefined : Math.min(selected, count - 1),
    );
  };

  const handleNudge = (direction: NudgeDirection) => {
    if (!draft || selected === undefined) return;
    commit(nudgePoint(draft, selected, direction, NUDGE_METERS));
  };

  const step = (delta: number) => {
    if (pointCount === 0) return;
    const from = selected ?? (delta > 0 ? -1 : pointCount);
    setSelectedIndex(Math.min(pointCount - 1, Math.max(0, from + delta)));
  };

  /**
   * AV-1106. Reads another track through the same parser registry the viewer
   * uses, and adds its route to the end of the draft. A track that begins far
   * from where the route ends is not joined until the user says how, because a
   * straight line across a continent is rarely what two saved sections mean.
   */
  const handleImport = async (file: File) => {
    setIsImporting(true);
    setNotice(undefined);
    try {
      const { activity } = await parseActivityFile(file);
      const base = useRouteDraftStore.getState().draft ?? createBlankDraft();
      const result = appendActivity(base, activity);
      if (result.farJoin && result.gapMeters !== undefined) {
        setPendingJoin({ activity, gapMeters: result.gapMeters, base });
        return;
      }
      applyEdit(result.draft);
    } catch (error) {
      const failure = toActivityError(error, 'unsupported_format');
      setNotice(`${failure.message} ${failure.hint}`);
    } finally {
      setIsImporting(false);
    }
  };

  const resolveJoin = (breakAtJoin: boolean) => {
    if (!pendingJoin) return;
    const { activity, base } = pendingJoin;
    setPendingJoin(undefined);
    applyEdit(appendActivity(base, activity, { breakAtJoin }).draft);
  };

  const handleStartOver = () => {
    setPendingJoin(undefined);
    setSelectedIndex(undefined);
    setSectionStart(undefined);
    setNotice(undefined);
    clear();
  };

  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Route Builder</h2>
          <p className="page__intro">
            Plan a route to load onto a watch, bike computer or phone. Start a new one, or edit a
            copy of a route you have opened. It all happens in this tab — nothing is uploaded or
            saved, and the file you opened is never changed.
          </p>
        </header>

        {!draft && (
          <section className="prose" aria-label="Start a route">
            <h3 className="prose__title">No route yet</h3>
            <p>
              Begin with an empty route, or open an activity in the file viewer and choose to build
              a route from it.
            </p>
            <p>
              <button type="button" className="button button--primary" onClick={startBlank}>
                Start a new route
              </button>
            </p>
            <p>Or begin from a file: its route becomes the start of a new one.</p>
            {notice && (
              <p role="status" className="route-tools__notice">
                {notice}
              </p>
            )}
            <FileDropZone onFile={(file) => void handleImport(file)} disabled={isImporting} />
          </section>
        )}

        {draft && (
          <>
            <section className="prose" aria-label="Current route">
              <h3 className="prose__title">{draft.name}</h3>
              <dl className="summary__grid">
                <div className="summary__stat">
                  <dt className="summary__label">Points</dt>
                  <dd className="summary__value">{pointCount}</dd>
                </div>
                <div className="summary__stat">
                  <dt className="summary__label">Distance</dt>
                  <dd className="summary__value">{formatDistance(distance, unitSystem)}</dd>
                </div>
              </dl>
            </section>

            <section className="box box--map" aria-label="Route editor map">
              <Suspense fallback={<MapPlaceholder reason="loading" />}>
                <RouteEditorMap
                  points={draft.points}
                  selectedIndex={selected}
                  range={section}
                  basemapEnabled={basemapEnabled}
                  onAdd={handleAdd}
                  onSelect={handleSelect}
                  onMove={handleMove}
                />
              </Suspense>
            </section>

            <section className="box route-tools" aria-label="Edit route">
              <p className="route-tools__help">
                Click the map to add a point at the end. Click a point to select it, then drag it
                to move it, or use the buttons below. To remove a stretch, mark where it starts and
                then select where it ends — or hold Shift and click the end point.
              </p>

              {notice && (
                <p role="status" className="route-tools__notice">
                  {notice}
                </p>
              )}

              <div className="route-tools__row" role="group" aria-label="History">
                <button type="button" className="button" onClick={undo} disabled={!canUndo}>
                  Undo
                </button>
                <button type="button" className="button" onClick={redo} disabled={!canRedo}>
                  Redo
                </button>
                <button type="button" className="button" onClick={handleStartOver}>
                  Start over
                </button>
              </div>

              <div className="route-tools__row" role="group" aria-label="Selected point">
                <span className="route-tools__status" aria-live="polite">
                  {selected === undefined
                    ? 'No point selected'
                    : `Point ${selected + 1} of ${pointCount} selected`}
                </span>
                <button
                  type="button"
                  className="button"
                  onClick={() => step(-1)}
                  disabled={pointCount === 0}
                >
                  Previous point
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => step(1)}
                  disabled={pointCount === 0}
                >
                  Next point
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={handleDelete}
                  disabled={selected === undefined}
                >
                  Delete point
                </button>
              </div>

              <div className="route-tools__row" role="group" aria-label="Section">
                <button
                  type="button"
                  className="button"
                  onClick={() => setSectionStart(selected)}
                  disabled={selected === undefined}
                >
                  Mark section start
                </button>
                {sectionStart !== undefined && (!section || section.start === section.end) && (
                  <span className="route-tools__status">
                    Section starts at point {sectionStart + 1}. Select where it ends.
                  </span>
                )}
                {section && section.start !== section.end && (
                  <>
                    <span className="route-tools__status" aria-live="polite">
                      Section: points {section.start + 1} to {section.end + 1} (
                      {section.end - section.start + 1} points,{' '}
                      {formatDistance(sectionDistance, unitSystem)})
                    </span>
                    <label className="route-tools__status">
                      <input
                        type="checkbox"
                        checked={keepGap}
                        onChange={(event) => setKeepGap(event.target.checked)}
                      />{' '}
                      Leave a gap instead of joining the ends
                    </label>
                    <button type="button" className="button" onClick={handleDiscardSection}>
                      Discard section
                    </button>
                  </>
                )}
                {sectionStart !== undefined && (
                  <button type="button" className="button" onClick={() => setSectionStart(undefined)}>
                    Cancel section
                  </button>
                )}
              </div>

              <div className="route-tools__row" role="group" aria-label="Add another track">
                <span className="route-tools__status">
                  Add another saved track to the end of this route:
                </span>
                <FileDropZone onFile={(file) => void handleImport(file)} disabled={isImporting} />
              </div>

              {pendingJoin && (
                <div className="route-tools__row" role="alertdialog" aria-label="Join the tracks">
                  <span className="route-tools__status">
                    That track starts {formatDistance(pendingJoin.gapMeters, unitSystem)} from where
                    this route ends. How should they be joined?
                  </span>
                  <button type="button" className="button" onClick={() => resolveJoin(false)}>
                    Join with a straight line
                  </button>
                  <button type="button" className="button" onClick={() => resolveJoin(true)}>
                    Keep them separate
                  </button>
                  <button type="button" className="button" onClick={() => setPendingJoin(undefined)}>
                    Cancel
                  </button>
                </div>
              )}

              <div className="route-tools__row" role="group" aria-label="Move selected point">
                {NUDGES.map(({ direction, label, symbol }) => (
                  <button
                    key={direction}
                    type="button"
                    className="button"
                    aria-label={`${label} ${NUDGE_METERS} metres`}
                    onClick={() => handleNudge(direction)}
                    disabled={selected === undefined}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
            </section>

            <section className="box" aria-label="Export route">
              <RouteExportPanel draft={draft} />
            </section>
          </>
        )}
      </div>
    </main>
  );
}
