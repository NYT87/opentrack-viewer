import type { Activity } from '../domain/activity';
import { buildCameraPath, type MapVideoCamera, type MapVideoCameraPath } from './camera';
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
  camera: MapVideoCameraPath;
  frameCount: number;
  /** The vertices the line is drawn through: none strays half a pixel from it at the follow zoom. */
  drawn: number[];
  /** One frame: where the camera is, how much route is drawn, and where on it the marker is. */
  frame: (frame: number) => MapVideoFrame;
  /** The same for a moment of the video, for a preview that keeps up by skipping frames. */
  at: (seconds: number) => MapVideoFrame;
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

export function buildMapVideoModel(activity: Activity, settings: MapVideoSettings): BuildMapVideoModelResult {
  const full = buildMapVideoRoute(activity);
  if (!full) return { ok: false, error: 'This activity has fewer than two points with a location, so there is no route to follow.' };
  const route = trimRoute(full, settings.privacyTrim.startMeters, settings.privacyTrim.endMeters);
  if (!route) {
    return { ok: false, error: 'The privacy trim leaves less than 100 m of the route. Trim less, or choose a longer activity.' };
  }
  const built = buildMapVideoTimeline(route, {
    lengthSeconds: settings.lengthSeconds,
    mode: settings.timing.mode,
    pauseBeatSeconds: settings.timing.pauseBeatSeconds,
    introSeconds: settings.intro.enabled ? settings.intro.seconds : 0,
    outroSeconds: settings.outro.enabled ? settings.outro.seconds : 0,
  });
  if (!built.ok) return built;
  const { timeline } = built;
  const camera = buildCameraPath(
    route,
    settings.camera,
    { width: settings.output.width, height: settings.output.height },
    settings.terrain.enabled ? settings.terrain.exaggeration : undefined,
  );
  const frameCount = Math.round(settings.lengthSeconds * settings.output.fps);
  const middle = route.vertices[Math.floor(route.vertices.length / 2)]!;
  const drawn = simplifiedIndices(route, metersPerPixel(settings.camera.zoom, middle.lat) / 2);
  const at = (seconds: number): MapVideoFrame => {
    const sample = timeline.at(seconds);
    return {
      seconds,
      sample,
      camera: camera.at(sample),
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
    },
  };
}
