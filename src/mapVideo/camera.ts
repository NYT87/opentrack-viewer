import { positionAt, type MapVideoRoute } from './route';
import type { TimelineSample } from './timing';

/**
 * AV-1203. Where the camera is for a moment of the video: pure, computed from
 * the route and the settings alone, so the preview and the export agree and a
 * frame never depends on what has loaded (TD-064).
 */

export interface MapVideoCameraSettings {
  /** The follow camera's zoom, MapLibre's scale. */
  zoom: number;
  /** Degrees from looking straight down, 0 to 60. */
  pitch: number;
  /** `follow` turns with the heading; `north` keeps north up. */
  bearing: 'follow' | 'north';
  /** Half the stretch the heading and the height are averaged over, in metres. */
  smoothingMeters: number;
}

export interface MapVideoCamera {
  center: [number, number];
  zoom: number;
  pitch: number;
  /** Degrees clockwise from north, 0 to 360. Over terrain the map holds the centre to the ground (TD-068). */
  bearing: number;
}

export interface MapVideoViewport {
  width: number;
  height: number;
}

/** The heading and height are sampled along the route this often. */
export const CAMERA_SAMPLE_METERS = 10;
/** The camera never turns faster than this, in degrees per metre of route. */
export const MAX_TURN_DEGREES_PER_METER = 0.5;
/** MapLibre's world is 512 pixels wide at zoom 0. */
const WORLD_PIXELS = 512;
const MAX_OVERVIEW_ZOOM = 17;

const toRadians = Math.PI / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
/** An angle in [0, 360). */
export const normalizeBearing = (degrees: number) => ((degrees % 360) + 360) % 360;
/** From `a` to `b` by the shorter way round. */
export const lerpBearing = (a: number, b: number, t: number) => normalizeBearing(a + ((((b - a) % 360) + 540) % 360 - 180) * t);

function headingDegrees(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const y = Math.sin((b.lon - a.lon) * toRadians) * Math.cos(b.lat * toRadians);
  const x =
    Math.cos(a.lat * toRadians) * Math.sin(b.lat * toRadians) -
    Math.sin(a.lat * toRadians) * Math.cos(b.lat * toRadians) * Math.cos((b.lon - a.lon) * toRadians);
  return Math.atan2(y, x) / toRadians;
}

const mercatorX = (lon: number) => (lon + 180) / 360;
const mercatorY = (lat: number) => {
  const sin = Math.sin(lat * toRadians);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
};
const lonOf = (x: number) => x * 360 - 180;
const latOf = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / toRadians;

/**
 * Samples taken once per route and settings. `bearings` are unwrapped (they
 * may run past 360) so neighbouring samples interpolate the short way.
 */
interface CameraSamples {
  bearings: number[];
}

/**
 * The heading at each sample: the route's direction averaged over
 * ±`smoothing` metres, nearer stretches weighing more, then held to
 * `MAX_TURN_DEGREES_PER_METER`. The average takes out GPS noise; the turn
 * limit takes a hairpin, where the average has no clear direction, as a
 * steady turn rather than a spin.
 */
function sampleCamera(route: MapVideoRoute, smoothing: number): CameraSamples {
  const count = Math.max(2, Math.ceil(route.totalMeters / CAMERA_SAMPLE_METERS) + 1);
  const step = route.totalMeters / (count - 1);
  const places = Array.from({ length: count }, (_, k) => positionAt(route, k * step));
  // The direction from each sample to the next, as a unit vector: chords a
  // sample apart rather than the edge a sample lands on, so one noisy fix
  // weighs no more than its share of the stretch. A chord across a gap
  // between segments has no direction.
  const east: number[] = [];
  const north: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const a = places[Math.min(k, count - 2)]!;
    const b = places[Math.min(k, count - 2) + 1]!;
    const across = route.vertices[a.index]!.segment !== route.vertices[b.index]!.segment;
    const heading = across || (a.lon === b.lon && a.lat === b.lat) ? Number.NaN : headingDegrees(a, b);
    east.push(Number.isNaN(heading) ? 0 : Math.sin(heading * toRadians));
    north.push(Number.isNaN(heading) ? 0 : Math.cos(heading * toRadians));
  }
  const reach = Math.max(0, Math.round(smoothing / Math.max(step, 1e-9)));
  const average = (values: number[], k: number) => {
    let sum = 0;
    let weights = 0;
    for (let j = Math.max(0, k - reach); j <= Math.min(count - 1, k + reach); j += 1) {
      const weight = reach === 0 ? 1 : 1 - Math.abs(j - k) / (reach + 1);
      sum += values[j]! * weight;
      weights += weight;
    }
    return weights > 0 ? sum / weights : 0;
  };

  const bearings: number[] = [];
  const maxTurn = MAX_TURN_DEGREES_PER_METER * step;
  for (let k = 0; k < count; k += 1) {
    const e = average(east, k);
    const n = average(north, k);
    const previous = bearings[k - 1];
    // No clear direction (a turn on the spot, a gap): keep the last heading.
    if (Math.hypot(e, n) < 1e-6) {
      bearings.push(previous ?? 0);
      continue;
    }
    const wanted = Math.atan2(e, n) / toRadians;
    if (previous === undefined) {
      bearings.push(normalizeBearing(wanted));
      continue;
    }
    const delta = ((((wanted - previous) % 360) + 540) % 360) - 180;
    bearings.push(previous + Math.max(-maxTurn, Math.min(maxTurn, delta)));
  }
  return { bearings };
}

