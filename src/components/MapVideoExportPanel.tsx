import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatDuration, type UnitSystem } from '../domain/units';
import type { ExportOutput } from '../overlay/export/client';
import { isOverlayExportError } from '../overlay/export/errors';
import { formatBytes } from '../overlay/export/plan';
import { isLikelyMobile } from '../overlay/export/burnSupport';
import type { PhotoImage } from '../mapVideo/figures';
import { buildMapVideoModel, type MapVideoModel } from '../mapVideo/model';
import { OPENFREEMAP_TILE_BUDGET, estimateBasemapTiles } from '../mapVideo/export/tileBudget';
import type { PhotoInput } from '../mapVideo/photos';
import type { MapVideoSettings } from '../mapVideo/project';
import { decodeAudioFile, fitAudio } from '../mapVideo/export/audio';
import { planMapVideoExport, posterFileName, type MapVideoFormat } from '../mapVideo/export/plan';
import type { MapVideoExportProgress } from '../mapVideo/export/renderMapVideo';
import { formatVideoTime } from '../mapVideo/timing';
import { download } from './ExportPanel';

export interface MapVideoExportPanelProps {
  activity: Activity;
  model: MapVideoModel;
  settings: MapVideoSettings;
  units: UnitSystem;
  maptilerKey: string;
  photoImages: ReadonlyMap<string, PhotoImage>;
  /** The photos placed along the route, so a zoom suggested is counted with their waits, as the video has them. */
  photos?: PhotoInput[];
  /** The preview's moment, for the poster. */
  pausedAt: number;
}

/** The highest follow zoom, half a step at a time, at which a video over the tile budget would fit, or undefined for none. */
function zoomThatFits(activity: Activity, settings: MapVideoSettings, photos: PhotoInput[]) {
  for (let zoom = Math.floor(settings.camera.zoom * 2) / 2 - 0.5; zoom >= 10; zoom -= 0.5) {
    const lower = { ...settings, camera: { ...settings.camera, zoom } };
    const built = buildMapVideoModel(activity, lower, photos);
    if (!built.ok) continue;
    const fits = estimateBasemapTiles(built.model, lower);
    if (fits <= OPENFREEMAP_TILE_BUDGET) return { zoom, count: fits };
  }
  return undefined;
}

/**
 * How long the camera's settings must stay still before the tiles are counted:
 * a count walks every frame's view (up to a fifth of a second for three
 * minutes at 60 fps), and over the budget the zoom that fits builds up to nine
 * models more, so neither is done while a slider is dragged.
 */
const COUNT_DELAY_MS = 400;

/**
 * What the tile count depends on: what moves the camera or makes more frames,
 * and the terrain, which changes the zoom MapLibre takes far off. The route's
 * or marker's colour, a figure or a style does not change which OpenFreeMap
 * tiles are seen, so changing one does not count again. A photo's wait is
 * read from the model, as photos are not settings.
 */
function tileCountKey(settings: MapVideoSettings, model: MapVideoModel): string {
  const { output, lengthSeconds, timing, intro, outro, camera, privacyTrim, keyframes, terrain } = settings;
  const holds = model.timeline.holds.map((hold) => [hold.startSeconds, hold.endSeconds]);
  // Terrain is in it: with terrain on, MapLibre takes coarser tiles where it sees further (TD-078).
  return JSON.stringify([output, lengthSeconds, timing, intro, outro, camera, privacyTrim, keyframes, terrain, holds]);
}

interface TileCount {
  key: string;
  activity: Activity;
  count: number;
  /** Over the budget: the zoom that fits, or undefined for none. */
  fits?: ReturnType<typeof zoomThatFits>;
}

/** What this browser can encode at the video's size: each format, or why not. */
interface Support {
  mp4: boolean;
  webm: boolean;
  reason?: string;
}

type Phase =
  | { status: 'idle' }
  | { status: 'running'; progress: MapVideoExportProgress }
  | { status: 'done'; output: ExportOutput; url: string; fileName: string; notes: string[]; settings: MapVideoSettings; model: MapVideoModel }
  | { status: 'stopped' }
  | { status: 'discarded' }
  | { status: 'error'; message: string };

