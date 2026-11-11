import type { Activity } from '../domain/activity';
import { parseOverlayTemplate, type OverlayTemplate } from '../overlay/template';
import type { MapVideoCameraSettings } from './camera';
import { MAX_FIXED_OFFSET_METERS, MAX_KEYFRAMES, type CameraKeyframe } from './keyframes';
import type { MapVideoTimingMode } from './timing';

/**
 * AV-1203. A map video as the reader sets it up: a project, saved and opened
 * as JSON like the overlay layout file (TD-061). It holds the settings and a
 * reference to the activity they were made for — its file name and point
 * count, to say so when a different one is open — and nothing of the activity
 * itself: no place, no time, no figure. A style URL or key the reader supplies
 * is never written into it (TD-064).
 */

export const MAP_VIDEO_PROJECT_KIND = 'opentrack-map-video';
export const MAP_VIDEO_PROJECT_VERSION = 1;
export const MAP_VIDEO_PROJECT_MAX_BYTES = 256 * 1024;

export type MapVideoBasemapStyle = 'liberty' | 'positron' | 'bright' | 'dark';
export const MAP_VIDEO_BASEMAP_STYLES: readonly MapVideoBasemapStyle[] = ['liberty', 'positron', 'bright', 'dark'];

/** MapTiler's maps, drawn with the reader's own key (TD-064): satellite is only offered this way. */
export type MapTilerStyle = 'satellite' | 'hybrid' | 'outdoor-v2' | 'streets-v2';
export const MAPTILER_STYLES: readonly MapTilerStyle[] = ['satellite', 'hybrid', 'outdoor-v2', 'streets-v2'];

/** `online` is OpenFreeMap; `maptiler` needs the reader's key; `route-only` fetches nothing. */
export type MapVideoBasemapSource = 'online' | 'maptiler' | 'route-only';
export const MAP_VIDEO_BASEMAP_SOURCES: readonly MapVideoBasemapSource[] = ['online', 'maptiler', 'route-only'];

/** What the route's colour shows: one colour, or how a recorded value changes along it. */
export type MapVideoColorBy = 'none' | 'speed' | 'elevation' | 'heartRate';
export const MAP_VIDEO_COLOR_BY: readonly MapVideoColorBy[] = ['none', 'speed', 'elevation', 'heartRate'];

export type MapVideoMarkerShape = 'dot' | 'arrow' | 'sport';
export const MAP_VIDEO_MARKER_SHAPES: readonly MapVideoMarkerShape[] = ['dot', 'arrow', 'sport'];

export interface MapVideoSettings {
  output: { width: number; height: number; fps: number };
  lengthSeconds: number;
  timing: { mode: MapVideoTimingMode; pauseBeatSeconds: number };
  intro: { enabled: boolean; seconds: number };
  outro: { enabled: boolean; seconds: number };
  /**
   * `online` draws OpenFreeMap's style; `maptiler` MapTiler's, with a key the
   * reader types, which is held in memory and never written here; `route-only`
   * fetches nothing (TD-064).
   */
  basemap: { source: MapVideoBasemapSource; style: MapVideoBasemapStyle; maptilerStyle: MapTilerStyle };
  terrain: { enabled: boolean; exaggeration: number };
  camera: MapVideoCameraSettings;
  route: {
    color: string;
    width: number;
    casing: boolean;
    casingColor: string;
    unrevealed: 'dimmed' | 'hidden';
    colorBy: MapVideoColorBy;
  };
  marker: { shape: MapVideoMarkerShape; size: number; color: string; trail: boolean };
  /** Start and finish flags, at the ends of the route as trimmed. */
  endpoints: { shown: boolean };
  /** Hidden from the line, the marker, the camera and the figures (`trimRoute`). */
  privacyTrim: { startMeters: number; endMeters: number };
  /** Figures and graphics over the map (AV-1207); none until then. */
  overlay: OverlayTemplate | null;
  /** The reader's camera keyframes (AV-1206), over the follow camera. Offsets, never places. */
  keyframes: CameraKeyframe[];
  /** AV-1207. The activity's totals on a card through the outro. */
  summaryCard: { enabled: boolean };
}

