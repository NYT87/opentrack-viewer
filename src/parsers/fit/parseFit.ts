import FitParser from 'fit-file-parser';

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

/*
 * The library's `exports` map publishes only its entry point, so its result
 * types are derived from the public API rather than deep-imported. This also
 * means a change in the library's shape surfaces here as a type error.
 */
type ParsedFit = Awaited<ReturnType<FitParser['parseAsync']>>;
type ParsedRecord = NonNullable<ParsedFit['records']>[number];
type ParsedLap = NonNullable<ParsedFit['laps']>[number];
type ParsedDeviceInfo = NonNullable<ParsedFit['device_infos']>[number];

export const FIT_PARSER_VERSION = '1.0.0';

export interface ParseFitOptions {
  fileName?: string;
  fileSizeBytes?: number;
  /** Overridable for deterministic ids in tests. */
  idFactory?: () => string;
}

/**
 * AV-702. Decodes a FIT file into the same normalized Activity model the GPX
 * parser produces (TD-002), so nothing downstream can tell the two apart.
 *
 * Runs entirely in the browser: `fit-file-parser` is pure JavaScript over an
 * ArrayBuffer and performs no I/O. See TD-018 for why this library rather than
 * Garmin's official SDK.
 */
export async function parseFit(
  buffer: ArrayBuffer,
  options: ParseFitOptions = {},
): Promise<Activity> {
  const warnings: ActivityWarning[] = [];
  const parsed = await decode(buffer);

  const records = parsed.records ?? [];
  if (records.length === 0) {
    throw new ActivityError(
      'no_route_points',
      'The FIT file decoded, but contained no record messages.',
    );
  }

  const sport = readSport(parsed);
  const points = normalizeRecords(records, parsed, warnings, sport);
  const laps = readLaps(parsed.laps ?? []);

  warnUnsupported(parsed, warnings);

  const activity: Activity = {
    id: (options.idFactory ?? defaultId)(),
    source: {
      format: 'fit',
      fileName: options.fileName,
      fileSizeBytes: options.fileSizeBytes,
      parserVersion: FIT_PARSER_VERSION,
    },
    metadata: {
      name: readName(parsed, options.fileName),
      creator: readCreator(parsed),
      deviceName: readCreator(parsed),
      device: readDevice(parsed),
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
export async function parseFitFile(file: File): Promise<Activity> {
  const buffer = await file.arrayBuffer();
  return parseFit(buffer, { fileName: file.name, fileSizeBytes: file.size });
}

async function decode(buffer: ArrayBuffer): Promise<ParsedFit> {
  // Duck-typed rather than `instanceof`: a buffer read in one realm (Node) and
  // parsed in another (jsdom, or a worker) is still a perfectly good buffer.
  const byteLength = (buffer as ArrayBuffer | undefined)?.byteLength;
  if (typeof byteLength !== 'number' || byteLength === 0) {
    throw new ActivityError('fit_parse_failed', 'The file is empty.');
  }

  const parser = new FitParser({
    mode: 'list',
    // Ask for base SI units so no conversion happens twice: the domain stores
    // metres and metres per second, and converts only for display.
    speedUnit: 'm/s',
    lengthUnit: 'm',
    temperatureUnit: 'celsius',
  });

  try {
    return await parser.parseAsync(buffer);
  } catch (error) {
    throw new ActivityError('fit_parse_failed', messageOf(error), { cause: error });
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : 'The FIT file could not be decoded.';
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `activity-${Date.now()}`;
}

/**
 * FIT names its sports in a much larger vocabulary than this viewer models, so
 * anything outside the set we handle becomes `other` rather than a guess.
 */
const SPORT_NAMES: Record<string, ActivitySport> = {
  running: 'running',
  cycling: 'cycling',
  hiking: 'hiking',
  walking: 'walking',
  swimming: 'swimming',
  rowing: 'rowing',
  alpine_skiing: 'skiing',
  cross_country_skiing: 'skiing',
  snowboarding: 'skiing',
};

function readSport(parsed: ParsedFit): ActivitySport {
  // The dedicated `sport` message is the most direct statement; a session
  // carries the same field and is present in files that omit it.
  const declared = parsed.sports?.[0]?.sport ?? parsed.sessions?.[0]?.sport;
  if (typeof declared !== 'string') return 'unknown';
  return SPORT_NAMES[declared] ?? 'other';
}

/**
 * Sports whose cadence is strokes per minute rather than strides. Same
 * reasoning as the GPX parser: a unit this viewer has no field for is dropped
 * rather than filed under one it does not have.
 */
const STROKE_CADENCE_SPORTS: ReadonlySet<ActivitySport> = new Set(['swimming', 'rowing']);

function normalizeRecords(
  records: ParsedRecord[],
  parsed: ParsedFit,
  warnings: ActivityWarning[],
  sport: ActivitySport,
): ActivityPoint[] {
  const segmentAt = buildSegmentIndex(parsed, warnings);
  const points: ActivityPoint[] = [];
  let missingCoordinates = 0;

  for (const record of records) {
    const index = points.length;
    const time = record.timestamp instanceof Date ? record.timestamp : undefined;
    const point: ActivityPoint = { index, segmentIndex: segmentAt(time) };

    /*
     * Indoor activities legitimately have no position at all, so a missing one
     * is counted but never drops the record: its sensor data is still real.
     * The same test the map, the stats and the exporters apply — a coordinate
     * this app refuses to draw is not one it stores.
     */
    const located = toValidCoordinate(record.position_lat, record.position_long);
    if (located) {
      point.lat = located.lat;
      point.lon = located.lon;
    } else {
      missingCoordinates += 1;
    }

    if (time) point.time = time;

    // `enhanced_*` fields carry the same measurement at higher resolution and
    // wider range; devices that write them mean them to win.
    const altitude = firstFinite(record.enhanced_altitude, record.altitude);
    if (altitude !== undefined) point.elevationMeters = altitude;

    if (isFinite(record.distance)) point.distanceMeters = record.distance;
    if (isFinite(record.heart_rate)) point.heartRateBpm = record.heart_rate;
    if (isFinite(record.power)) point.powerWatts = record.power;
    if (isFinite(record.temperature)) point.temperatureCelsius = record.temperature;
    if (isFinite(record.grade)) point.gradePercent = record.grade;
    if (isFinite(record.gps_accuracy)) point.accuracyMeters = record.gps_accuracy;

    const speed = firstFinite(record.enhanced_speed, record.speed);
    if (isPlausibleSpeed(speed)) point.speedMetersPerSecond = speed;

    // AV-515: FIT states cadence in cycles per minute, which is pedal
    // revolutions on a bike and strides — one foot — on a run.
    if (isFinite(record.cadence)) {
      if (sport === 'cycling') point.cyclingCadenceRpm = record.cadence;
      else if (!STROKE_CADENCE_SPORTS.has(sport)) point.runningCadenceSpm = record.cadence;
    }

    points.push(point);
  }

  /*
   * A partial miss is a GPS dropout mid-recording, which is worth naming. A
   * total miss is just an indoor activity — normal, not an anomaly — and shared
   * validation already reports it as `no_location_stream`, so saying it here
   * too would show the reader the same sentence twice.
   */
  if (missingCoordinates > 0 && missingCoordinates < points.length) {
    warnings.push({
      code: 'points_missing_coordinates',
      message:
        `${missingCoordinates} of ${points.length} points had no usable coordinates ` +
        'and are not drawn.',
      severity: 'info',
    });
  }

  return points;
}

/**
 * A FIT recording is paused by a `timer` event and resumed by another. Points
 * either side of a pause are not continuous, so they belong to different
 * segments — exactly what `<trkseg>` means in GPX, and what stops a pause from
 * being counted as distance travelled or drawn as a straight connector line.
 */
function buildSegmentIndex(
  parsed: ParsedFit,
  warnings: ActivityWarning[],
): (time: Date | undefined) => number {
  const resumes: number[] = [];

  for (const event of parsed.events ?? []) {
    if (event.event !== 'timer') continue;
    const at = event.timestamp instanceof Date ? event.timestamp.getTime() : undefined;
    if (at === undefined) continue;
    // Every start after the first opens a new segment; the stop that precedes
    // it is implied, so only the resumes need recording.
    if (event.event_type === 'start') resumes.push(at);
  }

  resumes.sort((a, b) => a - b);
  // The first start opens segment 0 rather than segment 1.
  const boundaries = resumes.slice(1);

  if (boundaries.length > 0) {
    warnings.push({
      code: 'multiple_segments',
      message:
        `This recording was paused ${boundaries.length} ` +
        `${boundaries.length === 1 ? 'time' : 'times'}. Each stretch is drawn as its own ` +
        'line, and the gaps between them are not counted towards the distance.',
      severity: 'info',
    });
  }

  return (time) => {
    if (!time || boundaries.length === 0) return 0;
    const at = time.getTime();
    let segment = 0;
    for (const boundary of boundaries) {
      if (at >= boundary) segment += 1;
      else break;
    }
    return segment;
  };
}

function readLaps(laps: ParsedLap[]): ActivityLap[] {
  return laps.map((lap, index) => {
    const normalized: ActivityLap = { index };
    if (lap.start_time instanceof Date) normalized.startTime = lap.start_time;
    if (lap.timestamp instanceof Date) normalized.endTime = lap.timestamp;
    if (isFinite(lap.total_distance)) normalized.distanceMeters = lap.total_distance;
    // Elapsed rather than timer time, matching how the summary reports duration.
    const duration = firstFinite(lap.total_elapsed_time, lap.total_timer_time);
    if (duration !== undefined) normalized.durationSeconds = duration;
    return normalized;
  });
}

/**
 * AV-702 / plan §5. The serial number is parsed because the file states it, but
 * it is a stable identifier for the user's device: it is never among the
 * displayable fields, so no UI can show it by accident.
 */
function readDevice(parsed: ParsedFit): ActivityDeviceInfo | undefined {
  // Prefer the device_info message, which describes the recording device
  // directly; file_id says who wrote the file, which is usually the same thing.
  const info = parsed.device_infos?.find(
    (entry: ParsedDeviceInfo) => entry.manufacturer || entry.product,
  );
  const fileId = parsed.file_ids?.[0];
  const from = info ?? fileId;
  if (!from) return undefined;

  const device: ActivityDeviceInfo = {
    source: info ? 'fit_device_info' : 'fit_file_id',
  };

  if (typeof from.manufacturer === 'string') device.manufacturer = titleCase(from.manufacturer);
  const productName = typeof fileId?.product_name === 'string' ? fileId.product_name : undefined;
  if (productName) device.model = productName;
  else if (isFinite(from.product)) device.product = String(from.product);

  if (info && isFinite(info.software_version)) {
    device.softwareVersion = String(info.software_version);
  }
  if (isFinite(from.serial_number)) device.serialNumber = String(from.serial_number);

  return device;
}

function readCreator(parsed: ParsedFit): string | undefined {
  const device = readDevice(parsed);
  if (!device) return undefined;
  return [device.manufacturer, device.model ?? device.product].filter(Boolean).join(' ') || undefined;
}

function readName(parsed: ParsedFit, fileName: string | undefined): string | undefined {
  // FIT has no activity-name field the way GPX has <name>; a workout name is
  // the closest thing, and otherwise the file name is more use than nothing.
  const sportName = parsed.sports?.[0]?.name;
  if (typeof sportName === 'string' && sportName.trim() !== '') return sportName.trim();
  return fileName?.replace(/\.fit$/i, '') || undefined;
}

/**
 * FIT carries far more message types than this viewer models. Silently ignoring
 * them would be dishonest about what was read, so the ones carrying activity
 * data we do not surface are named.
 */
const UNSUPPORTED_MESSAGES: [keyof ParsedFit, string][] = [
  ['hrv', 'heart rate variability'],
  ['lengths', 'pool lengths'],
  ['sets', 'strength sets'],
  ['splits', 'splits'],
  ['dive_gases', 'dive gas mixes'],
  ['course_points', 'course points'],
  ['monitors', 'daily monitoring'],
];

function warnUnsupported(parsed: ParsedFit, warnings: ActivityWarning[]): void {
  const ignored = UNSUPPORTED_MESSAGES.filter(([key]) => {
    const value = parsed[key];
    return Array.isArray(value) && value.length > 0;
  }).map(([, label]) => label);

  if (ignored.length === 0) return;

  warnings.push({
    code: 'unsupported_fit_messages',
    message: `This file also contains ${ignored.join(', ')}, which this viewer does not show.`,
    severity: 'info',
  });
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) if (isFinite(value)) return value;
  return undefined;
}

/** FIT reports manufacturers as lowercase identifiers such as `garmin`. */
function titleCase(value: string): string {
  return value
    .split('_')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}
