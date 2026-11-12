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
import { MapImagePanel } from '../components/MapImagePanel';
import { VideoReadProgress } from '../components/VideoReadProgress';
import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { formatDistance, formatDuration, formatFileSize, type UnitSystem } from '../domain/units';
import { parseActivityFile } from '../parsers';
import { SUPPORTED_FORMATS } from '../parsers/detectFormat';
import { useInteractionStore } from '../state/interactionStore';
import { useMapImageStore } from '../state/mapImageStore';
import {
  hasOverlaySource,
  useOverlayStore,
  type OverlayMedia,
  type OverlaySnapshot,
  type OverlayVideo,
} from '../state/overlayStore';
import type { VideoReadProgressState } from '../components/VideoReadProgress';
import { classifyOverlayFile, sortOverlayFiles } from './overlayFiles';
import { VIDEO_EXTENSIONS } from './readVideoTelemetry';
import { useVideoTelemetryRead } from './useVideoTelemetryRead';

/** What became of the last file of a kind chosen. Each kind has its own. */
type SlotState =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'error'; error: ActivityError; fileName: string };

const IDLE: SlotState = { status: 'idle' };

/**
 * Focuses the files once React has drawn them: the error they are showing if
 * any, so focus lands on what went wrong, else the drop zone, else the heading.
 */