export interface MapVideoActivityReference {
  /** The file the project was made for, as the reader named it. */
  fileName: string | null;
  points: number;
}

export interface MapVideoProject {
  activity: MapVideoActivityReference;
  settings: MapVideoSettings;
}

/** The limits TD-064 set. */
export const MAP_VIDEO_LIMITS = {
  minLengthSeconds: 5,
  maxLengthSeconds: 180,
  /** At more than 1080p's pixels, the video is held to a minute. */
  maxLengthSecondsAbove1080p: 60,
  fps: [30, 60] as readonly number[],
  /** 60 fps only up to 1080p's pixels. */
  maxPixelsAt60: 1920 * 1080,
  minSide: 320,
  maxSide: 4096,
  maxPixels: 3840 * 2160,
  phaseSeconds: [0.5, 10] as const,
  pauseBeatSeconds: [0.2, 3] as const,
  zoom: [10, 17] as const,
  pitch: [0, 60] as const,
  smoothingMeters: [50, 2000] as const,
  exaggeration: [1, 3] as const,
  routeWidth: [1, 24] as const,
  markerSize: [6, 48] as const,
  trimMeters: [0, 5000] as const,
} as const;

export const DEFAULT_MAP_VIDEO_SETTINGS: MapVideoSettings = {
  output: { width: 1920, height: 1080, fps: 30 },
  lengthSeconds: 30,
  timing: { mode: 'distance', pauseBeatSeconds: 0.6 },
  intro: { enabled: true, seconds: 2 },
  outro: { enabled: true, seconds: 3 },
  basemap: { source: 'online', style: 'liberty', maptilerStyle: 'satellite' },
  terrain: { enabled: false, exaggeration: 1.5 },
  camera: { zoom: 14.5, pitch: 45, bearing: 'follow', smoothingMeters: 300 },
  route: { color: '#ff5533', width: 6, casing: true, casingColor: '#1a1a1a', unrevealed: 'dimmed', colorBy: 'none' },
  marker: { shape: 'dot', size: 18, color: '#ff5533', trail: false },
  endpoints: { shown: true },
  privacyTrim: { startMeters: 0, endMeters: 0 },
  overlay: null,
  keyframes: [],
  summaryCard: { enabled: true },
};

/** The reference a project keeps to an activity: its file name and point count. */
export function referenceActivity(activity: Activity): MapVideoActivityReference {
  return { fileName: activity.source.fileName ?? null, points: activity.points.length };
}

/** Whether a project was made for this activity, as far as its reference can tell. */
export function isProjectFor(project: MapVideoProject, activity: Activity): boolean {
  const reference = referenceActivity(activity);
  return reference.points === project.activity.points && reference.fileName === project.activity.fileName;
}

/** Why an output size or length cannot be used, or undefined when it can. */
export function outputProblem(settings: Pick<MapVideoSettings, 'output' | 'lengthSeconds'>): string | undefined {
  const { width, height, fps } = settings.output;
  const limits = MAP_VIDEO_LIMITS;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return 'The size must be whole pixels.';
  // H.264 and VP9 encode in blocks of two pixels.
  if (width % 2 !== 0 || height % 2 !== 0) return 'Each side must be an even number of pixels.';
  if (Math.min(width, height) < limits.minSide || Math.max(width, height) > limits.maxSide) {
    return `Each side must be between ${limits.minSide} and ${limits.maxSide} pixels.`;
  }
  if (width * height > limits.maxPixels) return 'The size is larger than 4K (3840 × 2160 pixels).';
  if (!limits.fps.includes(fps)) return 'The frame rate must be 30 or 60 frames a second.';
  if (fps === 60 && width * height > limits.maxPixelsAt60) return '60 frames a second is offered up to 1080p.';
  const max = width * height > limits.maxPixelsAt60 ? limits.maxLengthSecondsAbove1080p : limits.maxLengthSeconds;
  if (!(settings.lengthSeconds >= limits.minLengthSeconds && settings.lengthSeconds <= max)) {
    return `The length must be between ${limits.minLengthSeconds} seconds and ${max === 60 ? '1 minute above 1080p' : '3 minutes'}.`;
  }
  return undefined;
}

