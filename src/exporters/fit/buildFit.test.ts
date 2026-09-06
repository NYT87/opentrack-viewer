import { describe, expect, it } from 'vitest';
import { buildFit } from './buildFit';
import { exportActivity } from '../index';
import { parseFit } from '../../parsers/fit/parseFit';
import { parseGpx } from '../../parsers/gpx/parseGpx';
import { readBinaryFixture, readFixture } from '../../test/helpers/fixtures';
import { makeActivity } from '../../test/helpers/activity';
import { ActivityError } from '../../domain/errors';

const gpx = (fixture: string) => parseGpx(readFixture(fixture), { fileName: fixture });
const fit = (fixture: string) => parseFit(readBinaryFixture(fixture), { fileName: fixture });

/** Re-reads exported bytes, which is the only real proof they are valid FIT. */
async function roundTrip(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return parseFit(buffer, { fileName: 'exported.fit' });
}

/**
 * The FIT protocol's CRC-16, written here rather than imported from the
 * encoder: a container checked with the same code that produced it proves only
 * that the code agrees with itself.
 */
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
];
function crc16(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!;
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
  }
  return crc;
}

describe('FIT export container (AV-553)', () => {
  it('writes a file whose header and CRC an outside reader accepts', () => {
    const { bytes } = buildFit(gpx('route-with-elevation.gpx'));

    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
    expect(bytes[0]).toBe(14); // header length
    // The stated data size must match what actually follows the header.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(bytes.length - 14 - 2);

    const stated = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8);
    expect(stated).toBe(crc16(bytes.subarray(0, bytes.length - 2)));
  });
});

describe('FIT export round-trips (AV-553)', () => {
  it('preserves position, elevation and time', async () => {
    const original = gpx('route-with-elevation.gpx');
    const reimported = await roundTrip(buildFit(original).bytes);

    expect(reimported.points).toHaveLength(original.points.length);
    for (const [index, point] of reimported.points.entries()) {
      const source = original.points[index]!;
      expect(point.lat).toBeCloseTo(source.lat!, 5);
      expect(point.lon).toBeCloseTo(source.lon!, 5);
      expect(point.elevationMeters).toBeCloseTo(source.elevationMeters!, 1);
      expect(point.time?.toISOString()).toBe(source.time?.toISOString());
    }
    expect(reimported.derived?.distanceMeters).toBeCloseTo(original.derived!.distanceMeters!, 1);
    // This fixture is a hike, which is FIT sport 17 — a value worth pinning,
    // since a mapping that only ever got `running` right would look fine too.
    expect(original.metadata.sport).toBe('hiking');
    expect(reimported.metadata.sport).toBe('hiking');
  });

  it('preserves the full sensor set through a FIT to FIT round trip', async () => {
    const original = await fit('ride-with-sensors.fit');
    const reimported = await roundTrip(buildFit(original).bytes);

    expect(reimported.metadata.sport).toBe('cycling');
    for (const [index, point] of reimported.points.entries()) {
      const source = original.points[index]!;
      expect(point.heartRateBpm).toBe(source.heartRateBpm);
      expect(point.cyclingCadenceRpm).toBe(source.cyclingCadenceRpm);
      expect(point.powerWatts).toBe(source.powerWatts);
      expect(point.temperatureCelsius).toBe(source.temperatureCelsius);
      expect(point.distanceMeters).toBeCloseTo(source.distanceMeters!, 2);
      expect(point.speedMetersPerSecond).toBeCloseTo(source.speedMetersPerSecond!, 3);
    }
  });

  it('keeps an indoor activity that has no GPS', async () => {
    // The case GPX export has to refuse: FIT needs time, not position.
    const original = await fit('treadmill-run.fit');
    const reimported = await roundTrip(buildFit(original).bytes);

    expect(reimported.points).toHaveLength(original.points.length);
    expect(reimported.streams.hasLocation).toBe(false);
    expect(reimported.points[0]?.heartRateBpm).toBe(150);
    expect(reimported.points[0]?.runningCadenceSpm).toBe(82);
    expect(reimported.derived?.distanceMeters).toBeCloseTo(original.derived!.distanceMeters!, 1);
  });

  it('keeps a paused recording as separate segments', async () => {
    const original = gpx('paused-run.gpx');
    expect(new Set(original.points.map((point) => point.segmentIndex)).size).toBeGreaterThan(1);

    const reimported = await roundTrip(buildFit(original).bytes);

    expect(reimported.points.map((point) => point.segmentIndex)).toEqual(
      original.points.map((point) => point.segmentIndex),
    );
    // The break is not distance the athlete covered.
    expect(reimported.derived?.distanceMeters).toBeCloseTo(original.derived!.distanceMeters!, 1);
  });

  it('writes a point that is missing one sensor reading without losing the rest', async () => {
    const patchy = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z'), heartRateBpm: 120 },
      { lat: 51.501, lon: -0.1, time: new Date('2024-01-01T10:00:10Z') },
      { lat: 51.502, lon: -0.1, time: new Date('2024-01-01T10:00:20Z'), heartRateBpm: 130 },
    ]);

    const reimported = await roundTrip(buildFit(patchy).bytes);

    // The gap is written as FIT's invalid marker, not as a zero heart rate.
    expect(reimported.points.map((point) => point.heartRateBpm)).toEqual([120, undefined, 130]);
  });
});

