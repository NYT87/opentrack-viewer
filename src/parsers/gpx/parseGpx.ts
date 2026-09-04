import {
  computeStreams,
  isPlausibleSpeed,
  type Activity,
  type ActivityDeviceInfo,
  type ActivityPoint,
  type ActivitySport,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';
import { withDerivedStats } from '../../domain/stats';
import type { RawGpxDocument, RawGpxPoint } from './gpxTypes';

export const GPX_PARSER_VERSION = '1.0.0';

export interface ParseGpxOptions {
  fileName?: string;
  fileSizeBytes?: number;
  /** Injectable so tests can run without a DOM-provided DOMParser. */
  domParser?: DOMParser;
  /** Overridable for deterministic ids in tests. */
  idFactory?: () => string;
}

/**
 * AV-201 / AV-202. Parses GPX XML into the normalized Activity model.
 *
 * Runs entirely in the browser via DOMParser — the text never leaves the
 * device. Malformed *points* are skipped with warnings; only a document that
 * cannot be read as GPX at all is a hard failure (plan §15).
 */
export function parseGpx(xml: string, options: ParseGpxOptions = {}): Activity {
  const warnings: ActivityWarning[] = [];
  const document = parseDocument(xml, options.domParser);
  const raw = readGpxDocument(document, warnings);

  if (raw.points.length === 0) {
    throw new ActivityError('no_route_points', 'No <trkpt> or <rtept> elements were found.');
  }

  const sport = mapSport(raw.type);
  const points = normalizePoints(raw.points, warnings, sport);
  const streams = computeStreams(points);

  if (raw.segmentCount > 1) {
    warnings.push({
      code: 'multiple_segments',
      message:
        `This recording has ${raw.segmentCount} segments. Each is drawn as its own line, ` +
        'and the gaps between them are not counted towards the distance.',
      severity: 'info',
    });
  }

  const activity: Activity = {
    id: (options.idFactory ?? defaultId)(),
    source: {
      format: 'gpx',
      fileName: options.fileName,
      fileSizeBytes: options.fileSizeBytes,
      parserVersion: GPX_PARSER_VERSION,
    },
    metadata: {
      name: raw.name,
      description: raw.description,
      creator: raw.creator,
      deviceName: raw.creator,
      device: raw.device,
      sport,
    },
    points,
    streams,
    warnings,
  };

  const withStats = withDerivedStats(activity);
  withStats.metadata.startTime = withStats.derived?.startTime;
  withStats.metadata.endTime = withStats.derived?.endTime;
  return withStats;
}

/** Convenience wrapper matching the async parser contract used by intake. */
export async function parseGpxFile(file: File): Promise<Activity> {
  const text = await file.text();
  return parseGpx(text, { fileName: file.name, fileSizeBytes: file.size });
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `activity-${Date.now()}`;
}

function parseDocument(xml: string, injected?: DOMParser): Document {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new ActivityError('invalid_gpx_xml', 'The file is empty.');
  }
  const parser = injected ?? new DOMParser();
  const document = parser.parseFromString(xml, 'application/xml');

  // DOMParser reports XML errors as a <parsererror> element rather than throwing.
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new ActivityError('invalid_gpx_xml', 'The file is not well-formed XML.');
  }
  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase().replace(/^.*:/, '') !== 'gpx') {
    throw new ActivityError('invalid_gpx_xml', 'The document root is not <gpx>.');
  }
  return document;
}

/** Namespace-agnostic child lookup: GPX extensions use many prefixes. */
function localName(element: Element): string {
  return (element.localName || element.nodeName).toLowerCase().replace(/^.*:/, '');
}

function childrenNamed(parent: Element | Document, name: string): Element[] {
  const target = name.toLowerCase();
  const result: Element[] = [];
  for (const child of Array.from(parent.children ?? [])) {
    if (localName(child) === target) result.push(child);
  }
  return result;
}

function firstNamed(parent: Element | Document, name: string): Element | undefined {
  return childrenNamed(parent, name)[0];
}

function textOf(parent: Element | Document | undefined, name: string): string | undefined {
  if (!parent) return undefined;
  const element = firstNamed(parent, name);
  const text = element?.textContent?.trim();
  return text ? text : undefined;
}

