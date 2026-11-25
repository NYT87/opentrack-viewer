import { insetTilesText, type InsetExportCheck } from '../overlay/insetExportCheck';

/**
 * AV-1023 (TD-092). What an export with a map in a route inset says before it starts: where its
 * tiles come from and how many (each is asked for once), that the privacy trim keeps the start and
 * end out of every request, and, when the export may not go ahead, why.
 */
export function InsetExportNotes({ check }: { check: InsetExportCheck | undefined }) {
  if (!check) return null;
  return (
    <>
      <p role="status" data-testid="inset-tiles">
        {insetTilesText(check)}
      </p>
      {check.refusal && <p role="alert">{check.refusal}</p>}
    </>
  );
}

/** AV-1023. What a running export with a map is waiting for, as the map video says it: tiles still coming, a hidden tab, and the WebM's pre-load. */
export function InsetWaiting({ waiting, loading }: { waiting: 'tiles' | 'hidden' | undefined; loading?: { done: number; total: number } }) {
  return (
    <>
      {loading && <p role="status">Loading the map’s tiles: {loading.done} of {loading.total}</p>}
      {waiting === 'tiles' && <p role="status">Waiting for map tiles…</p>}
      {waiting === 'hidden' && <p role="alert">Waiting: the tab is hidden, so the map cannot draw. Bring it back to carry on.</p>}
    </>
  );
}
