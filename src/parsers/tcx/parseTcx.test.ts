import { describe, expect, it } from 'vitest';
import { parseTcx, TCX_PARSER_VERSION } from './parseTcx';
import { ActivityError } from '../../domain/errors';
import { readFixture } from '../../test/helpers/fixtures';
import { DISPLAYABLE_DEVICE_FIELDS } from '../../domain/activity';
import { buildSeries } from '../../domain/series';
import { getChartAvailability } from '../../domain/charts';

const parse = (fixture: string) =>
  parseTcx(readFixture(fixture), { fileName: fixture, idFactory: () => 'fixed-id' });

describe('parseTcx (AV-751)', () => {
  it('reads track points from inside the laps that hold them', () => {
    const activity = parse('run-with-laps.tcx');

    expect(activity.points).toHaveLength(5);
    expect(activity.points[0]).toMatchObject({
      index: 0,
      elevationMeters: 15,
      distanceMeters: 0,
      heartRateBpm: 142,
      runningCadenceSpm: 84,
      speedMetersPerSecond: 3.33,
    });
    expect(activity.points[0]?.lat).toBeCloseTo(51.5, 6);
    expect(activity.points[0]?.lon).toBeCloseTo(-0.1, 6);
    expect(activity.points[0]?.time?.toISOString()).toBe('2024-05-01T07:00:00.000Z');
  });

  it('records source metadata', () => {
    const activity = parse('run-with-laps.tcx');

    expect(activity.source).toEqual({
      format: 'tcx',
      fileName: 'run-with-laps.tcx',
      fileSizeBytes: undefined,
      parserVersion: TCX_PARSER_VERSION,
    });
    expect(activity.metadata.sport).toBe('running');
    // TCX has no name; its <Id> is the start time, which is what tools show.
    expect(activity.metadata.name).toBe('2024-05-01T07:00:00Z');
  });

  it('reads laps, including the calories only this format states', () => {
    const activity = parse('run-with-laps.tcx');

    expect(activity.laps).toHaveLength(2);
    expect(activity.laps?.[0]).toMatchObject({
      index: 0,
      durationSeconds: 20,
      distanceMeters: 66.7,
      caloriesKcal: 12,
    });
    expect(activity.laps?.[1]?.caloriesKcal).toBe(11);
  });

  it('treats a second Track inside a lap as a pause', () => {
    const activity = parse('run-with-laps.tcx');

    // Two segments, not three: the 4.5 minute gap inside lap 2 splits the
    // route, and the boundary between lap 1 and lap 2 — ten continuous
    // seconds — does not.
    const segments = activity.points.map((point) => point.segmentIndex);
    expect(segments).toEqual([0, 0, 0, 0, 1]);

    // The gap is not ground covered: 133 m of track, not the ~155 m a straight
    // line across the pause would add.
    expect(activity.derived?.distanceMeters).toBeCloseTo(133.4, 0);
  });

  it('does not break the route at a lap boundary', () => {
    // A lap is a split marker, not a pause. Breaking there would drop the
    // ground covered between the last point of one lap and the first of the
    // next — invisible in a file that states its own distances, but a third of
    // this activity when distance has to come from the positions.
    const activity = parse('laps-without-distance.tcx');

    expect(activity.laps).toHaveLength(2);
    expect(new Set(activity.points.map((point) => point.segmentIndex))).toEqual(new Set([0]));
    expect(activity.derived?.distanceMeters).toBeCloseTo(300, 0);
  });

  it('does not store a coordinate the app would refuse to draw', () => {
    const activity = parse('impossible-coordinates.tcx');

    // Past the pole, past the antimeridian, and Null Island.
    expect(activity.points.map((point) => point.lat)).toEqual([
      51.5,
      undefined,
      undefined,
      undefined,
      51.502,
    ]);
    expect(activity.points.map((point) => point.lon)).toEqual([
      -0.1,
      undefined,
      undefined,
      undefined,
      -0.1,
    ]);

    // The points themselves survive: a bad fix does not discard a real heart rate.
    expect(activity.points).toHaveLength(5);
    expect(activity.points.map((point) => point.heartRateBpm)).toEqual([130, 131, 132, 133, 134]);
    expect(activity.warnings.map((warning) => warning.code)).toContain(
      'points_missing_coordinates',
    );
  });

  it('detects every stream the file carries', () => {
    const activity = parse('run-with-laps.tcx');

    expect(activity.streams).toMatchObject({
      hasLocation: true,
      hasTime: true,
      hasElevation: true,
      hasDistance: true,
      hasHeartRate: true,
      hasRunningCadence: true,
      hasCyclingCadence: false,
      hasSpeed: true,
    });
  });

  it('reads device information without exposing the unit id', () => {
    const activity = parse('run-with-laps.tcx');
    const device = activity.metadata.device;

    expect(device).toMatchObject({
      name: 'OpenTrack Test Watch',
      product: '2691',
      softwareVersion: '7.20',
      source: 'tcx_creator',
    });
    // UnitId is a serial number: parsed, but never renderable.
    expect(device?.serialNumber).toBe('3939123456');
    for (const field of DISPLAYABLE_DEVICE_FIELDS) {
      expect(device?.[field] ?? '').not.toContain('3939123456');
    }
  });

  it('takes a bare Cadence as pedal revolutions, which is what TCX means', () => {
    const activity = parse('ride-minimal.tcx');

    expect(activity.metadata.sport).toBe('cycling');
    expect(activity.points.map((point) => point.cyclingCadenceRpm)).toEqual([88, 90, 89]);
    expect(activity.points.every((point) => point.runningCadenceSpm === undefined)).toBe(true);
  });

  it('reads a file that states nothing optional at all', () => {
    const activity = parse('ride-minimal.tcx');

    expect(activity.points).toHaveLength(3);
    expect(activity.metadata.device).toBeUndefined();
    expect(activity.streams).toMatchObject({
      hasLocation: true,
      hasTime: true,
      hasElevation: false,
      hasHeartRate: false,
      hasPower: false,
    });
    // Distance is derived from the positions, since no point states one.
    expect(activity.derived?.distanceMeters).toBeGreaterThan(0);
  });

  it('rejects a malformed document', () => {
    expect(() => parse('malformed.tcx')).toThrow(ActivityError);
    expect(() => parse('malformed.tcx')).toThrow(/well-formed/i);
  });

  it('rejects a document that is not TCX', () => {
    expect(() => parseTcx('<?xml version="1.0"?><gpx version="1.1" />')).toThrow(
      /not <TrainingCenterDatabase>/,
    );
  });

  it('rejects an empty file', () => {
    expect(() => parseTcx('')).toThrow(/empty/i);
  });

  it('rejects a valid document with no track points', () => {
    const empty = `<?xml version="1.0"?>
      <TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
        <Activities><Activity Sport="Running"><Id>2024-01-01T00:00:00Z</Id>
          <Lap StartTime="2024-01-01T00:00:00Z"><TotalTimeSeconds>0</TotalTimeSeconds>
          <DistanceMeters>0</DistanceMeters><Calories>0</Calories></Lap>
        </Activity></Activities>
      </TrainingCenterDatabase>`;

    expect(() => parseTcx(empty)).toThrow(/No <Trackpoint>/);
  });
});

describe('TCX feeds the existing adapters (AV-751)', () => {
  it('builds chart series with no format-specific code', () => {
    const activity = parse('run-with-laps.tcx');

    for (const kind of ['elevation', 'heartRate', 'pace', 'cadence'] as const) {
      expect(buildSeries(activity, kind, 'distance').isEmpty, `${kind}`).toBe(false);
    }
  });

  it('offers a TCX run the same charts a GPX run gets', () => {
    const activity = parse('run-with-laps.tcx');
    const availabilityOf = (kind: string) =>
      getChartAvailability(activity).find((entry) => entry.kind === kind)?.available;

    expect(availabilityOf('pace')).toBe(true);
    expect(availabilityOf('cadence')).toBe(true);
    expect(availabilityOf('speed')).toBe(false); // running
  });
});
