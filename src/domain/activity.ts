/**
 * Format-independent activity domain model (AV-101, TD-002).
 *
 * Every parser — GPX, FIT and TCX — must produce this shape. UI, stats, map
 * and chart layers depend on this module only — never on parser output types.
 */

export type ActivitySourceFormat =
  | 'gpx'
  | 'fit'
  | 'tcx'
  | 'kml'
  | 'geojson'
  | 'csv'
  /** An MP4/MOV that carries GoPro GPMF telemetry (`AV-902`). */
  | 'gopro'
  /** An MP4/MOV with no telemetry this app can use — a video, and only that. */
  | 'video'
  | 'unknown';

export type ActivitySport =
  | 'running'
  | 'cycling'
  | 'hiking'
  | 'walking'
  | 'swimming'
  | 'skiing'
  | 'rowing'
  | 'other'
  | 'unknown';

export interface ActivitySource {
  format: ActivitySourceFormat;
  fileName?: string;
  fileSizeBytes?: number;
  parserVersion: string;
}

/**
 * Optional device metadata. `serialNumber` is modelled so a parser can capture
 * what a file contains, but it is a stable identifier: the UI never renders it
 * (plan §5, AV-405).
 */
export interface ActivityDeviceInfo {
  name?: string;
  manufacturer?: string;
  model?: string;
  product?: string;
  softwareVersion?: string;
  firmwareVersion?: string;
  serialNumber?: string;
  source?:
    | 'gpx_creator'
    | 'gpx_extension'
    | 'fit_device_info'
    | 'fit_file_id'
    | 'tcx_creator'
    | 'unknown';
}

/** Fields safe to show. Deliberately excludes every stable identifier. */
export const DISPLAYABLE_DEVICE_FIELDS = [
  'manufacturer',
  'model',
  'product',
  'name',
  'softwareVersion',
  'firmwareVersion',
] as const satisfies readonly (keyof ActivityDeviceInfo)[];

/** True when there is at least one user-friendly field worth showing. */
export function hasDisplayableDevice(
  device: ActivityDeviceInfo | undefined,
): device is ActivityDeviceInfo {
  return Boolean(device) && DISPLAYABLE_DEVICE_FIELDS.some((field) => Boolean(device?.[field]));
}

export interface ActivityMetadata {
  name?: string;
  description?: string;
  sport?: ActivitySport;
  startTime?: Date;
  endTime?: Date;
  creator?: string;
  deviceName?: string;
  device?: ActivityDeviceInfo;
}

export interface ActivityPoint {
  index: number;
  time?: Date;
  lat?: number;
  lon?: number;
  elevationMeters?: number;
  distanceMeters?: number;
  heartRateBpm?: number;
  /**
   * AV-515. Foot cadence in **strides per minute** — one foot, the unit foot
   * pods and watches report. Named for running because that is the only sport
   * that charts it, but a walk or hike records the same measurement. Kept
   * separate from cycling cadence because
   * the two are different measurements that happen to share a name, and one
   * generic "rpm" field made the chart label a guess.
   */
  runningCadenceSpm?: number;
  /** Cycling cadence in revolutions per minute (pedal revolutions). */
  cyclingCadenceRpm?: number;
  powerWatts?: number;
  temperatureCelsius?: number;
  speedMetersPerSecond?: number;
  gradePercent?: number;
  accuracyMeters?: number;
  /**
   * Which recorded segment this point belongs to. GPX files split a track into
   * <trkseg> elements — and may hold several <trk> elements — precisely because
   * the recording was interrupted. Points either side of a boundary are not
   * continuous, so distance must not be accumulated across one and no line
   * should be drawn between them.
   */
  segmentIndex?: number;
  extensions?: Record<string, unknown>;
}

export interface ActivityLap {
  index: number;
  startTime?: Date;
  endTime?: Date;
  distanceMeters?: number;
  durationSeconds?: number;
  /**
   * Energy the device estimated for this lap. Stated per lap because that is
   * how TCX states it, and it is an estimate from a model the file does not
   * describe — so it is reported where the file put it rather than summed into
   * an activity total this app would appear to vouch for.
   */
  caloriesKcal?: number;
}

export interface ActivityEvent {
  type: 'start' | 'stop' | 'pause' | 'resume' | 'lap' | 'marker' | 'unknown';
  time?: Date;
  pointIndex?: number;
  label?: string;
}

export interface ActivityStreams {
  hasLocation: boolean;
  hasElevation: boolean;
  hasTime: boolean;
  hasDistance: boolean;
  hasHeartRate: boolean;
  hasRunningCadence: boolean;
  hasCyclingCadence: boolean;
  hasSpeed: boolean;
  hasPower: boolean;
  hasTemperature: boolean;
}

