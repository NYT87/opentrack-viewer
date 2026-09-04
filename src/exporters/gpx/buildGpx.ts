import {
  hasValidLocation,
  isPlausibleSpeed,
  type Activity,
  type ActivityPoint,
  type ActivityWarning,
} from '../../domain/activity';
import { ActivityError } from '../../domain/errors';

/** Written into the `creator` attribute when the source file named no one. */
export const EXPORT_CREATOR = 'OpenTrack Viewer';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const TPX_NS = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';
const PWR_NS = 'http://www.garmin.com/xmlschemas/PowerExtension/v1';

/**
 * XML text escaping. Applied to every value that reaches the document, without
 * exception: an activity name is user-controlled text that arrived from a file,
 * and an unescaped `&` alone is enough to produce a document this app cannot
 * read back.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Coordinates keep seven decimals — about a centimetre, past any GPS's truth. */
function coordinate(value: number): string {
  return value.toFixed(7);
}

function decimal(value: number, places: number): string {
  return Number(value.toFixed(places)).toString();
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * AV-551. Serializes a normalized activity as GPX 1.1.
 *
 * Built as text rather than through the DOM so it can run in a worker later
 * (plan §14), and because `XMLSerializer` would still need every value escaped
 * by hand on the way in.
 *
 * Privacy (plan §5): the device serial number is never written. The app refuses
 * to display it, so writing it into a file the user is likely to share would
 * make the export the one place it leaks.
 */
export function buildGpx(activity: Activity): { xml: string; warnings: ActivityWarning[] } {
  const warnings: ActivityWarning[] = [];
  const points = activity.points;
  // The same test the map and the stats apply, so a point this app refuses to
  // draw is not one it writes: out of range, or Null Island, is not a position.
  const positioned = points.filter(hasValidLocation);

  if (positioned.length === 0) {
    throw new ActivityError(
      'no_location_stream',
      'This activity has no GPS coordinates, so there is nothing to write to a GPX track.',
    );
  }

  const skipped = points.length - positioned.length;
  if (skipped > 0) {
    warnings.push({
      code: 'export_points_without_position',
      message:
        `${skipped} of ${points.length} points have no usable coordinates and are left out: a ` +
        'GPX track point cannot exist without a position.',
      severity: 'info',
    });
  }

  collectLossWarnings(activity, positioned, warnings);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<gpx version="1.1" creator="${escapeXml(activity.metadata.creator ?? EXPORT_CREATOR)}"` +
      ` xmlns="${GPX_NS}" xmlns:gpxtpx="${TPX_NS}" xmlns:gpxpx="${PWR_NS}">`,
  );

  lines.push('  <metadata>');
  if (activity.metadata.name) lines.push(`    <name>${escapeXml(activity.metadata.name)}</name>`);
  if (activity.metadata.description) {
    lines.push(`    <desc>${escapeXml(activity.metadata.description)}</desc>`);
  }
  if (activity.derived?.startTime) {
    lines.push(`    <time>${activity.derived.startTime.toISOString()}</time>`);
  }
  lines.push('  </metadata>');

  lines.push('  <trk>');
  if (activity.metadata.name) lines.push(`    <name>${escapeXml(activity.metadata.name)}</name>`);
  const sport = activity.metadata.sport;
  if (sport && sport !== 'unknown') lines.push(`    <type>${escapeXml(sport)}</type>`);

  // One <trkseg> per recorded segment, so a pause stays a pause: joining them
  // would invent both distance and a straight line the athlete never took.
  for (const segment of groupBySegment(positioned)) {
    lines.push('    <trkseg>');
    for (const point of segment) lines.push(...trackPoint(point));
    lines.push('    </trkseg>');
  }

  lines.push('  </trk>');
  lines.push('</gpx>');

  return { xml: `${lines.join('\n')}\n`, warnings };
}

function groupBySegment(points: (ActivityPoint & { lat: number; lon: number })[]) {
  const segments: (ActivityPoint & { lat: number; lon: number })[][] = [];
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

function trackPoint(point: ActivityPoint & { lat: number; lon: number }): string[] {
  const lines = [`      <trkpt lat="${coordinate(point.lat)}" lon="${coordinate(point.lon)}">`];

  if (isFinite(point.elevationMeters)) {
    lines.push(`        <ele>${decimal(point.elevationMeters, 3)}</ele>`);
  }
  if (point.time instanceof Date && !Number.isNaN(point.time.getTime())) {
    lines.push(`        <time>${point.time.toISOString()}</time>`);
  }

  // GPX has no field of its own for sensor data; every device writes Garmin's
  // TrackPointExtension instead, so that is what this reads and writes.
  const cadence = point.runningCadenceSpm ?? point.cyclingCadenceRpm;
  const tpx: string[] = [];
  if (isFinite(point.heartRateBpm)) {
    tpx.push(`<gpxtpx:hr>${Math.round(point.heartRateBpm)}</gpxtpx:hr>`);
  }
  if (isFinite(cadence)) tpx.push(`<gpxtpx:cad>${Math.round(cadence)}</gpxtpx:cad>`);
  if (isFinite(point.temperatureCelsius)) {
    tpx.push(`<gpxtpx:atemp>${decimal(point.temperatureCelsius, 1)}</gpxtpx:atemp>`);
  }
  // Range-checked on the way out as well as in: a value the charts refuse to
  // plot is not one to hand to another application as fact.
  const speed = point.speedMetersPerSecond;
  if (isPlausibleSpeed(speed)) {
    tpx.push(`<gpxtpx:speed>${decimal(speed, 3)}</gpxtpx:speed>`);
  }

  const power = point.powerWatts;
  if (tpx.length > 0 || isFinite(power)) {
    lines.push('        <extensions>');
    if (tpx.length > 0) {
      lines.push(`          <gpxtpx:TrackPointExtension>${tpx.join('')}</gpxtpx:TrackPointExtension>`);
    }
    if (isFinite(power)) {
      lines.push(
        `          <gpxpx:PowerExtension><gpxpx:PowerInWatts>${Math.round(power)}` +
          '</gpxpx:PowerInWatts></gpxpx:PowerExtension>',
      );
    }
    lines.push('        </extensions>');
  }

  lines.push('      </trkpt>');
  return lines;
}

/**
 * AV-551. Names what GPX cannot carry cleanly, so the user learns it from the
 * export rather than from a file that quietly lost something.
 */
function collectLossWarnings(
  activity: Activity,
  positioned: ActivityPoint[],
  warnings: ActivityWarning[],
): void {
  if (activity.laps && activity.laps.length > 0) {
    warnings.push({
      code: 'export_laps_dropped',
      message:
        `GPX has no lap structure, so this activity's ${activity.laps.length} laps are not ` +
        'written. The track itself is unchanged.',
      severity: 'info',
    });
  }

  if (activity.streams.hasPower || activity.streams.hasTemperature || activity.streams.hasSpeed) {
    warnings.push({
      code: 'export_extension_fields',
      message:
        'Power, temperature and speed are written as Garmin extensions, which GPX does not ' +
        'define. Some applications ignore them.',
      severity: 'info',
    });
  }

  // GPX states a cadence number but never its unit, which is the same ambiguity
  // the importer has to guess its way out of.
  if (activity.streams.hasRunningCadence || activity.streams.hasCyclingCadence) {
    warnings.push({
      code: 'export_cadence_unit_lost',
      message:
        'Cadence is written as a bare number, because GPX has no way to say whether it means ' +
        'strides or pedal revolutions. Reading it back relies on the activity type.',
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

  const withoutTime = positioned.filter(
    (point) => !(point.time instanceof Date) || Number.isNaN(point.time.getTime()),
  ).length;
  if (withoutTime > 0 && withoutTime < positioned.length) {
    warnings.push({
      code: 'export_points_without_time',
      message: `${withoutTime} points have no timestamp and are written without one.`,
      severity: 'info',
    });
  }
}
