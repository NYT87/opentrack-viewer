import { useEffect, useMemo, useRef, useState } from 'react';
import { FileDropZone } from '../components/FileDropZone';
import { WarningList } from '../components/ErrorPanel';
import { toActivityError } from '../domain/errors';
import { draftToActivity, type RouteDraft } from '../domain/routeDraft';
import { formatDistance, type UnitSystem } from '../domain/units';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useInteractionStore } from '../state/interactionStore';
import { useRouteDraftStore } from '../state/routeDraftStore';

type Intake =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'error'; message: string };

const KIND_LABEL: Record<RouteDraft['kind'], string> = {
  blank: 'A new planned track',
  copied: 'Copied from a track',
  appended: 'Built from imported tracks',
};

/**
 * AV-1102. Where planned tracks are made: a page of its own, reached from Tools.
 * Route editing does not happen in the viewer, which shows what was recorded.
 *
 * It holds one draft (`RouteDraft`, AV-1101) in memory. A draft arrives by
 * handoff from the viewer, or is started here — blank, or from a track file,
 * which is also all a reload leaves, since the handoff does not survive one.
 * Editing tools come with the tasks that follow; this page takes drafts in and
 * says what it holds.
 */
export function RouteBuilderPage() {
  const draft = useRouteDraftStore((state) => state.draft);
  const startBlank = useRouteDraftStore((state) => state.startBlank);
  const importTrack = useRouteDraftStore((state) => state.importTrack);
  const clear = useRouteDraftStore((state) => state.clear);
  const unitSystem = useInteractionStore((state) => state.unitSystem);

  const [intake, setIntake] = useState<Intake>({ status: 'idle' });

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
            Plan a track: start a blank one, or begin from a GPX, FIT, TCX or KML route. It is
            built in this browser tab; nothing is uploaded, stored or sent anywhere.
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

        {draft && !busy && <DraftSummary draft={draft} units={unitSystem} onClear={clear} />}

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
          This track has no points yet. Import a route below to give it some; tools for placing
          points by hand come next.
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
