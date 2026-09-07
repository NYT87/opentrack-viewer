import { describe, expect, it } from 'vitest';
import { buildTcx } from './buildTcx';
import { exportActivity } from '../index';
import { parseTcx } from '../../parsers/tcx/parseTcx';
import { parseGpx } from '../../parsers/gpx/parseGpx';
import { parseFit } from '../../parsers/fit/parseFit';
import { readBinaryFixture, readFixture } from '../../test/helpers/fixtures';
import { makeActivity } from '../../test/helpers/activity';
import { ActivityError } from '../../domain/errors';

const tcx = (fixture: string) => parseTcx(readFixture(fixture), { fileName: fixture });
const gpx = (fixture: string) => parseGpx(readFixture(fixture), { fileName: fixture });

/** Re-reads an exported document, the only real proof it is valid TCX. */
const roundTrip = (xml: string) => parseTcx(xml, { fileName: 'exported.tcx' });

describe('TCX export round-trips (AV-752 / AV-753)', () => {
  it('preserves position, elevation, time and sensors', () => {
    const original = tcx('run-with-laps.tcx');
    const reimported = roundTrip(buildTcx(original).xml);

    expect(reimported.points).toHaveLength(original.points.length);
    for (const [index, point] of reimported.points.entries()) {
      const source = original.points[index]!;
      expect(point.lat).toBeCloseTo(source.lat!, 6);
      expect(point.lon).toBeCloseTo(source.lon!, 6);
      expect(point.elevationMeters).toBeCloseTo(source.elevationMeters!, 3);
      expect(point.time?.toISOString()).toBe(source.time?.toISOString());
      expect(point.heartRateBpm).toBe(source.heartRateBpm);
      expect(point.runningCadenceSpm).toBe(source.runningCadenceSpm);
    }
    expect(reimported.metadata.sport).toBe('running');
    expect(reimported.derived?.distanceMeters).toBeCloseTo(
      original.derived!.distanceMeters!,
      1,
    );
  });

  it('keeps a pause as a pause, through both directions', () => {
    const original = tcx('run-with-laps.tcx');
    const reimported = roundTrip(buildTcx(original).xml);

    // The original's three segments come from two laps and a mid-lap pause.
    // The export writes one lap, so the pause is what must survive.
    expect(new Set(reimported.points.map((point) => point.segmentIndex)).size).toBeGreaterThan(1);
    expect(reimported.points[3]?.segmentIndex).not.toBe(reimported.points[4]?.segmentIndex);
    // ...and the gap is still not counted as ground covered.
    expect(reimported.derived?.distanceMeters).toBeCloseTo(
      original.derived!.distanceMeters!,
      1,
    );
  });

  it('writes bike cadence as Cadence and run cadence as an extension', () => {
    const ride = tcx('ride-minimal.tcx');
    const rideXml = buildTcx(ride).xml;
    expect(rideXml).toContain('<Cadence>88</Cadence>');
    expect(rideXml).not.toContain('RunCadence');
    expect(roundTrip(rideXml).points[0]?.cyclingCadenceRpm).toBe(88);

    const run = tcx('run-with-laps.tcx');
    const runXml = buildTcx(run).xml;
    expect(runXml).toContain('<ns3:RunCadence>84</ns3:RunCadence>');
    expect(roundTrip(runXml).points[0]?.runningCadenceSpm).toBe(84);
  });

  it('carries a GPX activity into TCX and back', () => {
    const original = gpx('route-with-elevation.gpx');
    const reimported = roundTrip(buildTcx(original).xml);

    expect(reimported.points).toHaveLength(original.points.length);
    expect(reimported.derived?.distanceMeters).toBeCloseTo(original.derived!.distanceMeters!, 1);
    expect(reimported.derived?.elevationGainMeters).toBe(original.derived?.elevationGainMeters);
    // A hike has no TCX sport of its own, so it comes back as `other`.
    expect(original.metadata.sport).toBe('hiking');
    expect(reimported.metadata.sport).toBe('other');
  });

  it('carries a FIT ride into TCX with its power and speed intact', async () => {
    const original = await parseFit(readBinaryFixture('ride-with-sensors.fit'), {
      fileName: 'ride-with-sensors.fit',
    });
    const reimported = roundTrip(buildTcx(original).xml);

    expect(reimported.metadata.sport).toBe('cycling');
    for (const [index, point] of reimported.points.entries()) {
      const source = original.points[index]!;
      expect(point.powerWatts).toBe(source.powerWatts);
      expect(point.speedMetersPerSecond).toBeCloseTo(source.speedMetersPerSecond!, 3);
      expect(point.cyclingCadenceRpm).toBe(source.cyclingCadenceRpm);
    }
  });

  it('escapes text that would otherwise break the document', () => {
    const activity = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 51.501, lon: -0.1, time: new Date('2024-01-01T10:00:10Z') },
    ]);
    const hostile = {
      ...activity,
      metadata: { ...activity.metadata, creator: 'Tom & Jerry’s <watch>' },
    };

    expect(roundTrip(buildTcx(hostile).xml).metadata.creator).toBe('Tom & Jerry’s <watch>');
  });
});

