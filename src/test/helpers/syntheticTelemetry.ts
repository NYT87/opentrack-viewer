import { computeStreams, type Activity, type ActivityPoint, type ActivitySensorStream } from '../../domain/activity';
import { withDerivedStats } from '../../domain/stats';

/**
 * AV-1008. Synthetic telemetry of any length, made on demand and never
 * committed: the way to test an overlay against a ten-hour ride without a
 * ten-hour video, or a ten-hour file, anywhere in the repository.
 *
 * Deterministic: every value is a pure function of the point's index, so a
 * test (and a performance budget) means the same thing on every run and every
 * machine. There is no random number generator to seed.
 */
export interface SyntheticRideOptions {
  /** How long the recording is. */
  seconds: number;
  /** Points per second: 1 for a watch, 10–18 for a camera's GPS. */
  hz?: number;
  /** Wall-clock start; the default is a fixed instant, not "now". */
  start?: Date;
  /** Also carry a point-aligned camera stream of this many values per point (1). */
  sensorStream?: boolean;
}

export const SYNTHETIC_START = new Date('2024-06-01T08:00:00Z');

/** What a synthetic ride says at point `index` of one recorded every `1 / hz` seconds. */
export function syntheticPoint(index: number, hz = 1, start: Date = SYNTHETIC_START): ActivityPoint {
  const seconds = index / hz;
  // A route that wanders but stays valid: a slow circuit around a fixed centre.
  const angle = seconds / 600;
  return {
    index,
    time: new Date(start.getTime() + Math.round(seconds * 1000)),
    lat: 51.5 + 0.02 * Math.sin(angle),
    lon: -0.12 + 0.03 * Math.cos(angle),
    elevationMeters: 40 + 15 * Math.sin(seconds / 300),
    speedMetersPerSecond: 6 + 2 * Math.sin(seconds / 90),
    heartRateBpm: 140 + Math.round(20 * Math.sin(seconds / 240)),
    cyclingCadenceRpm: 85 + Math.round(10 * Math.sin(seconds / 60)),
    powerWatts: 200 + Math.round(80 * Math.sin(seconds / 45)),
  };
}

export function syntheticRide(options: SyntheticRideOptions): Activity {
  const hz = options.hz ?? 1;
  const count = Math.max(2, Math.round(options.seconds * hz) + 1);
  const points: ActivityPoint[] = new Array(count);
  for (let i = 0; i < count; i += 1) points[i] = syntheticPoint(i, hz, options.start);

  const sensorStreams: ActivitySensorStream[] | undefined = options.sensorStream
    ? [
        {
          key: 'ACCL',
          label: 'Acceleration',
          unit: 'm/s²',
          display: 'chart',
          sampleRateHz: 200,
          valuesByPoint: Array.from({ length: count }, (_, i) => 9.8 + Math.sin(i / hz / 5)),
        },
      ]
    : undefined;

  return withDerivedStats({
    id: `synthetic-${options.seconds}s-${hz}hz`,
    source: { format: 'gpx', parserVersion: 'synthetic' },
    metadata: { name: 'Synthetic ride', sport: 'cycling' },
    points,
    streams: computeStreams(points),
    ...(sensorStreams ? { sensorStreams } : {}),
    warnings: [],
  });
}
