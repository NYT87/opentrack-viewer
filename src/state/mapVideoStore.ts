import { create } from 'zustand';
import { hasValidLocation, type Activity } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import type { CameraKeyframe } from '../mapVideo/keyframes';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from '../mapVideo/project';

const KEYFRAME_UNDO_DEPTH = 50;

/**
 * Where the map video's activity came from: a file chosen on the page, or a
 * handoff from the viewer, Route Builder or the video telemetry page. Said
 * beside the activity, so the reader knows why it is there.
 */
export type MapVideoActivityOrigin = 'hand' | 'viewer' | 'routeBuilder' | 'videoTelemetry';

/**
 * What the map is drawn on: an online basemap, whose tile server learns which
 * area is shown, or the route alone, which fetches nothing (TD-064).
 */
export type MapVideoBasemap = MapVideoSettings['basemap']['source'];

/** A change to some settings: each section given is merged over the one held. */
export type MapVideoSettingsPatch = { [K in keyof MapVideoSettings]?: MapVideoSettings[K] extends object | null ? Partial<NonNullable<MapVideoSettings[K]>> | MapVideoSettings[K] : MapVideoSettings[K] };

interface MapVideoState {
  activity?: Activity;
  origin?: MapVideoActivityOrigin;
  /** Every setting of the video (TD-066), kept across activities: they are the reader's, not the file's. */
  settings: MapVideoSettings;
  /**
   * Whether the reader has chosen the basemap here. Until then the page
   * follows the app's basemap setting, so someone who turned tiles off is
   * not opted back in (TD-065).
   */
  basemapChosen: boolean;
  /** The reader's MapTiler key: in memory only, never in a project file or storage (TD-064). */
  maptilerKey: string;
  setMaptilerKey: (key: string) => void;
  setActivity: (activity: Activity, origin: MapVideoActivityOrigin) => void;
  setBasemap: (basemap: MapVideoBasemap) => void;
  updateSettings: (patch: MapVideoSettingsPatch) => void;
  /** Earlier keyframe lists, newest last: every keyframe edit can be undone, fifty deep, as in Route Builder (TD-052). */
  keyframeUndo: CameraKeyframe[][];
  /** Replaces the keyframes, keeping the old list to undo to. */
  editKeyframes: (keyframes: CameraKeyframe[]) => void;
  undoKeyframes: () => void;
  /** Settings opened from a project file: the basemap among them counts as chosen. */
  replaceSettings: (settings: MapVideoSettings) => void;
  clear: () => void;
}

/**
 * AV-1202. The map video page's own store, beside the viewer's and the overlay
 * page's (TD-040): closing the viewer's activity does not take a map video's
 * with it. In memory only, like every handoff (§5); a reload leaves it empty
 * and the page asks for a file.
 */
export const useMapVideoStore = create<MapVideoState>((set) => ({
  settings: DEFAULT_MAP_VIDEO_SETTINGS,
  basemapChosen: false,
  maptilerKey: '',
  setMaptilerKey: (maptilerKey) => set({ maptilerKey }),
  setActivity: (activity, origin) => set({ activity, origin }),
  setBasemap: (source) =>
    set((state) => ({ basemapChosen: true, settings: { ...state.settings, basemap: { ...state.settings.basemap, source } } })),
  updateSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        const current = settings[key];
        settings[key] =
          value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && key !== 'overlay'
            ? { ...current, ...value }
            : value;
      }
      return { settings: settings as unknown as MapVideoSettings };
    }),
  replaceSettings: (settings) => set({ settings, basemapChosen: true, keyframeUndo: [] }),
  keyframeUndo: [],
  editKeyframes: (keyframes) =>
    set((state) => ({
      keyframeUndo: [...state.keyframeUndo, state.settings.keyframes].slice(-KEYFRAME_UNDO_DEPTH),
      settings: { ...state.settings, keyframes },
    })),
  undoKeyframes: () =>
    set((state) => {
      const previous = state.keyframeUndo[state.keyframeUndo.length - 1];
      if (!previous) return state;
      return { keyframeUndo: state.keyframeUndo.slice(0, -1), settings: { ...state.settings, keyframes: previous } };
    }),
  // The settings are the reader's choice, not the file's: they stay.
  clear: () => set({ activity: undefined, origin: undefined }),
}));

/** The settings as the page uses them: the basemap follows the app's setting until chosen here. */
export function effectiveMapVideoSettings(settings: MapVideoSettings, basemapChosen: boolean, basemapEnabled: boolean): MapVideoSettings {
  if (basemapChosen) return settings;
  const source: MapVideoBasemap = basemapEnabled ? 'online' : 'route-only';
  return settings.basemap.source === source ? settings : { ...settings, basemap: { ...settings.basemap, source } };
}

/**
 * Why an activity cannot become a map video, or undefined when it can. The
 * camera follows a line, so at least two located points are needed: a single
 * fix is a place, not a route.
 */
export function mapVideoRefusal(activity: Activity): ActivityError | undefined {
  let located = 0;
  for (const point of activity.points) {
    if (hasValidLocation(point) && ++located >= 2) return undefined;
  }
  return located === 0
    ? new ActivityError('no_location_stream', 'This activity has no GPS coordinates, so there is no route to follow.')
    : new ActivityError('no_location_stream', 'This activity has only one point with a location, so there is no route to follow.');
}
