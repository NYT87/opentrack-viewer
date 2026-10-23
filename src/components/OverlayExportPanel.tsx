import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatDuration, type UnitSystem } from '../domain/units';
import { storageLimitBytes } from '../overlay/export/archiveSink';
import {
  probeExportStorage,
  startOverlayExport,
  type ExportJob,
  type ExportOutput,
} from '../overlay/export/client';
import { isOverlayExportError } from '../overlay/export/errors';
import {
  DEFAULT_EXPORT_FRAME_RATE,
  EXPORT_FRAME_RATES,
  EXPORT_HEIGHT_PRESETS,
  exportDimensions,
  formatBytes,
  formatFrameRate,
  highestFittingFrameRate,
  planExport,
} from '../overlay/export/plan';
import { getExportSupport, type ExportSupport } from '../overlay/export/support';
import type { ArchiveStorage } from '../overlay/export/protocol';
import { ZIP_MAX_BYTES } from '../overlay/export/zip';
import { buildOverlay, type OverlayControls } from '../overlay/presets';
import { buildOverlayTimeline } from '../overlay/timeline';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';

interface OverlayExportPanelProps {
  video: OverlayVideo;
  activity: Activity;
  controls: OverlayControls;
  offsetSeconds: number;
  units: UnitSystem;
  media: OverlayMedia | undefined;
  /** Injected by tests; the page uses the real worker and the real browser. */
  start?: typeof startOverlayExport;
  support?: ExportSupport;
  /** Asks the worker where an archive can really be stored; injected by tests. */
  probeStorage?: () => Promise<ArchiveStorage>;
  /** Told whether a finished file is waiting to be downloaded, so Start over can ask first. */
  onFinishedChange?: (finished: boolean) => void;
}

type StorageState =
  | { status: 'checking' }
  | { status: 'ready'; storage: ArchiveStorage }
  | { status: 'failed'; message: string };

type Phase =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | {
      status: 'done';
      url: string;
      fileName: string;
      bytes: number;
      frameCount: number;
      /** The rate it was drawn at, for the note on setting the editor to match. */
      fps: number;
      /** What it was made from, to tell when the page has since moved on. */
      made: { signature: string; activity: Activity; file: File };
    }
  | { status: 'stopped' }
  | { status: 'error'; message: string };

const NATIVE = 'native';

/**
 * The offered rate nearest the video's own, so a 25 fps video starts at 25 and
 * a GoPro's 29.97 starts at 29.97, not at a 30 that would drift (TD-059).
 */
function nearestFrameRate(frameIntervalSeconds: number | undefined): number {
  if (!frameIntervalSeconds || !(frameIntervalSeconds > 0)) return DEFAULT_EXPORT_FRAME_RATE;
  const own = 1 / frameIntervalSeconds;
  return EXPORT_FRAME_RATES.reduce((best, rate) =>
    Math.abs(rate - own) < Math.abs(best - own) ? rate : best,
  );
}

const baseName = (fileName: string) => fileName.replace(/\.[^.]+$/, '') || 'overlay';

/**
 * AV-1006. Exports the overlay on its own — a transparent PNG for every frame,
 * zipped — for an editor to lay over the video. The video is never modified,
 * re-encoded or read for its pictures; this draws only the overlay.
 *
 * Runs in a worker on this device. The frames, the telemetry and the archive
 * never leave it, and a stop discards everything written so far.
 */
