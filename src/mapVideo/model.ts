import type { Activity } from '../domain/activity';
import { buildCameraPath, type MapVideoCamera, type MapVideoCameraPath } from './camera';
import { withKeyframes } from './keyframes';
import { placePhotos, type PhotoInput, type PhotoPlacement } from './photos';
import type { MapVideoSettings } from './project';
import {
  buildMapVideoRoute,
  positionAt,
  revealAt,
  simplifiedIndices,
  trimRoute,
  type MapVideoRoute,
  type RoutePosition,
  type RouteReveal,
} from './route';
import { buildMapVideoTimeline, type MapVideoTimeline, type TimelineSample } from './timing';

/**
 * AV-1203. Everything a map video's frames are drawn from, built once from
 * the activity and the settings. The preview (AV-1204) and the export
 * (AV-1209) read frames from the same model, so they cannot disagree.
 */
export interface MapVideoModel {
  /** The route after the privacy trim: the only route anything below sees. */
  route: MapVideoRoute;
  timeline: MapVideoTimeline;
  camera: MapVideoCameraPath & { atSeconds: (seconds: number) => MapVideoCamera };
  frameCount: number;
  /** The vertices the line is drawn through: none strays half a pixel from it at the follow zoom. */
  drawn: number[];
  /** One frame: where the camera is, how much route is drawn, and where on it the marker is. */
  frame: (frame: number) => MapVideoFrame;
  /** The same for a moment of the video, for a preview that keeps up by skipping frames. */
  at: (seconds: number) => MapVideoFrame;
  /** AV-1208. Where each photo went, or why it was left out. */
  photos: PhotoPlacement[];
  /** The route as recorded, and how much of each end the privacy trim took: for placing by hand on the whole route. */
  trim: { fullMeters: number; start: number; end: number };
}

/** Metres a pixel covers at a zoom and latitude, on MapLibre's 512-pixel world. */
export function metersPerPixel(zoom: number, latitude: number): number {
  return (40_075_016.686 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
}

export interface MapVideoFrame {
  seconds: number;
  sample: TimelineSample;
  camera: MapVideoCamera;
  reveal: RouteReveal;
  /** The place the marker is, with its point in the activity, for figures (AV-1207). */
  position: RoutePosition;
}

export type BuildMapVideoModelResult = { ok: true; model: MapVideoModel } | { ok: false; error: string };

/**
 * `photos` are the reader's photos as the page read them (their EXIF in
 * memory only, TD-071): placed here, and each held on screen in the timeline.
 */
export function buildMapVideoModel(activity: Activity, settings: MapVideoSettings, photos: PhotoInput[] = []): BuildMapVideoModelResult {
  const full = buildMapVideoRoute(activity);
  if (!full) return { ok: false, error: 'This activity has fewer than two points with a location, so there is no route to follow.' };
  const route = trimRoute(full, settings.privacyTrim.startMeters, settings.privacyTrim.endMeters);
  if (!route) {
    return { ok: false, error: 'The privacy trim leaves less than 100 m of the route. Trim less, or choose a longer activity.' };
  }
  const trimStart = route === full ? 0 : settings.privacyTrim.startMeters;
  const trimEnd = route === full ? 0 : settings.privacyTrim.endMeters;
  const placements = placePhotos(photos, settings.photos, full, { start: trimStart, end: trimEnd });
  const holds = placements.flatMap((photo) => (photo.distance === undefined ? [] : [{ id: photo.id, distance: photo.distance, seconds: settings.photos.holdSeconds }]));
  const built = buildMapVideoTimeline(route, {
    lengthSeconds: settings.lengthSeconds,
    mode: settings.timing.mode,
    pauseBeatSeconds: settings.timing.pauseBeatSeconds,
    introSeconds: settings.intro.enabled ? settings.intro.seconds : 0,
    outroSeconds: settings.outro.enabled ? settings.outro.seconds : 0,
    holds,
  });
  if (!built.ok) return built;
  const { timeline } = built;
  // No height for the camera: over terrain the map holds the centre to the
  // ground. A height from the route put the marker off centre wherever the
  // recorded elevation and the terrain model disagree (TD-068).
  const viewport = { width: settings.output.width, height: settings.output.height };
  // The follow camera, and the reader's keyframes over it (AV-1206).
  const camera = withKeyframes(buildCameraPath(route, settings.camera, viewport), settings.keyframes, {
    timeline,
    route,
    viewport,
    settings: settings.camera,
  });
  const frameCount = Math.round(settings.lengthSeconds * settings.output.fps);
  const middle = route.vertices[Math.floor(route.vertices.length / 2)]!;
  const drawn = simplifiedIndices(route, metersPerPixel(settings.camera.zoom, middle.lat) / 2);
  const at = (seconds: number): MapVideoFrame => {
    const sample = timeline.at(seconds);
    return {
      seconds,
      sample,
      camera: camera.atSeconds(seconds),
      reveal: revealAt(route, sample.distance, drawn),
      position: positionAt(route, sample.distance),
    };
  };

  return {
    ok: true,
    model: {
      route,
      timeline,
      camera,
      frameCount,
      drawn,
      frame: (frame) => at(timeline.frameSeconds(frame, frameCount)),
      at,
      photos: placements,
      trim: { fullMeters: full.totalMeters, start: trimStart, end: trimEnd },
    },
  };
}