export function serializeMapVideoProject(project: MapVideoProject): string {
  return JSON.stringify(
    { kind: MAP_VIDEO_PROJECT_KIND, version: MAP_VIDEO_PROJECT_VERSION, activity: project.activity, settings: project.settings },
    null,
    2,
  );
}

export type ParseMapVideoProjectResult =
  | { ok: true; project: MapVideoProject; warnings: string[] }
  | { ok: false; error: string };

class FieldError extends Error {}

/** Reads one field: a value of the right kind within its range, or the default when absent. */
function read(raw: Record<string, unknown> | undefined, key: string, path: string) {
  const value = raw?.[key];
  const name = `${path}.${key}`;
  return {
    number(fallback: number, [min, max]: readonly [number, number]): number {
      if (value === undefined) return fallback;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new FieldError(`${name} must be a number from ${min} to ${max}.`);
      }
      return value;
    },
    boolean(fallback: boolean): boolean {
      if (value === undefined) return fallback;
      if (typeof value !== 'boolean') throw new FieldError(`${name} must be true or false.`);
      return value;
    },
    oneOf<T extends string | number>(fallback: T, options: readonly T[]): T {
      if (value === undefined) return fallback;
      if (!options.includes(value as T)) throw new FieldError(`${name} must be one of ${options.join(', ')}.`);
      return value as T;
    },
    color(fallback: string): string {
      if (value === undefined) return fallback;
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new FieldError(`${name} must be a colour like #ff5533.`);
      return value.toLowerCase();
    },
  };
}

function section(raw: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = raw?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new FieldError(`settings.${key} must be an object.`);
  return value as Record<string, unknown>;
}

const KNOWN_SECTIONS = ['output', 'lengthSeconds', 'timing', 'intro', 'outro', 'basemap', 'terrain', 'camera', 'route', 'marker', 'endpoints', 'privacyTrim', 'overlay', 'keyframes', 'summaryCard'];