function readGpxDocument(document: Document, warnings: ActivityWarning[]): RawGpxDocument {
  const root = document.documentElement;
  const metadata = firstNamed(root, 'metadata');
  // A GPX file may carry several <trk> elements. Reading only the first would
  // silently discard the rest of a valid recording.
  const tracks = childrenNamed(root, 'trk');
  const firstTrack = tracks[0];

  const points: RawGpxPoint[] = [];
  let segmentCount = 0;

  for (const track of tracks) {
    for (const segment of childrenNamed(track, 'trkseg')) {
      const segmentIndex = segmentCount;
      segmentCount += 1;
      for (const trkpt of childrenNamed(segment, 'trkpt')) {
        points.push(readPoint(trkpt, segmentIndex));
      }
    }
  }

  if (tracks.length > 1) {
    warnings.push({
      code: 'multiple_tracks',
      message:
        `The file contains ${tracks.length} tracks, shown as one activity. ` +
        'The gaps between them are not counted towards the distance.',
      severity: 'info',
    });
  }

  // Fall back to <rte>/<rtept> for planned routes with no recorded track.
  if (points.length === 0) {
    const routes = childrenNamed(root, 'rte');

    for (const route of routes) {
      const rtepts = childrenNamed(route, 'rtept');
      if (rtepts.length === 0) continue;
      const segmentIndex = segmentCount;
      segmentCount += 1;
      for (const rtept of rtepts) {
        points.push(readPoint(rtept, segmentIndex));
      }
    }

    if (points.length > 0) {
      warnings.push({
        code: 'route_instead_of_track',
        message: 'No recorded track found; showing the planned route (<rte>) instead.',
        severity: 'info',
      });
      if (segmentCount > 1) {
        warnings.push({
          code: 'multiple_routes',
          message:
            `The file contains ${segmentCount} routes, shown as one activity. ` +
            'The gaps between them are not counted towards the distance.',
          severity: 'info',
        });
      }
    }
  }

  return {
    device: readDeviceInfo(root),
    // Activity-level metadata comes from the first track; later tracks in a
    // multi-track file are treated as continuations of the same activity.
    name: textOf(firstTrack, 'name') ?? textOf(metadata, 'name'),
    description: textOf(firstTrack, 'desc') ?? textOf(metadata, 'desc'),
    creator: root.getAttribute('creator') ?? undefined,
    type: textOf(firstTrack, 'type'),
    points,
    segmentCount,
  };
}

/**
 * AV-202. Reads whatever device information the file actually states.
 *
 * The GPX `creator` attribute names the thing that wrote the file, which may be
 * a device ("Garmin Edge 530") or an application ("StravaGPX Android"). There
 * is no reliable way to tell them apart, so it is recorded verbatim as `name`
 * and the UI labels it "Recorded with" rather than claiming a hardware model
 * (§17 open question resolved). Structured fields are populated only when the
 * file spells them out in an extension.
 */
function readDeviceInfo(root: Element): ActivityDeviceInfo | undefined {
  const device: ActivityDeviceInfo = {};

  const creator = root.getAttribute('creator')?.trim();
  if (creator) {
    device.name = creator;
    device.source = 'gpx_creator';
  }

  const walk = (element: Element): void => {
    for (const child of Array.from(element.children)) {
      const value = child.textContent?.trim();
      if (value) {
        switch (localName(child)) {
          case 'manufacturer':
            device.manufacturer ??= value;
            break;
          case 'model':
            device.model ??= value;
            break;
          case 'product':
            device.product ??= value;
            break;
          case 'serial':
          case 'serialnumber':
            device.serialNumber ??= value;
            break;
          case 'softwareversion':
            device.softwareVersion ??= value;
            break;
          case 'firmwareversion':
            device.firmwareVersion ??= value;
            break;
          default:
            break;
        }
      }
      if (child.children.length > 0) walk(child);
    }
  };

  // Device details live under <metadata> or a top-level <extensions> block.
  const metadata = firstNamed(root, 'metadata');
  if (metadata) walk(metadata);
  const extensions = firstNamed(root, 'extensions');
  if (extensions) walk(extensions);

  if (Object.keys(device).some((key) => key !== 'source')) {
    if (device.manufacturer || device.model || device.product || device.serialNumber) {
      device.source = 'gpx_extension';
    }
    return device;
  }
  return undefined;
}

function readPoint(element: Element, segmentIndex: number): RawGpxPoint {
  const point: RawGpxPoint = {
    lat: parseNumber(element.getAttribute('lat')),
    lon: parseNumber(element.getAttribute('lon')),
    elevationMeters: parseNumber(textOf(element, 'ele')),
    time: parseDate(textOf(element, 'time')),
    segmentIndex,
  };

  const extensions = firstNamed(element, 'extensions');
  if (extensions) readExtensions(extensions, point);
  return point;
}

/**
 * Reads Garmin TrackPointExtension and similar sensor extensions. The nesting
 * varies by device, so this walks the subtree by local name rather than
 * matching a fixed schema.
 */
