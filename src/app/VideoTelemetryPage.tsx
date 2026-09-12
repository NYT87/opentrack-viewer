import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileDropZone } from '../components/FileDropZone';
import { WarningList } from '../components/ErrorPanel';
import { formatDistance, formatDuration, type UnitSystem } from '../domain/units';
import { ActivityError, toActivityError } from '../domain/errors';
import type { Activity } from '../domain/activity';
import { useActivityStore } from '../state/activityStore';
import { useInteractionStore } from '../state/interactionStore';
import { ROUTES } from './routes';

/** The container formats a GoPro writes. */
const VIDEO_EXTENSIONS = ['mp4', 'mov'];

type PageState =
  | { status: 'idle' }
  | { status: 'extracting'; fileName: string; fraction: number }
  | { status: 'ready'; activity: Activity }
  | { status: 'error'; error: ActivityError };

/**
 * AV-907. Reads the telemetry out of a GoPro video, then hands the result to
 * the viewer.
 *
 * A page of its own rather than another thing the viewer's drop zone accepts:
 * a video is orders of magnitude larger than a GPX file, so reading one needs
 * progress and a way to stop, and neither belongs in a drop zone. Until the
 * read succeeds this page shows no map, no charts and no export controls —
 * there is no activity for them to describe yet.
 *
 * Nothing is uploaded at any point: the video is read by this tab, the payload
 * is interpreted in this tab, and the activity is handed over in memory.
 */
export function VideoTelemetryPage() {
  const navigate = useNavigate();
  const setActivity = useActivityStore((state) => state.setActivity);
  const unitSystem = useInteractionStore((state) => state.unitSystem);

  const [state, setState] = useState<PageState>({ status: 'idle' });
  const abortRef = useRef<AbortController | undefined>(undefined);

  const handleFile = async (file: File) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'extracting', fileName: file.name, fraction: 0 });

    try {
      // Loaded on demand: a reader who never opens a video should not download
      // an MP4 demuxer to look at a GPX file.
      const [{ extractGpmf }, { parseGopro }] = await Promise.all([
        import('../parsers/gopro/extractGpmf'),
        import('../parsers/gopro/parseGopro'),
      ]);

      const payload = await extractGpmf(file, {
        signal: controller.signal,
        onProgress: (fraction) =>
          setState((current) =>
            current.status === 'extracting' ? { ...current, fraction } : current,
          ),
      });

      const activity = await parseGopro(payload, {
        fileName: file.name,
        fileSizeBytes: file.size,
      });
      setState({ status: 'ready', activity });
    } catch (error) {
      setState({ status: 'error', error: toActivityError(error, 'gopro_extract_failed') });
    } finally {
      abortRef.current = undefined;
    }
  };

  const cancel = () => abortRef.current?.abort();

  const openInViewer = () => {
    if (state.status !== 'ready') return;
    // The handoff: the activity is put where the viewer already looks for one.
    setActivity(state.activity);
    navigate(ROUTES.viewer);
  };

  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Video telemetry</h2>
          <p className="page__intro">
            GoPro cameras record where they were alongside the picture. Open a video here to read
            that track out of it and view it as an activity. The video is read on this device —
            it is never uploaded, and neither is anything found inside it.
          </p>
        </header>

        {state.status === 'idle' && (
          <FileDropZone
            acceptedExtensions={VIDEO_EXTENSIONS}
            onFile={(file) => void handleFile(file)}
          />
        )}

        {state.status === 'extracting' && (
          <section className="prose" aria-label="Reading the video">
            <h3 className="prose__title">Reading {state.fileName}</h3>
            <p>
              Only the telemetry track is kept; the video itself streams past without being held
              in memory, however large it is.
            </p>
            <progress
              className="video__progress"
              value={state.fraction}
              max={1}
              aria-label="Extraction progress"
            />
            <p>
              <button type="button" className="button" onClick={cancel}>
                Stop reading
              </button>
            </p>
          </section>
        )}

        {state.status === 'error' && (
          <section className="prose" aria-label="Extraction failed">
            <h3 className="prose__title">That video could not be read</h3>
            <p role="alert">{state.error.message}</p>
            <p>
              <button
                type="button"
                className="button"
                onClick={() => setState({ status: 'idle' })}
              >
                Try another video
              </button>
            </p>
          </section>
        )}

        {state.status === 'ready' && (
          <ExtractionSummary
            activity={state.activity}
            units={unitSystem}
            onOpen={openInViewer}
            onReset={() => setState({ status: 'idle' })}
          />
        )}
      </div>
    </main>
  );
}

function ExtractionSummary({
  activity,
  units,
  onOpen,
  onReset,
}: {
  activity: Activity;
  units: UnitSystem;
  onOpen: () => void;
  onReset: () => void;
}) {
  const derived = activity.derived;

  return (
    <section className="prose" aria-label="Extraction result">
      <h3 className="prose__title">Telemetry found</h3>
      <dl className="summary__grid">
        <div className="summary__stat">
          <dt className="summary__label">Points</dt>
          <dd className="summary__value">{activity.points.length}</dd>
        </div>
        <div className="summary__stat">
          <dt className="summary__label">Distance</dt>
          <dd className="summary__value">{formatDistance(derived?.distanceMeters, units)}</dd>
        </div>
        <div className="summary__stat">
          <dt className="summary__label">Duration</dt>
          <dd className="summary__value">{formatDuration(derived?.durationSeconds)}</dd>
        </div>
        {activity.metadata.device?.name && (
          <div className="summary__stat">
            <dt className="summary__label">Camera</dt>
            <dd className="summary__value">{activity.metadata.device.name}</dd>
          </div>
        )}
      </dl>

      <WarningList warnings={activity.warnings} />

      <p className="video__actions">
        <button type="button" className="button button--primary" onClick={onOpen}>
          Open in viewer
        </button>
        <button type="button" className="button" onClick={onReset}>
          Read another video
        </button>
      </p>
    </section>
  );
}
