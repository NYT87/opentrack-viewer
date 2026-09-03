/** Parser-internal shapes. Nothing outside `parsers/gpx` should import these. */

export interface RawGpxPoint {
  lat?: number;
  lon?: number;
  elevationMeters?: number;
  time?: Date;
  heartRateBpm?: number;
  cadenceRpm?: number;
  powerWatts?: number;
  temperatureCelsius?: number;
  speedMetersPerSecond?: number;
  /** Index of the <trkseg> the point came from. */
  segmentIndex: number;
}

export interface RawGpxDocument {
  name?: string;
  description?: string;
  creator?: string;
  type?: string;
  points: RawGpxPoint[];
  segmentCount: number;
}
