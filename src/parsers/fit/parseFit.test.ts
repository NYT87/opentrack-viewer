import { describe, expect, it } from 'vitest';
import { parseFit, FIT_PARSER_VERSION } from './parseFit';
import { ActivityError } from '../../domain/errors';
import { readBinaryFixture } from '../../test/helpers/fixtures';
import { DISPLAYABLE_DEVICE_FIELDS } from '../../domain/activity';
import { buildSeries } from '../../domain/series';
import { getChartAvailability } from '../../domain/charts';

const parse = (fixture: string) =>
  parseFit(readBinaryFixture(fixture), { fileName: fixture, idFactory: () => 'fixed-id' });

describe('parseFit (AV-702)', () => {
  it('reads records into normalized points', async () => {
    const activity = await parse('ride-with-sensors.fit');

    expect(activity.points).toHaveLength(6);
    expect(activity.points[0]).toMatchObject({
      index: 0,
      heartRateBpm: 138,
      cyclingCadenceRpm: 85,
      powerWatts: 210,
      temperatureCelsius: 14,
      distanceMeters: 0,
      speedMetersPerSecond: 8,
    });
    // Coordinates arrive as semicircles and must come out as degrees.
    expect(activity.points[0]?.lat).toBeCloseTo(51.5, 5);
    expect(activity.points[0]?.lon).toBeCloseTo(-0.12, 5);
    // Altitude is stored scaled and offset; 20 m must survive the round trip.
    expect(activity.points[0]?.elevationMeters).toBeCloseTo(20, 5);
    expect(activity.points[0]?.time?.toISOString()).toBe('2024-03-02T09:00:00.000Z');
  });

  it('records source metadata', async () => {
    const activity = await parse('ride-with-sensors.fit');

    expect(activity.source).toEqual({
      format: 'fit',
      fileName: 'ride-with-sensors.fit',
      fileSizeBytes: undefined,
      parserVersion: FIT_PARSER_VERSION,
    });
    expect(activity.metadata.sport).toBe('cycling');
  });

  it('detects every sensor stream the file carries', async () => {
    const activity = await parse('ride-with-sensors.fit');

    expect(activity.streams).toMatchObject({
      hasLocation: true,
      hasTime: true,
      hasElevation: true,
      hasDistance: true,
      hasHeartRate: true,
      hasCyclingCadence: true,
      hasRunningCadence: false,
      hasPower: true,
      hasTemperature: true,
      hasSpeed: true,
    });
  });

  it('reads device information without ever exposing the serial number', async () => {
    const activity = await parse('ride-with-sensors.fit');
    const device = activity.metadata.device;

    expect(device).toMatchObject({
      manufacturer: 'Garmin',
      source: 'fit_device_info',
      softwareVersion: '6.1',
    });
    // Parsed, because the file states it...
    expect(device?.serialNumber).toBe('3987654321');
    // ...but never in the set any UI is allowed to render.
    expect(DISPLAYABLE_DEVICE_FIELDS).not.toContain('serialNumber');
    for (const field of DISPLAYABLE_DEVICE_FIELDS) {
      expect(device?.[field] ?? '').not.toContain('3987654321');
    }
  });

  it('computes the same derived stats as any other format', async () => {
    const activity = await parse('ride-with-sensors.fit');

    // Six points ten seconds apart at ~8 m/s: 50 seconds and about 400 m.
    expect(activity.derived?.durationSeconds).toBe(50);
    expect(activity.derived?.distanceMeters).toBeGreaterThan(380);
    expect(activity.derived?.distanceMeters).toBeLessThan(420);
    // The points climb 20 m to 30 m, but elevation gain runs through the same
    // 3 m noise threshold every format shares, which smooths 2 m steps.
    expect(activity.points.at(-1)!.elevationMeters! - activity.points[0]!.elevationMeters!).toBe(10);
    expect(activity.derived?.elevationGainMeters).toBe(8);
    expect(activity.derived?.averageHeartRateBpm).toBeCloseTo(140.5, 1);
  });

  it('does not store a coordinate the app would refuse to draw', async () => {
    const activity = await parse('impossible-coordinates.fit');

    // Past the pole, and Null Island. FIT cannot state an out-of-range
    // longitude at all: 181 degrees overflows its signed semicircle field.
    expect(activity.points.map((point) => point.lat)).toEqual([
      expect.closeTo(51.5, 5),
      undefined,
      undefined,
      expect.closeTo(51.502, 5),
    ]);
    expect(activity.points.map((point) => point.lon === undefined)).toEqual([
      false,
      true,
      true,
      false,
    ]);

    // The points survive: a bad fix does not discard a real heart rate.
    expect(activity.points).toHaveLength(4);
    expect(activity.points.map((point) => point.heartRateBpm)).toEqual([130, 131, 132, 133]);
    expect(activity.warnings.map((warning) => warning.code)).toContain(
      'points_missing_coordinates',
    );
  });

  it('rejects a file with no records', async () => {
    // A valid FIT header and CRC wrapping no record messages at all.
    const header = Uint8Array.from([
      14, 0x20, 0x5c, 0x08, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0x2b, 0x8a, 0, 0,
    ]);
    await expect(parseFit(header.buffer as ArrayBuffer)).rejects.toBeInstanceOf(ActivityError);
  });

  it('rejects an empty file', async () => {
    await expect(parseFit(new ArrayBuffer(0))).rejects.toMatchObject({
      code: 'fit_parse_failed',
    });
  });

  it('reports a truncated file as a FIT failure, not a crash', async () => {
    const full = new Uint8Array(readBinaryFixture('ride-with-sensors.fit'));
    const truncated = full.slice(0, 40);

    await expect(parseFit(truncated.buffer as ArrayBuffer)).rejects.toMatchObject({
      code: 'fit_parse_failed',
    });
  });
});

