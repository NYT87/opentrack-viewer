import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMATS,
  exportActivity,
  getExportAvailability,
  type ExportFormat,
} from './index';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';
import { makeActivity } from '../test/helpers/activity';
import { ActivityError } from '../domain/errors';

const parse = (fixture: string) => parseGpx(readFixture(fixture), { fileName: fixture });

/** Re-reads an exported file, which is the only real proof it is valid GPX. */
const roundTrip = async (blob: Blob, fileName = 'exported.gpx') =>
  parseGpx(await blob.text(), { fileName });

describe('exportActivity registry (AV-550)', async () => {
  it('advertises what it can write', async () => {
    // The shipping details only; each entry also carries the rule for when it
    // can be written at all, which has its own tests below.
    expect(
      EXPORT_FORMATS.map(({ format, label, extension, mimeType }) => ({
        format,
        label,
        extension,
        mimeType,
      })),
    ).toEqual([
      { format: 'gpx', label: 'GPX', extension: 'gpx', mimeType: 'application/gpx+xml' },
      { format: 'fit', label: 'FIT', extension: 'fit', mimeType: 'application/vnd.ant.fit' },
      {
        format: 'tcx',
        label: 'TCX',
        extension: 'tcx',
        mimeType: 'application/vnd.garmin.tcx+xml',
      },
    ]);
  });

  it('returns a blob, a file name, a mime type and warnings', async () => {
    const result = await exportActivity(parse('route-with-elevation.gpx'), { format: 'gpx' });

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.type).toBe('application/gpx+xml;charset=utf-8');
    expect(result.mimeType).toBe('application/gpx+xml');
    expect(result.fileName).toMatch(/\.gpx$/);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(await result.blob.text()).toContain('<gpx');
  });

  it('rejects a format it cannot write', async () => {
    await expect(
      exportActivity(parse('simple-route.gpx'), { format: 'kml' as ExportFormat }),
    ).rejects.toBeInstanceOf(ActivityError);
  });

  it('names the file after the activity, not the file that was opened', async () => {
    const result = await exportActivity(parse('route-with-elevation.gpx'), { format: 'gpx' });

    expect(result.fileName).toBe('Elevation-Route.gpx');
  });

  it('never lets an activity name become a path', async () => {
    const activity = makeActivity([{ lat: 0, lon: 0.1 }, { lat: 1, lon: 0.1 }]);
    const named = {
      ...activity,
      metadata: { ...activity.metadata, name: '../../etc/passwd' },
    };

    const result = await exportActivity(named, { format: 'gpx' });

    expect(result.fileName).not.toContain('/');
    expect(result.fileName).not.toContain('..');
    expect(result.fileName).toBe('etc-passwd.gpx');
  });
});

