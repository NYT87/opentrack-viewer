import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatDuration, type UnitSystem } from '../domain/units';
import {
  inspectBurnSource,
  probeExportStorage,
  startBurnedInExport,
  type ExportJob,
  type ExportOutput,
} from '../overlay/export/client';
import { isOverlayExportError } from '../overlay/export/errors';
import { planBurn } from '../overlay/export/burnPlan';
import { describeBurnReadiness, getBurnSupport, type BurnSupport } from '../overlay/export/burnSupport';
import { EXPORT_HEIGHT_PRESETS, exportDimensions, formatBytes } from '../overlay/export/plan';
import type { ArchiveStorage, BurnSourceInfo } from '../overlay/export/protocol';
import { buildOverlay, type OverlayControls } from '../overlay/presets';
import { buildOverlayTimeline } from '../overlay/timeline';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';

interface BurnedInExportPanelProps {
  video: OverlayVideo;
  activity: Activity;
  controls: OverlayControls;
  offsetSeconds: number;
  units: UnitSystem;
  media: OverlayMedia | undefined;
  /** Injected by tests; the page uses the real worker and the real browser. */
  start?: typeof startBurnedInExport;
  inspect?: typeof inspectBurnSource;
  probeStorage?: () => Promise<ArchiveStorage>;
  freeSpace?: () => Promise<number | undefined>;
  support?: BurnSupport;
}

/** What was learned about the video, and for which picture size and file it was asked. */
type Inspected =
  | { key: string; status: 'ready'; info: BurnSourceInfo }
  | { key: string; status: 'failed'; message: string };
type Source = { status: 'checking' } | Inspected;

type Phase =
  | { status: 'idle' }
  | { status: 'running'; fraction: number; seconds: number }
  | {
      status: 'done';
      url: string;
      fileName: string;
      bytes: number;
      notes: string[];
      made: { signature: string; activity: Activity; file: File };
    }
  | { status: 'stopped' }
  | { status: 'error'; message: string };

const NATIVE = 'native';
const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, '') || 'video';