function focusSlot(ref: RefObject<HTMLElement | null>) {
  setTimeout(() => {
    const slot = ref.current;
    // With the files gone (the still image, once nothing is left to say), the way back to them.
    const target =
      slot?.querySelector<HTMLElement>('.panel--error button') ??
      slot?.querySelector<HTMLElement>('.dropzone__target') ??
      slot?.querySelector<HTMLElement>('h3') ??
      document.querySelector<HTMLElement>('[data-add-video]') ??
      document.querySelector<HTMLElement>('[data-start-over]');
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
  const trim = useOverlayStore((state) => state.trim);
  const setTrim = useOverlayStore((state) => state.setTrim);
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
  /** AV-1013. Making an image of the activity's map, which needs no video. */
  const mapImageChosen = useMapImageStore((state) => state.chosen);
  const setMapImageChosen = useMapImageStore((state) => state.setChosen);
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
  const filesSection = useRef<HTMLElement>(null);
  const [refusal, setRefusal] = useState<string | undefined>();
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
  /** AV-1014. Moves on when Start over lets go, so a pick still being sorted takes nothing after it. */
  const picks = useRef(0);
  /** The name of the video being read, if one is: a second video is refused until it is done. */
  const readingVideo = useRef<string | undefined>(undefined);
  /** What the input refused by name before the pick reached `handleFiles`, taken up there. */
  const refusedByName = useRef<string | undefined>(undefined);
  // A pick still being sorted when the page is left must not start a read after it.
  useEffect(
    () => () => {
      picks.current += 1;
    },
    [],
  );
  const letGoOfVideoRead = () => {
    videoRead.current += 1;
    readingVideo.current = undefined;
    cancel();
  };
  const letGoOfActivityRead = () => {
    activityRead.current += 1;
  };

  const handleVideo = async (file: File) => {
    const generation = ++videoRead.current;
    readingVideo.current = file.name;
    setCleared(undefined);
    setVideoState(IDLE);
    try {
      const { activity, timing, activityError } = await read(file);
      if (generation !== videoRead.current) return;
      readingVideo.current = undefined;
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
      readingVideo.current = undefined;
      const failure = toActivityError(error, 'gopro_extract_failed');
      if (failure.code === 'extraction_cancelled') return;
      // What the reader throws is a file nothing could be drawn over; the
      // video already held, if any, is still the one in use.
      setVideoState({ status: 'error', error: failure, fileName: file.name });
      focusSlot(filesSection);
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
      focusSlot(filesSection);
    }
  };

  /**
   * AV-1014. One pick or drop, of one file or several: each is told apart by
   * what it is, and the video and the activity are read as they were by their
   * own slots. `videoOnly` is the still image's "Add a video", which keeps its
   * activity and takes no other.
   */
  const handleFiles = async (picked: File[], videoOnly: boolean) => {
    const pick = picks.current;
    // What the input refused by name is already shown; the sorting adds to it.
    const earlier = refusedByName.current;
    refusedByName.current = undefined;
    const classified = await Promise.all(
      picked.map(async (file) => ({ file, kind: await classifyOverlayFile(file) })),
    );
    if (pick !== picks.current) return;
    const sorted = sortOverlayFiles(classified);
    const reasons = [earlier, sorted.refusal].filter((reason) => reason !== undefined);
    let { video, activity } = sorted;
    if (activity && videoOnly) {
      reasons.push(
        `"${activity.name}" is an activity, and only a video is taken here. Start over to use another activity.`,
      );
      activity = undefined;
    }
    if (video && readingVideo.current !== undefined) {
      reasons.push(
        `"${readingVideo.current}" is still being read; wait for it or cancel it, then choose "${video.name}" again.`,
      );
      video = undefined;
    }
    setRefusal(reasons.length > 0 ? reasons.join(' ') : undefined);
    if (video) void handleVideo(video);
    if (activity) void handleActivity(activity);
  };

  const focusStartOver = () =>
    setTimeout(() => document.querySelector<HTMLElement>('[data-start-over]')?.focus(), 0);

  const startOver = () => {
    picks.current += 1;
    letGoOfVideoRead();
    letGoOfActivityRead();
    setConfirmingStartOver(false);
    setFinished({ png: false, video: false });
    setCleared(clear());
    setVideoState(IDLE);
    setActivityState(IDLE);
    setAddingVideo(false);
    setRefusal(undefined);
    focusSlot(filesSection);
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
          focusSlot(filesSection);
        }}
      >
        Undo
      </button>
    </div>
  );

  /*
   * AV-1014. A video still being read, picked beside the activity rather than
   * through the still image's Add a video: the page waits for it as the
   * workspace, rather than opening the still image for the moment the
   * activity is read first.
   */
  const videoComing = Boolean(reading) && !addingVideo;
  const mapImage = mapImageChosen && !source.video && !videoComing && source.activity !== undefined;
  const canvas = canvasMode && source.activity !== undefined && !mapImage;
  /*
   * The still image and the map image are made from the activity alone: once
   * one is chosen, the file slots give way to it, and Start over, below it, is
   * the way to another activity or to a video.
   */
  const routeImage =
    !source.video && !videoComing && source.activity !== undefined && !canvas && !mapImage;
  const stillImage = routeImage || mapImage;
  /*
   * AV-1014. The files give way to the still image, and "Add a video" brings
   * back the input. They are drawn at one place in the tree either way, and
   * stay while anything is being read or refused, so a drop is never lost to
   * a section drawn anew.
   */
  const showFiles =
    !stillImage ||
    addingVideo ||
    Boolean(reading) ||
    videoState.status !== 'idle' ||
    activityState.status !== 'idle' ||
    refusal !== undefined;

  return (
    <main className={source.video || canvas || mapImage ? 'page page--overlays is-workspace' : 'page page--overlays'}>
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Overlays</h2>
          <p className="page__intro">
            Draw what a video's telemetry says over the picture (speed, distance, the route, the
            climbs) for your own video editor. Everything is drawn on this device; the video, its
            telemetry and anything made from them are never uploaded.
          </p>
        </header>

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
                trim={trim}
                onTrimChange={setTrim}
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
                  <input
                    type="radio"
                    name="overlay-mode"
                    checked={!canvas && !mapImage}
                    onChange={() => {
                      setCanvasMode(false);
                      setMapImageChosen(false);
                    }}
                  />
                  <span>{source.video ? 'An overlay from a template' : 'A still image'}</span>
                </label>
                {!source.video && (
                  <label className="overlay-controls__choice">
                    <input
                      type="radio"
                      name="overlay-mode"
                      checked={mapImage}
                      onChange={() => {
                        setCanvasMode(false);
                        setMapImageChosen(true);
                      }}
                    />
                    <span>A map image, with the activity’s details</span>
                  </label>
                )}
                <label className="overlay-controls__choice">
                  <input
                    type="radio"
                    name="overlay-mode"
                    checked={canvas}
                    onChange={() => {
                      setCanvasMode(true);
                      setMapImageChosen(false);
                    }}
                  />
                  <span>{source.video ? 'A custom canvas over the video' : 'A custom video overlay, with no video'}</span>
                </label>
              </fieldset>
            )}
            {showFiles && (
              <FilesSection
                sectionRef={filesSection}
                video={source.video}
                activity={source.activity}
                focusedSection={source.focusedSection}
                media={media}
                units={unitSystem}
                compact={Boolean(source.video)}
                stillImage={stillImage}
                reading={reading}
                videoState={videoState}
                activityState={activityState}
                refusal={refusal}
                onRefused={(reason) => {
                  refusedByName.current = reason;
                  setRefusal(reason);
                }}
                onFiles={(files, videoOnly) => void handleFiles(files, videoOnly)}
                onVideo={(file) => void handleVideo(file)}
                onActivity={(file) => void handleActivity(file)}
                onCancelReading={cancel}
                onDismissVideo={() => {
                  setVideoState(IDLE);
                  focusSlot(filesSection);
                }}
                onDismissActivity={() => {
                  setActivityState(IDLE);
                  focusSlot(filesSection);
                }}
                onDismissRefusal={() => {
                  setRefusal(undefined);
                  focusSlot(filesSection);
                }}
                onRemoveVideo={() => {
                  picks.current += 1;
                  letGoOfVideoRead();
                  setVideo(undefined);
                  focusSlot(filesSection);
                }}
                onRemoveActivity={() => {
                  letGoOfActivityRead();
                  setActivityState(IDLE);
                  clearActivity();
                  focusSlot(filesSection);
                }}
              />
            )}
            {!stillImage && startOverControls()}
            {canvas && source.activity && (
              <CustomCanvas
                activity={source.activity}
                video={source.video}
                media={media}
                offsetSeconds={offsetSeconds}
                trim={trim}
                units={unitSystem}
                onOpenSync={source.video ? () => setCanvasMode(false) : undefined}
                onMediaInfo={setMedia}
                onFinishedChange={exportFinished}
                initialDraft={canvasDraft}
                onDraftChange={setCanvasDraft}
              />
            )}
            {/* Below the files, so the slots never move when a route image appears. */}
            {mapImage && source.activity && <MapImagePanel activity={source.activity} units={unitSystem} />}
            {routeImage && source.activity && (
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
                {startOverControls(
                  addingVideo ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        // Lets go of a video being read or refused, too: the input goes with it.
                        picks.current += 1;
                        letGoOfVideoRead();
                        setVideoState(IDLE);
                        setRefusal(undefined);
                        setAddingVideo(false);
                      }}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button"
                      data-add-video
                      onClick={() => {
                        setAddingVideo(true);
                        focusSlot(filesSection);
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
                  trim={trim}
                  units={unitSystem}
                  media={media}
                  onFinishedChange={pngFinished}
                />
                <BurnedInExportPanel
                  video={source.video}
                  activity={source.activity}
                  controls={controls}
                  offsetSeconds={offsetSeconds}
                  trim={trim}
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

/** A file input the "Choose another" button of a held file opens, keeping the current file until then. */
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

const KIND_ACCEPTED = [...VIDEO_EXTENSIONS, ...SUPPORTED_FORMATS];

/**
 * AV-1014. The files, in one section: what is being read, what went wrong,
 * the one input, and a line for each file held. The input stays through any
 * read (TD-059), and gives way only when both a video and an activity are held.
 */
function FilesSection({
  sectionRef,
  video,
  activity,
  focusedSection,
  media,
  units,
  compact,
  stillImage,
  reading,
  videoState,
  activityState,
  refusal,
  onFiles,
  onRefused,
  onVideo,
  onActivity,
  onCancelReading,
  onDismissVideo,
  onDismissActivity,
  onDismissRefusal,
  onRemoveVideo,
  onRemoveActivity,
}: {
  sectionRef: RefObject<HTMLElement | null>;
  video: OverlayVideo | undefined;
  activity: Activity | undefined;
  focusedSection?: boolean;
  media: OverlayMedia | undefined;
  units: UnitSystem;
  /** In the workspace: one line each, the details folded away. */
  compact: boolean;
  /** With the still image showing: only a video is taken, and the activity is not listed. */
  stillImage: boolean;
  reading: VideoReadProgressState | undefined;
  videoState: SlotState;
  activityState: SlotState;
  refusal: string | undefined;
  onFiles: (files: File[], videoOnly: boolean) => void;
  onRefused: (reason: string | undefined) => void;
  onVideo: (file: File) => void;
  onActivity: (file: File) => void;
  onCancelReading: () => void;
  onDismissVideo: () => void;
  onDismissActivity: () => void;
  onDismissRefusal: () => void;
  onRemoveVideo: () => void;
  onRemoveActivity: () => void;
}) {
  const bothHeld = Boolean(video) && Boolean(activity);
  // Says what it wants from what is held: the other kind, or either when empty.
  const wording = stillImage
    ? { title: 'Drop a video to draw over', subtitle: 'MP4 or MOV. Or choose one.' }
    : video || reading
      ? activity
        ? // Only while the video beside it is read: with both held the input is not drawn.
          { title: 'Drop another activity to use instead', subtitle: 'GPX, FIT, TCX or KML. Or choose one.' }
        : { title: 'Drop the activity for this video', subtitle: 'GPX, FIT, TCX or KML. Or choose one.' }
      : activity
        ? { title: 'Drop a video to draw over', subtitle: 'MP4 or MOV. Or choose one.' }
        : {
            title: 'Drop a video, an activity, or both',
            subtitle: 'MP4 or MOV; GPX, FIT, TCX or KML. Or choose them.',
          };

  return (
    <section className="prose overlay-slot overlay-files" aria-label="Files" ref={sectionRef}>
      <h3 className="prose__title" tabIndex={-1}>
        Files
      </h3>
      {reading && <VideoReadProgress progress={reading} onCancel={onCancelReading} />}
      {activityState.status === 'reading' && (
        <p role="status">Reading {activityState.fileName} in this tab…</p>
      )}
      {videoState.status === 'error' && (
        <ErrorPanel error={videoState.error} fileName={videoState.fileName} onDismiss={onDismissVideo} />
      )}
      {activityState.status === 'error' && (
        <ErrorPanel
          error={activityState.error}
          fileName={activityState.fileName}
          onDismiss={onDismissActivity}
        />
      )}
      {refusal && (
        <div className="panel panel--error" role="alert">
          <p className="panel__message">{refusal}</p>
          <button type="button" className="button" onClick={onDismissRefusal}>
            Dismiss
          </button>
        </div>
      )}
      {!bothHeld && (
        <FileDropZone
          multiple
          acceptedExtensions={stillImage ? VIDEO_EXTENSIONS : KIND_ACCEPTED}
          onFiles={(files) => onFiles(files, stillImage)}
          onRefused={onRefused}
          testId="overlay-file-input"
          title={wording.title}
          subtitle={wording.subtitle}
        />
      )}
      {video && (
        <VideoLine
          video={video}
          activity={activity}
          media={media}
          compact={compact}
          reading={reading}
          onFile={onVideo}
          onRemove={onRemoveVideo}
        />
      )}
      {activity && !stillImage && (
        <ActivityLine
          activity={activity}
          focusedSection={focusedSection}
          units={units}
          compact={compact}
          busy={activityState.status === 'reading'}
          onFile={onActivity}
          onRemove={onRemoveActivity}
        />
      )}
    </section>
  );
}

function VideoLine({
  video,
  activity,
  media,
  compact,
  reading,
  onFile,
  onRemove,
}: {
  video: OverlayVideo;
  activity: Activity | undefined;
  media: OverlayMedia | undefined;
  compact: boolean;
  reading: VideoReadProgressState | undefined;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const replace = useRef<HTMLInputElement>(null);
  // The container's clock where it has one, else the length the browser read.
  const duration = video.timing?.durationSeconds ?? media?.durationSeconds;
  return (
    <div role="group" aria-label="Video" className="overlay-files__file">
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
        testId="overlay-video-replace"
        inputRef={replace}
      />
    </div>
  );
}

function ActivityLine({
  activity,
  focusedSection,
  units,
  compact,
  busy,
  onFile,
  onRemove,
}: {
  activity: Activity;
  focusedSection?: boolean;
  units: UnitSystem;
  /** In the workspace: one line, the details folded away. */
  compact: boolean;
  busy: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const replace = useRef<HTMLInputElement>(null);
  const charted = activity.sensorStreams?.filter((stream) => stream.display === 'chart') ?? [];

  return (
    <div role="group" aria-label="Activity" className="overlay-files__file">
      {compact && (
        <p className="overlay-slot__line">
          <span className="overlay-slot__name">
            {activity.source.fileName ?? activity.source.format.toUpperCase()}
          </span>
          <span>{formatDistance(activity.derived?.distanceMeters, units)}</span>
          <span>{formatDuration(activity.derived?.durationSeconds)}</span>
          {focusedSection && <span>Focused section only</span>}
        </p>
      )}
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
              <dd className="summary__value">{charted.map((stream) => stream.label).join(', ')}</dd>
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
        testId="overlay-activity-replace"
        inputRef={replace}
      />
    </div>
  );
}

/** What an activity read, shown as it is, or folded under "Details" in the workspace. */
function SlotDetails({ folded, children }: { folded: boolean; children: ReactNode }) {
  if (!folded) return <>{children}</>;
  return (
    <details className="overlay-slot__details">
      <summary>Details</summary>
      {children}
    </details>
  );
}
