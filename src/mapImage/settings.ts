import { DEFAULT_MAP_VIDEO_SETTINGS, MAP_VIDEO_LIMITS, type MapVideoSettings } from '../mapVideo/project';
import type { OverlayComponent } from '../overlay/template';

/**
 * AV-1013. An activity as an image of its map: the route on a real basemap,
 * always seen from straight above, with the activity's details in a panel
 * below it or placed freely over it. The map, its route and its credit are
 * the map video's (TD-064, TD-068); only the camera and what goes with the
 * map are the image's own.
 */

/** `panel`: the map on top and a panel of details below; `canvas`: the map fills the image, the custom canvas over it. */
export type MapImageLayout = 'panel' | 'canvas';

/** What the panel can hold, in the order it is laid out. */
export type MapImageDetail = 'name' | 'date' | 'distance' | 'moving' | 'elapsed' | 'climb' | 'speed' | 'pace' | 'heartRate' | 'profile';
export const MAP_IMAGE_DETAILS: readonly MapImageDetail[] = ['name', 'date', 'distance', 'moving', 'elapsed', 'climb', 'speed', 'pace', 'heartRate', 'profile'];

/** Where the map is looked at from, in the image's own pixels: straight down, so there is no pitch. */
export interface MapImageCamera {
  center: [number, number];
  zoom: number;
  /** Degrees clockwise from north, 0 to 360. */
  bearing: number;
}

export interface MapImageSettings {
  layout: MapImageLayout;
  output: { width: number; height: number };
  format: 'png' | 'jpeg';
  basemap: MapVideoSettings['basemap'];
  route: Omit<MapVideoSettings['route'], 'unrevealed'>;
  endpoints: { shown: boolean };
  privacyTrim: MapVideoSettings['privacyTrim'];
  /** Where the reader left the map, or undefined while it is fitted to the route. */
  camera?: MapImageCamera;
  panel: { background: string; details: MapImageDetail[] };
  /** The free canvas's elements (TD-062), in fractions of the image. */
  overlay: OverlayComponent[];
}

export const MAP_IMAGE_LIMITS = {
  minSide: MAP_VIDEO_LIMITS.minSide,
  maxSide: MAP_VIDEO_LIMITS.maxSide,
  maxPixels: MAP_VIDEO_LIMITS.maxPixels,
  /** The map's zoom, at the image's own size: from a continent to a street corner. */
  zoom: [1, 19] as const,
} as const;

export interface MapImageSizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const MAP_IMAGE_SIZE_PRESETS: readonly MapImageSizePreset[] = [
  { id: 'portrait-post', label: 'Portrait post, 1080 × 1350', width: 1080, height: 1350 },
  { id: 'square', label: 'Square, 1080 × 1080', width: 1080, height: 1080 },
  { id: 'story', label: 'Story, 1080 × 1920', width: 1080, height: 1920 },
  { id: 'link', label: 'Link preview, 1200 × 630', width: 1200, height: 630 },
  { id: 'landscape', label: 'Landscape, 1920 × 1080', width: 1920, height: 1080 },
  { id: 'landscape-4k', label: 'Landscape 4K, 3840 × 2160', width: 3840, height: 2160 },
];

export const DEFAULT_MAP_IMAGE_SETTINGS: MapImageSettings = {
  layout: 'panel',
  output: { width: 1080, height: 1350 },
  format: 'png',
  basemap: { ...DEFAULT_MAP_VIDEO_SETTINGS.basemap },
  route: { color: '#ff5533', width: 6, casing: true, casingColor: '#1a1a1a', colorBy: 'none' },
  endpoints: { shown: true },
  privacyTrim: { startMeters: 0, endMeters: 0 },
  panel: { background: '#14202b', details: ['name', 'date', 'distance', 'moving', 'climb', 'pace'] },
  overlay: [],
};

/** Why the size cannot be drawn, or undefined. */
export function mapImageSizeProblem({ width, height }: { width: number; height: number }): string | undefined {
  const { minSide, maxSide, maxPixels } = MAP_IMAGE_LIMITS;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return 'The width and height are whole pixels.';
  if (width < minSide || height < minSide) return `Each side is at least ${minSide} pixels.`;
  if (width > maxSide || height > maxSide) return `Each side is at most ${maxSide} pixels.`;
  if (width * height > maxPixels) return 'The image is at most 4K’s pixels (3840 × 2160, or the same number in another shape).';
  return undefined;
}

/**
 * The map video's settings the image's map is drawn with: the same basemap,
 * route style, ends and trim, at the map's own size, with no terrain and the
 * whole route drawn, so `installVideoLayers` and `styleVideoMap` draw it.
 */
export function videoSettingsForImage(settings: MapImageSettings, mapSize: { width: number; height: number }): MapVideoSettings {
  return {
    ...DEFAULT_MAP_VIDEO_SETTINGS,
    output: { ...mapSize, fps: DEFAULT_MAP_VIDEO_SETTINGS.output.fps },
    basemap: settings.basemap,
    terrain: { ...DEFAULT_MAP_VIDEO_SETTINGS.terrain, enabled: false },
    route: { ...settings.route, unrevealed: 'hidden' },
    endpoints: settings.endpoints,
    privacyTrim: settings.privacyTrim,
    summaryCard: { enabled: false },
  };
}