export interface MapVideoCameraPath {
  /** The follow camera at a distance along the route. */
  follow: (distance: number) => MapVideoCamera;
  /** The whole route in view, north up, looking down. */
  overview: MapVideoCamera;
  /** The camera for a moment of the video. */
  at: (sample: TimelineSample) => MapVideoCamera;
}

/** The zoom and centre that fit the route in the frame, leaving `padding` pixels at each edge. */
export function overviewCamera(route: MapVideoRoute, viewport: MapVideoViewport): MapVideoCamera {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const vertex of route.vertices) {
    const x = mercatorX(vertex.lon);
    const y = mercatorY(vertex.lat);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const padding = Math.round(Math.min(viewport.width, viewport.height) * 0.08);
  const fit = (pixels: number, span: number) => (span > 0 ? Math.log2((pixels - 2 * padding) / (span * WORLD_PIXELS)) : MAX_OVERVIEW_ZOOM);
  const zoom = Math.min(MAX_OVERVIEW_ZOOM, fit(viewport.width, maxX - minX), fit(viewport.height, maxY - minY));
  return { center: [lonOf((minX + maxX) / 2), latOf((minY + maxY) / 2)], zoom, pitch: 0, bearing: 0 };
}

/** Between two cameras, eased; the centre moves in the map's own projection. */
export function blendCameras(a: MapVideoCamera, b: MapVideoCamera, t: number): MapVideoCamera {
  const k = ease(Math.min(1, Math.max(0, t)));
  return {
    center: [
      lonOf(lerp(mercatorX(a.center[0]), mercatorX(b.center[0]), k)),
      latOf(lerp(mercatorY(a.center[1]), mercatorY(b.center[1]), k)),
    ],
    zoom: lerp(a.zoom, b.zoom, k),
    pitch: lerp(a.pitch, b.pitch, k),
    bearing: lerpBearing(a.bearing, b.bearing, k),
  };
}

/** The camera path for a route. */
export function buildCameraPath(route: MapVideoRoute, settings: MapVideoCameraSettings, viewport: MapVideoViewport): MapVideoCameraPath {
  const samples = sampleCamera(route, Math.max(0, settings.smoothingMeters));
  const count = samples.bearings.length;
  const step = route.totalMeters / (count - 1);
  const pitch = Math.min(60, Math.max(0, settings.pitch));
  const sampleAt = (values: number[], distance: number) => {
    const x = Math.min(count - 1, Math.max(0, distance / step));
    const k = Math.min(count - 2, Math.floor(x));
    return lerp(values[k]!, values[k + 1]!, x - k);
  };

  const follow = (distance: number): MapVideoCamera => {
    const place = positionAt(route, distance);
    const camera: MapVideoCamera = {
      center: [place.lon, place.lat],
      zoom: settings.zoom,
      pitch,
      bearing: settings.bearing === 'north' ? 0 : normalizeBearing(sampleAt(samples.bearings, place.distance)),
    };
    return camera;
  };
  const overview = overviewCamera(route, viewport);
  const start = follow(0);
  const end = follow(route.totalMeters);

  return {
    follow,
    overview,
    at: (sample) => {
      if (sample.phase === 'intro') return blendCameras(overview, start, sample.phaseProgress);
      if (sample.phase === 'outro') return blendCameras(end, overview, sample.phaseProgress);
      return follow(sample.distance);
    },
  };
}