describe('TCX export limits (AV-752)', () => {
  it('refuses an activity with no timestamps', () => {
    const noTime = makeActivity([
      { lat: 51.5, lon: -0.1 },
      { lat: 51.6, lon: -0.1 },
    ]);

    expect(() => buildTcx(noTime)).toThrow(ActivityError);
    expect(() => buildTcx(noTime)).toThrow(/no timestamps/i);
  });

  it('says a sport TCX cannot name is written as Other', () => {
    const codes = buildTcx(gpx('route-with-elevation.gpx')).warnings.map((w) => w.code);

    expect(codes).toContain('export_sport_approximated');
  });

  it('says temperature is dropped, because TCX has nowhere to put it', async () => {
    const ride = await parseFit(readBinaryFixture('ride-with-sensors.fit'), {
      fileName: 'ride-with-sensors.fit',
    });

    expect(buildTcx(ride).warnings.map((w) => w.code)).toContain('export_temperature_dropped');
    expect(buildTcx(ride).xml).not.toContain('emperature');
  });

  it('says several laps became one, and that the pauses survived', () => {
    const codes = buildTcx(tcx('run-with-laps.tcx')).warnings.map((w) => w.code);

    expect(codes).toContain('export_laps_merged');
  });

  it('never writes the device unit id, and says so', () => {
    const source = tcx('run-with-laps.tcx');
    expect(source.metadata.device?.serialNumber).toBe('3939123456');

    const { xml, warnings } = buildTcx(source);

    expect(warnings.map((w) => w.code)).toContain('export_serial_omitted');
    expect(xml).not.toContain('3939123456');
    expect(xml).not.toContain('UnitId');
    expect(roundTrip(xml).metadata.device?.serialNumber).toBeUndefined();
  });

  it('writes the Calories the schema requires even when nothing states one', () => {
    const xml = buildTcx(gpx('route-with-elevation.gpx')).xml;

    // A missing Calories element makes the document invalid, so zero it is.
    expect(xml).toContain('<Calories>0</Calories>');
  });
});

describe('an exported section describes itself (AV-752)', () => {
  const distancesIn = (xml: string) =>
    [...xml.matchAll(/<DistanceMeters>([\d.]+)<\/DistanceMeters>/g)].map((match) =>
      Number(match[1]),
    );

  it('starts its trackpoint distances at zero, not at the source odometer', async () => {
    const ride = await parseFit(readBinaryFixture('ride-with-sensors.fit'), {
      fileName: 'ride-with-sensors.fit',
    });
    // The section's own readings begin at 160 m into the ride.
    expect(ride.points[2]?.distanceMeters).toBe(160);

    const result = await exportActivity(ride, {
      format: 'tcx',
      range: { startIndex: 2, endIndex: 4 },
    });
    const xml = await result.blob.text();

    // The first value is the lap total; the trackpoints follow it. Asserted on
    // the serialized text because re-importing normalizes the stream, so a
    // round trip alone cannot see this.
    const [lapTotal, ...trackpoints] = distancesIn(xml);
    expect(lapTotal).toBeCloseTo(160, 0);
    expect(trackpoints).toEqual([0, 80, 160]);
  });

  it("leaves a whole activity distance stream untouched", async () => {
    const ride = await parseFit(readBinaryFixture('ride-with-sensors.fit'), {
      fileName: 'ride-with-sensors.fit',
    });

    const xml = buildTcx(ride).xml;
    const [, ...trackpoints] = distancesIn(xml);

    expect(trackpoints).toEqual([0, 80, 160, 240, 320, 400]);
  });
});

describe('TCX through the export registry (AV-550)', () => {
  it('produces a .tcx download with the right mime type', async () => {
    const result = await exportActivity(gpx('route-with-elevation.gpx'), { format: 'tcx' });

    expect(result.fileName).toBe('Elevation-Route.tcx');
    expect(result.mimeType).toBe('application/vnd.garmin.tcx+xml');
    expect(await result.blob.text()).toContain('<TrainingCenterDatabase');
  });

  it('writes a selected section as one lap covering exactly that section', async () => {
    const original = tcx('run-with-laps.tcx');
    const result = await exportActivity(original, {
      format: 'tcx',
      range: { startIndex: 0, endIndex: 2 },
    });

    const xml = await result.blob.text();
    const reimported = roundTrip(xml);

    expect(result.fileName).toMatch(/-section\.tcx$/);
    expect(reimported.points).toHaveLength(3);
    // TD-023: one lap for the section, not the halves of the two it spanned.
    expect(reimported.laps).toHaveLength(1);
    expect(reimported.laps?.[0]?.distanceMeters).toBeCloseTo(
      reimported.derived!.distanceMeters!,
      0,
    );
  });
});
