import { useMemo, useRef, useState } from 'react';
import { download } from './ExportPanel';
import { toActivityError } from '../domain/errors';
import {
  FRAMES_PER_ARCHIVE,
  MAX_FRAME_SIZE,
  exportFrameSequence,
  planFrameExport,
  type FrameProgress,
} from '../overlays/exportFrames';
import type { OverlayRenderer } from '../overlays/renderOverlay';

export interface VideoInfo {
  /** Seconds; absent when the browser could not read it. */
  duration?: number;
  width: number;
  height: number;
}

export interface OverlayFrameExportProps {
  renderer: OverlayRenderer;
  offsetSeconds: number;
  video: VideoInfo;
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; progress?: FrameProgress }
  | { status: 'done'; files: string[]; frames: number }
  | { status: 'stopped'; files: string[] }
  | { status: 'failed'; message: string; files: string[] };

/** "about 2 min 5 s" — coarse on purpose; an estimate should not look exact. */
function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `about ${seconds} s`;
  return `about ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * AV-1006. Saves the overlay alone as a transparent PNG sequence.
 *
 * The frames come from the same renderer the preview uses, at the video's own
 * size and the offset set above, and are saved as zip files as they fill so a
 * long clip never has to fit in memory at once. Nothing is uploaded: the frames
 * are drawn, packed and saved by this tab, and the video itself is never read
 * for this — only its length and size are used.
 */
export function OverlayFrameExport({ renderer, offsetSeconds, video }: OverlayFrameExportProps) {
  const [fps, setFps] = useState(30);
  const [width, setWidth] = useState<number | undefined>();
  const [height, setHeight] = useState<number | undefined>();
  const [start, setStart] = useState<number | undefined>();
  const [end, setEnd] = useState<number | undefined>();
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
  };

  // Worked out as the settings change, so the button and the message agree.
  const plan = useMemo(() => {
    try {
      return { ok: true as const, ...planFrameExport(options) };
    } catch (error) {
      return { ok: false as const, message: toActivityError(error, 'invalid_selected_range').message };
    }
    // `options` is rebuilt every render from the values below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps, options.width, options.height, options.startSeconds, options.endSeconds, offsetSeconds]);

  const running = run.status === 'running';

  const handleExport = async () => {
    if (!plan.ok) return;
    const abort = new AbortController();
    controller.current = abort;
    const files: string[] = [];
    setRun({ status: 'running' });
    try {
      const result = await exportFrameSequence({
        options,
        renderer,
        baseName: 'overlay',
        signal: abort.signal,
        onProgress: (progress) => setRun({ status: 'running', progress }),
        onArchive: (archive) => {
          download(archive.blob, archive.fileName);
          files.push(archive.fileName);
        },
      });
      setRun({ status: 'done', files, frames: result.frameCount });
    } catch (error) {
      const failure = toActivityError(error, 'overlay_export_failed');
      setRun(
        failure.code === 'overlay_export_cancelled'
          ? { status: 'stopped', files }
          : { status: 'failed', message: `${failure.message} ${failure.hint}`, files },
      );
    } finally {
      controller.current = undefined;
    }
  };

  const number = (value: number | undefined, fallback: number) =>
    value === undefined || Number.isNaN(value) ? (value === undefined ? fallback : '') : value;
  const parse = (text: string) => (text === '' ? NaN : Number(text));

  return (
    <section className="box route-tools" aria-label="Export overlay frames">
      <h3 className="prose__title">Save the overlay alone</h3>
      <p className="export__hint">
        Saves the overlay as a numbered sequence of transparent PNG frames, for a video editor to
        lay over the original. The video file is not changed or read. It is made in this tab and
        nothing is uploaded.
      </p>

      <div className="route-tools__row">
        <label className="export__label">
          Frame rate (fps){' '}
          <input
            className="input"
            type="number"
            min={1}
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
            max={MAX_FRAME_SIZE}
            aria-label="Frame width"
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
            max={MAX_FRAME_SIZE}
            aria-label="Frame height"
            value={number(height, video.height)}
            disabled={running}
            onChange={(event) => setHeight(parse(event.target.value))}
          />
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
            aria-label="Export from"
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
            aria-label="Export to"
            value={number(end, Number(defaultEnd.toFixed(3)))}
            disabled={running}
            onChange={(event) => setEnd(parse(event.target.value))}
          />
        </label>
      </div>

      {plan.ok ? (
        <p className="export__hint" aria-live="polite">
          {plan.frameCount.toLocaleString('en-US')} frames
          {plan.minimumArchives > 1
            ? `, in at least ${plan.minimumArchives} zip files of up to ${FRAMES_PER_ARCHIVE.toLocaleString('en-US')} frames. Your browser may ask to allow several downloads.`
            : ', in one zip file.'}
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
          disabled={!plan.ok || running}
        >
          {running ? 'Saving…' : 'Save PNG frames (zip)'}
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
            value={run.progress.framesDone}
            max={run.progress.frameCount}
            aria-label="Export progress"
          />
          <p className="export__hint">
            Frame {run.progress.framesDone.toLocaleString('en-US')} of{' '}
            {run.progress.frameCount.toLocaleString('en-US')}
            {run.progress.archivesDone > 0 ? ` · ${run.progress.archivesDone} zip saved` : ''}
            {run.progress.remainingMs !== undefined ? ` · ${formatRemaining(run.progress.remainingMs)} left` : ''}
          </p>
        </div>
      )}

      {run.status === 'done' && (
        <div role="status" className="export__result">
          <p className="export__saved">
            Saved {run.frames.toLocaleString('en-US')} frames in{' '}
            <strong>{run.files.join(', ')}</strong>.
          </p>
          {run.files.length > 1 && <p>Unzip every part into the same folder.</p>}
        </div>
      )}
      {run.status === 'stopped' && (
        <p role="status">
          Stopped.{' '}
          {run.files.length > 0
            ? `${run.files.join(', ')} ${run.files.length === 1 ? 'was' : 'were'} saved and ${run.files.length === 1 ? 'is' : 'are'} complete.`
            : 'Nothing was saved.'}
        </p>
      )}
      {run.status === 'failed' && (
        <p role="alert" className="route-tools__notice">
          {run.message}
          {run.files.length > 0 ? ` ${run.files.join(', ')} had already been saved.` : ''}
        </p>
      )}
    </section>
  );
}
