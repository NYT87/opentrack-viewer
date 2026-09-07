import {
  computeStreams,
  isPlausibleSpeed,
  toValidCoordinate,
  type Activity,
  type ActivityDeviceInfo,
  type ActivityLap,
  type ActivityPoint,
  type ActivitySport,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';
import { withDerivedStats } from '../../domain/stats';

export const TCX_PARSER_VERSION = '1.0.0';

export interface ParseTcxOptions {
  fileName?: string;
  fileSizeBytes?: number;
  /** Injectable so tests can run without a DOM-provided DOMParser. */
  domParser?: DOMParser;
  /** Overridable for deterministic ids in tests. */
  idFactory?: () => string;
}

/**
 * AV-751. Parses a Training Center Database document into the normalized
 * Activity model, so a TCX file is indistinguishable downstream from a GPX or
 * FIT one (TD-002). The mapping is TD-023.
 *
 * Runs entirely in the browser via `DOMParser`, like the GPX parser: the text
 * never leaves the device. Malformed *points* are skipped with warnings; only a
 * document that cannot be read as TCX at all is a hard failure (plan §15).
 */
export function parseTcx(xml: string, options: ParseTcxOptions = {}): Activity {
  const warnings: ActivityWarning[] = [];
  const document = parseDocument(xml, options.domParser);
  const activityNode = firstChild(document.documentElement, 'Activities')
    ? child(firstChild(document.documentElement, 'Activities')!, 'Activity')
    : undefined;

  if (!activityNode) {
    throw new ActivityError(
      'invalid_tcx_xml',
      'The document has no <Activity> inside <Activities>.',
    );
  }

  const sport = mapSport(activityNode.getAttribute('Sport'));
  const lapNodes = children(activityNode, 'Lap');

  if (lapNodes.length > 1) {
    warnings.push({
      code: 'multiple_laps',
      message: `This activity has ${lapNodes.length} laps.`,
      severity: 'info',
    });
  }

  const { points, laps } = readLaps(lapNodes, sport, warnings);

  if (points.length === 0) {
    throw new ActivityError('no_route_points', 'No <Trackpoint> elements were found.');
  }

  const activity: Activity = {
    id: (options.idFactory ?? defaultId)(),
    source: {
      format: 'tcx',
      fileName: options.fileName,
      fileSizeBytes: options.fileSizeBytes,
      parserVersion: TCX_PARSER_VERSION,
    },
    metadata: {
      // TCX has no activity name; its <Id> is the start timestamp, which is a
      // better label than nothing and is what other tools display.
      name: text(child(activityNode, 'Id')) ?? options.fileName?.replace(/\.tcx$/i, ''),
      device: readDevice(activityNode),
      deviceName: text(child(child(activityNode, 'Creator'), 'Name')),
      creator: text(child(child(activityNode, 'Creator'), 'Name')),
      sport,
    },
    points,
    streams: computeStreams(points),
    ...(laps.length > 0 ? { laps } : {}),
    warnings,
  };

  const withStats = withDerivedStats(activity);
  withStats.metadata.startTime = withStats.derived?.startTime;
  withStats.metadata.endTime = withStats.derived?.endTime;
  return withStats;
}

/** Convenience wrapper matching the async parser contract used by intake. */
export async function parseTcxFile(file: File): Promise<Activity> {
  const text = await file.text();
  return parseTcx(text, { fileName: file.name, fileSizeBytes: file.size });
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `activity-${Date.now()}`;
}

function parseDocument(xml: string, injected?: DOMParser): Document {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new ActivityError('invalid_tcx_xml', 'The file is empty.');
  }
  const parser = injected ?? new DOMParser();
  const document = parser.parseFromString(xml, 'application/xml');

  // DOMParser reports XML errors as a <parsererror> element rather than throwing.
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new ActivityError('invalid_tcx_xml', 'The file is not well-formed XML.');
  }
  const root = document.documentElement;
  if (!root || localName(root) !== 'trainingcenterdatabase') {
    throw new ActivityError(
      'invalid_tcx_xml',
      'The document root is not <TrainingCenterDatabase>.',
    );
  }
  return document;
}

