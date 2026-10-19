import { create } from 'zustand';
import type { Activity } from '../domain/activity';
import { DEFAULT_OVERLAY_CONTROLS, type OverlayControls } from '../overlay/presets';

/**
 * What the overlay page knows about a video's clock, as its container states
 * it. Video time `t` corresponds to wall-clock `start + t`, which is how an
 * activity's timestamped points will be lined up against the picture.
 */
export interface OverlayVideoTiming {
  durationSeconds: number;
  /** Seconds between frames. */
  frameIntervalSeconds: number;
  /** Wall-clock time of the first frame, where the container states one. */
  start?: Date;
}

export interface OverlayVideo {
  /** The local file itself, so a later preview can play it. Never uploaded. */
  file: File;
  /** Absent for a video whose container carried no telemetry track. */
  timing?: OverlayVideoTiming;
  /**
   * Why this video supplies no activity of its own, when it does not: no
   * telemetry track, or a track with no usable fix. Shown beside the file, so
   * the reader knows an activity file has to come from elsewhere.
   */
  telemetryNote?: string;
}

/**
 * What the video element reports once it has read the file: the picture's
 * size and the true length. The export sizes its frames from the first and,
 * where the container stated no clock, takes its length from the second.
 */
export interface OverlayMedia {
  width: number;
  height: number;
  durationSeconds: number;
}

/**
 * Where the activity came from. `hand` is a file the reader chose; `video` is
 * the telemetry of the video beside it. The difference decides what a new
 * video may replace (TD-040): a reader's choice, never; the previous video's
 * track, always — it belonged to that video, not to this one.
 */
export type OverlayActivityOrigin = 'hand' | 'video';

/**
 * AV-1002. What the overlay page works from: a local video, a normalized
 * activity — which carries the auxiliary camera streams (`sensorStreams`) and
 * its warnings with it — or both.
 *
 * In memory only, like the viewer's activity (TD-025, §5). The extraction page
 * writes it on "Create overlays"; the overlay page writes it when files are
 * chosen by hand; a reload leaves it empty, and the page says so.
 */
export interface OverlaySource {
  video?: OverlayVideo;
  activity?: Activity;
  activityOrigin?: OverlayActivityOrigin;
  /**
   * AV-1009. The activity is the viewer's focused section, handed over on
   * purpose, not the whole recording. Said beside the activity so a route image
   * of a part is never taken for the ride.
   */
  focusedSection?: boolean;
}

interface OverlayState {
  source: OverlaySource;
  /**
   * AV-1004. Seconds the telemetry is late against the video (see
   * `OverlayTimelineOptions.offsetSeconds`). It describes how this video and
   * this activity disagree, so it is forgotten when either is replaced.
   */
  offsetSeconds: number;
  setOffsetSeconds: (seconds: number) => void;
  /**
   * AV-1005. Template, component, layout and style choices. Kept for the
   * session — across template switches and replaced files, so a reader's
   * accent colour is not lost with the video — and in memory only, like the
   * rest: nothing but the theme is ever written to storage.
   */
  controls: OverlayControls;
  /** AV-1006. Reported by the preview; forgotten with the video. */
  media: OverlayMedia | undefined;
  setMedia: (media: OverlayMedia | undefined) => void;
  setControls: (patch: Partial<OverlayControls>) => void;
  /**
   * Sets the video. Replacing or removing a video takes with it an activity
   * that was that video's own telemetry; one chosen by hand stays.
   */
  setVideo: (video: OverlayVideo | undefined) => void;
  /** Sets the activity, recording where it came from and whether it is a focused section. */
  setActivity: (
    activity: Activity,
    origin: OverlayActivityOrigin,
    options?: { focusedSection?: boolean },
  ) => void;
  clearActivity: () => void;
  /**
   * AV-1009. The viewer's "Create route overlay": the activity on its own, for a
   * route image. A video already held here is let go, with its offset and its
   * measurements: the page would otherwise open the video workflow and not the
   * route image the reader asked for.
   */
  setStandaloneActivity: (activity: Activity, options?: { focusedSection?: boolean }) => void;
  /**
   * Offers a video's own telemetry as the activity. Taken when the slot is
   * empty or holds a previous video's telemetry; declined when the reader
   * chose an activity by hand. Returns whether it was taken.
   */
  offerVideoActivity: (activity: Activity) => boolean;
  clear: () => void;
}

export const useOverlayStore = create<OverlayState>((set, get) => ({
  source: {},
  offsetSeconds: 0,
  controls: DEFAULT_OVERLAY_CONTROLS,
  media: undefined,

  setMedia: (media) =>
    set((state) => {
      const same =
        state.media?.width === media?.width &&
        state.media?.height === media?.height &&
        state.media?.durationSeconds === media?.durationSeconds;
      return same ? state : { media };
    }),

  setControls: (patch) => set((state) => ({ controls: { ...state.controls, ...patch } })),

  setOffsetSeconds: (seconds) => set({ offsetSeconds: Number.isFinite(seconds) ? seconds : 0 }),

  setVideo: (video) =>
    set((state) => {
      const keepsActivity = state.source.activityOrigin === 'hand';
      return {
        offsetSeconds: 0,
        media: undefined,
        source: {
          video,
          activity: keepsActivity ? state.source.activity : undefined,
          activityOrigin: keepsActivity ? 'hand' : undefined,
          ...(keepsActivity && state.source.focusedSection ? { focusedSection: true } : {}),
        },
      };
    }),

  setActivity: (activity, origin, options) =>
    set((state) => ({
      offsetSeconds: 0,
      source: {
        video: state.source.video,
        activity,
        activityOrigin: origin,
        ...(options?.focusedSection ? { focusedSection: true } : {}),
      },
    })),

  clearActivity: () =>
    set((state) => ({ offsetSeconds: 0, source: { video: state.source.video } })),

  setStandaloneActivity: (activity, options) =>
    set({
      offsetSeconds: 0,
      media: undefined,
      source: {
        activity,
        activityOrigin: 'hand',
        ...(options?.focusedSection ? { focusedSection: true } : {}),
      },
    }),

  offerVideoActivity: (activity) => {
    if (get().source.activityOrigin === 'hand') return false;
    get().setActivity(activity, 'video');
    return true;
  },

  clear: () =>
    set({ source: {}, offsetSeconds: 0, media: undefined, controls: DEFAULT_OVERLAY_CONTROLS }),
}));

/** Whether there is anything on the page to make an overlay from. */
export function hasOverlaySource(source: OverlaySource): boolean {
  return Boolean(source.video || source.activity);
}
