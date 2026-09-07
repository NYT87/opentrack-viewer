import {
  hasValidLocation,
  isPlausibleSpeed,
  type Activity,
  type ActivityPoint,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';

const TCX_NS = 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2';
const TPX_NS = 'http://www.garmin.com/xmlschemas/ActivityExtension/v2';

/** TCX names three sports. Everything else this app models becomes `Other`. */
function tcxSport(activity: Activity): string {
  if (activity.metadata.sport === 'running') return 'Running';
  if (activity.metadata.sport === 'cycling') return 'Biking';
  return 'Other';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const decimal = (value: number, places: number) => Number(value.toFixed(places)).toString();
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const hasTime = (point: ActivityPoint): point is ActivityPoint & { time: Date } =>
  point.time instanceof Date && !Number.isNaN(point.time.getTime());

/**
 * AV-752. Serializes a normalized activity as TCX, following TD-023.
 *
 * Built as text rather than through the DOM, like the GPX writer, so it can run
 * in a worker later and because `XMLSerializer` would still need every value
 * escaped by hand on the way in.
 *
 * Privacy (plan §5, TD-020): no `UnitId` is written. The app refuses to display
 * the device serial, so an exported file is not where it starts appearing.
 */
export function buildTcx(activity: Activity): { xml: string; warnings: ActivityWarning[] } {
  const warnings: ActivityWarning[] = [];
  const timed = activity.points.filter(hasTime);

  if (timed.length === 0) {
    throw new ActivityError(
      'invalid_tcx_xml',
      'This activity has no timestamps. Every TCX track point needs a time, and a lap is ' +
        'defined by when it started, so there is nothing to write.',
    );
  }

  collectLossWarnings(activity, timed, warnings);

  const start = timed[0]!.time;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<TrainingCenterDatabase xmlns="${TCX_NS}" xmlns:ns3="${TPX_NS}">`);
  lines.push('  <Activities>');
  lines.push(`    <Activity Sport="${tcxSport(activity)}">`);
  // TCX identifies an activity by when it began; there is no name field.
  lines.push(`      <Id>${start.toISOString()}</Id>`);

  /*
   * A slice keeps its source's distance readings, so a section starting 160 m
   * into a ride still says 160. Measuring from the first reading makes the
   * exported stream describe the exported activity, which is the only thing
   * this file claims to contain.
   */
  const distanceOrigin = firstDistance(timed);
  for (const lap of buildLaps(activity, timed)) lines.push(...lapElement(lap, distanceOrigin));

  const creator = activity.metadata.creator ?? activity.metadata.device?.name;
  if (creator) {
    lines.push('      <Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">');
    lines.push(`        <Name>${escapeXml(creator)}</Name>`);
    lines.push('      </Creator>');
  }

  lines.push('    </Activity>');
  lines.push('  </Activities>');
  lines.push('</TrainingCenterDatabase>');

  return { xml: `${lines.join('\n')}\n`, warnings };
}

interface TcxLap {
  startTime: Date;
  durationSeconds: number;
  distanceMeters: number;
  caloriesKcal: number;
  /** One per continuous stretch of recording. */
  tracks: (ActivityPoint & { time: Date })[][];
}

/**
 * TD-023. A `Track` exists only inside a `Lap`, and the schema requires at
 * least one lap — so an activity without laps still gets one, covering the
 * whole track. Segments become separate `Track` elements within it, which is
 * how TCX records a pause.
 */
function buildLaps(activity: Activity, timed: (ActivityPoint & { time: Date })[]): TcxLap[] {
  const tracks = groupBySegment(timed);
  const first = timed[0]!.time;
  const last = timed.at(-1)!.time;

  return [
    {
      startTime: first,
      durationSeconds:
        activity.derived?.durationSeconds ?? (last.getTime() - first.getTime()) / 1000,
      distanceMeters: activity.derived?.distanceMeters ?? 0,
      // Summed only from laps that state it; a file that says nothing says 0,
      // which the schema requires rather than allowing the element to be absent.
      caloriesKcal: (activity.laps ?? []).reduce(
        (total, lap) => total + (finite(lap.caloriesKcal) ? lap.caloriesKcal : 0),
        0,
      ),
      tracks,
    },
  ];
}

/** The reading every other distance in the exported file is measured from. */
function firstDistance(points: ActivityPoint[]): number {
  for (const point of points) if (finite(point.distanceMeters)) return point.distanceMeters;
  return 0;
}

function lapElement(lap: TcxLap, distanceOrigin: number): string[] {
  const lines = [`      <Lap StartTime="${lap.startTime.toISOString()}">`];
  lines.push(`        <TotalTimeSeconds>${decimal(lap.durationSeconds, 2)}</TotalTimeSeconds>`);
  lines.push(`        <DistanceMeters>${decimal(lap.distanceMeters, 2)}</DistanceMeters>`);
  lines.push(`        <Calories>${Math.round(lap.caloriesKcal)}</Calories>`);
  lines.push('        <Intensity>Active</Intensity>');
  lines.push('        <TriggerMethod>Manual</TriggerMethod>');

  for (const track of lap.tracks) {
    lines.push('        <Track>');
    for (const point of track) lines.push(...trackpoint(point, distanceOrigin));
    lines.push('        </Track>');
  }

  lines.push('      </Lap>');
  return lines;
}

function trackpoint(point: ActivityPoint & { time: Date }, distanceOrigin: number): string[] {
  const lines = ['          <Trackpoint>'];
  lines.push(`            <Time>${point.time.toISOString()}</Time>`);

  if (hasValidLocation(point)) {
    lines.push('            <Position>');
    lines.push(`              <LatitudeDegrees>${point.lat.toFixed(7)}</LatitudeDegrees>`);
    lines.push(`              <LongitudeDegrees>${point.lon.toFixed(7)}</LongitudeDegrees>`);
    lines.push('            </Position>');
  }
  if (finite(point.elevationMeters)) {
    lines.push(`            <AltitudeMeters>${decimal(point.elevationMeters, 3)}</AltitudeMeters>`);
  }
  if (finite(point.distanceMeters)) {
    const travelled = Math.max(0, point.distanceMeters - distanceOrigin);
    lines.push(`            <DistanceMeters>${decimal(travelled, 2)}</DistanceMeters>`);
  }
  if (finite(point.heartRateBpm)) {
    lines.push(
      `            <HeartRateBpm><Value>${Math.round(point.heartRateBpm)}</Value></HeartRateBpm>`,
    );
  }
  // The schema's Cadence is bike cadence; running cadence is an extension.
  if (finite(point.cyclingCadenceRpm)) {
    lines.push(`            <Cadence>${Math.round(point.cyclingCadenceRpm)}</Cadence>`);
  }

  const extensions: string[] = [];
  const speed = point.speedMetersPerSecond;
  if (isPlausibleSpeed(speed)) extensions.push(`<ns3:Speed>${decimal(speed, 3)}</ns3:Speed>`);
  if (finite(point.powerWatts)) {
    extensions.push(`<ns3:Watts>${Math.round(point.powerWatts)}</ns3:Watts>`);
  }
  if (finite(point.runningCadenceSpm)) {
    extensions.push(`<ns3:RunCadence>${Math.round(point.runningCadenceSpm)}</ns3:RunCadence>`);
  }
  if (extensions.length > 0) {
    lines.push(`            <Extensions><ns3:TPX>${extensions.join('')}</ns3:TPX></Extensions>`);
  }

  lines.push('          </Trackpoint>');
  return lines;
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

/** AV-752. What TCX cannot carry cleanly, said out loud. */
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
        'TCX track point cannot exist without one.',
      severity: 'info',
    });
  }

  const sport = activity.metadata.sport;
  if (sport && sport !== 'running' && sport !== 'cycling' && sport !== 'unknown') {
    warnings.push({
      code: 'export_sport_approximated',
      message:
        `TCX has only Running, Biking and Other, so "${sport}" is written as Other and cannot ` +
        'be recovered by reading the file back.',
      severity: 'info',
    });
  }

  if (activity.streams.hasTemperature) {
    warnings.push({
      code: 'export_temperature_dropped',
      message: 'TCX defines no temperature field, standard or extension, so it is not written.',
      severity: 'info',
    });
  }

  const laps = activity.laps ?? [];
  if (laps.length > 1) {
    warnings.push({
      code: 'export_laps_merged',
      message:
        `This activity's ${laps.length} laps are written as one lap covering the whole track. ` +
        'Its pauses are preserved as separate tracks within it.',
      severity: 'info',
    });
  }

  if (activity.metadata.device?.serialNumber) {
    warnings.push({
      code: 'export_serial_omitted',
      message: 'The recording device’s serial number is deliberately left out of the export.',
      severity: 'info',
    });
  }
}
