import { computeStreams, type Activity, type ActivityPoint } from '../../domain/activity';
import { withDerivedStats } from '../../domain/stats';

/**
 * AV-1109. Synthesized copies of the two Garmin Connect rides the task names,
 * built in memory rather than committed.
 *
 * The originals are a morning ride and its continuation 74 minutes later, near
 * Imabari on 2026-09-24. Their shape is kept exactly, because that is what the
 * merge is tested against: the file names, the point counts (5,817 and
 * 10,465), the first and last timestamps, one track segment each, a stop
 * inside each where the position holds still, and the second starting a few
 * tens of metres from where the first ended. Their places are not: the route
 * here is a made-up curve in open country, so no one's real rides are in the
 * repository (the originals are a person's location history, and the privacy
 * model has no room for committing that). The same generator feeds the unit
 * and the browser tests, so both test the same two files.
 */

export interface RideFixture {
  fileName: string;
  name: string;
  pointCount: number;
  start: string;
  end: string;
  /** Seconds of the one stop inside the ride, where the rider stood still. */
  stopSeconds: number;
}

export const MORNING_RIDE: RideFixture = {
  fileName: 'activity_24573607104.gpx',
  name: 'Imabari City Cycling',
  pointCount: 5_817,
  start: '2026-09-23T23:55:51.000Z',
  end: '2026-09-24T02:11:48.000Z',
  stopSeconds: 601,
};

export const AFTERNOON_RIDE: RideFixture = {
  fileName: 'activity_24573607127.gpx',
  name: 'Imabari City Cycling',
  pointCount: 10_465,
  start: '2026-09-24T03:26:17.000Z',
  end: '2026-09-24T07:36:36.000Z',
  stopSeconds: 900,
};

/** 02:11:48 to 03:26:17: the pause between the two, 74 minutes and 29 seconds. */
export const PAUSE_SECONDS = 4_469;

const ORIGIN = { lat: 46.2, lon: 7.1 };
const METERS_PER_DEGREE = 111_320;

interface Sample {
  time: number;
  lat: number;
  lon: number;
  ele: number;
}

/**
 * The ride's samples. Steps are one or two seconds, with exactly as many
 * two-second steps as the first-to-last span needs, and one stop a third of
 * the way in; the rider moves at 5 to 7 m/s along a slowly turning heading.
 */
function samples(ride: RideFixture, from: { lat: number; lon: number }, phase: number): Sample[] {
  const start = Date.parse(ride.start);
  const span = (Date.parse(ride.end) - start) / 1000;
  const intervals = ride.pointCount - 1;
  const moving = intervals - 1;
  const doubles = span - ride.stopSeconds - moving;
  const stopAt = Math.floor(intervals / 3);
  const out: Sample[] = [];
  let time = start;
  let { lat, lon } = from;
  let k = 0;
  for (let i = 0; i < ride.pointCount; i += 1) {
    out.push({
      time,
      lat,
      lon,
      ele: Math.round((7 + 30 * (1 - Math.cos((i + phase) / 800))) * 10) / 10,
    });
    if (i === intervals) break;
    let step: number;
    if (i === stopAt) {
      step = ride.stopSeconds;
    } else {
      step = Math.floor(((k + 1) * doubles) / moving) > Math.floor((k * doubles) / moving) ? 2 : 1;
      k += 1;
      const speed = 6 + Math.sin((i + phase) / 300);
      const heading = (i + phase) / 700;
      const meters = speed * step;
      lat += (meters * Math.cos(heading)) / METERS_PER_DEGREE;
      lon += (meters * Math.sin(heading)) / (METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
    }
    time += step * 1000;
  }
  return out;
}

function toGpx(ride: RideFixture, points: Sample[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx creator="Garmin Connect" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">',
    `  <metadata><time>${new Date(Date.parse(ride.start) - 1000).toISOString()}</time></metadata>`,
    '  <trk>',
    `    <name>${ride.name}</name>`,
    '    <type>cycling</type>',
    '    <trkseg>',
  ];
  for (const point of points) {
    lines.push(
      `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}"><ele>${point.ele}</ele>` +
        `<time>${new Date(point.time).toISOString()}</time></trkpt>`,
    );
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}

let cachedSamples: { morning: Sample[]; afternoon: Sample[] } | undefined;

/** The afternoon ride starts 40 m north of where the morning one ended. */
function rideSamples(): { morning: Sample[]; afternoon: Sample[] } {
  if (cachedSamples) return cachedSamples;
  const morning = samples(MORNING_RIDE, ORIGIN, 0);
  const end = morning.at(-1)!;
  const afternoon = samples(AFTERNOON_RIDE, { lat: end.lat + 40 / METERS_PER_DEGREE, lon: end.lon }, 5_000);
  cachedSamples = { morning, afternoon };
  return cachedSamples;
}

/** Both rides as GPX text, as the browser tests hand them to the page. */
export function buildMergeRides(): { morning: string; afternoon: string } {
  const { morning, afternoon } = rideSamples();
  return { morning: toGpx(MORNING_RIDE, morning), afternoon: toGpx(AFTERNOON_RIDE, afternoon) };
}

/**
 * Both rides as the activities the GPX parser makes of that text: the same
 * points, the same fields, one segment. Built directly because jsdom reads
 * 16,000 points of XML in minutes; the unit tests check the reading itself on
 * a short ride, and the browser tests read these files whole.
 */
export function buildMergeRideActivities(): { morning: Activity; afternoon: Activity } {
  const { morning, afternoon } = rideSamples();
  const activity = (ride: RideFixture, list: Sample[]): Activity => {
    const points: ActivityPoint[] = list.map((sample, index) => ({
      index,
      time: new Date(sample.time),
      // As written to the file: seven decimals.
      lat: Number(sample.lat.toFixed(7)),
      lon: Number(sample.lon.toFixed(7)),
      elevationMeters: sample.ele,
      segmentIndex: 0,
    }));
    return withDerivedStats({
      id: ride.fileName,
      source: { format: 'gpx', fileName: ride.fileName, parserVersion: 'fixture' },
      metadata: { name: ride.name, sport: 'cycling', creator: 'Garmin Connect' },
      points,
      streams: computeStreams(points),
      warnings: [],
    });
  };
  return { morning: activity(MORNING_RIDE, morning), afternoon: activity(AFTERNOON_RIDE, afternoon) };
}
