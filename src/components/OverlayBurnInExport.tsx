import { useEffect, useMemo, useRef, useState } from 'react';
import { download } from './ExportPanel';
import type { VideoInfo } from './OverlayFrameExport';
import { toActivityError } from '../domain/errors';
import {
  MAX_SIZE,
  browserEnvironment,
  exportBurnedIn,
  pickRecorderFormat,
  planBurnIn,
  type BurnInEnvironment,
  type BurnInProgress,
  type BurnInQuality,
} from '../overlays/burnIn';
import type { OverlayRenderer } from '../overlays/renderOverlay';

export interface OverlayBurnInExportProps {
  /** The video being previewed; it is only played, never changed. */
  file: File;
  renderer: OverlayRenderer;
  offsetSeconds: number;
  video: VideoInfo;
  /** Told when an export starts and ends, so the page can keep the preview from competing with it. */
  onBusyChange?: (busy: boolean) => void;
  /** Replaces the browser, for tests. */
  env?: BurnInEnvironment;
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; progress?: BurnInProgress }
  | { status: 'done'; fileName: string; bytes: number; hasAudio: boolean; wantedAudio: boolean; seconds: number }
  | { status: 'stopped' }
  | { status: 'failed'; message: string };

const megabytes = (bytes: number) => (bytes / 1e6 < 10 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6).toString());

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes} min ${total % 60} s` : `${total} s`;
}

/**
 * AV-1007. Saves the video with the overlay burned into the picture.
 *
 * It plays the video through once, at its own speed, and records the result —
 * so it takes as long as the clip, and the tab has to stay in view while it
 * runs (a hidden tab is paused rather than allowed to drop frames). The reasons
 * and the measurements behind that are in TD-038. The original file is only
 * played, never changed, and nothing is uploaded: the recording is made, held
 * and saved by this tab.
 */
export function OverlayBurnInExport({
  file,
  renderer,
  offsetSeconds,
  video,
  onBusyChange,
  env = browserEnvironment,
}: OverlayBurnInExportProps) {
  const [fps, setFps] = useState(30);
  const [width, setWidth] = useState<number | undefined>();
  const [height, setHeight] = useState<number | undefined>();
  const [start, setStart] = useState<number | undefined>();
  const [end, setEnd] = useState<number | undefined>();
  const [quality, setQuality] = useState<BurnInQuality>('standard');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const controller = useRef<AbortController | undefined>(undefined);

  const defaultEnd = video.duration !== undefined && Number.isFinite(video.duration) ? video.duration : 0;
  const options = {
    fps,
    width: width ?? video.width,
    height: height ?? video.height,
    startSeconds: start ?? 0,
    endSeconds: end ?? defaultEnd,
    offsetSeconds,
    quality,
    includeAudio,
  };

  // Whether this browser can do it at all, said before the user sets anything up.
  const support = useMemo(() => {
    if (!env.isRecordingSupported()) {
      return { ok: false as const, message: 'This browser cannot record video from a page, so the overlay cannot be saved into the video. Try a recent Chrome, Edge, Firefox or Safari.' };
    }
    if (!pickRecorderFormat((mime) => env.isTypeSupported(mime), false)) {
      return { ok: false as const, message: 'This browser cannot record video in a format it can save. Try a recent Chrome, Edge, Firefox or Safari.' };
    }
    return { ok: true as const };
  }, [env]);

  const plan = useMemo(() => {
    try {
      return { ok: true as const, ...planBurnIn(options, video.duration) };
    } catch (error) {
      return { ok: false as const, message: toActivityError(error, 'invalid_selected_range').message };
    }
    // `options` is rebuilt every render from the values below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps, options.width, options.height, options.startSeconds, options.endSeconds, offsetSeconds, quality, includeAudio, video.duration]);

  const running = run.status === 'running';

  // Leaving the page mid-export stops it, rather than leaving a recording running unseen.
  useEffect(() => () => controller.current?.abort(), []);

  const handleExport = async () => {
    if (!plan.ok || !support.ok) return;
    const abort = new AbortController();
    controller.current = abort;
    setRun({ status: 'running' });
    onBusyChange?.(true);
    try {
      const result = await exportBurnedIn({
        file,
        options,
        renderer,
        signal: abort.signal,
        env,
        onProgress: (progress) => setRun({ status: 'running', progress }),
      });
      const fileName = `video-with-overlay.${result.extension}`;
      download(result.blob, fileName);
      setRun({
        status: 'done',
        fileName,
        bytes: result.bytes,
        hasAudio: result.hasAudio,
        wantedAudio: includeAudio,
        seconds: result.durationSeconds,
      });
    } catch (error) {
      const failure = toActivityError(error, 'overlay_export_failed');
      setRun(
        failure.code === 'overlay_export_cancelled'
          ? { status: 'stopped' }
          : { status: 'failed', message: `${failure.message} ${failure.hint}` },
      );
    } finally {
      controller.current = undefined;
      onBusyChange?.(false);
    }
  };

  const number = (value: number | undefined, fallback: number) =>
    value === undefined ? fallback : Number.isNaN(value) ? '' : value;
  const parse = (text: string) => (text === '' ? NaN : Number(text));

  return (
    <section className="box route-tools" aria-label="Save video with overlay">
      <h3 className="prose__title">Save the video with the overlay</h3>
      <p className="export__hint">
        Records the video with the overlay drawn into the picture, as one file you can share
        anywhere. It plays the video through once, so <strong>it takes as long as the clip</strong>{' '}
        and this tab has to stay in view while it runs. Your original video is not changed, and
        nothing is uploaded.
      </p>

      {!support.ok && (
        <p role="alert" className="route-tools__notice">
          {support.message}
        </p>
      )}

      <div className="route-tools__row">
        <label className="export__label">
          Frame rate (fps){' '}
          <input
            className="input"
            type="number"
            min={1}
            aria-label="Video frame rate"
            value={Number.isNaN(fps) ? '' : fps}
            disabled={running}
            onChange={(event) => setFps(parse(event.target.value))}
          />
        </label>
        <label className="export__label">
          Width{' '}
          <input
            className="input"
            type="number"
            max={MAX_SIZE}
            aria-label="Video width"
            value={number(width, video.width)}
            disabled={running}
            onChange={(event) => setWidth(parse(event.target.value))}
          />
        </label>
        <label className="export__label">
          Height{' '}
          <input
            className="input"
            type="number"
            max={MAX_SIZE}
            aria-label="Video height"
            value={number(height, video.height)}
            disabled={running}
            onChange={(event) => setHeight(parse(event.target.value))}
          />
        </label>
        <label className="export__label">
          Quality{' '}
          <select
            className="select"
            aria-label="Video quality"
            value={quality}
            disabled={running}
            onChange={(event) => setQuality(event.target.value as BurnInQuality)}
          >
            <option value="standard">Standard</option>
            <option value="high">High (larger file)</option>
          </select>
        </label>
      </div>
      <div className="route-tools__row">
        <label className="export__label">
          From (seconds){' '}
          <input
            className="input"
            type="number"
            min={0}
            step={0.1}
            aria-label="Video from"
            value={number(start, 0)}
            disabled={running}
            onChange={(event) => setStart(parse(event.target.value))}
          />
        </label>
        <label className="export__label">
          To (seconds){' '}
          <input
            className="input"
            type="number"
            min={0}
            step={0.1}
            aria-label="Video to"
            value={number(end, Number(defaultEnd.toFixed(3)))}
            disabled={running}
            onChange={(event) => setEnd(parse(event.target.value))}
          />
        </label>
        <label className="export__label">
          <input
            type="checkbox"
            checked={includeAudio}
            disabled={running}
            onChange={(event) => setIncludeAudio(event.target.checked)}
          />{' '}
          Include the video&apos;s sound
        </label>
      </div>

      {plan.ok ? (
        <p className="export__hint" aria-live="polite">
          Takes about {clock(plan.durationSeconds)}, and makes a file of about{' '}
          {megabytes(plan.estimatedBytes)} MB.
        </p>
      ) : (
        <p role="alert" className="route-tools__notice">
          {plan.message}
        </p>
      )}

      <div className="route-tools__row">
        <button
          type="button"
          className="button button--primary"
          onClick={() => void handleExport()}
          disabled={!plan.ok || !support.ok || running}
        >
          {running ? 'Recording…' : 'Save video with overlay'}
        </button>
        {running && (
          <button type="button" className="button" onClick={() => controller.current?.abort()}>
            Stop
          </button>
        )}
      </div>

      {run.status === 'running' && run.progress && (
        <div role="status" aria-live="off">
          <progress
            value={run.progress.recordedSeconds}
            max={run.progress.durationSeconds}
            aria-label="Recording progress"
          />
          <p className="export__hint">
            {run.progress.paused
              ? 'Paused — bring this tab back to the front to continue.'
              : `Recorded ${clock(run.progress.recordedSeconds)} of ${clock(run.progress.durationSeconds)} · about ${clock(run.progress.remainingMs / 1000)} left · ${megabytes(run.progress.bytes)} MB so far. Keep this tab in view.`}
          </p>
        </div>
      )}

      {run.status === 'done' && (
        <div role="status" className="export__result">
          <p className="export__saved">
            Saved <strong>{run.fileName}</strong> ({clock(run.seconds)}, {megabytes(run.bytes)} MB).
          </p>
          {run.wantedAudio && !run.hasAudio && (
            <p>It has no sound: this video has none, or the browser could not capture it.</p>
          )}
        </div>
      )}
      {run.status === 'stopped' && <p role="status">Stopped. Nothing was saved.</p>}
      {run.status === 'failed' && (
        <p role="alert" className="route-tools__notice">
          {run.message}
        </p>
      )}
    </section>
  );
}