function readExtensions(extensions: Element, point: RawGpxPoint): void {
  const walk = (element: Element): void => {
    for (const child of Array.from(element.children)) {
      const name = localName(child);
      const value = child.textContent?.trim();
      switch (name) {
        case 'hr':
        case 'heartrate':
          point.heartRateBpm = parseNumber(value);
          break;
        case 'cad':
        case 'cadence':
          point.cadence = parseNumber(value);
          break;
        case 'power':
        case 'watts':
          point.powerWatts = parseNumber(value);
          break;
        case 'atemp':
        case 'temp':
        case 'temperature':
          point.temperatureCelsius = parseNumber(value);
          break;
        case 'speed':
          point.speedMetersPerSecond = parseNumber(value);
          break;
        default:
          break;
      }
      if (child.children.length > 0) walk(child);
    }
  };
  walk(extensions);
}

function parseNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Sports whose cadence is strokes per minute — a unit this viewer has no field for. */
const STROKE_CADENCE_SPORTS: ReadonlySet<ActivitySport> = new Set(['swimming', 'rowing']);

function mapSport(type: string | undefined): ActivitySport {
  if (!type) return 'unknown';
  const normalized = type.toLowerCase();
  if (normalized.includes('run')) return 'running';
  if (normalized.includes('bike') || normalized.includes('cycl')) return 'cycling';
  if (normalized.includes('hik')) return 'hiking';
  if (normalized.includes('walk')) return 'walking';
  if (normalized.includes('swim')) return 'swimming';
  if (normalized.includes('ski')) return 'skiing';
  if (normalized.includes('row')) return 'rowing';
  return 'other';
}

/**
 * Assigns stable indices and reports points that had to be dropped.
 *
 * AV-515: GPX states a cadence number but never its unit, so the declared
 * sport decides which field it belongs in. A cycling track's cadence is pedal
 * revolutions; a walk, hike or run reports foot cadence in strides per minute.
 *
 * A swim or a row reports *strokes* per minute, which is neither — this viewer
 * has no field for it, so that number is dropped rather than filed under a unit
 * it does not have. Sports that never say what they are keep foot cadence: an
 * untyped GPX is the common case, and a step count is the overwhelmingly likely
 * meaning.
 */
function normalizePoints(
  raw: RawGpxPoint[],
  warnings: ActivityWarning[],
  sport: ActivitySport,
): ActivityPoint[] {
  const points: ActivityPoint[] = [];
  let missingCoordinates = 0;
  let missingElevation = 0;
  let missingTime = 0;

  for (const item of raw) {
    const hasCoordinates =
      Number.isFinite(item.lat) &&
      Number.isFinite(item.lon) &&
      (item.lat as number) >= -90 &&
      (item.lat as number) <= 90 &&
      (item.lon as number) >= -180 &&
      (item.lon as number) <= 180;

    if (!hasCoordinates) missingCoordinates += 1;
    if (!Number.isFinite(item.elevationMeters)) missingElevation += 1;
    if (!item.time) missingTime += 1;

    const point: ActivityPoint = { index: points.length, segmentIndex: item.segmentIndex };
    if (hasCoordinates) {
      point.lat = item.lat;
      point.lon = item.lon;
    }
    if (Number.isFinite(item.elevationMeters)) point.elevationMeters = item.elevationMeters;
    if (item.time) point.time = item.time;
    if (Number.isFinite(item.heartRateBpm)) point.heartRateBpm = item.heartRateBpm;
    if (Number.isFinite(item.cadence)) {
      if (sport === 'cycling') point.cyclingCadenceRpm = item.cadence;
      else if (!STROKE_CADENCE_SPORTS.has(sport)) point.runningCadenceSpm = item.cadence;
    }
    if (Number.isFinite(item.powerWatts)) point.powerWatts = item.powerWatts;
    if (Number.isFinite(item.temperatureCelsius)) {
      point.temperatureCelsius = item.temperatureCelsius;
    }
    // A negative or absurd <gpxtpx:speed> is a device fault: dropping it here
    // keeps the value out of the model entirely, so speed is derived from
    // positions instead of plotting the fault.
    if (isPlausibleSpeed(item.speedMetersPerSecond)) {
      point.speedMetersPerSecond = item.speedMetersPerSecond;
    }
    points.push(point);
  }

  if (missingCoordinates > 0) {
    warnings.push({
      code: 'points_missing_coordinates',
      message: `${missingCoordinates} of ${raw.length} points had no usable coordinates and are not drawn.`,
      severity: missingCoordinates === raw.length ? 'warning' : 'info',
    });
  }
  if (missingElevation === raw.length) {
    warnings.push({
      code: 'no_elevation_data',
      message: 'No elevation values were present in this file.',
      severity: 'info',
    });
  }
  if (missingTime === raw.length) {
    warnings.push({
      code: 'no_time_data',
      message: 'No timestamps were present in this file.',
      severity: 'info',
    });
  }

  return points;
}
