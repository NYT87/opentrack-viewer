import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileDropZone } from '../components/FileDropZone';
import { WarningList } from '../components/ErrorPanel';
import { VideoReadProgress } from '../components/VideoReadProgress';
import { formatDistance, formatDuration, type UnitSystem } from '../domain/units';
import { ActivityError, toActivityError } from '../domain/errors';
import type { Activity } from '../domain/activity';
import { useActivityStore } from '../state/activityStore';
import { useInteractionStore } from '../state/interactionStore';
import { useOverlayStore, type OverlayVideoTiming } from '../state/overlayStore';
import { VIDEO_EXTENSIONS } from './readVideoTelemetry';
import { ROUTES } from './routes';
import { useVideoTelemetryRead } from './useVideoTelemetryRead';

type PageState =
  | { status: 'idle' }
  /** The file and its clock are kept for the overlay page (AV-1002). */
  | { status: 'ready'; activity: Activity; video: File; timing: OverlayVideoTiming }
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
  const setOverlayVideo = useOverlayStore((state) => state.setVideo);
  const offerOverlayActivity = useOverlayStore((state) => state.offerVideoActivity);
  const unitSystem = useInteractionStore((state) => state.unitSystem);

  const [state, setState] = useState<PageState>({ status: 'idle' });
  const { reading, read, cancel } = useVideoTelemetryRead();

  const handleFile = async (file: File) => {
    setState({ status: 'idle' });
    try {
      const { activity, timing, activityError } = await read(file);
      if (!activity || !timing) {
        // This page exists to turn the track into an activity; a video that
        // yields none is, here, a failure to explain. The overlay page differs.
        setState({
          status: 'error',
          error: activityError ?? new ActivityError('gopro_extract_failed', 'No activity was read.'),
        });
        return;
      }
      setState({ status: 'ready', activity, video: file, timing });
    } catch (error) {
      const failure = toActivityError(error, 'gopro_extract_failed');
      // A stop is what the reader asked for, not something to explain.
      setState(failure.code === 'extraction_cancelled' ? { status: 'idle' } : { status: 'error', error: failure });
    }
  };

  const openInViewer = () => {
    if (state.status !== 'ready') return;
    // The handoff: the activity is put where the viewer already looks for one.
    setActivity(state.activity);
    navigate(ROUTES.viewer);
  };

  const createOverlays = () => {
    if (state.status !== 'ready') return;
    // AV-1002. The same idea, for the overlay page: the video and the
    // container's clock, handed over in memory and nowhere else. The activity
    // (with the camera's other streams and its warnings inside it) is offered
    // too; the store declines it if the reader chose one there by hand, which
    // is theirs to keep (TD-040).
    setOverlayVideo({ file: state.video, timing: state.timing });
    offerOverlayActivity(state.activity);
    navigate(ROUTES.overlays);
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

        {reading ? (
          <VideoReadProgress progress={reading} onCancel={cancel} />
        ) : (
          <>
            {state.status === 'idle' && (
              <FileDropZone
                acceptedExtensions={VIDEO_EXTENSIONS}
                onFile={(file) => void handleFile(file)}
              />
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
                onOverlays={createOverlays}
                onReset={() => setState({ status: 'idle' })}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ExtractionSummary({
  activity,
  units,
  onOpen,
  onOverlays,
  onReset,
}: {
  activity: Activity;
  units: UnitSystem;
  onOpen: () => void;
  onOverlays: () => void;
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
        <button type="button" className="button" onClick={onOverlays}>
          Create overlays
        </button>
        <button type="button" className="button" onClick={onReset}>
          Read another video
        </button>
      </p>
    </section>
  );
}