/** TCX names only three sports; everything else a device recorded is `Other`. */
function mapSport(sport: string | null): ActivitySport {
  switch (sport?.toLowerCase()) {
    case 'running':
      return 'running';
    case 'biking':
      return 'cycling';
    default:
      return 'other';
  }
}

/**
 * Laps carry the track. A lap holds one `<Track>` per continuous stretch of
 * recording, so a *second* track inside a lap is a pause — the same boundary a
 * GPX `<trkseg>` and a FIT timer event mark.
 *
 * A lap boundary is not one. A lap is a split marker — a button press, a
 * kilometre, an interval — and the recording usually runs straight through it.
 * Breaking the route there would drop the ground covered between the last point
 * of one lap and the first of the next, which is invisible in a file that
 * states its own distances and a third of the total in one that does not.
 */
function readLaps(
  lapNodes: Element[],
  sport: ActivitySport,
  warnings: ActivityWarning[],
): { points: ActivityPoint[]; laps: ActivityLap[] } {
  const points: ActivityPoint[] = [];
  const laps: ActivityLap[] = [];
  let segmentIndex = 0;
  let missingCoordinates = 0;
  let skippedTrackpoints = 0;

  for (const [index, lapNode] of lapNodes.entries()) {
    const startTime = parseDate(lapNode.getAttribute('StartTime'));
    const lap: ActivityLap = { index };
    if (startTime) lap.startTime = startTime;

    const duration = parseNumber(text(child(lapNode, 'TotalTimeSeconds')));
    if (duration !== undefined) lap.durationSeconds = duration;
    const distance = parseNumber(text(child(lapNode, 'DistanceMeters')));
    if (distance !== undefined) lap.distanceMeters = distance;
    const calories = parseNumber(text(child(lapNode, 'Calories')));
    if (calories !== undefined) lap.caloriesKcal = calories;

    for (const [trackIndex, trackNode] of children(lapNode, 'Track').entries()) {
      // Every track after the first opens a new segment.
      if (trackIndex > 0) segmentIndex += 1;

      for (const pointNode of children(trackNode, 'Trackpoint')) {
        const point = readTrackpoint(pointNode, points.length, segmentIndex, sport);
        if (!point) {
          skippedTrackpoints += 1;
          continue;
        }
        if (point.lat === undefined) missingCoordinates += 1;
        points.push(point);
      }
    }

    // The lap's own end, so a lap knows its bounds even without a duration.
    const last = points.at(-1);
    if (last?.time) lap.endTime = last.time;
    laps.push(lap);
  }

  if (skippedTrackpoints > 0) {
    warnings.push({
      code: 'points_missing_data',
      message:
        `${skippedTrackpoints} track points had neither a time nor a position and are ignored.`,
      severity: 'info',
    });
  }
  if (missingCoordinates > 0 && missingCoordinates < points.length) {
    warnings.push({
      code: 'points_missing_coordinates',
      message:
        `${missingCoordinates} of ${points.length} points had no usable coordinates and are ` +
        'not drawn.',
      severity: 'info',
    });
  }

  return { points, laps };
}