describe('GPX export (AV-551)', async () => {
  it('round-trips a route through export and re-import', async () => {
    const original = parse('route-with-elevation.gpx');
    const result = await exportActivity(original, { format: 'gpx' });
    const reimported = await roundTrip(result.blob);

    expect(reimported.points).toHaveLength(original.points.length);
    for (const [index, point] of reimported.points.entries()) {
      const source = original.points[index]!;
      expect(point.lat).toBeCloseTo(source.lat!, 6);
      expect(point.lon).toBeCloseTo(source.lon!, 6);
      expect(point.elevationMeters).toBeCloseTo(source.elevationMeters!, 3);
      expect(point.time?.toISOString()).toBe(source.time?.toISOString());
    }
    // The shape the map draws is the same shape.
    expect(reimported.derived?.distanceMeters).toBeCloseTo(original.derived!.distanceMeters!, 1);
    expect(reimported.derived?.elevationGainMeters).toBe(original.derived?.elevationGainMeters);
  });

  it('round-trips sensor data, including power under Garmin’s spelling', async () => {
    const original = parse('route-with-elevation.gpx');
    const withPower = {
      ...original,
      points: original.points.map((point) => ({ ...point, powerWatts: 200 + point.index })),
    };

    const result = await exportActivity({ ...withPower, streams: { ...withPower.streams, hasPower: true } }, {
      format: 'gpx',
    });
    const xml = await result.blob.text();
    expect(xml).toContain('<gpxpx:PowerInWatts>200</gpxpx:PowerInWatts>');

    const reimported = await roundTrip(result.blob);
    expect(reimported.points.map((point) => point.powerWatts)).toEqual(
      withPower.points.map((point) => point.powerWatts),
    );
    expect(reimported.points[0]?.heartRateBpm).toBe(original.points[0]?.heartRateBpm);
  });

  it('keeps a paused recording as separate segments', async () => {
    const original = parse('paused-run.gpx');
    expect(new Set(original.points.map((point) => point.segmentIndex)).size).toBeGreaterThan(1);

    const reimported = await roundTrip((await exportActivity(original, { format: 'gpx' })).blob);

    expect(reimported.points.map((point) => point.segmentIndex)).toEqual(
      original.points.map((point) => point.segmentIndex),
    );
    // Merging segments would have invented the distance across the gap.
    expect(reimported.derived?.distanceMeters).toBeCloseTo(original.derived!.distanceMeters!, 1);
  });

  it('writes only the selected section when given a range', async () => {
    const original = parse('route-with-elevation.gpx');
    const result = await exportActivity(original, { format: 'gpx', range: { startIndex: 1, endIndex: 2 } });

    const reimported = await roundTrip(result.blob);
    expect(reimported.points).toHaveLength(2);
    expect(reimported.points[0]?.lat).toBeCloseTo(original.points[1]!.lat!, 6);
    // The name says it is a section, so it cannot be mistaken for the whole ride.
    expect(result.fileName).toBe('Elevation-Route-section.gpx');
  });

  it('rejects a range that is not a range', async () => {
    await expect(
      exportActivity(parse('route-with-elevation.gpx'), {
        format: 'gpx',
        range: { startIndex: 3, endIndex: 1 },
      }),
    ).rejects.toBeInstanceOf(ActivityError);
  });

  it('escapes text that would otherwise break the document', async () => {
    const activity = makeActivity([{ lat: 0, lon: 0.1 }, { lat: 1, lon: 0.1 }]);
    const hostile = {
      ...activity,
      metadata: { ...activity.metadata, name: 'Tom & Jerry’s <ride> "fast"' },
    };

    const reimported = await roundTrip((await exportActivity(hostile, { format: 'gpx' })).blob);

    expect(reimported.metadata.name).toBe('Tom & Jerry’s <ride> "fast"');
  });

  it('refuses to write a GPX for an activity with no coordinates', async () => {
    const indoor = makeActivity([
      { heartRateBpm: 120, time: new Date('2024-01-01T10:00:00Z') },
      { heartRateBpm: 130, time: new Date('2024-01-01T10:01:00Z') },
    ]);

    // An empty track is worse than an honest refusal.
    await expect(exportActivity(indoor, { format: 'gpx' })).rejects.toThrow(/no GPS coordinates/i);
  });
});

describe('export warnings name what GPX cannot carry (AV-551)', async () => {
  const codesFor = async (fixture: string) =>
    (await exportActivity(parse(fixture), { format: 'gpx' })).warnings.map(
      (warning) => warning.code,
    );

  it('says nothing when nothing is lost', async () => {
    expect(await codesFor('simple-route.gpx')).toEqual([]);
  });

  it('warns that cadence loses its unit', async () => {
    expect(await codesFor('run-with-cadence.gpx')).toContain('export_cadence_unit_lost');
  });

  it('warns that sensor fields rely on extensions', async () => {
    // This fixture records speed; `ride-with-speed.gpx` only implies it through
    // its positions, so nothing extension-shaped would be written for it.
    expect(await codesFor('ride-with-faulty-speed.gpx')).toContain('export_extension_fields');
  });

  it('says the serial number is deliberately left out', async () => {
    const result = await exportActivity(parse('device-metadata.gpx'), { format: 'gpx' });

    expect(result.warnings.map((warning) => warning.code)).toContain('export_serial_omitted');
    // And it really is absent from the file. The fixture states this serial, and
    // the parser does read it — so the export is what drops it.
    expect(parse('device-metadata.gpx').metadata.device?.serialNumber).toBe('3939123456');
    const xml = await result.blob.text();
    expect(xml).not.toContain('3939123456');
    expect(await roundTrip(result.blob)).toMatchObject({
      metadata: { device: expect.not.objectContaining({ serialNumber: expect.anything() }) },
    });
  });

  it('leaves out coordinates the app would refuse to draw', async () => {
    // Out of range, and Null Island: the same points the map and the stats skip.
    const dubious = makeActivity([
      { lat: 51.5, lon: -0.1 },
      { lat: 91, lon: -0.1 },
      { lat: 0, lon: 0 },
      { lat: 51.502, lon: -0.1 },
    ]);

    const result = await exportActivity(dubious, { format: 'gpx' });
    const xml = await result.blob.text();

    expect(xml.match(/<trkpt/g)).toHaveLength(2);
    expect(xml).not.toContain('lat="91');
    expect(xml).not.toContain('lat="0.0000000" lon="0.0000000"');
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'export_points_without_position',
    );
  });

  it('leaves out a speed no device could have measured', async () => {
    const faulty = makeActivity([
      { lat: 51.5, lon: -0.1, speedMetersPerSecond: 4, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 51.501, lon: -0.1, speedMetersPerSecond: -5, time: new Date('2024-01-01T10:00:10Z') },
      { lat: 51.502, lon: -0.1, speedMetersPerSecond: 900, time: new Date('2024-01-01T10:00:20Z') },
    ]);

    const xml = await (await exportActivity(faulty, { format: 'gpx' })).blob.text();

    // Only the believable one is handed on as fact.
    expect(xml.match(/<gpxtpx:speed>/g)).toHaveLength(1);
    expect(xml).toContain('<gpxtpx:speed>4</gpxtpx:speed>');
    expect(xml).not.toContain('-5');
    expect(xml).not.toContain('900');
  });

  it('reports points it had to leave out', async () => {
    const partial = makeActivity([
      { lat: 0, lon: 0.1 },
      { heartRateBpm: 120 },
      { lat: 1, lon: 0.1 },
    ]);

    const { warnings } = await exportActivity(partial, { format: 'gpx' });
    expect(warnings.map((warning) => warning.code)).toContain('export_points_without_position');
  });
});