/**
 * AV-1209. The map video made into a file (TD-072): every frame drawn and
 * waited for, encoded in this tab to MP4 (H.264) or WebM (VP9), with the
 * reader's own sound if they add one, and written to the origin-private file
 * system until it is downloaded. A still of any moment can be saved as a PNG.
 */
export function MapVideoExportPanel({ activity, model, settings, units, maptilerKey, photoImages, pausedAt, photos = [] }: MapVideoExportPanelProps) {
  const ids = { format: useId(), audio: useId() };
  // Answered by the encoders themselves, for this size; kept with the size it was asked for.
  const [checked, setChecked] = useState<Support & { key: string }>();
  const [chosen, setChosen] = useState<MapVideoFormat | undefined>();
  const [audioFile, setAudioFile] = useState<File | undefined>();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [poster, setPoster] = useState<{ busy: boolean; message?: string }>({ busy: false });
  const controller = useRef<AbortController | undefined>(undefined);
  const output = useRef<ExportOutput | undefined>(undefined);
  const { width, height } = settings.output;

  // What the browser can encode at this size. A browser without WebCodecs, or a phone, is told so at once.
  const plainReason =
    typeof VideoEncoder === 'undefined'
      ? 'This browser has no video encoder (WebCodecs), so it cannot make the video. Chrome, Edge and Safari on a computer can.'
      : isLikelyMobile()
        ? 'Map videos are made on a computer for now: a phone’s memory and its tab rules have not been measured (TD-064).'
        : undefined;
  const sizeKey = `${width}x${height}@${settings.output.fps}`;
  useEffect(() => {
    if (plainReason) return;
    let current = true;
    void import('mediabunny').then(async ({ canEncodeVideo }) => {
      const bitrate = width * height * settings.output.fps * 0.16;
      const [mp4, webm] = await Promise.all([
        canEncodeVideo('avc', { width, height, bitrate }).catch(() => false),
        canEncodeVideo('vp9', { width, height, bitrate }).catch(() => false),
      ]);
      if (current) {
        setChecked({ key: sizeKey, mp4, webm, ...(mp4 || webm ? {} : { reason: `This browser cannot encode H.264 or VP9 at ${width} × ${height}. Try a smaller size.` }) });
      }
    });
    return () => {
      current = false;
    };
  }, [plainReason, sizeKey, width, height, settings.output.fps]);
  const support: Support | undefined = plainReason
    ? { mp4: false, webm: false, reason: plainReason }
    : checked?.key === sizeKey
      ? checked
      : undefined;

  // The stored file stays until the reader has it; leaving the page frees it.
  useEffect(
    () => () => {
      controller.current?.abort();
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

  // TD-064: OpenFreeMap's terms allow at most 3,000 tiles to be collected at a time, so a video asking for more waits.
  // Counted once the camera's settings are still (TD-077), and the video waits for the count.
  const online = settings.basemap.source === 'online';
  const countKey = useMemo(() => tileCountKey(settings, model), [settings, model]);
  const [counted, setCounted] = useState<TileCount>();
  const tiles = online && counted?.key === countKey && counted.activity === activity ? counted : undefined;
  const counting = online && !tiles;
  useEffect(() => {
    if (!counting) return undefined;
    const timer = setTimeout(() => {
      const count = estimateBasemapTiles(model, settings);
      setCounted({ key: countKey, activity, count, ...(count > OPENFREEMAP_TILE_BUDGET ? { fits: zoomThatFits(activity, settings, photos) } : {}) });
    }, COUNT_DELAY_MS);
    return () => clearTimeout(timer);
    // The count reads the model and settings it was keyed on: a change that does not move the key starts no new count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counting, countKey, activity]);
  const overBudget = tiles !== undefined && tiles.count > OPENFREEMAP_TILE_BUDGET;

  const format: MapVideoFormat | undefined = chosen && support?.[chosen] ? chosen : support?.mp4 ? 'mp4' : support?.webm ? 'webm' : undefined;
  const plan = format ? planMapVideoExport(activity, model, settings, format) : undefined;
  const planProblem = plan && 'problem' in plan ? plan.problem : undefined;
  const keyMissing = settings.basemap.source === 'maptiler' && !maptilerKey.trim();
  const running = phase.status === 'running';
  const stale = phase.status === 'done' && (phase.settings !== settings || phase.model !== model);
  const input = { activity, model, settings, units, maptilerKey, photoImages };

  const begin = async () => {
    if (!plan || 'problem' in plan) return;
    void output.current?.dispose();
    output.current = undefined;
    const active = new AbortController();
    controller.current = active;
    setPhase({ status: 'running', progress: { done: 0, total: plan.frameCount, requests: 0, waiting: undefined } });
    const notes: string[] = [];
    try {
      let audio;
      if (audioFile) {
        const decoded = await decodeAudioFile(audioFile);
        if ('problem' in decoded) notes.push(`${decoded.problem} The video is made without sound.`);
        else {
          audio = fitAudio(decoded.channels, decoded.sampleRate, plan.lengthSeconds);
          if (audio.trimmed) notes.push(`The sound runs longer than the video, so it is cut at ${formatVideoTime(plan.lengthSeconds)} and fades out.`);
        }
      }
      const { runMapVideoExport } = await import('../mapVideo/export/renderMapVideo');
      const result = await runMapVideoExport(input, plan, {
        signal: active.signal,
        ...(audio ? { audio } : {}),
        onProgress: (progress) => {
          if (controller.current === active) setPhase({ status: 'running', progress });
        },
      });
      if (controller.current !== active) {
        void result.dispose();
        return;
      }
      output.current = result;
      setPhase({ status: 'done', output: result, url: URL.createObjectURL(result.file), fileName: plan.fileName, notes: [...notes, ...(result.notes ?? [])], settings, model });
    } catch (error) {
      if (controller.current !== active) return;
      if (isOverlayExportError(error) && error.code === 'cancelled') setPhase({ status: 'stopped' });
      else setPhase({ status: 'error', message: error instanceof Error ? error.message : 'The video could not be made.' });
    } finally {
      if (controller.current === active) controller.current = undefined;
    }
  };

  const savePoster = async () => {
    setPoster({ busy: true });
    try {
      const { renderPoster } = await import('../mapVideo/export/renderMapVideo');
      const blob = await renderPoster(input, pausedAt);
      download(blob, posterFileName(activity, pausedAt));
      setPoster({ busy: false, message: `Saved the still at ${formatVideoTime(pausedAt)}.` });
    } catch (error) {
      setPoster({ busy: false, message: error instanceof Error ? error.message : 'The still could not be made.' });
    }
  };

  const blocked = !support || !format || planProblem !== undefined || keyMissing || running || counting || overBudget;

  return (
    <section className="prose map-video-export" aria-label="Make the video">
      <h3 className="prose__title">Make the video</h3>
      <p>
        Every frame is drawn with all of its map and encoded in this tab; nothing is uploaded. Keep this tab in front
        while it runs: a hidden tab stops the map from drawing, and the video waits until the tab is back.
      </p>
      {!support && <p role="status">Checking what this browser can encode…</p>}
      {support?.reason && <p role="alert">{support.reason}</p>}
      {keyMissing && <p role="status">Type your MapTiler key above, or choose another map, to make the video.</p>}
      {planProblem && <p role="alert">{planProblem}</p>}
      {counting && <p role="status">Counting the map tiles the video would ask OpenFreeMap for…</p>}
      {overBudget && (
        <p role="alert">
          This video would ask OpenFreeMap for about {tiles.count.toLocaleString('en')} map tiles, more than the{' '}
          {OPENFREEMAP_TILE_BUDGET.toLocaleString('en')} its terms allow one download to take.{' '}
          {tiles.fits
            ? `At zoom ${tiles.fits.zoom} (Camera, above) it would be about ${tiles.fits.count.toLocaleString('en')}. Lower the zoom, or choose route only.`
            : 'Even zoomed out it would be more: choose route only, or a shorter stretch with the privacy trim.'}
          {settings.keyframes.length > 0 && ' Keyframes set their own zoom: lower theirs too.'}
        </p>
      )}

      {support && (support.mp4 || support.webm) && (
        <>
          <div className="map-video-settings__field">
            <label htmlFor={ids.format}>Format</label>
            <select id={ids.format} value={format} disabled={running} onChange={(event) => setChosen(event.target.value as MapVideoFormat)}>
              <option value="mp4" disabled={!support.mp4}>
                {support.mp4 ? 'MP4 (H.264), for every player and editor' : 'MP4 (H.264): not in this browser'}
              </option>
              <option value="webm" disabled={!support.webm}>
                {support.webm ? 'WebM (VP9)' : 'WebM (VP9): not in this browser'}
              </option>
            </select>
          </div>
          <div className="map-video-settings__field">
            <label htmlFor={ids.audio}>Sound (optional)</label>
            <input
              id={ids.audio}
              type="file"
              accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac"
              disabled={running}
              onChange={(event) => setAudioFile(event.target.files?.[0])}
              data-testid="map-video-audio-input"
            />
          </div>
          <p className="map-video-settings__hint">
            Your own file, from this device; nothing is fetched. Longer sound is cut at the video’s end and fades out.
          </p>
          {plan && !('problem' in plan) && (
            <p className="map-video-settings__hint">
              {plan.frameCount} frames at {plan.width} × {plan.height}, {plan.fps} a second: about {formatBytes(plan.estimatedBytes)}, as{' '}
              {plan.fileName}.
              {tiles && !overBudget && ` About ${tiles.count.toLocaleString('en')} map tiles from OpenFreeMap, asked four at a time.`}
            </p>
          )}
          <p className="video__actions">
            {running ? (
              <button type="button" className="button" onClick={() => controller.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="button" className="button button--primary" onClick={() => void begin()} disabled={blocked}>
                {stale ? 'Make it again' : 'Make the video'}
              </button>
            )}
          </p>
        </>
      )}
      {/* A still needs no video encoder: it is offered wherever the map can be drawn (TD-064). */}
      <p className="video__actions">
        <button type="button" className="button" onClick={() => void savePoster()} disabled={poster.busy || keyMissing || running}>
          {poster.busy ? 'Saving the still…' : `Save a still of ${formatVideoTime(pausedAt)} (PNG)`}
        </button>
      </p>
      {poster.message && <p role="status">{poster.message}</p>}

      {phase.status === 'running' && (
        <>
          <p>
            <progress aria-label="Video progress" value={phase.progress.done} max={phase.progress.total} className="overlay-export__progress" />{' '}
            {phase.progress.done} of {phase.progress.total} frames
            {phase.progress.secondsLeft !== undefined && `, about ${formatDuration(phase.progress.secondsLeft)} left`}
            {phase.progress.requests > 0 && `; ${phase.progress.requests} map requests so far`}
            {phase.progress.waiting === 'tiles' && '. Waiting for map tiles…'}
          </p>
          {phase.progress.waiting === 'hidden' && <p role="alert">Waiting: the tab is hidden, so the map cannot draw. Bring it back to carry on.</p>}
          <p className="visually-hidden" role="status">
            Making the video: {Math.floor((phase.progress.done / Math.max(1, phase.progress.total)) * 4) * 25}% done.
          </p>
        </>
      )}
      {stale && <p role="alert">This video was made with earlier settings, and no longer matches the preview. Make it again to match it.</p>}
      {phase.status === 'done' && (
        <p role="status">
          Done: {formatBytes(phase.output.bytes)}.{' '}
          <a className={stale ? 'button' : 'button button--primary'} href={phase.url} download={phase.fileName}>
            Download {phase.fileName}
          </a>{' '}
          <button
            type="button"
            className="button"
            onClick={() => {
              void output.current?.dispose();
              output.current = undefined;
              setPhase({ status: 'discarded' });
            }}
          >
            Discard
          </button>
        </p>
      )}
      {phase.status === 'done' &&
        phase.notes.map((note) => (
          <p key={note} role="status">
            {note}
          </p>
        ))}
      {phase.status === 'discarded' && <p role="status">The temporary file was discarded. Copies already downloaded are kept.</p>}
      {phase.status === 'stopped' && <p role="status">Stopped. Nothing was kept.</p>}
      {phase.status === 'error' && <p role="alert">{phase.message}</p>}
    </section>
  );
}
