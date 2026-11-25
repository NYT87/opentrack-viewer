import { toValidCoordinate, type Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { shownActivity } from '../mapVideo/figures';
import type { MapVideoSettings } from '../mapVideo/project';
import type { MapVideoRoute } from '../mapVideo/route';
import { mapVideoAttribution } from '../mapVideo/style';
import { projectProfile, type ProjectedProfile } from '../overlay/elevationProfile';
import type { MeasureText } from '../overlay/staticImage';
import { buildOverlayTimeline, type OverlayTimeline } from '../overlay/timeline';
import { mapImagePanelContent } from './details';
import { fitCamera, imageRoute } from './geometry';
import { planPanel, type PanelLayout } from './panel';
import { videoSettingsForImage, type MapImageCamera, type MapImageSettings } from './settings';

/**
 * AV-1013. Everything a map image is drawn from, worked out once from the
 * activity and the settings: the route the trim leaves, the panel and the map
 * it leaves room for, where the map is looked at from, and the credit. The
 * preview and the export draw from the same plan.
 */
export interface MapImagePlan {
  width: number;
  height: number;
  /** The map's height: the image's, less the panel. The map is always the image's width. */
  mapHeight: number;
  route: MapVideoRoute;
  /** The stretch the privacy trim leaves, for the profile and the canvas's elements. */
  shown: Activity;
  /** The reader's camera, or the route fitted, at the map's own size. */
  camera: MapImageCamera;
  /** Whether `camera` is the fit, not the reader's. */
  fitted: boolean;
  panel: PanelLayout;
  profile?: ProjectedProfile;
  credit?: string;
  /** The map video's settings the map is drawn with (`videoSettingsForImage`). */
  video: MapVideoSettings;
}

export type PlanMapImageResult = { ok: true; plan: MapImagePlan } | { ok: false; error: string };

export interface PlanMapImageInput {
  activity: Activity;
  settings: MapImageSettings;
  units: UnitSystem;
  measure: MeasureText;
  readerTimeZone?: string;
}

export function planMapImage({ activity, settings, units, measure, readerTimeZone }: PlanMapImageInput): PlanMapImageResult {
  const built = imageRoute(activity, settings.privacyTrim);
  if (!built.ok) return built;
  const { route } = built;
  const shown = shownActivity(activity, { route }, settings);
  const { width, height } = settings.output;
  const content = settings.layout === 'panel' ? mapImagePanelContent(settings.panel.details, { activity, shown, units, readerTimeZone }) : undefined;
  const panel = content ? planPanel(content, { width, height }, measure) : { height: 0, scale: 1, items: [] };
  const mapHeight = height - panel.height;
  const video = videoSettingsForImage(settings, { width, height: mapHeight });
  const profile = content?.profile ? projectProfile(shown) : undefined;
  const credit = mapVideoAttribution(video);
  return {
    ok: true,
    plan: {
      width,
      height,
      mapHeight,
      route,
      shown,
      camera: settings.camera ?? fitCamera(route, { width, height: mapHeight }),
      fitted: settings.camera === undefined,
      panel,
      ...(profile ? { profile } : {}),
      ...(credit ? { credit } : {}),
      video,
    },
  };
}

/**
 * The free canvas's clock for a still: the activity's own span, read at its
 * end, so a live figure shows its final value and the route inset the whole
 * route. Figures for the whole activity, the date, text and shapes do not
 * move with it.
 */
export function stillOverlayClock(shown: Activity): { timeline: OverlayTimeline; seconds: number } {
  let first = Infinity;
  let last = -Infinity;
  for (const point of shown.points) {
    const ms = point.time?.getTime();
    if (ms === undefined || !Number.isFinite(ms)) continue;
    first = Math.min(first, ms);
    last = Math.max(last, ms);
  }
  const span = last > first ? (last - first) / 1000 : 0;
  const timeline = buildOverlayTimeline(shown, { video: { durationSeconds: span } });
  if (timeline.unavailable === 'no_timestamps') return { timeline: staticTimeline(shown), seconds: 0 };
  return { timeline, seconds: span };
}

/**
 * TD-088 (TD-061). The clock of a still whose activity has no timestamps (a GPX
 * route, a KML path): no moment can be asked of it, but the picture shows the
 * end of it, so the route inset and the elevation profile, which are geometry,
 * are drawn with their position at the last point and their progress at 1. No
 * figure is live: nothing is read at a moment that has none.
 */
function staticTimeline(shown: Activity): OverlayTimeline {
  const last = [...shown.points].reverse().map((point) => toValidCoordinate(point.lat, point.lon)).find((place) => place !== undefined);
  const available = new Set<string>();
  if (shown.points.some((point) => typeof point.elevationMeters === 'number' && Number.isFinite(point.elevationMeters))) available.add('metric:elevation');
  return {
    durationSeconds: 0,
    offsetSeconds: 0,
    available,
    hasRoute: last !== undefined,
    sensorLabels: new Map(),
    sampleAt: (videoTimeSeconds) => ({ videoTimeSeconds, activityElapsedSeconds: 0, values: {}, position: last, progress: 1 }),
  };
}