export function OverlayExportPanel({
  video,
  activity,
  controls,
  offsetSeconds,
  units,
  media,
  start = startOverlayExport,
  support = getExportSupport(),
  probeStorage = probeExportStorage,
  onFinishedChange,
}: OverlayExportPanelProps) {
  const id = useId();
  const [fps, setFps] = useState(() => nearestFrameRate(video.timing?.frameIntervalSeconds));
  const [heightChoice, setHeightChoice] = useState<string>(NATIVE);
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [storageState, setStorageState] = useState<StorageState>({ status: 'checking' });
  const job = useRef<ExportJob | undefined>(undefined);
  const output = useRef<ExportOutput | undefined>(undefined);

  // Where the archive can really go is only known to the worker, which is the
  // one that is given a file to write; plan against that, not against a guess.
  useEffect(() => {
    if (!support.supported) return;
    let current = true;
    probeStorage().then(
      (storage) => current && setStorageState({ status: 'ready', storage }),
      (error: unknown) =>
        current &&
        setStorageState({
          status: 'failed',
          message: error instanceof Error ? error.message : 'The export engine could not be started.',
        }),
    );
    return () => {
      current = false;
    };
  }, [probeStorage, support.supported]);
  const storageLimitBytesNow =
    storageState.status === 'ready' ? storageLimitBytes(storageState.storage) : ZIP_MAX_BYTES;

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
  const { width: exportWidth, height: exportHeight } = exportDimensions(
    media ? media.width / media.height : 16 / 9,
    height,
  );
  const plan = planExport({
    videoDurationSeconds: durationSeconds ?? 0,
    fps,
    width: exportWidth,
    height: exportHeight,
    limitBytes: storageLimitBytesNow,
  });
  const built = useMemo(
    () => buildOverlay(controls, timeline, exportWidth / exportHeight),
    [controls, timeline, exportWidth, exportHeight],
  );
  // Everything that changes the picture. A finished export is compared with it.
  const signature = JSON.stringify([built.template, units, offsetSeconds, plan.fps, plan.width, plan.height]);
  const fallbackFps = plan.fitsArchive
    ? undefined
    : highestFittingFrameRate({
        videoDurationSeconds: durationSeconds ?? 0,
        width: exportWidth,
        height: exportHeight,
        limitBytes: storageLimitBytesNow,
      });

  // The archive is stored until the reader has it; leaving the page frees it.
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

  const isFinished = phase.status === 'done';
  useEffect(() => onFinishedChange?.(isFinished), [isFinished, onFinishedChange]);

  if (timeline.unavailable) return null;

  /*
   * TD-059. A video the activity covers none of would export an empty overlay:
   * blocked like "nothing switched on", with the way out named.
   */
  const noOverlap = timeline.alignment?.overlaps === false;

  const running = phase.status === 'running';
  const nothingOn = built.template.components.length === 0;

  const begin = () => {
    if (!ready || running) return;
    void output.current?.dispose();
    output.current = undefined;
    setPhase({ status: 'running', done: 0, total: plan.frameCount });

    let active: ExportJob;
    try {
      active = start(
        {
          width: plan.width,
          height: plan.height,
          fps: plan.fps,
          frameCount: plan.frameCount,
          videoDurationSeconds: durationSeconds ?? 0,
          videoStart: video.timing?.start,
          offsetSeconds,
          units,
          template: built.template,
          activity,
        },
        (done, total) => setPhase({ status: 'running', done, total }),
      );
    } catch (error) {
      // The export could not even be started: say so, and leave the panel ready to try again.
      setPhase({
        status: 'error',
        message: error instanceof Error ? error.message : 'The export could not be started.',
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
          fileName: `${baseName(video.file.name)}-overlay-${plan.width}x${plan.height}-${formatFrameRate(plan.fps)}fps.zip`,
          fps: plan.fps,
          bytes: result.bytes,
          frameCount: result.frameCount,
          made: { signature, activity, file: video.file },
        });
      },
      (error: unknown) => {
        if (job.current !== active) return;
        job.current = undefined;
        if (isOverlayExportError(error) && error.code === 'cancelled') {
          setPhase({ status: 'stopped' });
        } else {
          setPhase({
            status: 'error',
            message: error instanceof Error ? error.message : 'The export could not be completed.',
          });
        }
      },
    );
  };

  const stop = () => job.current?.cancel();
  // One primary at a time: the export until a file is ready, then its download,
  // and the export again once that file no longer matches the preview.
  const stale =
    phase.status === 'done' &&
    (phase.made.signature !== signature || phase.made.activity !== activity || phase.made.file !== video.file);
  const downloadFirst = phase.status === 'done' && !stale;

  return (
    <section className="prose overlay-export" aria-label="Export overlay">
      <h3 className="prose__title" tabIndex={-1}>
        Export overlay
      </h3>
      <p>
        Saves the overlay by itself, one transparent PNG per frame in a ZIP, to place over your video
        in an editor. Your video is not changed, and nothing is uploaded.
      </p>

      {!support.supported && <p role="alert">{support.reason}</p>}
      {support.supported && storageState.status === 'checking' && (
        <p role="status">Checking how this browser can store the export…</p>
      )}
      {support.supported && storageState.status === 'failed' && (
        <p role="alert">{storageState.message}</p>
      )}
      {support.supported && storageState.status === 'ready' && !ready && (
        <p role="status">Waiting for the video to load so its size and length are known.</p>
      )}

      {support.supported && storageState.status === 'ready' && ready && (
        <>
          <div className="overlay-export__settings">
            <div className="overlay-controls__field">
              <label htmlFor={`${id}-fps`}>Frame rate</label>
              <select
                className="select"
                id={`${id}-fps`}
                value={fps}
                disabled={running}
                onChange={(event) => setFps(Number(event.target.value))}
              >
                {EXPORT_FRAME_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {formatFrameRate(rate)} fps
                  </option>
                ))}
              </select>
            </div>
            <div className="overlay-controls__field">
              <label htmlFor={`${id}-size`}>Picture size</label>
              <select
                className="select"
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
                    {preset}p ({exportDimensions(media.width / media.height, preset).width} ×{' '}
                    {preset})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p data-testid="export-plan">
            {plan.frameCount} frames, {plan.width} × {plan.height}, {formatDuration(plan.durationSeconds)}{' '}
            long. About {formatBytes(plan.estimatedBytes)}; roughly{' '}
            {formatDuration(Math.max(1, plan.estimatedSeconds))} to draw.
          </p>

          {!plan.fitsArchive && (
            <p role="alert">
              {storageLimitBytesNow < ZIP_MAX_BYTES
                ? `This browser can store about ${formatBytes(storageLimitBytesNow)} of export, and this is more than that.`
                : 'This is more than one ZIP file can hold.'}{' '}
              {fallbackFps !== undefined ? (
                <button type="button" className="button" onClick={() => setFps(fallbackFps)}>
                  Use {formatFrameRate(fallbackFps)} fps
                </button>
              ) : (
                'Choose a smaller picture size.'
              )}
            </p>
          )}
          {nothingOn && (
            <p role="status">No component is switched on, so there is nothing to export.</p>
          )}
          {noOverlap && <p role="status">The activity covers none of this video, so nothing would be drawn. Change where the video starts, in Sync.</p>}

          <p className="video__actions">
            {running ? (
              <button type="button" className="button" onClick={stop}>
                Stop export
              </button>
            ) : (
              <button
                type="button"
                className={downloadFirst ? 'button' : 'button button--primary'}
                onClick={begin}
                disabled={!plan.fitsArchive || nothingOn || noOverlap}
              >
                {stale ? 'Export again' : 'Export PNG sequence'}
              </button>
            )}
          </p>
        </>
      )}

      {phase.status === 'running' && (
        <>
          <p>
            <progress
              aria-label="Export progress"
              value={phase.done}
              max={phase.total}
              className="overlay-export__progress"
            />{' '}
            Frame {phase.done} of {phase.total}
          </p>
          {/* Said at each quarter, not each frame: a frame count would drown a screen reader. */}
          <p className="visually-hidden" role="status">
            Exporting: {Math.floor((phase.done / Math.max(1, phase.total)) * 4) * 25}% done.
          </p>
        </>
      )}
      {stale && (
          <p role="alert">
            This file was made with earlier settings, and no longer matches the preview. Export
            again to match it.
          </p>
        )}
      {phase.status === 'done' && (
        <p role="status">
          Done: {phase.frameCount} frames, {formatBytes(phase.bytes)}.{' '}
          <a className={downloadFirst ? 'button button--primary' : 'button'} href={phase.url} download={phase.fileName}>
            Download {phase.fileName}
          </a>
        </p>
      )}
      {phase.status === 'done' && (
        <p className="overlay-export__import">
          In your editor, set the sequence to {formatFrameRate(phase.fps)} fps and place the first
          frame at the start of the clip; the frames are numbered from there.
        </p>
      )}
      {phase.status === 'stopped' && <p role="status">Export stopped. Nothing was saved.</p>}
      {phase.status === 'error' && <p role="alert">{phase.message}</p>}
    </section>
  );
}
