import { useMemo } from 'react';
import { draftDistanceMeters } from '../domain/routeDraft';
import { formatDistance } from '../domain/units';
import { useInteractionStore } from '../state/interactionStore';
import { useRouteDraftStore } from '../state/routeDraftStore';

/**
 * AV-1102. Where a planned route is made.
 *
 * It owns a *draft*, never a loaded activity: whatever was open in the viewer
 * is copied in by the handoff (AV-1103) and stays as it was. Nothing here
 * uploads or stores anything — the draft lives in memory and a reload starts
 * the page empty.
 */
export function RouteBuilderPage() {
  const draft = useRouteDraftStore((state) => state.draft);
  const startBlank = useRouteDraftStore((state) => state.startBlank);
  const clear = useRouteDraftStore((state) => state.clear);
  const unitSystem = useInteractionStore((state) => state.unitSystem);

  const distance = useMemo(() => (draft ? draftDistanceMeters(draft) : 0), [draft]);

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
          </section>
        )}

        {draft && (
          <section className="prose" aria-label="Current route">
            <h3 className="prose__title">{draft.name}</h3>
            <dl className="summary__grid">
              <div className="summary__stat">
                <dt className="summary__label">Points</dt>
                <dd className="summary__value">{draft.points.length}</dd>
              </div>
              <div className="summary__stat">
                <dt className="summary__label">Distance</dt>
                <dd className="summary__value">{formatDistance(distance, unitSystem)}</dd>
              </div>
            </dl>
            <p>
              <button type="button" className="button" onClick={clear}>
                Start over
              </button>
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
