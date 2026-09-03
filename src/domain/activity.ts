/**
 * Format-independent activity domain model (AV-101, TD-002).
 *
 * Every parser (GPX today, FIT later) must produce this shape. UI, stats, map
 * and chart layers depend on this module only — never on parser output types.
 */

export type ActivitySourceFormat =
  | 'gpx'
  | 'fit'
  | 'tcx'
  | 'kml'
  | 'geojson'
  | 'csv'
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

export interface ActivityMetadata {
  name?: string;
  description?: string;
  sport?: ActivitySport;
  startTime?: Date;
  endTime?: Date;
  creator?: string;
  deviceName?: string;
}

export interface ActivityPoint {
  index: number;
  time?: Date;
  lat?: number;
  lon?: number;
  elevationMeters?: number;
  distanceMeters?: number;
  heartRateBpm?: number;
  cadenceRpm?: number;
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
  hasCadence: boolean;
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

/** True when the point carries a finite, in-range WGS84 coordinate pair. */
export function hasValidLocation(
  point: ActivityPoint,
): point is ActivityPoint & { lat: number; lon: number } {
  const { lat, lon } = point;
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // (0, 0) is Null Island: almost always a parser/device artefact, not a route.
    !(lat === 0 && lon === 0)
  );
}

/** Derives the stream availability flags from the points themselves. */
export function computeStreams(points: ActivityPoint[]): ActivityStreams {
  const streams: ActivityStreams = {
    hasLocation: false,
    hasElevation: false,
    hasTime: false,
    hasDistance: false,
    hasHeartRate: false,
    hasCadence: false,
    hasPower: false,
    hasTemperature: false,
  };

  for (const point of points) {
    if (hasValidLocation(point)) streams.hasLocation = true;
    if (Number.isFinite(point.elevationMeters)) streams.hasElevation = true;
    if (point.time instanceof Date && !Number.isNaN(point.time.getTime())) streams.hasTime = true;
    if (Number.isFinite(point.distanceMeters)) streams.hasDistance = true;
    if (Number.isFinite(point.heartRateBpm)) streams.hasHeartRate = true;
    if (Number.isFinite(point.cadenceRpm)) streams.hasCadence = true;
    if (Number.isFinite(point.powerWatts)) streams.hasPower = true;
    if (Number.isFinite(point.temperatureCelsius)) streams.hasTemperature = true;
  }

  return streams;
}