/** The keyframes of a project, each checked like any other setting. */
function readKeyframes(raw: unknown, L: typeof MAP_VIDEO_LIMITS): CameraKeyframe[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FieldError('settings.keyframes must be a list.');
  if (raw.length > MAX_KEYFRAMES) throw new FieldError(`settings.keyframes holds more than ${MAX_KEYFRAMES} keyframes.`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const path = `settings.keyframes[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new FieldError(`${path} must be an object.`);
    const k = entry as Record<string, unknown>;
    if (typeof k.id !== 'string' || k.id.length === 0 || k.id.length > 40 || seen.has(k.id)) throw new FieldError(`${path}.id must be a short text, used once.`);
    seen.add(k.id);
    const offset = (typeof k.offset === 'object' && k.offset !== null ? k.offset : undefined) as Record<string, unknown> | undefined;
    if (!offset) throw new FieldError(`${path}.offset is missing.`);
    if (k.bearing !== null && (typeof k.bearing !== 'number' || !Number.isFinite(k.bearing) || k.bearing < 0 || k.bearing >= 360)) {
      throw new FieldError(`${path}.bearing must be a number from 0 to 360, or null to follow the route.`);
    }
    return {
      id: k.id,
      seconds: read(k, 'seconds', path).number(Number.NaN, [0, L.maxLengthSeconds]),
      mode: read(k, 'mode', path).oneOf<'follow' | 'fixed'>('follow', ['follow', 'fixed']),
      offset: {
        east: read(offset, 'east', `${path}.offset`).number(0, [-MAX_FIXED_OFFSET_METERS, MAX_FIXED_OFFSET_METERS]),
        north: read(offset, 'north', `${path}.offset`).number(0, [-MAX_FIXED_OFFSET_METERS, MAX_FIXED_OFFSET_METERS]),
      },
      zoom: read(k, 'zoom', path).number(Number.NaN, L.zoom),
      pitch: read(k, 'pitch', path).number(Number.NaN, L.pitch),
      bearing: k.bearing as number | null,
    };
  }).map((keyframe, index) => {
    if (Number.isNaN(keyframe.seconds) || Number.isNaN(keyframe.zoom) || Number.isNaN(keyframe.pitch)) {
      throw new FieldError(`settings.keyframes[${index}] needs its seconds, zoom and pitch.`);
    }
    return keyframe;
  });
}

/**
 * Opens a project file. The kind, version and size are checked, and every
 * setting is checked against its limits: a value out of range is refused by
 * name rather than quietly changed. A section left out takes its default; an
 * unknown one is left out with a warning, so a later version's file says what
 * it lost.
 */
export function parseMapVideoProject(json: string): ParseMapVideoProjectResult {
  if (json.length > MAP_VIDEO_PROJECT_MAX_BYTES) return { ok: false, error: 'This file is too large to be a map video project.' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'This file is not valid JSON, so it is not a map video project.' };
  }
  if (typeof raw !== 'object' || raw === null || (raw as { kind?: unknown }).kind !== MAP_VIDEO_PROJECT_KIND) {
    return { ok: false, error: 'This file is not an OpenTrack map video project.' };
  }
  const file = raw as { version?: unknown; activity?: unknown; settings?: unknown };
  if (file.version !== MAP_VIDEO_PROJECT_VERSION) {
    return { ok: false, error: `This project is version ${String(file.version)}, which this app cannot read.` };
  }

  const warnings: string[] = [];
  try {
    const activityRaw = file.activity as { fileName?: unknown; points?: unknown } | undefined;
    if (typeof activityRaw !== 'object' || activityRaw === null) throw new FieldError('activity is missing.');
    const fileName = activityRaw.fileName ?? null;
    if (fileName !== null && typeof fileName !== 'string') throw new FieldError('activity.fileName must be text.');
    const points = activityRaw.points;
    if (typeof points !== 'number' || !Number.isInteger(points) || points < 0) throw new FieldError('activity.points must be a whole number.');

    if (typeof file.settings !== 'object' || file.settings === null || Array.isArray(file.settings)) throw new FieldError('settings is missing.');
    const s = file.settings as Record<string, unknown>;
    for (const key of Object.keys(s)) if (!KNOWN_SECTIONS.includes(key)) warnings.push(`The setting "${key}" is not known to this version and was left out.`);
    const d = DEFAULT_MAP_VIDEO_SETTINGS;
    const L = MAP_VIDEO_LIMITS;
    const output = section(s, 'output');
    const timing = section(s, 'timing');
    const intro = section(s, 'intro');
    const outro = section(s, 'outro');
    const basemap = section(s, 'basemap');
    const terrain = section(s, 'terrain');
    const camera = section(s, 'camera');
    const route = section(s, 'route');
    const trim = section(s, 'privacyTrim');
    const marker = section(s, 'marker');
    const endpoints = section(s, 'endpoints');

    const settings: MapVideoSettings = {
      output: {
        width: read(output, 'width', 'settings.output').number(d.output.width, [L.minSide, L.maxSide]),
        height: read(output, 'height', 'settings.output').number(d.output.height, [L.minSide, L.maxSide]),
        fps: read(output, 'fps', 'settings.output').oneOf(d.output.fps, L.fps),
      },
      lengthSeconds: read(s, 'lengthSeconds', 'settings').number(d.lengthSeconds, [L.minLengthSeconds, L.maxLengthSeconds]),
      timing: {
        mode: read(timing, 'mode', 'settings.timing').oneOf<MapVideoTimingMode>(d.timing.mode, ['distance', 'time']),
        pauseBeatSeconds: read(timing, 'pauseBeatSeconds', 'settings.timing').number(d.timing.pauseBeatSeconds, L.pauseBeatSeconds),
      },
      intro: {
        enabled: read(intro, 'enabled', 'settings.intro').boolean(d.intro.enabled),
        seconds: read(intro, 'seconds', 'settings.intro').number(d.intro.seconds, L.phaseSeconds),
      },
      outro: {
        enabled: read(outro, 'enabled', 'settings.outro').boolean(d.outro.enabled),
        seconds: read(outro, 'seconds', 'settings.outro').number(d.outro.seconds, L.phaseSeconds),
      },
      basemap: {
        source: read(basemap, 'source', 'settings.basemap').oneOf(d.basemap.source, MAP_VIDEO_BASEMAP_SOURCES),
        style: read(basemap, 'style', 'settings.basemap').oneOf(d.basemap.style, MAP_VIDEO_BASEMAP_STYLES),
        maptilerStyle: read(basemap, 'maptilerStyle', 'settings.basemap').oneOf(d.basemap.maptilerStyle, MAPTILER_STYLES),
      },
      terrain: {
        enabled: read(terrain, 'enabled', 'settings.terrain').boolean(d.terrain.enabled),
        exaggeration: read(terrain, 'exaggeration', 'settings.terrain').number(d.terrain.exaggeration, L.exaggeration),
      },
      camera: {
        zoom: read(camera, 'zoom', 'settings.camera').number(d.camera.zoom, L.zoom),
        pitch: read(camera, 'pitch', 'settings.camera').number(d.camera.pitch, L.pitch),
        bearing: read(camera, 'bearing', 'settings.camera').oneOf<'follow' | 'north'>(d.camera.bearing, ['follow', 'north']),
        smoothingMeters: read(camera, 'smoothingMeters', 'settings.camera').number(d.camera.smoothingMeters, L.smoothingMeters),
      },
      route: {
        color: read(route, 'color', 'settings.route').color(d.route.color),
        width: read(route, 'width', 'settings.route').number(d.route.width, L.routeWidth),
        casing: read(route, 'casing', 'settings.route').boolean(d.route.casing),
        casingColor: read(route, 'casingColor', 'settings.route').color(d.route.casingColor),
        unrevealed: read(route, 'unrevealed', 'settings.route').oneOf<'dimmed' | 'hidden'>(d.route.unrevealed, ['dimmed', 'hidden']),
        colorBy: read(route, 'colorBy', 'settings.route').oneOf(d.route.colorBy, MAP_VIDEO_COLOR_BY),
      },
      marker: {
        shape: read(marker, 'shape', 'settings.marker').oneOf(d.marker.shape, MAP_VIDEO_MARKER_SHAPES),
        size: read(marker, 'size', 'settings.marker').number(d.marker.size, L.markerSize),
        color: read(marker, 'color', 'settings.marker').color(d.marker.color),
        trail: read(marker, 'trail', 'settings.marker').boolean(d.marker.trail),
      },
      endpoints: { shown: read(endpoints, 'shown', 'settings.endpoints').boolean(d.endpoints.shown) },
      privacyTrim: {
        startMeters: read(trim, 'startMeters', 'settings.privacyTrim').number(d.privacyTrim.startMeters, L.trimMeters),
        endMeters: read(trim, 'endMeters', 'settings.privacyTrim').number(d.privacyTrim.endMeters, L.trimMeters),
      },
      overlay: null,
      keyframes: [],
      summaryCard: { enabled: read(section(s, 'summaryCard'), 'enabled', 'settings.summaryCard').boolean(d.summaryCard.enabled) },
    };
    settings.keyframes = readKeyframes(s.keyframes, L);
    const problem = outputProblem(settings);
    if (problem) throw new FieldError(problem);
    if (s.overlay !== undefined && s.overlay !== null) {
      const overlay = parseOverlayTemplate(JSON.stringify(s.overlay));
      if (!overlay.ok) throw new FieldError(`The figures over the map cannot be read. ${overlay.error}`);
      settings.overlay = overlay.template;
      warnings.push(...overlay.warnings);
    }
    return { ok: true, project: { activity: { fileName, points }, settings }, warnings };
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, error: `This project cannot be opened: ${error.message}` };
    throw error;
  }
}