function readTrackpoint(
  node: Element,
  index: number,
  segmentIndex: number,
  sport: ActivitySport,
): ActivityPoint | undefined {
  const time = parseDate(text(child(node, 'Time')));
  const position = child(node, 'Position');
  const lat = parseNumber(text(child(position, 'LatitudeDegrees')));
  const lon = parseNumber(text(child(position, 'LongitudeDegrees')));

  // Out of range, or Null Island, is not a place: it does not enter the model,
  // so nothing downstream has to keep re-deciding that it is unusable.
  const located = toValidCoordinate(lat, lon);

  // A point with neither a clock nor a place carries nothing this app can use.
  if (!time && !located) return undefined;

  const point: ActivityPoint = { index, segmentIndex };
  if (time) point.time = time;
  if (located) {
    point.lat = located.lat;
    point.lon = located.lon;
  }

  const elevation = parseNumber(text(child(node, 'AltitudeMeters')));
  if (elevation !== undefined) point.elevationMeters = elevation;
  const distance = parseNumber(text(child(node, 'DistanceMeters')));
  if (distance !== undefined) point.distanceMeters = distance;
  const heartRate = parseNumber(text(child(child(node, 'HeartRateBpm'), 'Value')));
  if (heartRate !== undefined) point.heartRateBpm = heartRate;

  readExtensions(node, point);

  /*
   * TD-023. TCX is the first format that states cadence units itself: the
   * schema's `Cadence` on a trackpoint is bike cadence, and running cadence
   * lives in the `RunCadence` extension. An explicit `RunCadence` has already
   * been read, so a bare `Cadence` only falls back to the sport when the file
   * gave no better answer.
   */
  const cadence = parseNumber(text(child(node, 'Cadence')));
  if (cadence !== undefined && point.runningCadenceSpm === undefined) {
    if (sport === 'running') point.runningCadenceSpm = cadence;
    else point.cyclingCadenceRpm = cadence;
  }

  return point;
}

/** Reads the Garmin ActivityExtension `TPX` block, wherever it is nested. */
function readExtensions(node: Element, point: ActivityPoint): void {
  const extensions = child(node, 'Extensions');
  if (!extensions) return;

  const walk = (element: Element): void => {
    for (const entry of Array.from(element.children)) {
      const value = parseNumber(entry.textContent?.trim());
      switch (localName(entry)) {
        case 'speed':
          if (isPlausibleSpeed(value)) point.speedMetersPerSecond = value;
          break;
        case 'watts':
          if (value !== undefined) point.powerWatts = value;
          break;
        case 'runcadence':
          if (value !== undefined) point.runningCadenceSpm = value;
          break;
        default:
          break;
      }
      if (entry.children.length > 0) walk(entry);
    }
  };
  walk(extensions);
}

/**
 * TD-020. `UnitId` is the device's serial number: read because the file states
 * it, but never among the fields any UI may render.
 */
function readDevice(activityNode: Element): ActivityDeviceInfo | undefined {
  const creator = child(activityNode, 'Creator');
  if (!creator) return undefined;

  const device: ActivityDeviceInfo = { source: 'tcx_creator' };
  const name = text(child(creator, 'Name'));
  if (name) device.name = name;
  const product = text(child(creator, 'ProductID'));
  if (product) device.product = product;
  const unitId = text(child(creator, 'UnitId'));
  if (unitId) device.serialNumber = unitId;

  const version = child(creator, 'Version');
  const major = text(child(version, 'VersionMajor'));
  const minor = text(child(version, 'VersionMinor'));
  if (major) device.softwareVersion = minor ? `${major}.${minor}` : major;

  return device;
}

/* Namespace-agnostic lookups: TCX documents vary in prefix, and the Garmin
 * extension blocks declare namespaces of their own. */

function localName(element: Element): string {
  return element.nodeName.toLowerCase().replace(/^.*:/, '');
}

function children(parent: Element | undefined, name: string): Element[] {
  if (!parent) return [];
  const wanted = name.toLowerCase();
  return Array.from(parent.children).filter((entry) => localName(entry) === wanted);
}

function child(parent: Element | undefined, name: string): Element | undefined {
  return children(parent, name)[0];
}

function firstChild(parent: Element | undefined, name: string): Element | undefined {
  return child(parent, name);
}

function text(element: Element | undefined): string | undefined {
  const value = element?.textContent?.trim();
  return value ? value : undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