export interface ActivityDerivedStats {
  pointCount: number;
  startTime?: Date;
  endTime?: Date;
  durationSeconds?: number;
  movingDurationSeconds?: number;
  distanceMeters?: number;
  /** Distance over elapsed duration, matching the `Duration` figure shown. */
  averageSpeedMetersPerSecond?: number;
  /** The same average expressed as pace, which is how runners read it. */
  averagePaceSecondsPerKm?: number;
  elevationGainMeters?: number;
  elevationLossMeters?: number;
  minElevationMeters?: number;
  maxElevationMeters?: number;
  averageHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  averagePowerWatts?: number;
  maxPowerWatts?: number;
}

/**
 * User-selectable chart x-axis. Point index is deliberately not a member: it is
 * an internal rendering fallback for activities that have neither distance nor
 * timestamps, never something the user picks.
 */
export type ChartXAxisMode = 'distance' | 'time';

/**
 * A contiguous span of `activity.points`, inclusive at both ends. Ranges are
 * expressed in point indices rather than axis units so a selection means the
 * same thing whichever x-axis the charts are showing (AV-509).
 */
export interface ActivityPointRange {
  startIndex: number;
  endIndex: number;
}

export type ActivityWarningSeverity = 'info' | 'warning' | 'error';

export interface ActivityWarning {
  code: string;
  message: string;
  severity: ActivityWarningSeverity;
  pointIndex?: number;
}

export interface Activity {
  id: string;
  source: ActivitySource;
  metadata: ActivityMetadata;
  points: ActivityPoint[];
  laps?: ActivityLap[];
  events?: ActivityEvent[];
  streams: ActivityStreams;
  derived?: ActivityDerivedStats;
  warnings: ActivityWarning[];
}

/**
 * Speeds above this are not plausible on a bicycle, which is the fastest thing
 * this viewer plots. Generous enough for a fast descent (AV-513).
 */
export const MAX_PLAUSIBLE_CYCLING_SPEED_MPS = 35;

/**
 * True when a recorded speed can be believed. A device that reports a negative
 * or absurd value has faulted, and the honest thing to do with a faulty reading
 * is to treat it as absent — a speed derived from positions is then used
 * instead, rather than drawing a spike the ride never contained.
 *
 * Recorded speed is checked against the *cycling* ceiling wherever it appears,
 * because a file's sport is not always known at the point the value is read.
 */
export function isPlausibleSpeed(value: number | undefined): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PLAUSIBLE_CYCLING_SPEED_MPS
  );
}

/** A WGS84 position this app is willing to treat as a place. */
export interface Coordinate {
  lat: number;
  lon: number;
}

/**
 * Returns the pair when it is a usable WGS84 coordinate, and `undefined`
 * otherwise.
 *
 * The single definition of what this app treats as a place. Parsers use it to
 * decide what enters the model, and the map, stats and exporters use it through
 * `hasValidLocation` to decide what leaves — so a coordinate the app refuses to
 * draw is never one it stored, and never one it writes out.
 *
 * It returns the pair rather than a type predicate because it validates *two*
 * values: a predicate can narrow only its first argument, which would leave
 * every caller casting the longitude it had just been told was fine.
 */
export function toValidCoordinate(lat: unknown, lon: unknown): Coordinate | undefined {
  const usable =
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // (0, 0) is Null Island: almost always a parser/device artefact, not a route.
    !(lat === 0 && lon === 0);

  return usable ? { lat, lon } : undefined;
}

/** True when the point carries a finite, in-range WGS84 coordinate pair. */
export function hasValidLocation(
  point: ActivityPoint,
): point is ActivityPoint & { lat: number; lon: number } {
  return toValidCoordinate(point.lat, point.lon) !== undefined;
}

/** Derives the stream availability flags from the points themselves. */
export function computeStreams(points: ActivityPoint[]): ActivityStreams {
  const streams: ActivityStreams = {
    hasLocation: false,
    hasElevation: false,
    hasTime: false,
    hasDistance: false,
    hasHeartRate: false,
    hasRunningCadence: false,
    hasCyclingCadence: false,
    hasSpeed: false,
    hasPower: false,
    hasTemperature: false,
  };

  for (const point of points) {
    if (hasValidLocation(point)) streams.hasLocation = true;
    if (Number.isFinite(point.elevationMeters)) streams.hasElevation = true;
    if (point.time instanceof Date && !Number.isNaN(point.time.getTime())) streams.hasTime = true;
    if (Number.isFinite(point.distanceMeters)) streams.hasDistance = true;
    if (Number.isFinite(point.heartRateBpm)) streams.hasHeartRate = true;
    if (Number.isFinite(point.runningCadenceSpm)) streams.hasRunningCadence = true;
    if (Number.isFinite(point.cyclingCadenceRpm)) streams.hasCyclingCadence = true;
    if (isPlausibleSpeed(point.speedMetersPerSecond)) streams.hasSpeed = true;
    if (Number.isFinite(point.powerWatts)) streams.hasPower = true;
    if (Number.isFinite(point.temperatureCelsius)) streams.hasTemperature = true;
  }

  return streams;
}
