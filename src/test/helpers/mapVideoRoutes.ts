import type { ActivityPoint } from '../../domain/activity';
import { makeActivity } from './activity';

/** Metres per degree of latitude, near enough for test routes. */
export const METERS_PER_DEGREE = 111_195;
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);

export interface TestPoint {
  /** Metres north and east of the origin (46° N, 7° E). */
  north: number;
  east: number;
  /** Seconds from the start. */
  second?: number;
  elevation?: number;
  segment?: number;
}

/** An activity through these places, near 46° N, 7° E. */
export function activityThrough(points: TestPoint[]) {
  const lat0 = 46;
  const lon0 = 7;
  const metersPerLonDegree = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  return makeActivity(
    points.map((point): Partial<ActivityPoint> => ({
      lat: lat0 + point.north / METERS_PER_DEGREE,
      lon: lon0 + point.east / metersPerLonDegree,
      ...(point.second !== undefined ? { time: new Date(T0 + point.second * 1000) } : {}),
      ...(point.elevation !== undefined ? { elevationMeters: point.elevation } : {}),
      ...(point.segment !== undefined ? { segmentIndex: point.segment } : {}),
    })),
  );
}

/** A straight ride north: a point every `step` metres, at `speed` m/s. */
export function straightNorth(meters: number, step = 10, speed = 5): TestPoint[] {
  return Array.from({ length: Math.round(meters / step) + 1 }, (_, i) => ({ north: i * step, east: 0, second: (i * step) / speed }));
}