async function browserFreeSpace(): Promise<number | undefined> {
  try {
    const { quota, usage } = (await navigator.storage?.estimate?.()) ?? {};
    return quota !== undefined && usage !== undefined ? quota - usage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * AV-1007. Renders a copy of the video with the overlay drawn into the picture:
 * every frame is decoded, the overlay is drawn over it, and the result is
 * encoded as H.264 in an MP4, with the sound carried over where it can be. The original file is only
 * read — never changed — and the new one goes to the reader as a download.
 *
 * Everything happens in a worker on this device. Before a render is offered the
 * panel looks at the video and the browser and says, in words, what will happen
 * and what stands in the way.
 */
export function BurnedInExportPanel({
  video,
  activity,
  controls,
  offsetSeconds,
  units,
  media,
  start = startBurnedInExport,
  inspect = inspectBurnSource,
  probeStorage = probeExportStorage,
  freeSpace = browserFreeSpace,
  support = getBurnSupport(),
}: BurnedInExportPanelProps) {
  const id = useId();
  const [heightChoice, setHeightChoice] = useState<string>(NATIVE);
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [inspected, setInspected] = useState<Inspected | undefined>(undefined);
  const [storage, setStorage] = useState<ArchiveStorage | undefined>(undefined);
  const [freeBytes, setFreeBytes] = useState<number | undefined>(undefined);
  const job = useRef<ExportJob | undefined>(undefined);
  const output = useRef<ExportOutput | undefined>(undefined);

  const durationSeconds = video.timing?.durationSeconds ?? media?.durationSeconds;
  const timeline = useMemo(
    () =>
      buildOverlayTimeline(activity, {
        video: { durationSeconds: durationSeconds ?? 0, start: video.timing?.start },
        offsetSeconds,
      }),
    [activity, durationSeconds, video.timing?.start, offsetSeconds],
  );

  const ready = media !== undefined && durationSeconds !== undefined && durationSeconds > 0;
  const height = heightChoice === NATIVE ? (media?.height ?? 1080) : Number(heightChoice);
  const { width: outWidth, height: outHeight } = exportDimensions(
    media ? media.width / media.height : 16 / 9,
    height,
  );
  const frameRate =
    video.timing && video.timing.frameIntervalSeconds > 0
      ? Math.round(10 / video.timing.frameIntervalSeconds) / 10
      : undefined;

  const built = useMemo(
    () => buildOverlay(controls, timeline, outWidth / outHeight),
    [controls, timeline, outWidth, outHeight],
  );
  // The answer belongs to the file and size it was asked for: any other is a question not yet answered.
  const inspectKey = `${video.file.name}:${video.file.size}:${video.file.lastModified}:${outWidth}x${outHeight}:${frameRate}`;
  const source: Source =
    inspected && inspected.key === inspectKey ? inspected : { status: 'checking' };
  const plan = planBurn({
    videoDurationSeconds: durationSeconds ?? 0,
    width: outWidth,
    height: outHeight,
    frameRate,
    hasAudio: source.status === 'ready' && source.info.audio !== undefined,
  });

  // Look at the video, once the target size is known: what is in it, whether
  // this browser can decode it and encode the result. Reads only the index.
  const bitrate = plan.bitrate;
  useEffect(() => {
    if (!support.supported || !ready) return;
    let current = true;
    inspect(video.file, { width: outWidth, height: outHeight, bitrate, frameRate }).then(
      (info) => current && setInspected({ key: inspectKey, status: 'ready', info }),
      (error: unknown) =>
        current &&
        setInspected({
          key: inspectKey,
          status: 'failed',
          message: error instanceof Error ? error.message : 'The video could not be read.',
        }),
    );
    return () => {
      current = false;
    };
  }, [support.supported, ready, video.file, outWidth, outHeight, bitrate, frameRate, inspect, inspectKey]);

  useEffect(() => {
    if (!support.supported) return;
    let current = true;
    probeStorage().then(
      (kind) => current && setStorage(kind),
      () => current && setStorage('memory'),
    );
    void freeSpace().then((bytes) => current && setFreeBytes(bytes));
    return () => {
      current = false;
    };
  }, [support.supported, probeStorage, freeSpace]);

  // The rendered file is stored until the reader has it; leaving the page frees it.
  useEffect(
    () => () => {
      job.current?.cancel();
      void output.current?.dispose();
    },
    [],
  );
  useEffect(
    () => () => {
      if (phase.status === 'done') URL.revokeObjectURL(phase.url);
    },
    [phase],
  );

  if (timeline.unavailable) return null;

  const signature = JSON.stringify([built.template, units, offsetSeconds, outWidth, outHeight]);
  const running = phase.status === 'running';
  const nothingOn = built.template.components.length === 0;
  const readiness =
    source.status === 'ready' && storage !== undefined
      ? describeBurnReadiness({
          info: source.info,
          tooLarge: plan.tooLarge,
          estimatedBytes: plan.estimatedBytes,
          freeBytes,
          fileStorage: storage === 'opfs',
        })
      : undefined;
  const blocked = (readiness?.errors.length ?? 1) > 0 || nothingOn;

  const begin = () => {
    if (!ready || running || blocked) return;
    void output.current?.dispose();
    output.current = undefined;
    setPhase({ status: 'running', fraction: 0, seconds: 0 });

    let active: ExportJob;
    try {
      active = start(
        {
          file: video.file,
          width: outWidth,
          height: outHeight,
          bitrate: plan.bitrate,
          frameRate,
          videoDurationSeconds: durationSeconds ?? 0,
          videoStart: video.timing?.start,
          offsetSeconds,
          units,
          template: built.template,
          activity,
        },
        (fraction, seconds) => setPhase({ status: 'running', fraction, seconds }),
      );
    } catch (error) {
      setPhase({
        status: 'error',
        message: error instanceof Error ? error.message : 'The render could not be started.',
      });
      return;
    }
    job.current = active;

    active.done.then(
      (result) => {
        if (job.current !== active) return;
        job.current = undefined;
        output.current = result;
        setPhase({
          status: 'done',
          url: URL.createObjectURL(result.file),
          fileName: `${baseName(video.file.name)}-with-overlay.mp4`,
          bytes: result.bytes,
          notes: result.notes ?? [],
          made: { signature, activity, file: video.file },
        });
      },
      (error: unknown) => {
        if (job.current !== active) return;
        job.current = undefined;
        if (isOverlayExportError(error) && error.code === 'cancelled') setPhase({ status: 'stopped' });
        else {
          setPhase({
            status: 'error',
            message: error instanceof Error ? error.message : 'The video could not be rendered.',
          });
        }
      },
    );
  };

  return (
    <section className="prose overlay-export" aria-label="Burned-in export">
      <h3 className="prose__title">Export video with the overlay</h3>
      <p>
        Renders a copy of your video with the overlay drawn into the picture: an MP4 with H.264
        video, carrying your video&apos;s sound over where it can (what will happen to yours is
        said below). Your original file is only read, never changed. The render happens on this
        device; nothing is uploaded. Desktop browsers only.
      </p>

      {!support.supported && <p role="alert">{support.reason}</p>}
      {support.supported && !ready && (
        <p role="status">Waiting for the video to load so its size and length are known.</p>
      )}
      {support.supported && ready && source.status === 'checking' && (
        <p role="status">Checking what this browser can do with this video…</p>
      )}
      {support.supported && ready && source.status === 'failed' && (
        <p role="alert">{source.message}</p>
      )}

      {support.supported && ready && media && source.status === 'ready' && (
        <>
          <div className="overlay-export__settings">
            <label className="overlay-controls__field" htmlFor={`${id}-size`}>
              Picture size
              <select
                id={`${id}-size`}
                value={heightChoice}
                disabled={running}
                onChange={(event) => setHeightChoice(event.target.value)}
              >
                <option value={NATIVE}>
                  Same as the video ({exportDimensions(media.width / media.height, media.height).width}
                  {' × '}
                  {exportDimensions(media.width / media.height, media.height).height})
                </option>
                {EXPORT_HEIGHT_PRESETS.filter((preset) => preset !== media.height).map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}p ({exportDimensions(media.width / media.height, preset).width} × {preset})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p data-testid="burn-plan">
            {outWidth} × {outHeight}, H.264 at about {(plan.bitrate / 1e6).toFixed(1)} Mbps — roughly{' '}
            {formatBytes(plan.estimatedBytes)}. Rendering takes roughly{' '}
            {formatDuration(Math.max(1, plan.estimatedSeconds))} for {formatDuration(durationSeconds)}{' '}
            of video (about {plan.realtimeMultiple.toFixed(1)}× faster than playing it).
          </p>

          {readiness && readiness.notes.length > 0 && (
            <ul aria-label="About this render">
              {readiness.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {readiness && readiness.errors.length > 0 && (
            <div role="alert">
              {readiness.errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}
          {nothingOn && (
            <p role="status">No component is switched on, so there is nothing to draw.</p>
          )}

          <p className="video__actions">
            {running ? (
              <button type="button" className="button" onClick={() => job.current?.cancel()}>
                Stop render
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                onClick={begin}
                disabled={blocked || storage === undefined}
              >
                Render video with overlay
              </button>
            )}
          </p>
        </>
      )}

      {phase.status === 'running' && (
        <p>
          <progress
            aria-label="Render progress"
            value={Math.round(phase.fraction * 100)}
            max={100}
            className="overlay-export__progress"
          />{' '}
          {Math.round(phase.fraction * 100)}% — {formatDuration(phase.seconds)} of{' '}
          {formatDuration(durationSeconds)}
        </p>
      )}
      {phase.status === 'done' &&
        (phase.made.signature !== signature ||
          phase.made.activity !== activity ||
          phase.made.file !== video.file) && (
          <p role="alert">
            This video was rendered with earlier settings, and no longer matches the preview. Render
            again to match it.
          </p>
        )}
      {phase.status === 'done' && (
        <p role="status">
          Done: {formatBytes(phase.bytes)}.{' '}
          <a className="button button--primary" href={phase.url} download={phase.fileName}>
            Download {phase.fileName}
          </a>
        </p>
      )}
      {phase.status === 'done' &&
        phase.notes.map((note) => (
          <p key={note} role="status">
            {note}
          </p>
        ))}
      {phase.status === 'stopped' && <p role="status">Render stopped. Nothing was saved.</p>}
      {phase.status === 'error' && <p role="alert">{phase.message}</p>}
    </section>
  );
}
