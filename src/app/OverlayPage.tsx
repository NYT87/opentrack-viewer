import { useState } from 'react';
import { FileDropZone } from '../components/FileDropZone';
import { WarningList } from '../components/ErrorPanel';
import { VideoReadProgress } from '../components/VideoReadProgress';
import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { formatDistance, formatDuration, formatFileSize, type UnitSystem } from '../domain/units';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useInteractionStore } from '../state/interactionStore';
import { hasOverlaySource, useOverlayStore, type OverlayVideo } from '../state/overlayStore';
import { VIDEO_EXTENSIONS } from './readVideoTelemetry';
import { useVideoTelemetryRead } from './useVideoTelemetryRead';

type Busy =
  | { status: 'idle' }
  | { status: 'readingActivity'; fileName: string }
  | { status: 'error'; error: ActivityError };

/**
 * AV-1002. Where overlays are made: a page of its own, reached from Tools,
 * that holds a local video, a normalized activity, or both.
 *
 * It renders nothing of the viewer — no map, no charts, no export controls —
 * because there is nothing to view here, only something to draw over. Until
 * `AV-1003` and `AV-1004` bring the timeline and the preview, what it does is
 * take the files in, say what it has, and keep them in memory for the rest.
 *
 * Two ways in. The extraction page hands over what it read; or the files are
 * chosen here, which is also what a reload needs, since the handoff is memory
 * only (§5) and does not survive one.
 */