describe('a format that would refuse is never offered (AV-555)', () => {
  const indoor = () =>
    makeActivity([
      { heartRateBpm: 120, time: new Date('2024-01-01T10:00:00Z') },
      { heartRateBpm: 130, time: new Date('2024-01-01T10:01:00Z') },
    ]);

  const plannedRoute = () =>
    makeActivity([
      { lat: 51.5, lon: -0.1 },
      { lat: 51.501, lon: -0.1 },
    ]);

  const availabilityOf = (activity: Parameters<typeof getExportAvailability>[0], format: string) =>
    getExportAvailability(activity).find((entry) => entry.format === format)!;

  it('offers every format for an activity with both position and time', () => {
    const complete = parse('route-with-elevation.gpx');

    expect(getExportAvailability(complete).every((entry) => entry.available)).toBe(true);
  });

  it('withholds GPX from an activity with no coordinates, and says why', () => {
    expect(availabilityOf(indoor(), 'gpx')).toEqual({
      format: 'gpx',
      label: 'GPX',
      available: false,
      reason: expect.stringMatching(/needs GPS coordinates/i),
      code: 'no_location_stream',
    });
    // ...while the formats it can be written to stay on offer.
    expect(availabilityOf(indoor(), 'fit').available).toBe(true);
    expect(availabilityOf(indoor(), 'tcx').available).toBe(true);
  });

  it('withholds the timed formats from a route with no clock', () => {
    expect(availabilityOf(plannedRoute(), 'fit')).toMatchObject({
      available: false,
      code: 'fit_parse_failed',
    });
    expect(availabilityOf(plannedRoute(), 'tcx')).toMatchObject({
      available: false,
      code: 'invalid_tcx_xml',
    });
    expect(availabilityOf(plannedRoute(), 'gpx').available).toBe(true);
  });

  it('judges the section, not the activity, when a range is selected', () => {
    // The first two points have no position; the ride as a whole does.
    const partly = makeActivity([
      { time: new Date('2024-01-01T10:00:00Z') },
      { time: new Date('2024-01-01T10:00:10Z') },
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:20Z') },
      { lat: 51.501, lon: -0.1, time: new Date('2024-01-01T10:00:30Z') },
    ]);

    const whole = getExportAvailability(partly).find((e) => e.format === 'gpx')!;
    const section = getExportAvailability(partly, { startIndex: 0, endIndex: 1 }).find(
      (e) => e.format === 'gpx',
    )!;

    expect(whole.available).toBe(true);
    expect(section.available).toBe(false);
  });

  it('agrees with what the exporters actually do', async () => {
    // The guard against drift: availability is a promise about the writer, and
    // the only way to keep it honest is to ask the writer.
    const activities = [parse('route-with-elevation.gpx'), indoor(), plannedRoute()];

    for (const [index, activity] of activities.entries()) {
      for (const entry of getExportAvailability(activity)) {
        const attempt = exportActivity(activity, { format: entry.format }).then(
          () => true,
          () => false,
        );
        expect(await attempt, `activity ${index} → ${entry.format}`).toBe(entry.available);
      }
    }
  });
});
