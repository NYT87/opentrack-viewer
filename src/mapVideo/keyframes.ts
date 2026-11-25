import { blendCameras, type MapVideoCamera, type MapVideoCameraPath, type MapVideoCameraSettings, type MapVideoViewport } from './camera';
import { positionAt, type MapVideoRoute } from './route';
import type { MapVideoTimeline, TimelineSample } from './timing';

/**
 * AV-1206. Camera keyframes: at a moment of the video, where the camera is,
 * set by the reader on top of the automatic follow camera.
 *
 * A keyframe holds no place. Its centre is an offset from the marker, in
 * metres east and north, so a project file with keyframes still holds
 * nothing of the ride (TD-066), and a project opened on another activity
 * still means something.
 *
 * - `follow`: the camera keeps that offset from the marker as it moves, and
 *   the offset is held so the marker never leaves the frame.
 * - `fixed`: the camera stays where the marker was at that moment, plus the
 *   offset, and the marker may leave the frame: the reader chose that.
 *
 * Between keyframes the camera eases in and out (smoothstep: slow, faster,
 * slow). Before the first and after the last, it eases from and back to the
 * follow camera's own values, which are therefore the default between them.
 */
export interface CameraKeyframe {
  id: string;
  /** The moment, in video seconds, within the follow (not the intro or outro). */
  seconds: number;
  mode: 'follow' | 'fixed';
  /** The centre's offset from the marker at this moment, in metres. */
  offset: { east: number; north: number };
  zoom: number;
  pitch: number;
  /** Degrees clockwise from north, or null to turn with the route as the follow camera does. */
  bearing: number | null;
}

export const MAX_KEYFRAMES = 100;
/** A fixed camera may stand this far from the marker at most. */
export const MAX_FIXED_OFFSET_METERS = 20_000;
/** The marker is kept within this share of the shorter side from the frame's centre. */
const KEEP_IN_FRAME_SHARE = 0.35;

const toRadians = Math.PI / 180;
const METERS_PER_DEGREE = 111_195;

/** Metres a pixel covers at a zoom and latitude, on MapLibre's 512-pixel world. */
function metersPerPixel(zoom: number, latitude: number): number {
  return (40_075_016.686 * Math.cos(latitude * toRadians)) / (512 * 2 ** zoom);
}

/**
 * How far the centre may stand from the marker before the marker could leave
 * the frame: a share of the frame's shorter side, less with the camera tilted,
 * since a tilted camera sees less ground below the centre than above it.
 */
export function maxFollowOffsetMeters(zoom: number, pitch: number, latitude: number, viewport: MapVideoViewport): number {
  return KEEP_IN_FRAME_SHARE * Math.min(viewport.width, viewport.height) * metersPerPixel(zoom, latitude) * Math.cos(pitch * toRadians);
}

/** A place moved by metres east and north. */
export function offsetPlace([lon, lat]: [number, number], { east, north }: { east: number; north: number }): [number, number] {
  return [lon + east / (METERS_PER_DEGREE * Math.cos(lat * toRadians)), lat + north / METERS_PER_DEGREE];
}

/** The metres east and north from `from` to `to`. */
export function offsetBetween(from: [number, number], to: [number, number]): { east: number; north: number } {
  return { east: (to[0] - from[0]) * METERS_PER_DEGREE * Math.cos(from[1] * toRadians), north: (to[1] - from[1]) * METERS_PER_DEGREE };
}

/** The offset held to `max` metres, its direction kept. */
function limitOffset(offset: { east: number; north: number }, max: number): { east: number; north: number } {
  const length = Math.hypot(offset.east, offset.north);
  return length <= max || length === 0 ? offset : { east: (offset.east * max) / length, north: (offset.north * max) / length };
}

/**
 * A keyframe as the model can use it: its moment within the follow, its
 * values within their limits, and a follow offset that keeps the marker in
 * frame at its zoom and tilt.
 */
export function clampKeyframe(
  keyframe: CameraKeyframe,
  context: { timeline: MapVideoTimeline; route: MapVideoRoute; viewport: MapVideoViewport },
): CameraKeyframe {
  const { timeline, route, viewport } = context;
  const seconds = Math.min(timeline.introSeconds + timeline.followSeconds, Math.max(timeline.introSeconds, keyframe.seconds));
  const zoom = Math.min(17, Math.max(10, keyframe.zoom));
  const pitch = Math.min(60, Math.max(0, keyframe.pitch));
  const latitude = positionAt(route, timeline.at(seconds).distance).lat;
  const max = keyframe.mode === 'follow' ? maxFollowOffsetMeters(zoom, pitch, latitude, viewport) : MAX_FIXED_OFFSET_METERS;
  return {
    ...keyframe,
    seconds,
    zoom,
    pitch,
    bearing: keyframe.bearing === null ? null : ((keyframe.bearing % 360) + 360) % 360,
    offset: limitOffset(keyframe.offset, max),
  };
}