describe('exporting a section of a distance-stream activity (AV-551 / AV-553)', () => {
  it('writes the section’s own distance, not the odometer reading', async () => {
    const ride = await fit('ride-with-sensors.fit');

    const result = await exportActivity(ride, {
      format: 'fit',
      range: { startIndex: 2, endIndex: 4 },
    });
    const reimported = await roundTrip(new Uint8Array(await result.blob.arrayBuffer()));

    // 160 m of ground, not the 320 m the source odometer had reached.
    expect(reimported.derived?.distanceMeters).toBe(160);
    expect(reimported.points).toHaveLength(3);
  });

  it('writes the same section distance to GPX', async () => {
    const ride = await fit('ride-with-sensors.fit');

    const result = await exportActivity(ride, {
      format: 'gpx',
      range: { startIndex: 2, endIndex: 4 },
    });
    const xml = await result.blob.text();
    const reimported = parseGpx(xml, { fileName: 'section.gpx' });

    // GPX carries no distance stream, so this is derived from the positions —
    // and must agree with what FIT wrote from the recorded one.
    expect(reimported.derived?.distanceMeters).toBeCloseTo(160, 0);
  });
});

describe('FIT export limits (AV-553)', () => {
  it('refuses an activity with no timestamps', () => {
    const noTime = makeActivity([
      { lat: 51.5, lon: -0.1 },
      { lat: 51.6, lon: -0.1 },
    ]);

    expect(() => buildFit(noTime)).toThrow(ActivityError);
    expect(() => buildFit(noTime)).toThrow(/no timestamps/i);
  });

  it('never writes a serial number, and says so', async () => {
    const source = await fit('ride-with-sensors.fit');
    expect(source.metadata.device?.serialNumber).toBe('3987654321');

    const { bytes, warnings } = buildFit(source);

    expect(warnings.map((warning) => warning.code)).toContain('export_device_not_reproduced');
    // 3987654321 as little-endian uint32 is the byte run a copy would leave.
    const serial = new Uint8Array(new Uint32Array([3987654321]).buffer);
    expect(indexOfSequence(bytes, serial)).toBe(-1);

    const reimported = await roundTrip(bytes);
    expect(reimported.metadata.device?.serialNumber).toBeUndefined();
  });

  it('writes the invalid marker for a coordinate the app would refuse to draw', async () => {
    const dubious = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 91, lon: -0.1, time: new Date('2024-01-01T10:00:10Z') },
      { lat: 0, lon: 0, time: new Date('2024-01-01T10:00:20Z') },
      { lat: 51.502, lon: -0.1, time: new Date('2024-01-01T10:00:30Z') },
    ]);

    const reimported = await roundTrip(buildFit(dubious).bytes);

    // Every record survives — FIT needs only time — but the unusable positions
    // come back absent rather than as a semicircle value of nonsense.
    expect(reimported.points).toHaveLength(4);
    expect(reimported.points.map((point) => point.lat === undefined)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(reimported.points[0]?.lat).toBeCloseTo(51.5, 5);
    expect(reimported.points[3]?.lat).toBeCloseTo(51.502, 5);
  });

  it('writes the invalid marker for a speed no device could have measured', async () => {
    const faulty = makeActivity([
      { lat: 51.5, lon: -0.1, speedMetersPerSecond: 4, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 51.501, lon: -0.1, speedMetersPerSecond: -5, time: new Date('2024-01-01T10:00:10Z') },
      { lat: 51.502, lon: -0.1, speedMetersPerSecond: 900, time: new Date('2024-01-01T10:00:20Z') },
    ]);

    const reimported = await roundTrip(buildFit(faulty).bytes);

    expect(reimported.points.map((point) => point.speedMetersPerSecond)).toEqual([
      4,
      undefined,
      undefined,
    ]);
  });

  it('names the points it had to leave out', () => {
    const partial = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 51.501, lon: -0.1 },
      { lat: 51.502, lon: -0.1, time: new Date('2024-01-01T10:00:20Z') },
    ]);

    const { warnings } = buildFit(partial);
    expect(warnings.map((warning) => warning.code)).toContain('export_points_without_time');
  });

  it('says when sub-second timestamps are rounded away', () => {
    const precise = makeActivity([
      { lat: 51.5, lon: -0.1, time: new Date('2024-01-01T10:00:00.250Z') },
      { lat: 51.501, lon: -0.1, time: new Date('2024-01-01T10:00:10.750Z') },
    ]);

    expect(buildFit(precise).warnings.map((warning) => warning.code)).toContain(
      'export_subsecond_time_lost',
    );
  });

  it('reports only the device identity for a plain timed route', () => {
    // Every real file names a creator, so this one warning is the floor rather
    // than a sign that something unusual was lost.
    expect(buildFit(gpx('simple-route.gpx')).warnings.map((warning) => warning.code)).toEqual([
      'export_device_not_reproduced',
    ]);
  });
});

describe('FIT through the export registry (AV-550)', () => {
  it('produces a .fit download with the right mime type', async () => {
    const result = await exportActivity(gpx('route-with-elevation.gpx'), { format: 'fit' });

    expect(result.fileName).toBe('Elevation-Route.fit');
    expect(result.mimeType).toBe('application/vnd.ant.fit');
    // Bytes, so no charset is claimed.
    expect(result.blob.type).toBe('application/vnd.ant.fit');

    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
  });

  it('writes only the selected section', async () => {
    const original = gpx('route-with-elevation.gpx');
    const result = await exportActivity(original, {
      format: 'fit',
      range: { startIndex: 1, endIndex: 2 },
    });

    expect(result.fileName).toBe('Elevation-Route-section.fit');
    const reimported = await roundTrip(new Uint8Array(await result.blob.arrayBuffer()));
    expect(reimported.points).toHaveLength(2);
    expect(reimported.points[0]?.lat).toBeCloseTo(original.points[1]!.lat!, 5);
  });
});

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
