import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { OverlayControls } from '../components/OverlayControls';
import { buildOverlayTimeline } from '../overlay/timeline';
import { FileDropZone } from '../components/FileDropZone';
import { ErrorPanel, WarningList } from '../components/ErrorPanel';
import { BurnedInExportPanel } from '../components/BurnedInExportPanel';
import { OverlayExportPanel } from '../components/OverlayExportPanel';
import { OverlayPreview } from '../components/OverlayPreview';
import { RouteOverlayPanel } from '../components/RouteOverlayPanel';
import { CustomCanvas } from '../components/CustomCanvas';
import { VideoReadProgress } from '../components/VideoReadProgress';
import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { formatDistance, formatDuration, formatFileSize, type UnitSystem } from '../domain/units';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useInteractionStore } from '../state/interactionStore';
import {
  hasOverlaySource,
  useOverlayStore,
  type OverlayMedia,
  type OverlaySnapshot,
  type OverlayVideo,
} from '../state/overlayStore';
import type { VideoReadProgressState } from '../components/VideoReadProgress';
import { VIDEO_EXTENSIONS } from './readVideoTelemetry';
import { useVideoTelemetryRead } from './useVideoTelemetryRead';

/** What became of the last file chosen for a slot. Each slot has its own. */
type SlotState =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'error'; error: ActivityError; fileName: string };

const IDLE: SlotState = { status: 'idle' };

/**
 * Focuses a slot once React has drawn it: the error it is showing if any, so
 * focus lands on what went wrong, else its drop zone, else its heading.
 */
function focusSlot(ref: RefObject<HTMLElement | null>) {
  setTimeout(() => {
    const slot = ref.current;
    const target =
      slot?.querySelector<HTMLElement>('.panel--error button') ??
      slot?.querySelector<HTMLElement>('.dropzone__target') ??
      slot?.querySelector<HTMLElement>('h3');
    target?.focus();
  }, 0);
}

