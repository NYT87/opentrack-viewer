import { create } from 'zustand';
import type { Activity } from '../domain/activity';

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
}

interface OverlayState {
  source: OverlaySource;
  /**
   * Sets the video. Replacing or removing a video takes with it an activity
   * that was that video's own telemetry; one chosen by hand stays.
   */
  setVideo: (video: OverlayVideo | undefined) => void;
  /** Sets the activity, recording where it came from. */
  setActivity: (activity: Activity, origin: OverlayActivityOrigin) => void;
  clearActivity: () => void;
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

  setVideo: (video) =>
    set((state) => {
      const keepsActivity = state.source.activityOrigin === 'hand';
      return {
        source: {
          video,
          activity: keepsActivity ? state.source.activity : undefined,
          activityOrigin: keepsActivity ? 'hand' : undefined,
        },
      };
    }),

  setActivity: (activity, origin) =>
    set((state) => ({ source: { ...state.source, activity, activityOrigin: origin } })),

  clearActivity: () =>
    set((state) => ({ source: { video: state.source.video } })),

  offerVideoActivity: (activity) => {
    if (get().source.activityOrigin === 'hand') return false;
    get().setActivity(activity, 'video');
    return true;
  },

  clear: () => set({ source: {} }),
}));

/** Whether there is anything on the page to make an overlay from. */
export function hasOverlaySource(source: OverlaySource): boolean {
  return Boolean(source.video || source.activity);
}