describe('parseFit without GPS (AV-703)', () => {
  it('keeps an indoor activity, with its sensors, and says why there is no route', async () => {
    const activity = await parse('treadmill-run.fit');

    expect(activity.points).toHaveLength(5);
    expect(activity.streams).toMatchObject({
      hasLocation: false,
      hasTime: true,
      hasDistance: true,
      hasHeartRate: true,
      hasRunningCadence: true,
    });
    // Every point is kept: no position does not mean no data.
    expect(activity.points.every((point) => point.lat === undefined)).toBe(true);
    expect(activity.points[0]?.heartRateBpm).toBe(150);
    // The parser says nothing about the missing route: an indoor activity is
    // normal, and shared validation owns that warning. Saying it here too would
    // show the reader the same sentence twice.
    expect(activity.warnings.map((warning) => warning.code)).not.toContain('no_location_stream');
    expect(activity.warnings.map((warning) => warning.code)).not.toContain(
      'points_missing_coordinates',
    );
  });

  it('files a treadmill run cadence as strides, never pedal revolutions', async () => {
    const activity = await parse('treadmill-run.fit');

    expect(activity.points[0]?.runningCadenceSpm).toBe(82);
    expect(activity.points.every((point) => point.cyclingCadenceRpm === undefined)).toBe(true);
    expect(activity.metadata.sport).toBe('running');
  });

  it('derives distance from the recorded stream when there is no GPS', async () => {
    const activity = await parse('treadmill-run.fit');

    // Five points at ~33.33 m apart: about 133 m over 40 seconds.
    expect(activity.derived?.distanceMeters).toBeCloseTo(133.32, 1);
    expect(activity.derived?.durationSeconds).toBe(40);
  });
});

describe('FIT feeds the existing adapters (AV-703 / AV-704)', () => {
  it('builds chart series from FIT data with no format-specific code', async () => {
    const activity = await parse('ride-with-sensors.fit');

    for (const kind of ['elevation', 'heartRate', 'power', 'speed'] as const) {
      const series = buildSeries(activity, kind, 'distance');
      expect(series.isEmpty, `${kind} should have samples`).toBe(false);
    }
  });

  it('offers a cycling FIT file the speed chart, and no pace chart', async () => {
    const activity = await parse('ride-with-sensors.fit');
    const availability = getChartAvailability(activity);
    const availabilityOf = (kind: string) =>
      availability.find((entry) => entry.kind === kind)?.available;

    expect(availabilityOf('speed')).toBe(true);
    expect(availabilityOf('power')).toBe(true);
    expect(availabilityOf('pace')).toBe(false);
  });

  it('offers an indoor run its pace and cadence charts without a map', async () => {
    const activity = await parse('treadmill-run.fit');
    const availability = getChartAvailability(activity);
    const availabilityOf = (kind: string) =>
      availability.find((entry) => entry.kind === kind)?.available;

    // Distance and time are both present, so pace works with no GPS at all.
    expect(availabilityOf('pace')).toBe(true);
    expect(availabilityOf('cadence')).toBe(true);
    expect(availabilityOf('elevation')).toBe(false);
  });
});
