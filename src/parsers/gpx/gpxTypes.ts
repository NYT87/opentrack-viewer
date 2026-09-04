/** Parser-internal shapes. Nothing outside `parsers/gpx` should import these. */

export interface RawGpxPoint {
  lat?: number;
  lon?: number;
  elevationMeters?: number;
  time?: Date;
  heartRateBpm?: number;
  /** As written in the file; the sport decides what unit it means. */
  cadence?: number;
  powerWatts?: number;
  temperatureCelsius?: number;
  speedMetersPerSecond?: number;
  /** Index of the <trkseg> the point came from. */
  segmentIndex: number;
}

import type { ActivityDeviceInfo } from '../../domain/activity';

export interface RawGpxDocument {
  device?: ActivityDeviceInfo;
  name?: string;
  description?: string;
  creator?: string;
  type?: string;
  points: RawGpxPoint[];
  segmentCount: number;
}