/**
 * AV-1002. Where overlays are made: a page of its own, reached from Tools,
 * that holds a local video, a normalized activity, or both.
 *
 * It renders nothing of the viewer — no map, no charts, no export controls —
 * because there is nothing to view here, only something to draw over.
 *
 * TD-059. With a video it is a workspace: the preview kept in view, and the
 * files, the overlay controls and the exports beside it. Reading or failing to
 * read a file is said in that file's slot, and nothing else is taken down for
 * it: a file being replaced stays until its replacement has been read.
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
  const restore = useOverlayStore((state) => state.restore);
  const offsetSeconds = useOverlayStore((state) => state.offsetSeconds);
  const setOffsetSeconds = useOverlayStore((state) => state.setOffsetSeconds);
  const controls = useOverlayStore((state) => state.controls);
  const setControls = useOverlayStore((state) => state.setControls);
  const media = useOverlayStore((state) => state.media);
  const setMedia = useOverlayStore((state) => state.setMedia);
  const unitSystem = useInteractionStore((state) => state.unitSystem);

  const [videoState, setVideoState] = useState<SlotState>(IDLE);
  const [activityState, setActivityState] = useState<SlotState>(IDLE);
  /** What Start over let go of, until the reader undoes it or chooses a file. */
  const [cleared, setCleared] = useState<OverlaySnapshot | undefined>();
  /** Where the preview draws its sync panel: the side column, below the files. */
  const [syncTarget, setSyncTarget] = useState<HTMLDivElement | null>(null);
  /** Whether either export holds a finished file Start over would throw away. */
  const [finished, setFinished] = useState({ png: false, video: false });
  const [confirmingStartOver, setConfirmingStartOver] = useState(false);
  /** With the still image showing, whether the reader asked for the video slot back. */
  const [addingVideo, setAddingVideo] = useState(false);
  /** AV-1011. Making a custom canvas rather than a built-in template (or the still image, without a video). */
  const canvasMode = useOverlayStore((state) => state.canvasMode);
  const setCanvasMode = useOverlayStore((state) => state.setCanvasMode);
  const canvasDraft = useOverlayStore((state) => state.canvasDraft);
  const setCanvasDraft = useOverlayStore((state) => state.setCanvasDraft);
  /** Records whether each export holds a finished file: the template's and the canvas's alike. */
  const exportFinished = useCallback(
    (kind: 'png' | 'video', done: boolean) =>
      setFinished((current) => (current[kind] === done ? current : { ...current, [kind]: done })),
    [],
  );
  const pngFinished = useCallback((done: boolean) => exportFinished('png', done), [exportFinished]);
  const videoFinished = useCallback((done: boolean) => exportFinished('video', done), [exportFinished]);
  const { reading, read, cancel } = useVideoTelemetryRead();
  const videoSlot = useRef<HTMLElement>(null);
  const activitySlot = useRef<HTMLElement>(null);
  const keepIt = useRef<HTMLButtonElement>(null);
  const exports = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  // TD-059. Where the stage sticks over the page (below 1100px), the page
  // scrolls a focused control clear of it: its height is the scroll padding.
  useEffect(() => {
    const element = stage.current;
    const scroller = element?.closest<HTMLElement>('.shell__scroll');
    if (!element || !scroller || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      scroller.style.setProperty('--overlay-stage-height', `${element.offsetHeight}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty('--overlay-stage-height');
    };
  }, [source.video]);

  // The confirm takes the place of the button that opened it: focus goes to
  // its safe answer rather than falling to the page.
  useEffect(() => {
    if (confirmingStartOver) keepIt.current?.focus();
  }, [confirmingStartOver]);

  /*
   * A read that finishes after the reader has let its slot go — Start over,
   * Remove, or a newer file — must write nothing: each read takes a
   * generation, and letting go moves it on, as the viewer's store does.
   */
  const videoRead = useRef(0);
  const activityRead = useRef(0);
  const letGoOfVideoRead = () => {
    videoRead.current += 1;
    cancel();
  };
  const letGoOfActivityRead = () => {
    activityRead.current += 1;
  };

  const handleVideo = async (file: File) => {
    const generation = ++videoRead.current;
    setCleared(undefined);
    setVideoState(IDLE);
    try {
      const { activity, timing, activityError } = await read(file);
      if (generation !== videoRead.current) return;
      // Whatever the reader returned is a video to draw over — it decides
      // which outcomes still are — and what the video could not supply is
      // noted beside it. The store decides whether its telemetry becomes the
      // activity: not over one the reader chose by hand (TD-040).
      setVideo({ file, timing, telemetryNote: activityError?.message });
      // The still image gives way to the video workspace; a later still image starts without the slot.
      setAddingVideo(false);
      if (activity) offerVideoActivity(activity);
    } catch (error) {
      if (generation !== videoRead.current) return;
      const failure = toActivityError(error, 'gopro_extract_failed');
      if (failure.code === 'extraction_cancelled') return;
      // What the reader throws is a file nothing could be drawn over; the
      // video already held, if any, is still the one in use.
      setVideoState({ status: 'error', error: failure, fileName: file.name });
      focusSlot(videoSlot);
    }
  };

  const handleActivity = async (file: File) => {
    const generation = ++activityRead.current;
    setCleared(undefined);
    setActivityState({ status: 'reading', fileName: file.name });
    try {
      // The same intake the viewer uses: GPX, FIT, TCX and KML, read here.
      // Set only once read, so the activity being replaced stays until then.
      const { activity } = await parseActivityFile(file);
      if (generation !== activityRead.current) return;
      setActivity(activity, 'hand');
      setActivityState(IDLE);
    } catch (error) {
      if (generation !== activityRead.current) return;
      setActivityState({
        status: 'error',
        error: toActivityError(error, 'unsupported_format'),
        fileName: file.name,
      });
      focusSlot(activitySlot);
    }
  };

  const focusStartOver = () =>
    setTimeout(() => document.querySelector<HTMLElement>('[data-start-over]')?.focus(), 0);

  const startOver = () => {
    letGoOfVideoRead();
    letGoOfActivityRead();
    setConfirmingStartOver(false);
    setFinished({ png: false, video: false });
    setCleared(clear());
    setVideoState(IDLE);
    setActivityState(IDLE);
    setAddingVideo(false);
    focusSlot(videoSlot);
  };

  // The controls sit in the side column, so the page builds the timeline they
  // ask about: the same one the preview builds, from the same inputs.
  const durationSeconds = source.video?.timing?.durationSeconds ?? media?.durationSeconds ?? 0;
  const timeline = useMemo(
    () =>
      buildOverlayTimeline(source.activity, {
        video: { durationSeconds, start: source.video?.timing?.start },
        offsetSeconds,
      }),
    [source.activity, durationSeconds, source.video?.timing?.start, offsetSeconds],
  );

  const videoSlotElement = (
    <VideoSlot
        slotRef={videoSlot}
        video={source.video}
        activity={source.activity}
        media={media}
        compact={Boolean(source.video)}
        state={videoState}
        reading={reading}
        onCancelReading={cancel}
        onFile={(file) => void handleVideo(file)}
        onDismiss={() => {
          setVideoState(IDLE);
          focusSlot(videoSlot);
        }}
        onRemove={() => {
          letGoOfVideoRead();
          setVideo(undefined);
          focusSlot(videoSlot);
        }}
      />
  );

  const files = (
    <>
      {videoSlotElement}
      <ActivitySlot
        slotRef={activitySlot}
        activity={source.activity}
        focusedSection={source.focusedSection}
        units={unitSystem}
        compact={Boolean(source.video)}
        state={activityState}
        onFile={(file) => void handleActivity(file)}
        onDismiss={() => {
          setActivityState(IDLE);
          focusSlot(activitySlot);
        }}
        onRemove={() => {
          letGoOfActivityRead();
          setActivityState(IDLE);
          clearActivity();
          focusSlot(activitySlot);
        }}
      />
    </>
  );

  /** Start over, and its confirm; `beside` is another action on the same row. */
  const startOverControls = (beside?: ReactNode) => (
    <>
      {hasOverlaySource(source) && !confirmingStartOver && (
        <p className="overlay-files__actions">
          {beside}
          {/* Lets go of the files only: the overlay settings are the reader's (TD-043). */}
          <button
            type="button"
            className="button"
            data-start-over
            onClick={() =>
              source.activity && (finished.png || finished.video)
                ? setConfirmingStartOver(true)
                : startOver()
            }
          >
            Start over
          </button>
        </p>
      )}
      {confirmingStartOver && (
        // Undo puts the files back, but a finished export is made again, not kept.
        <div className="panel overlay-undo" role="alert">
          <p className="panel__message">
            A finished export is still here to download. Starting over lets it go, and Undo will not
            bring it back.
          </p>
          <span className="overlay-files__actions">
            <button type="button" className="button" onClick={startOver}>
              Start over anyway
            </button>
            <button
              type="button"
              className="button"
              ref={keepIt}
              onClick={() => {
                setConfirmingStartOver(false);
                focusStartOver();
              }}
            >
              Keep it
            </button>
          </span>
        </div>
      )}
    </>
  );

  const undo = cleared && (
    <div className="panel overlay-undo" role="status">
      <p className="panel__message">
        Started over: both files were let go. Your overlay settings are kept.
      </p>
      <button
        type="button"
        className="button"
        onClick={() => {
          restore(cleared);
          setCleared(undefined);
          focusSlot(videoSlot);
        }}
      >
        Undo
      </button>
    </div>
  );

  const canvas = canvasMode && source.activity !== undefined;
  /*
   * The still image is made from the activity alone: once it is chosen, the
   * file slots give way to it, and Start over, below it, is the way to another
   * activity or to a video.
   */
  const stillImage = !source.video && source.activity !== undefined && !canvas;

  return (
    <main className={source.video || canvas ? 'page page--overlays is-workspace' : 'page page--overlays'}>
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Overlays</h2>
          <p className="page__intro">
            Draw what a video's telemetry says over the picture (speed, distance, the route, the
            climbs) for your own video editor. Everything is drawn on this device; the video, its
            telemetry and anything made from them are never uploaded.
          </p>
        </header>

        {!hasOverlaySource(source) && (
          <section className="prose" aria-label="Nothing to overlay yet">
            <h3 className="prose__title">Nothing to overlay yet</h3>
            <p>
              Choose a GoPro video, an activity file, or both. A handoff from Video telemetry lives
              in memory only and does not survive a reload: choose the files again below.
            </p>
          </section>
        )}

        {/*
          TD-059. One layout for every state, so the file slots never move in
          the page: a file being dropped while a video finishes reading is not
          lost to a slot drawn anew. With a video it is a workspace, the picture
          kept in view beside the files, the controls and the exports.
        */}
        <div className={source.video && !canvas ? 'overlay-workspace' : 'overlay-column'}>
          <div className="overlay-workspace__stage" ref={stage}>
            {source.video && !canvas ? (
              <OverlayPreview
                video={source.video}
                activity={source.activity}
                offsetSeconds={offsetSeconds}
                onOffsetChange={setOffsetSeconds}
                units={unitSystem}
                controls={controls}
                onControlsChange={setControls}
                onMediaInfo={setMedia}
                controlsElsewhere
                syncTarget={syncTarget}
              />
            ) : null}
          </div>
          <div className="overlay-workspace__side">
            {/* The way past the files, sync and overlay settings, for a keyboard. */}
            {source.video && source.activity && !canvas && (
              <p className="overlay-skip">
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    const target = exports.current?.querySelector<HTMLElement>('h3');
                    target?.focus();
                    target?.scrollIntoView({ block: 'start' });
                  }}
                >
                  Skip to export
                </button>
              </p>
            )}
            {/* Beside the drop zone Start over puts focus in, so it is seen. */}
            {undo}
            {/*
              TD-059. With a video, sync is the first thing to do, so it comes
              first, and the files it is done with shrink to a line each below.
              The slots keep their place in the tree either way, so a file being
              dropped is never lost to a slot drawn anew.
            */}
            <div className="overlay-sync-slot" ref={setSyncTarget} />
            {/* AV-1011. With an activity, the reader chooses what to make. */}
            {source.activity && (
              <fieldset className="overlay-mode" aria-label="What to make">
                <legend className="summary__label">What to make</legend>
                <label className="overlay-controls__choice">
                  <input type="radio" name="overlay-mode" checked={!canvas} onChange={() => setCanvasMode(false)} />
                  <span>{source.video ? 'An overlay from a template' : 'A still image'}</span>
                </label>
                <label className="overlay-controls__choice">
                  <input type="radio" name="overlay-mode" checked={canvas} onChange={() => setCanvasMode(true)} />
                  <span>{source.video ? 'A custom canvas over the video' : 'A custom video overlay, with no video'}</span>
                </label>
              </fieldset>
            )}
            {!stillImage && files}
            {!stillImage && startOverControls()}
            {canvas && source.activity && (
              <CustomCanvas
                activity={source.activity}
                video={source.video}
                media={media}
                offsetSeconds={offsetSeconds}
                units={unitSystem}
                onOpenSync={source.video ? () => setCanvasMode(false) : undefined}
                onMediaInfo={setMedia}
                onFinishedChange={exportFinished}
                initialDraft={canvasDraft}
                onDraftChange={setCanvasDraft}
              />
            )}
            {/* Below the files, so the slots never move when a route image appears. */}
            {!source.video && source.activity && !canvas && (
              <RouteOverlayPanel
                activity={source.activity}
                focusedSection={source.focusedSection}
              />
            )}
            {stillImage && (
              <div className="overlay-still__start-over">
                <p className="overlay-controls__hint">
                  Made from {source.activity?.source.fileName ?? source.activity?.metadata.name ?? 'this activity'}
                  {source.focusedSection && ', the focused section only'}. Add a video to draw over it, keeping this
                  activity; start over to use another.
                </p>
                {/* Only the video slot comes back: the activity stays as it is. */}
                {(addingVideo || reading || videoState.status !== 'idle') && videoSlotElement}
                {startOverControls(
                  addingVideo ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        // Lets go of a video being read or refused, too: the slot goes with it.
                        letGoOfVideoRead();
                        setVideoState(IDLE);
                        setAddingVideo(false);
                      }}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setAddingVideo(true);
                        focusSlot(videoSlot);
                      }}
                    >
                      Add a video
                    </button>
                  ),
                )}
              </div>
            )}
            {source.video && source.activity && !timeline.unavailable && !canvas && (
              <OverlayControls
                controls={controls}
                timeline={timeline}
                onChange={setControls}
                frameAspect={media && media.height > 0 ? media.width / media.height : undefined}
              />
            )}
            {source.video && source.activity && !canvas && (
              <div className="overlay-exports" ref={exports}>
                <OverlayExportPanel
                  video={source.video}
                  activity={source.activity}
                  controls={controls}
                  offsetSeconds={offsetSeconds}
                  units={unitSystem}
                  media={media}
                  onFinishedChange={pngFinished}
                />
                <BurnedInExportPanel
                  video={source.video}
                  activity={source.activity}
                  controls={controls}
                  offsetSeconds={offsetSeconds}
                  units={unitSystem}
                  media={media}
                  onFinishedChange={videoFinished}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/** A file input the slot's "Choose another" button opens, keeping the current file until then. */
function ReplaceInput({
  accept,
  onFile,
  testId,
  inputRef,
}: {
  accept: readonly string[];
  onFile: (file: File) => void;
  testId: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      hidden
      accept={accept.map((extension) => `.${extension}`).join(',')}
      data-testid={testId}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) onFile(file);
      }}
    />
  );
}

function VideoSlot({
  slotRef,
  video,
  activity,
  media,
  compact,
  state,
  reading,
  onCancelReading,
  onFile,
  onDismiss,
  onRemove,
}: {
  slotRef: RefObject<HTMLElement | null>;
  video: OverlayVideo | undefined;
  activity: Activity | undefined;
  media: OverlayMedia | undefined;
  /** In the workspace: one line, the details folded away. */
  compact: boolean;
  state: SlotState;
  reading: VideoReadProgressState | undefined;
  onCancelReading: () => void;
  onFile: (file: File) => void;
  onDismiss: () => void;
  onRemove: () => void;
}) {
  const replace = useRef<HTMLInputElement>(null);
  // The container's clock where it has one, else the length the browser read.
  const duration = video?.timing?.durationSeconds ?? media?.durationSeconds;
  return (
    <section className="prose overlay-slot" aria-label="Video" ref={slotRef}>
      <h3 className="prose__title" tabIndex={-1}>
        Video
      </h3>
      {reading && <VideoReadProgress progress={reading} onCancel={onCancelReading} />}
      {state.status === 'error' && (
        <ErrorPanel error={state.error} fileName={state.fileName} onDismiss={onDismiss} />
      )}
      {video ? (
        <>
          {compact ? (
            <p className="overlay-slot__line">
              <span className="overlay-slot__name">{video.file.name}</span>
              <span>{formatFileSize(video.file.size)}</span>
              {duration !== undefined && <span>{formatDuration(duration)}</span>}
            </p>
          ) : (
            <dl className="summary__grid">
              <div className="summary__stat">
                <dt className="summary__label">File</dt>
                <dd className="summary__value">{video.file.name}</dd>
              </div>
              <div className="summary__stat">
                <dt className="summary__label">Size</dt>
                <dd className="summary__value">{formatFileSize(video.file.size)}</dd>
              </div>
              {duration !== undefined && (
                <div className="summary__stat">
                  <dt className="summary__label">Duration</dt>
                  <dd className="summary__value">{formatDuration(duration)}</dd>
                </div>
              )}
            </dl>
          )}
          {/* With an activity chosen, a video without telemetry is not a problem: said as a note. */}
          {video.telemetryNote && (
            <p className={activity ? 'overlay-slot__note' : undefined}>
              {video.telemetryNote}
              {activity && ' The activity file below is drawn over it instead.'}
            </p>
          )}
          <p className="overlay-slot__actions">
            <button
              type="button"
              className="button"
              onClick={() => replace.current?.click()}
              disabled={Boolean(reading)}
            >
              Choose another video
            </button>
            <button type="button" className="button" onClick={onRemove} disabled={Boolean(reading)}>
              Remove
            </button>
          </p>
          <ReplaceInput
            accept={VIDEO_EXTENSIONS}
            onFile={onFile}
            testId="overlay-video-input"
            inputRef={replace}
          />
        </>
      ) : (
        !reading && (
          <FileDropZone
            acceptedExtensions={VIDEO_EXTENSIONS}
            onFile={onFile}
            testId="overlay-video-input"
          />
        )
      )}
    </section>
  );
}

function ActivitySlot({
  slotRef,
  activity,
  focusedSection,
  units,
  compact,
  state,
  onFile,
  onDismiss,
  onRemove,
}: {
  slotRef: RefObject<HTMLElement | null>;
  activity: Activity | undefined;
  focusedSection?: boolean;
  units: UnitSystem;
  /** In the workspace: one line, the details folded away. */
  compact: boolean;
  state: SlotState;
  onFile: (file: File) => void;
  onDismiss: () => void;
  onRemove: () => void;
}) {
  const replace = useRef<HTMLInputElement>(null);
  const charted = activity?.sensorStreams?.filter((stream) => stream.display === 'chart') ?? [];
  const busy = state.status === 'reading';

  return (
    <section className="prose overlay-slot" aria-label="Activity" ref={slotRef}>
      <h3 className="prose__title" tabIndex={-1}>
        Activity
      </h3>
      {busy && <p role="status">Reading {state.fileName} in this tab…</p>}
      {state.status === 'error' && (
        <ErrorPanel error={state.error} fileName={state.fileName} onDismiss={onDismiss} />
      )}
      {activity && compact && (
        <p className="overlay-slot__line">
          <span className="overlay-slot__name">
            {activity.source.fileName ?? activity.source.format.toUpperCase()}
          </span>
          <span>{formatDistance(activity.derived?.distanceMeters, units)}</span>
          <span>{formatDuration(activity.derived?.durationSeconds)}</span>
          {focusedSection && <span>Focused section only</span>}
        </p>
      )}
      {activity ? (
        <>
          {/* Folded away in the workspace: what was read, for whoever wants it. */}
          <SlotDetails folded={compact}>
            <dl className="summary__grid">
              {/* In the workspace the name, distance and duration are on the line above. */}
              {!compact && (
                <div className="summary__stat">
                  <dt className="summary__label">From</dt>
                  <dd className="summary__value">
                    {activity.source.fileName ?? activity.source.format.toUpperCase()}
                  </dd>
                </div>
              )}
              {focusedSection && !compact && (
                <div className="summary__stat">
                  <dt className="summary__label">Scope</dt>
                  <dd className="summary__value">Focused section only</dd>
                </div>
              )}
              <div className="summary__stat">
                <dt className="summary__label">Points</dt>
                <dd className="summary__value">{activity.points.length}</dd>
              </div>
              {!compact && (
                <>
                  <div className="summary__stat">
                    <dt className="summary__label">Distance</dt>
                    <dd className="summary__value">
                      {formatDistance(activity.derived?.distanceMeters, units)}
                    </dd>
                  </div>
                  <div className="summary__stat">
                    <dt className="summary__label">Duration</dt>
                    <dd className="summary__value">
                      {formatDuration(activity.derived?.durationSeconds)}
                    </dd>
                  </div>
                </>
              )}
              {charted.length > 0 && (
                <div className="summary__stat">
                  <dt className="summary__label">Camera streams</dt>
                  <dd className="summary__value">
                    {charted.map((stream) => stream.label).join(', ')}
                  </dd>
                </div>
              )}
            </dl>
          </SlotDetails>
          <WarningList warnings={activity.warnings} />
          <p className="overlay-slot__actions">
            <button
              type="button"
              className="button"
              onClick={() => replace.current?.click()}
              disabled={busy}
            >
              Choose another activity
            </button>
            <button type="button" className="button" onClick={onRemove} disabled={busy}>
              Remove
            </button>
          </p>
          <ReplaceInput
            accept={SUPPORTED_FORMATS}
            onFile={onFile}
            testId="overlay-activity-input"
            inputRef={replace}
          />
        </>
      ) : (
        !busy && (
          <FileDropZone
            acceptedExtensions={SUPPORTED_FORMATS}
            onFile={onFile}
            testId="overlay-activity-input"
          />
        )
      )}
    </section>
  );
}

/** What a slot read, shown as it is, or folded under "Details" in the workspace. */
function SlotDetails({ folded, children }: { folded: boolean; children: ReactNode }) {
  if (!folded) return <>{children}</>;
  return (
    <details className="overlay-slot__details">
      <summary>Details</summary>
      {children}
    </details>
  );
}