/** Keyframes in time order; two at the same moment keep the order they were given. */
export function sortKeyframes(keyframes: CameraKeyframe[]): CameraKeyframe[] {
  return keyframes.map((keyframe, index) => ({ keyframe, index })).sort((a, b) => a.keyframe.seconds - b.keyframe.seconds || a.index - b.index).map(({ keyframe }) => keyframe);
}

interface Stop {
  seconds: number;
  mode: 'follow' | 'fixed';
  offset: { east: number; north: number };
  zoom: number;
  pitch: number;
  bearing: number | null;
  /** For a fixed stop: where the camera stands. */
  anchor?: [number, number];
}

/**
 * The camera path with keyframes on top. With none, it is the follow camera
 * exactly. The intro and the outro fly from and to the overview as before,
 * meeting the keyframed camera where the follow starts and ends.
 */
export function withKeyframes(
  path: MapVideoCameraPath,
  keyframes: CameraKeyframe[],
  context: { timeline: MapVideoTimeline; route: MapVideoRoute; viewport: MapVideoViewport; settings: MapVideoCameraSettings },
): MapVideoCameraPath & { atSeconds: (seconds: number) => MapVideoCamera } {
  if (keyframes.length === 0) {
    const atSeconds = (seconds: number) => path.at(context.timeline.at(seconds));
    return { ...path, atSeconds };
  }
  const { timeline, route, viewport, settings } = context;
  const start = timeline.introSeconds;
  const end = timeline.introSeconds + timeline.followSeconds;
  const marker = (seconds: number): [number, number] => {
    const place = positionAt(route, timeline.at(seconds).distance);
    return [place.lon, place.lat];
  };
  const base = { mode: 'follow' as const, offset: { east: 0, north: 0 }, zoom: settings.zoom, pitch: settings.pitch, bearing: settings.bearing === 'north' ? 0 : null };
  const set = sortKeyframes(keyframes.map((keyframe) => clampKeyframe(keyframe, { timeline, route, viewport }))).map((keyframe): Stop => ({
    ...keyframe,
    ...(keyframe.mode === 'fixed' ? { anchor: offsetPlace(marker(keyframe.seconds), keyframe.offset) } : {}),
  }));
  // The follow camera's own values at either end, unless a keyframe is there already.
  const stops: Stop[] = [
    ...(set[0]!.seconds > start ? [{ ...base, seconds: start }] : []),
    ...set,
    ...(set[set.length - 1]!.seconds < end ? [{ ...base, seconds: end }] : []),
  ];

  const state = (stop: Stop, seconds: number): MapVideoCamera => {
    const follow = path.follow(timeline.at(seconds).distance);
    return {
      center: stop.anchor ?? offsetPlace(marker(seconds), stop.offset),
      zoom: stop.zoom,
      pitch: stop.pitch,
      bearing: stop.bearing ?? follow.bearing,
    };
  };

  const atSeconds = (seconds: number): MapVideoCamera => {
    const sample = timeline.at(seconds);
    if (sample.phase === 'intro') return blendCameras(path.overview, atSeconds(start), sample.phaseProgress);
    if (sample.phase === 'outro') return blendCameras(atSeconds(end), path.overview, sample.phaseProgress);
    if (stops.length === 1) return state(stops[0]!, seconds);
    let i = 0;
    while (i + 2 < stops.length && stops[i + 1]!.seconds <= seconds) i += 1;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const span = b.seconds - a.seconds;
    const t = span > 0 ? Math.min(1, Math.max(0, (seconds - a.seconds) / span)) : 1;
    const from = state(a, seconds);
    const to = state(b, seconds);
    // Eased in and out, the bearing the short way round (blendCameras).
    const camera = blendCameras(from, to, t);
    if (a.mode === 'follow' && b.mode === 'follow') {
      // Both ends keep the marker in frame; the blend must too, at the zoom and tilt it has reached.
      const here = marker(seconds);
      const max = maxFollowOffsetMeters(camera.zoom, camera.pitch, here[1], viewport);
      camera.center = offsetPlace(here, limitOffset(offsetBetween(here, camera.center), max));
    }
    return camera;
  };

  return {
    ...path,
    at: (sample: TimelineSample) => {
      // The sample alone does not say the moment; it is recovered from the phase.
      const seconds =
        sample.phase === 'intro'
          ? sample.phaseProgress * timeline.introSeconds
          : sample.phase === 'outro'
            ? end + sample.phaseProgress * timeline.outroSeconds
            : start + sample.phaseProgress * timeline.followSeconds;
      return atSeconds(seconds);
    },
    atSeconds,
  };
}
