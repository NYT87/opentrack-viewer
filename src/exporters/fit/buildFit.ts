import { FitBaseType, FitEncoder, type FitEncoderField } from 'fit-file-parser';
import {
  hasValidLocation,
  isPlausibleSpeed,
  type Activity,
  type ActivityPoint,
  type ActivitySport,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';

/** Global message numbers, from the FIT profile (TD-021). */
const MSG = {
  fileId: 0,
  sport: 12,
  session: 18,
  lap: 19,
  record: 20,
  event: 21,
  activity: 34,
} as const;

/** One local id per message type, so each definition is written once. */
const LOCAL = { fileId: 0, sport: 1, event: 2, record: 3, lap: 4, session: 5, activity: 6 } as const;

const FILE_TYPE_ACTIVITY = 4;
/** FIT's registered id for software that is not a hardware manufacturer. */
const MANUFACTURER_DEVELOPMENT = 255;
const EVENT_TIMER = 0;
const EVENT_SESSION = 8;
const EVENT_ACTIVITY = 26;
const EVENT_TYPE_START = 0;
const EVENT_TYPE_STOP = 1;
const ACTIVITY_TYPE_MANUAL = 0;

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

/**
 * FIT sport ids. Our `skiing` covers three of theirs, so it exports as alpine —
 * a lossy but honest choice, since the model never recorded which it was.
 */
const SPORT_IDS: Record<ActivitySport, number> = {
  running: 1,
  cycling: 2,
  walking: 11,
  hiking: 17,
  swimming: 5,
  rowing: 15,
  skiing: 13,
  other: 0,
  unknown: 0,
};

/**
 * FIT marks a field as absent by writing the maximum value of its base type
 * (the sign bit's worth less, for signed types). Every record shares one
 * definition, so a point missing a value writes the invalid marker rather than
 * forcing a second definition message.
 */
const INVALID = {
  uint8: 0xff,
  sint8: 0x7f,
  uint16: 0xffff,
  uint32: 0xffffffff,
  sint32: 0x7fffffff,
} as const;

interface RecordField {
  number: number;
  size: number;
  baseType: FitBaseType;
  invalid: number;
  /** Already scaled to the units FIT stores. */
  read: (point: ActivityPoint, context: WriteContext) => number | undefined;
}

interface WriteContext {
  /**
   * The first recorded distance in the activity being written. A slice keeps
   * its source's readings, so a section starting 160 m into a ride still says
   * 160 — and a file whose odometer starts there describes a ride that began
   * mid-air. Subtracting it makes the exported stream describe the exported
   * activity, which is the only thing the file claims to contain.
   */
  distanceOrigin: number;
}

const round = (value: number) => Math.round(value);
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Every record field this exporter can write, in FIT field-number order. */
const RECORD_FIELDS: (RecordField & { needs: (activity: Activity) => boolean })[] = [
  {
    number: 0,
    size: 4,
    baseType: FitBaseType.Sint32,
    invalid: INVALID.sint32,
    needs: (a) => a.streams.hasLocation,
    read: (p) => (hasValidLocation(p) ? round(p.lat * SEMICIRCLES_PER_DEGREE) : undefined),
  },
  {
    number: 1,
    size: 4,
    baseType: FitBaseType.Sint32,
    invalid: INVALID.sint32,
    needs: (a) => a.streams.hasLocation,
    read: (p) => (hasValidLocation(p) ? round(p.lon * SEMICIRCLES_PER_DEGREE) : undefined),
  },
  {
    number: 2,
    size: 2,
    baseType: FitBaseType.Uint16,
    invalid: INVALID.uint16,
    needs: (a) => a.streams.hasElevation,
    // Stored as (metres + 500) * 5, which is why a sea-level point is not zero.
    read: (p) =>
      finite(p.elevationMeters) ? clamp(round((p.elevationMeters + 500) * 5), 0, 65534) : undefined,
  },
  {
    number: 3,
    size: 1,
    baseType: FitBaseType.Uint8,
    invalid: INVALID.uint8,
    needs: (a) => a.streams.hasHeartRate,
    read: (p) => (finite(p.heartRateBpm) ? clamp(round(p.heartRateBpm), 0, 254) : undefined),
  },
  {
    number: 4,
    size: 1,
    baseType: FitBaseType.Uint8,
    invalid: INVALID.uint8,
    needs: (a) => a.streams.hasRunningCadence || a.streams.hasCyclingCadence,
    read: (p) => {
      const cadence = p.runningCadenceSpm ?? p.cyclingCadenceRpm;
      return finite(cadence) ? clamp(round(cadence), 0, 254) : undefined;
    },
  },
  {
    number: 5,
    size: 4,
    baseType: FitBaseType.Uint32,
    invalid: INVALID.uint32,
    needs: (a) => a.streams.hasDistance,
    read: (p, context) =>
      finite(p.distanceMeters)
        ? round(Math.max(0, p.distanceMeters - context.distanceOrigin) * 100)
        : undefined,
  },
  {
    number: 6,
    size: 2,
    baseType: FitBaseType.Uint16,
    invalid: INVALID.uint16,
    needs: (a) => a.streams.hasSpeed,
    // Range-checked on the way out as well as in: a value the charts refuse to
    // plot is not one to hand to another application as fact.
    read: (p) =>
      isPlausibleSpeed(p.speedMetersPerSecond)
        ? clamp(round(p.speedMetersPerSecond * 1000), 0, 65534)
        : undefined,
  },
  {
    number: 7,
    size: 2,
    baseType: FitBaseType.Uint16,
    invalid: INVALID.uint16,
    needs: (a) => a.streams.hasPower,
    read: (p) => (finite(p.powerWatts) ? clamp(round(p.powerWatts), 0, 65534) : undefined),
  },
  {
    number: 13,
    size: 1,
    baseType: FitBaseType.Sint8,
    invalid: INVALID.sint8,
    needs: (a) => a.streams.hasTemperature,
    read: (p) =>
      finite(p.temperatureCelsius) ? clamp(round(p.temperatureCelsius), -128, 126) : undefined,
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const enumField = (number: number, value: number): FitEncoderField => ({
  number,
  size: 1,
  baseType: FitBaseType.Enum,
  value,
});
const u16 = (number: number, value: number): FitEncoderField => ({
  number,
  size: 2,
  baseType: FitBaseType.Uint16,
  value,
});
const u32 = (number: number, value: number): FitEncoderField => ({
  number,
  size: 4,
  baseType: FitBaseType.Uint32,
  value,
});

const hasTime = (point: ActivityPoint): point is ActivityPoint & { time: Date } =>
  point.time instanceof Date && !Number.isNaN(point.time.getTime());

/**
 * AV-553. Writes a normalized activity as a FIT activity file, following the
 * minimal profile agreed in TD-021.
 *
 * The binary container — header, definition records, base types, CRC — belongs
 * to `FitEncoder`. What lives here is the profile mapping: which field number
 * carries which measurement, and the scale and offset FIT stores it at.
 *
 * Privacy (plan §5, TD-020): no serial number is written, in any message. The
 * file declares this app as its creator rather than reproducing the identity of
 * the device that made the original recording.
 */
export function buildFit(activity: Activity): { bytes: Uint8Array; warnings: ActivityWarning[] } {
  const warnings: ActivityWarning[] = [];
  const timed = activity.points.filter(hasTime);

  if (timed.length === 0) {
    throw new ActivityError(
      'fit_parse_failed',
      'This activity has no timestamps. A FIT file keys every record by time, so there is ' +
        'nothing to write.',
    );
  }

  collectLossWarnings(activity, timed, warnings);

  const encoder = new FitEncoder();
  const start = timed[0]!.time;
  const end = timed.at(-1)!.time;
  const stamp = (date: Date) => FitEncoder.toFitTimestamp(date);

  encoder.writeMessage(
    MSG.fileId,
    [
      enumField(0, FILE_TYPE_ACTIVITY),
      u16(1, MANUFACTURER_DEVELOPMENT),
      u32(4, stamp(start)),
    ],
    LOCAL.fileId,
  );

  const sport = activity.metadata.sport ?? 'unknown';
  encoder.writeMessage(MSG.sport, [enumField(0, SPORT_IDS[sport])], LOCAL.sport);

  // One definition for every record, so the fields are those the activity has
  // as a whole; a point missing one writes FIT's invalid marker.
  const fields = RECORD_FIELDS.filter((field) => field.needs(activity));
  const context: WriteContext = { distanceOrigin: firstDistance(timed) };

  for (const segment of groupBySegment(timed)) {
    const first = segment[0]!;
    const last = segment.at(-1)!;

    // A pause is a stopped timer, which is what makes the gap a gap rather than
    // a stretch the athlete covered impossibly fast.
    encoder.writeMessage(
      MSG.event,
      [u32(253, stamp(first.time)), enumField(0, EVENT_TIMER), enumField(1, EVENT_TYPE_START)],
      LOCAL.event,
    );

    for (const point of segment) {
      encoder.writeMessage(
        MSG.record,
        [
          u32(253, stamp(point.time)),
          ...fields.map((field): FitEncoderField => ({
            number: field.number,
            size: field.size,
            baseType: field.baseType,
            value: field.read(point, context) ?? field.invalid,
          })),
        ],
        LOCAL.record,
      );
    }

    encoder.writeMessage(
      MSG.event,
      [u32(253, stamp(last.time)), enumField(0, EVENT_TIMER), enumField(1, EVENT_TYPE_STOP)],
      LOCAL.event,
    );
  }

  for (const lap of activity.laps ?? []) {
    const lapStart = lap.startTime ?? start;
    const lapEnd = lap.endTime ?? end;
    encoder.writeMessage(
      MSG.lap,
      [
        u32(253, stamp(lapEnd)),
        u32(2, stamp(lapStart)),
        u32(7, round((lap.durationSeconds ?? 0) * 1000)),
        u32(9, round((lap.distanceMeters ?? 0) * 100)),
      ],
      LOCAL.lap,
    );
  }

  const elapsedSeconds = activity.derived?.durationSeconds ?? (end.getTime() - start.getTime()) / 1000;
  const movingSeconds = activity.derived?.movingDurationSeconds ?? elapsedSeconds;
  encoder.writeMessage(
    MSG.session,
    [
      u32(253, stamp(end)),
      enumField(0, EVENT_SESSION),
      enumField(1, EVENT_TYPE_STOP),
      u32(2, stamp(start)),
      enumField(5, SPORT_IDS[sport]),
      u32(7, round(elapsedSeconds * 1000)),
      u32(8, round(movingSeconds * 1000)),
      u32(9, round((activity.derived?.distanceMeters ?? 0) * 100)),
    ],
    LOCAL.session,
  );

  encoder.writeMessage(
    MSG.activity,
    [
      u32(253, stamp(end)),
      u32(0, round(movingSeconds * 1000)),
      u16(1, 1),
      enumField(2, ACTIVITY_TYPE_MANUAL),
      enumField(3, EVENT_ACTIVITY),
      enumField(4, EVENT_TYPE_STOP),
    ],
    LOCAL.activity,
  );

  return { bytes: encoder.close(), warnings };
}

/** The reading every other distance in the exported file is measured from. */
function firstDistance(points: ActivityPoint[]): number {
  for (const point of points) if (finite(point.distanceMeters)) return point.distanceMeters;
  return 0;
}

function groupBySegment(points: (ActivityPoint & { time: Date })[]) {
  const segments: (ActivityPoint & { time: Date })[][] = [];
  let current = -1;
  for (const point of points) {
    const segment = point.segmentIndex ?? 0;
    if (segment !== current || segments.length === 0) {
      segments.push([]);
      current = segment;
    }
    segments.at(-1)!.push(point);
  }
  return segments;
}

/** AV-553. What FIT omits or approximates, said out loud. */
function collectLossWarnings(
  activity: Activity,
  timed: ActivityPoint[],
  warnings: ActivityWarning[],
): void {
  const untimed = activity.points.length - timed.length;
  if (untimed > 0) {
    warnings.push({
      code: 'export_points_without_time',
      message:
        `${untimed} of ${activity.points.length} points have no timestamp and are left out: a ` +
        'FIT record cannot exist without one.',
      severity: 'info',
    });
  }

  if (timed.some((point) => point.time!.getMilliseconds() !== 0)) {
    warnings.push({
      code: 'export_subsecond_time_lost',
      message: 'FIT stores whole seconds, so fractions of a second are rounded away.',
      severity: 'info',
    });
  }

  if (activity.streams.hasRunningCadence || activity.streams.hasCyclingCadence) {
    warnings.push({
      code: 'export_cadence_unit_lost',
      message:
        'Cadence is written to a single FIT field, which does not say whether it means strides ' +
        'or pedal revolutions. Reading it back relies on the activity type.',
      severity: 'info',
    });
  }

  if (activity.metadata.sport === 'skiing') {
    warnings.push({
      code: 'export_sport_approximated',
      message: 'FIT separates alpine, cross-country and snowboarding; this is written as alpine.',
      severity: 'info',
    });
  }

  if (activity.metadata.device || activity.metadata.creator) {
    warnings.push({
      code: 'export_device_not_reproduced',
      message:
        'The file names this app as its creator rather than the device that made the original ' +
        'recording, and no serial number is written.',
      severity: 'info',
    });
  }
}
