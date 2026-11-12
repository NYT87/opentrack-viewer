import { create } from 'zustand';
import type { Activity } from '../domain/activity';
import { cameraAtWidth } from '../mapImage/geometry';
import { DEFAULT_MAP_IMAGE_SETTINGS, imageBasemap, type MapImageCamera, type MapImageSettings } from '../mapImage/settings';
import type { MapVideoBasemap } from './mapVideoStore';

/** A change to some settings: each section given is merged over the one held. */
export type MapImageSettingsPatch = {
  [K in keyof MapImageSettings]?: MapImageSettings[K] extends unknown[] ? MapImageSettings[K] : MapImageSettings[K] extends object ? Partial<MapImageSettings[K]> : MapImageSettings[K];
};

/** Where the reader left the map: for one activity, at one image width. */
interface MapImageView {
  activity: Activity;
  camera: MapImageCamera;
  width: number;
}

interface MapImageState {
  /** The reader's choices, kept across activities; the camera is not among them (`view`). */
  settings: Omit<MapImageSettings, 'camera'>;
  /** Whether the basemap was chosen here. Until then it follows the app's setting, as the map video's does (TD-065). */
  basemapChosen: boolean;
  view?: MapImageView;
  /** Whether the overlay page is making a map image, rather than the still image or the canvas. */
  chosen: boolean;
  setChosen: (chosen: boolean) => void;
  setBasemap: (source: MapVideoBasemap) => void;
  updateSettings: (patch: MapImageSettingsPatch) => void;
  /**
   * The reader moved the map; undefined fits it to the route again. `width` is
   * the width the map was drawn at when it was moved: the preview's, which is
   * the last size that could be drawn, not a size still being typed.
   */
  setCamera: (activity: Activity, camera: MapImageCamera | undefined, width: number) => void;
}

/**
 * AV-1013. The map image's own store, beside the overlay page's: in memory
 * only, like every handoff (§5). MapTiler is never offered for an image
 * (TD-079), so no key is held here.
 */
export const useMapImageStore = create<MapImageState>((set) => ({
  settings: DEFAULT_MAP_IMAGE_SETTINGS,
  basemapChosen: false,
  chosen: false,
  setChosen: (chosen) => set({ chosen }),
  setBasemap: (source) => set((state) => ({ basemapChosen: true, settings: { ...state.settings, basemap: { ...state.settings.basemap, source } } })),
  updateSettings: (patch) =>
    set((state) => {
      const settings = { ...state.settings } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        const current = settings[key];
        settings[key] =
          value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current)
            ? { ...current, ...value }
            : value;
      }
      return { settings: settings as unknown as MapImageSettings };
    }),
  setCamera: (activity, camera, width) => set({ view: camera ? { activity, camera, width } : undefined }),
}));

/**
 * The settings as the image is drawn with: the basemap following the app's
 * setting until chosen here, and the reader's camera only for the activity it
 * was set on, at the width it is drawn at (`atWidth`, the image's own unless
 * the preview is holding an earlier size while another is typed).
 */
export function effectiveMapImageSettings(
  state: Pick<MapImageState, 'settings' | 'basemapChosen' | 'view'>,
  activity: Activity,
  basemapEnabled: boolean,
  atWidth: number = state.settings.output.width,
): MapImageSettings {
  const { settings, basemapChosen, view } = state;
  const source = imageBasemap(basemapChosen ? settings.basemap : { ...settings.basemap, source: basemapEnabled ? 'online' : 'route-only' }).source;
  const camera = view && view.activity === activity ? cameraAtWidth(view.camera, view.width, atWidth) : undefined;
  return {
    ...settings,
    basemap: source === settings.basemap.source ? settings.basemap : { ...settings.basemap, source },
    ...(camera ? { camera } : {}),
  };
}
