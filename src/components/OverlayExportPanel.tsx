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
  planWebmExport,
} from '../overlay/export/plan';
import { startWebmExport } from '../overlay/export/recordWebm';
import { getExportSupport, type ExportSupport } from '../overlay/export/support';
import { probeWebmSupport, type WebmSupport } from '../overlay/export/webmSupport';
import type { ArchiveStorage } from '../overlay/export/protocol';
import { ZIP_MAX_BYTES } from '../overlay/export/zip';
import { buildOverlay, type OverlayControls } from '../overlay/presets';
import { drawnWithoutTelemetry, type OverlayTemplate } from '../overlay/template';
import { buildOverlayTimeline } from '../overlay/timeline';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';

interface OverlayExportPanelProps {
  /**
   * The video the overlay is for. AV-1011: absent on a custom canvas with no
   * video, where the frames run across the activity's own span.
   */
  video?: OverlayVideo;
  activity: Activity;
  controls: OverlayControls;
  /** AV-1011. A layout made on the custom canvas, drawn as it is instead of one built from the controls. */
  template?: OverlayTemplate;
  /** AV-1011. The canvas's own resolution, which takes the place of the picture-size choice. */
  size?: { width: number; height: number };
  offsetSeconds: number;
  units: UnitSystem;
  media: OverlayMedia | undefined;
  /** Injected by tests; the page uses the real worker and the real browser. */
  start?: typeof startOverlayExport;
  support?: ExportSupport;
  /** Asks the worker where an archive can really be stored; injected by tests. */
  probeStorage?: () => Promise<ArchiveStorage>;
  /** AV-1012. Records a transparent WebM; injected by tests. */
  startWebm?: typeof startWebmExport;
  /** AV-1012. Whether this browser keeps a recording's transparency; injected by tests. */
  probeWebm?: () => Promise<WebmSupport>;
  /** Told whether a finished file is waiting to be downloaded, so Start over can ask first. */
  onFinishedChange?: (finished: boolean) => void;
}

type StorageState =
  | { status: 'checking' }
  | { status: 'ready'; storage: ArchiveStorage }
  | { status: 'failed'; message: string };

/** AV-1012. What the overlay is saved as. */
type ExportFormat = 'png' | 'webm';

type WebmState = { status: 'checking' } | { status: 'ready' } | { status: 'unavailable'; reason: string };

