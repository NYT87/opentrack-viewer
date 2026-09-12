import {
  computeStreams,
  toValidCoordinate,
  type Activity,
  type ActivityPoint,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';
import { withDerivedStats } from '../../domain/stats';
import type { GpmfPayload } from './extractGpmf';

export const GOPRO_PARSER_VERSION = '1.0.0';

/**
 * A GPS fix of 2 (two-dimensional) or better. Below that the receiver is
 * reporting a position it has not actually established — GoPro's own HERO8
 * sample is 231 such points, every one of them in the North Pacific at nine
 * kilometres altitude, because it was recorded indoors.
 */
const MIN_GPS_FIX = 2;

/**
 * Dilution of precision above which a point is not worth plotting. Under 5 is
 * good, and a receiver with no lock reports 99.99 — so this admits ordinary
 * poor reception under trees while rejecting the "no idea" sentinel.
 */
const MAX_GPS_DOP = 10;

export interface ParseGoproOptions {
  fileName?: string;
  fileSizeBytes?: number;
  idFactory?: () => string;
}

interface GoproSample {
  value?: number[];
  date?: Date;
  cts?: number;
  sticky?: { fix?: number; precision?: number };
}

/**
 * AV-904. Turns an extracted GPMF payload into the normalized `Activity` every
 * other part of this app already understands (TD-002).
 *
 * Nothing downstream learns where the activity came from: the same stats, map,
 * charts, focused ranges and exporters that serve a GPX file serve this, with
 * no GoPro-specific branch anywhere.
 */
export async function parseGopro(
  payload: GpmfPayload,
  options: ParseGoproOptions = {},
): Promise<Activity> {
  const { default: goproTelemetry } = await import('gopro-telemetry');
  const warnings: ActivityWarning[] = [];

  /*
   * The library's own types describe its many option-dependent shapes; this
   * reads the one shape these options produce, so the cast is through
   * `unknown` deliberately rather than pretending the two types overlap.
   */
  const parsed = (await goproTelemetry(
    {
      rawData: payload.rawData,
      timing: {
        videoDuration: payload.timing.videoDurationSeconds,
        frameDuration: payload.timing.frameDurationMs,
        start: payload.timing.start ?? new Date(0),
        samples: payload.timing.samples,
      },
    },
    { stream: ['GPS9', 'GPS5'] },
  )) as unknown as Record<
    string,
    { 'device name'?: string; streams?: Record<string, { samples?: GoproSample[] }> }
  >;

  const device = Object.values(parsed)[0];
  // GPS9 where the camera writes it (HERO11 onward), GPS5 otherwise. They are
  // the same measurements in a different shape, which `readSample` reconciles.
  const streamKey = device?.streams?.GPS9 ? 'GPS9' : 'GPS5';
  const samples = device?.streams?.[streamKey]?.samples ?? [];

  if (samples.length === 0) {
    throw new ActivityError(
      'no_telemetry_track',
      'This video carries telemetry, but no GPS track that could be turned into an activity.',
    );
  }

  const { points, rejected } = readPoints(samples, streamKey);

  if (points.length === 0) {
    throw new ActivityError(
      'no_location_stream',
      `None of this video's ${samples.length} GPS samples has a usable satellite fix. The ` +
        'camera recorded positions before it had one, which is what happens indoors.',
    );
  }

  if (rejected > 0) {
    warnings.push({
      code: 'gopro_samples_without_fix',
      message:
        `${rejected} of ${samples.length} GPS samples were recorded without a usable fix and ` +
        'are left out, which is normal for the first seconds of a recording.',
      severity: 'info',
    });
  }

  const activity: Activity = {
    id: (options.idFactory ?? defaultId)(),
    source: {
      format: 'gopro',
      fileName: options.fileName,
      fileSizeBytes: options.fileSizeBytes,
      parserVersion: GOPRO_PARSER_VERSION,
    },
    metadata: {
      name: options.fileName?.replace(/\.(mp4|mov)$/i, ''),
      // The camera model, and nothing that identifies the camera itself
      // (TD-020): GPMF's device id is not carried into the model at all.
      ...(device?.['device name']
        ? {
            deviceName: device['device name'],
            device: { name: device['device name'], source: 'gopro_device' as const },
          }
        : {}),
      // A camera records what it sees, not what the athlete was doing.
      sport: 'unknown',
    },
    points,
    streams: computeStreams(points),
    warnings,
  };

  const withStats = withDerivedStats(activity);
  withStats.metadata.startTime = withStats.derived?.startTime;
  withStats.metadata.endTime = withStats.derived?.endTime;
  return withStats;
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `activity-${Date.now()}`;
}

/**
 * `GPS5` is `[lat, lon, alt, 2D speed, 3D speed]` with its fix and precision in
 * `sticky`, where precision is DOP × 100. `GPS9` appends `[…, days, secs, DOP,
 * fix]` and carries no sticky at all. Same measurements, two shapes.
 *
 * **Sticky means stated once and implied thereafter.** The library emits such a
 * value only when it changes, so a reading taken per sample sees it on the
 * first and `undefined` on every one after. GoPro's HERO8 sample is exactly
 * that: `fix: 0` on sample one, nothing on the remaining 230 — and reading it
 * naively lets all 230 through as though their quality were unknown. The last
 * stated value is carried forward, which is what sticky means.
 */
class QualityReader {
  private fix: number | undefined;
  private dop: number | undefined;

  constructor(private readonly streamKey: string) {}

  read(sample: GoproSample): { fix: number | undefined; dop: number | undefined } {
    if (this.streamKey === 'GPS9') {
      // Per-sample, so nothing is carried: GPS9 states both every time.
      return { fix: sample.value?.[8], dop: sample.value?.[7] };
    }

    if (sample.sticky?.fix !== undefined) this.fix = sample.sticky.fix;
    if (sample.sticky?.precision !== undefined) this.dop = sample.sticky.precision / 100;

    return { fix: this.fix, dop: this.dop };
  }
}

function readPoints(
  samples: GoproSample[],
  streamKey: string,
): { points: ActivityPoint[]; rejected: number } {
  const points: ActivityPoint[] = [];
  const quality = new QualityReader(streamKey);
  let rejected = 0;

  for (const sample of samples) {
    const { fix, dop } = quality.read(sample);

    // A position the receiver never established is not a place the camera was.
    if (fix !== undefined && fix < MIN_GPS_FIX) {
      rejected += 1;
      continue;
    }
    if (dop !== undefined && dop > MAX_GPS_DOP) {
      rejected += 1;
      continue;
    }

    const located = toValidCoordinate(sample.value?.[0], sample.value?.[1]);
    if (!located) {
      rejected += 1;
      continue;
    }

    const point: ActivityPoint = { index: points.length, lat: located.lat, lon: located.lon };

    const altitude = sample.value?.[2];
    if (Number.isFinite(altitude)) point.elevationMeters = altitude;

    // Ground speed, not the 3D figure: an activity's speed is how fast it
    // moved over the ground, which is what every other format states.
    const speed = sample.value?.[3];
    if (Number.isFinite(speed)) point.speedMetersPerSecond = speed;

    if (sample.date instanceof Date && !Number.isNaN(sample.date.getTime())) {
      point.time = sample.date;
    }

    points.push(point);
  }

  return { points, rejected };
}