export function OverlayPage() {
  const source = useOverlayStore((state) => state.source);
  const setVideo = useOverlayStore((state) => state.setVideo);
  const setActivity = useOverlayStore((state) => state.setActivity);
  const clearActivity = useOverlayStore((state) => state.clearActivity);
  const offerVideoActivity = useOverlayStore((state) => state.offerVideoActivity);
  const clear = useOverlayStore((state) => state.clear);
  const unitSystem = useInteractionStore((state) => state.unitSystem);

  const [busy, setBusy] = useState<Busy>({ status: 'idle' });
  const { reading, read, cancel } = useVideoTelemetryRead();

  const handleVideo = async (file: File) => {
    setBusy({ status: 'idle' });
    try {
      const { activity, timing, activityError } = await read(file);
      // Whatever the reader returned is a video to draw over — it decides
      // which outcomes still are — and what the video could not supply is
      // noted beside it. The store decides whether its telemetry becomes the
      // activity: not over one the reader chose by hand (TD-040).
      setVideo({ file, timing, telemetryNote: activityError?.message });
      if (activity) offerVideoActivity(activity);
    } catch (error) {
      const failure = toActivityError(error, 'gopro_extract_failed');
      if (failure.code === 'extraction_cancelled') return;
      // What the reader throws is a file nothing could be drawn over.
      setBusy({ status: 'error', error: failure });
    }
  };

  const handleActivity = async (file: File) => {
    setBusy({ status: 'readingActivity', fileName: file.name });
    try {
      // The same intake the viewer uses: GPX, FIT, TCX and KML, read here.
      const { activity } = await parseActivityFile(file);
      setActivity(activity, 'hand');
      setBusy({ status: 'idle' });
    } catch (error) {
      setBusy({ status: 'error', error: toActivityError(error, 'unsupported_format') });
    }
  };

  const idle = busy.status === 'idle' && !reading;

  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Overlays</h2>
          <p className="page__intro">
            Draw what a video's telemetry says over the picture — speed, distance, the route, the
            climbs — for your own video editor. Everything is drawn on this device; the video, its
            telemetry and anything made from them are never uploaded.
          </p>
        </header>

        {idle && !hasOverlaySource(source) && (
          <section className="prose" aria-label="Nothing to overlay yet">
            <h3 className="prose__title">Nothing to overlay yet</h3>
            <p>
              Overlays start from a GoPro video, an activity file, or both. If you came here from
              Video telemetry, that handoff lives in memory only and does not survive a reload —
              choose the files again below.
            </p>
          </section>
        )}

        {reading && <VideoReadProgress progress={reading} onCancel={cancel} />}

        {busy.status === 'readingActivity' && (
          <section className="prose" aria-label="Reading the activity">
            <h3 className="prose__title">Reading {busy.fileName}</h3>
            <p>Parsing happens in this tab.</p>
          </section>
        )}

        {busy.status === 'error' && (
          <section className="prose" aria-label="File not read">
            <h3 className="prose__title">That file could not be read</h3>
            <p role="alert">{busy.error.message}</p>
            <p>
              <button type="button" className="button" onClick={() => setBusy({ status: 'idle' })}>
                Try another file
              </button>
            </p>
          </section>
        )}

        {idle && (
          <>
            <VideoSlot
              video={source.video}
              onFile={(file) => void handleVideo(file)}
              onClear={() => setVideo(undefined)}
            />
            <ActivitySlot
              activity={source.activity}
              units={unitSystem}
              onFile={(file) => void handleActivity(file)}
              onClear={clearActivity}
            />
          </>
        )}

        {idle && hasOverlaySource(source) && (
          <section className="prose" aria-label="What comes next">
            <h3 className="prose__title">Held here, for the next steps</h3>
            <p>
              {source.video && source.activity
                ? 'Templates, a synchronized preview and export follow. Both files stay in memory on this page until then, or until you start over.'
                : source.video
                  ? 'This video supplies no activity of its own. Add an activity file — from a watch, say — to draw over it.'
                  : 'Without a video, this activity can become a standalone overlay: the route on a transparent background. Add a video to draw its telemetry over the picture.'}
            </p>
            <p className="video__actions">
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

function VideoSlot({
  video,
  onFile,
  onClear,
}: {
  video: OverlayVideo | undefined;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <section className="prose" aria-label="Video">
      <h3 className="prose__title">Video</h3>
      {video ? (
        <>
          <dl className="summary__grid">
            <div className="summary__stat">
              <dt className="summary__label">File</dt>
              <dd className="summary__value">{video.file.name}</dd>
            </div>
            <div className="summary__stat">
              <dt className="summary__label">Size</dt>
              <dd className="summary__value">{formatFileSize(video.file.size)}</dd>
            </div>
            {video.timing && (
              <div className="summary__stat">
                <dt className="summary__label">Duration</dt>
                <dd className="summary__value">{formatDuration(video.timing.durationSeconds)}</dd>
              </div>
            )}
          </dl>
          {video.telemetryNote && <p>{video.telemetryNote}</p>}
          <p>
            <button type="button" className="button" onClick={onClear}>
              Choose another video
            </button>
          </p>
        </>
      ) : (
        <FileDropZone
          acceptedExtensions={VIDEO_EXTENSIONS}
          onFile={onFile}
          testId="overlay-video-input"
        />
      )}
    </section>
  );
}

function ActivitySlot({
  activity,
  units,
  onFile,
  onClear,
}: {
  activity: Activity | undefined;
  units: UnitSystem;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const charted = activity?.sensorStreams?.filter((stream) => stream.display === 'chart') ?? [];

  return (
    <section className="prose" aria-label="Activity">
      <h3 className="prose__title">Activity</h3>
      {activity ? (
        <>
          <dl className="summary__grid">
            <div className="summary__stat">
              <dt className="summary__label">From</dt>
              <dd className="summary__value">
                {activity.source.fileName ?? activity.source.format.toUpperCase()}
              </dd>
            </div>
            <div className="summary__stat">
              <dt className="summary__label">Points</dt>
              <dd className="summary__value">{activity.points.length}</dd>
            </div>
            <div className="summary__stat">
              <dt className="summary__label">Distance</dt>
              <dd className="summary__value">
                {formatDistance(activity.derived?.distanceMeters, units)}
              </dd>
            </div>
            <div className="summary__stat">
              <dt className="summary__label">Duration</dt>
              <dd className="summary__value">{formatDuration(activity.derived?.durationSeconds)}</dd>
            </div>
            {charted.length > 0 && (
              <div className="summary__stat">
                <dt className="summary__label">Camera streams</dt>
                <dd className="summary__value">
                  {charted.map((stream) => stream.label).join(', ')}
                </dd>
              </div>
            )}
          </dl>
          <WarningList warnings={activity.warnings} />
          <p>
            <button type="button" className="button" onClick={onClear}>
              Choose another activity
            </button>
          </p>
        </>
      ) : (
        <FileDropZone
          acceptedExtensions={SUPPORTED_FORMATS}
          onFile={onFile}
          testId="overlay-activity-input"
        />
      )}
    </section>
  );
}