type Phase =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | {
      status: 'done';
      format: ExportFormat;
      url: string;
      fileName: string;
      bytes: number;
      frameCount: number;
      /** The rate it was drawn at, for the note on setting the editor to match. */
      fps: number;
      /** Things the reader should know about the file. */
      notes?: string[];
      /** What it was made from, to tell when the page has since moved on. */
      made: { signature: string; activity: Activity; file: File | undefined };
    }
  | { status: 'stopped' }
  | { status: 'discarded' }
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
  template: customTemplate,
  size,
  offsetSeconds,
  units,
  media,
  start = startOverlayExport,
  support = getExportSupport(),
  probeStorage = probeExportStorage,
  startWebm = startWebmExport,
  probeWebm = probeWebmSupport,
  onFinishedChange,
}: OverlayExportPanelProps) {
  const id = useId();
  const [fps, setFps] = useState(() => nearestFrameRate(video?.timing?.frameIntervalSeconds));
  const [heightChoice, setHeightChoice] = useState<string>(NATIVE);
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [storageState, setStorageState] = useState<StorageState>({ status: 'checking' });
  const [format, setFormat] = useState<ExportFormat>('png');
  const [webmState, setWebmState] = useState<WebmState>({ status: 'checking' });
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
  // AV-1012. Whether a recording keeps its transparency is the browser's own answer, asked once.
  useEffect(() => {
    let current = true;
    probeWebm().then(
      (answer) =>
        current &&
        setWebmState(
          answer.supported
            ? { status: 'ready' }
            : { status: 'unavailable', reason: answer.reason ?? 'This browser cannot record a transparent video.' },
        ),
      () => current && setWebmState({ status: 'unavailable', reason: 'This browser cannot record a transparent video.' }),
    );
    return () => {
      current = false;
    };
  }, [probeWebm]);
  const asWebm = format === 'webm' && webmState.status === 'ready';

  const storageLimitBytesNow =
    storageState.status === 'ready' ? storageLimitBytes(storageState.storage) : ZIP_MAX_BYTES;

  // Without a video the frames run across the activity's own span, from its first timed point.
  const activitySpan = useMemo(
    () => (video ? undefined : buildOverlayTimeline(activity, { video: { durationSeconds: 0 } }).alignment?.activitySpanSeconds),
    [video, activity],
  );
  const durationSeconds = video ? (video.timing?.durationSeconds ?? media?.durationSeconds) : activitySpan;
  const videoStart = video?.timing?.start;
  const effectiveOffset = video ? offsetSeconds : 0;
  const timeline = useMemo(
    () =>
      buildOverlayTimeline(activity, {
        video: { durationSeconds: durationSeconds ?? 0, start: videoStart },
        offsetSeconds: effectiveOffset,
      }),
    [activity, durationSeconds, videoStart, effectiveOffset],
  );

  const ready = (size !== undefined || media !== undefined) && durationSeconds !== undefined && durationSeconds > 0;
  const height = heightChoice === NATIVE ? (media?.height ?? 1080) : Number(heightChoice);
  const { width: exportWidth, height: exportHeight } =
    size ?? exportDimensions(media ? media.width / media.height : 16 / 9, height);
  const plan = planExport({
    videoDurationSeconds: durationSeconds ?? 0,
    fps,
    width: exportWidth,
    height: exportHeight,
    limitBytes: storageLimitBytesNow,
  });
  const webmPlan = planWebmExport({
    videoDurationSeconds: durationSeconds ?? 0,
    fps,
    width: exportWidth,
    height: exportHeight,
  });
  const fits = asWebm ? webmPlan.fits : plan.fitsArchive;
  const built = useMemo(
    () => (customTemplate ? { template: customTemplate } : buildOverlay(controls, timeline, exportWidth / exportHeight)),
    [customTemplate, controls, timeline, exportWidth, exportHeight],
  );
  // Everything that changes the picture. A finished export is compared with it.
  const signature = JSON.stringify([built.template, units, effectiveOffset, plan.fps, plan.width, plan.height, asWebm]);
  const fallbackFps = plan.fitsArchive || asWebm
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
      job.current = undefined;
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
  // Told when the file is finished or let go, and, as the panel goes, that it
  // is gone with it. Through the latest listener, so a listener that is new on
  // every render is not told anything twice.
  const finishedListener = useRef(onFinishedChange);
  useEffect(() => {
    finishedListener.current = onFinishedChange;
  }, [onFinishedChange]);
  useEffect(() => {
    finishedListener.current?.(isFinished);
  }, [isFinished]);
  useEffect(() => () => finishedListener.current?.(false), []);

  if (timeline.unavailable) return null;

  /*
   * TD-059. A video the activity covers none of would export an empty overlay:
   * blocked like "nothing switched on", with the way out named.
   */
  const outsideActivity = timeline.alignment?.overlaps === false;
  // AV-1011. Shapes and texts for the whole activity are drawn on every frame, covered or not.
  const drawnAnyway = built.template.components.some((component) => component.visible && drawnWithoutTelemetry(component));
  const noOverlap = outsideActivity && !drawnAnyway;

  const running = phase.status === 'running';
  const nothingOn = built.template.components.length === 0;

  const begin = () => {
    if (!ready || running) return;
    void output.current?.dispose();
    output.current = undefined;
    setPhase({ status: 'running', done: 0, total: plan.frameCount });
    const madeAs: ExportFormat = asWebm ? 'webm' : 'png';

    let active: ExportJob;
    try {
      active = (madeAs === 'webm' ? startWebm : start)(
        {
          width: plan.width,
          height: plan.height,
          fps: plan.fps,
          frameCount: plan.frameCount,
          videoDurationSeconds: durationSeconds ?? 0,
          videoStart,
          offsetSeconds: effectiveOffset,
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
        if (job.current !== active) { void result.dispose(); return; }
        job.current = undefined;
        output.current = result;
        setPhase({
          status: 'done',
          format: madeAs,
          url: URL.createObjectURL(result.file),
          fileName: `${baseName(video?.file.name ?? activity.source.fileName ?? 'activity')}-overlay-${plan.width}x${plan.height}-${formatFrameRate(plan.fps)}fps.${madeAs === 'webm' ? 'webm' : 'zip'}`,
          fps: plan.fps,
          notes: result.notes,
          bytes: result.bytes,
          frameCount: result.frameCount,
          made: { signature, activity, file: video?.file },
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
    (phase.made.signature !== signature || phase.made.activity !== activity || phase.made.file !== video?.file);
  const downloadFirst = phase.status === 'done' && !stale;

  return (
    <section className="prose overlay-export" aria-label="Export overlay">
      <h3 className="prose__title" tabIndex={-1}>
        Export overlay
      </h3>
      <p>
        Saves the overlay by itself, transparent where nothing is drawn, to place over your video in an
        editor: one PNG per frame in a ZIP, or a WebM video where this browser can record one. Your video
        is not changed, and nothing is uploaded.
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
          <fieldset className="editor__modes" disabled={running}>
            <legend className="summary__label">Format</legend>
            <label className="editor__mode">
              <input
                type="radio"
                name={`${id}-format`}
                value="png"
                checked={!asWebm}
                onChange={() => setFormat('png')}
              />
              PNG sequence (ZIP)
            </label>
            <label className="editor__mode">
              <input
                type="radio"
                name={`${id}-format`}
                value="webm"
                checked={asWebm}
                disabled={webmState.status !== 'ready'}
                onChange={() => setFormat('webm')}
              />
              Transparent video (WebM)
              {webmState.status === 'checking' && <span className="export__note"> — checking this browser…</span>}
              {webmState.status === 'unavailable' && <span className="export__note"> — {webmState.reason}</span>}
            </label>
          </fieldset>
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
            {size ? (
              // AV-1011. The canvas's own resolution: chosen on the canvas, not here.
              <p className="overlay-controls__hint">
                Picture size: {size.width} × {size.height}, the canvas’s.
              </p>
            ) : media ? (
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
            ) : null}
          </div>

          {asWebm ? (
            <p data-testid="export-plan">
              {webmPlan.frameCount} frames, {webmPlan.width} × {webmPlan.height},{' '}
              {formatDuration(webmPlan.durationSeconds)} long. At most about {formatBytes(webmPlan.estimatedBytes)}.
              Recorded in real time, so it takes {formatDuration(Math.max(1, webmPlan.estimatedSeconds))}: keep this
              tab open and in front until it finishes.
            </p>
          ) : (
            <p data-testid="export-plan">
              {plan.frameCount} frames, {plan.width} × {plan.height}, {formatDuration(plan.durationSeconds)}{' '}
              long. About {formatBytes(plan.estimatedBytes)}; roughly{' '}
              {formatDuration(Math.max(1, plan.estimatedSeconds))} to draw.
            </p>
          )}

          {asWebm && !webmPlan.fits && (
            <p role="alert">
              This recording could be more than the {formatBytes(webmPlan.limitBytes)} a tab can hold. Choose a
              smaller picture size, or use the PNG sequence.
            </p>
          )}
          {!asWebm && !plan.fitsArchive && (
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
          {outsideActivity && drawnAnyway && (
            <p role="status">
              The activity covers none of this video, so only the shapes and texts for the whole activity are drawn. Change
              where the video starts, in Sync, for the rest.
            </p>
          )}

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
                disabled={!fits || nothingOn || noOverlap}
              >
                {stale ? 'Export again' : asWebm ? 'Export transparent video' : 'Export PNG sequence'}
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
          </a>{' '}
          <button type="button" className="button" onClick={() => {
            void output.current?.dispose();
            output.current = undefined;
            setPhase({ status: 'discarded' });
          }}>
            Discard export
          </button>
        </p>
      )}
      {phase.status === 'done' && phase.format === 'png' && (
        <p className="overlay-export__import">
          In your editor, set the sequence to {formatFrameRate(phase.fps)} fps and place the first
          frame at the start of the clip; the frames are numbered from there.
        </p>
      )}
      {phase.status === 'done' && phase.format === 'webm' && (
        <p className="overlay-export__import">
          In your editor, put the video on a track above the clip and start it where the clip starts. It is
          VP9 with an alpha channel, at {formatFrameRate(phase.fps)} fps. An editor that does not read VP9
          transparency shows it opaque; the PNG sequence works in every editor.
        </p>
      )}
      {phase.status === 'done' && phase.notes?.map((note) => <p key={note} role="status">{note}</p>)}
      {phase.status === 'discarded' && <p role="status">Temporary export discarded. Copies already downloaded are kept.</p>}
      {phase.status === 'stopped' && <p role="status">Export stopped. Nothing was saved.</p>}
      {phase.status === 'error' && <p role="alert">{phase.message}</p>}
    </section>
  );
}
