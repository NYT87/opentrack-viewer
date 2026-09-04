/**
 * Generates the `.fit` fixtures beside this script.
 *
 * FIT is binary, so its fixtures cannot be read or edited as text the way the
 * GPX ones can. They are generated from this script instead, which is the
 * readable source of truth: run `node src/test/fixtures/make-fit-fixtures.mjs`
 * after changing it and commit the regenerated files.
 *
 * The encoder here is deliberately hand-written rather than taken from the
 * parsing library, so a fixture cannot agree with a bug in the code under test.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** FIT counts time from 1989-12-31, not the Unix epoch. */
const FIT_EPOCH_OFFSET_SECONDS = 631065600;
const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

// Base type ids from the FIT protocol. The 0x80 bit marks a multi-byte type.
const T = {
  enum: { id: 0x00, size: 1 },
  sint8: { id: 0x01, size: 1 },
  uint8: { id: 0x02, size: 1 },
  sint16: { id: 0x83, size: 2 },
  uint16: { id: 0x84, size: 2 },
  sint32: { id: 0x85, size: 4 },
  uint32: { id: 0x86, size: 4 },
  uint32z: { id: 0x8c, size: 4 },
};

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

/** The CRC-16 variant defined by the FIT protocol, a nibble at a time. */
function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

/** Accumulates little-endian records. */
class Writer {
  bytes = [];
  u8(value) { this.bytes.push(value & 0xff); return this; }
  u16(value) { this.u8(value); return this.u8(value >> 8); }
  u32(value) { this.u16(value); return this.u16(value >>> 16); }
  raw(values) { for (const v of values) this.u8(v); return this; }
  write(type, value) {
    if (type.size === 1) return this.u8(value);
    if (type.size === 2) return this.u16(value);
    return this.u32(value);
  }
}

/**
 * A definition record: describes the shape of every data record that follows
 * under the same local id. Emitted once per message type, which is how a real
 * device writes a track of thousands of records.
 *
 * `fields` is a list of `[name, fieldNumber, type]`.
 */
function define(writer, localId, globalNum, fields) {
  writer.u8(0x40 | localId); // definition record
  writer.u8(0); // reserved
  writer.u8(0); // architecture: little-endian
  writer.u16(globalNum);
  writer.u8(fields.length);
  for (const [, number, type] of fields) writer.u8(number).u8(type.size).u8(type.id);
  return fields;
}

/** One data record, written in the field order its definition declared. */
function data(writer, localId, fields, values) {
  writer.u8(localId);
  for (const [name, , type] of fields) writer.write(type, values[name]);
}

const secondsToFit = (iso) =>
  Math.round(new Date(iso).getTime() / 1000) - FIT_EPOCH_OFFSET_SECONDS;
const degreesToSemicircles = (degrees) => Math.round(degrees * SEMICIRCLES_PER_DEGREE);

/** Wraps records in a FIT header and trailing CRC. */
function fitFile(records) {
  const header = new Writer();
  header.u8(14).u8(0x20).u16(2140).u32(records.length).raw([0x2e, 0x46, 0x49, 0x54]);
  header.u16(crc16(header.bytes));

  const body = [...header.bytes, ...records];
  const crc = new Writer().u16(crc16(body));
  return Uint8Array.from([...body, ...crc.bytes]);
}

// Global message numbers from the FIT profile.
const MSG = { fileId: 0, sport: 12, record: 20, session: 18, deviceInfo: 23 };
// Enum values used below: file type 4 is an activity; sport 1 is running, 2 cycling.
const FILE_TYPE_ACTIVITY = 4;
const SPORT_RUNNING = 1;
const SPORT_CYCLING = 2;
const SUB_SPORT_ROAD = 7;
const SUB_SPORT_TREADMILL = 1;
const MANUFACTURER_GARMIN = 1;

const FILE_ID_FIELDS = [
  ['type', 0, T.enum],
  ['manufacturer', 1, T.uint16],
  ['product', 2, T.uint16],
  ['serialNumber', 3, T.uint32z],
  ['timeCreated', 4, T.uint32],
];
const SPORT_FIELDS = [
  ['sport', 0, T.enum],
  ['subSport', 1, T.enum],
];
const DEVICE_INFO_FIELDS = [
  ['deviceIndex', 0, T.uint8],
  ['manufacturer', 2, T.uint16],
  ['serialNumber', 3, T.uint32z],
  ['product', 4, T.uint16],
  ['softwareVersion', 5, T.uint16],
];

/**
 * A ride with GPS and the full sensor set, plus a serial number the viewer must
 * parse but never show.
 */
function buildRide() {
  const w = new Writer();
  const start = '2024-03-02T09:00:00Z';

  const fileId = define(w, 0, MSG.fileId, FILE_ID_FIELDS);
  data(w, 0, fileId, {
    type: FILE_TYPE_ACTIVITY,
    manufacturer: MANUFACTURER_GARMIN,
    product: 3121,
    serialNumber: 3987654321,
    timeCreated: secondsToFit(start),
  });

  const sport = define(w, 1, MSG.sport, SPORT_FIELDS);
  data(w, 1, sport, { sport: SPORT_CYCLING, subSport: SUB_SPORT_ROAD });

  const device = define(w, 2, MSG.deviceInfo, DEVICE_INFO_FIELDS);
  data(w, 2, device, {
    deviceIndex: 0,
    manufacturer: MANUFACTURER_GARMIN,
    serialNumber: 3987654321,
    product: 3121,
    softwareVersion: 610,
  });

  const record = define(w, 3, MSG.record, [
    ['timestamp', 253, T.uint32],
    ['positionLat', 0, T.sint32],
    ['positionLong', 1, T.sint32],
    ['altitude', 2, T.uint16],
    ['heartRate', 3, T.uint8],
    ['cadence', 4, T.uint8],
    ['distance', 5, T.uint32],
    ['speed', 6, T.uint16],
    ['power', 7, T.uint16],
    ['temperature', 13, T.sint8],
  ]);

  // Six points ten seconds apart, heading north at a steady ~8 m/s.
  for (let i = 0; i < 6; i += 1) {
    data(w, 3, record, {
      timestamp: secondsToFit(start) + i * 10,
      positionLat: degreesToSemicircles(51.5 + i * 0.00072),
      positionLong: degreesToSemicircles(-0.12),
      altitude: (20 + i * 2 + 500) * 5, // scale 5, offset 500 m
      heartRate: 138 + i,
      cadence: 85 + (i % 3),
      distance: i * 80 * 100, // scale 100, so centimetres
      speed: 8000, // scale 1000, so millimetres per second
      power: 210 + i * 5,
      temperature: 14,
    });
  }

  return fitFile(w.bytes);
}

/** A treadmill run: real timestamps and sensors, no GPS at all. */
function buildTreadmillRun() {
  const w = new Writer();
  const start = '2024-03-03T07:30:00Z';

  const fileId = define(w, 0, MSG.fileId, FILE_ID_FIELDS);
  data(w, 0, fileId, {
    type: FILE_TYPE_ACTIVITY,
    manufacturer: MANUFACTURER_GARMIN,
    product: 2697,
    serialNumber: 1122334455,
    timeCreated: secondsToFit(start),
  });

  const sport = define(w, 1, MSG.sport, SPORT_FIELDS);
  data(w, 1, sport, { sport: SPORT_RUNNING, subSport: SUB_SPORT_TREADMILL });

  const record = define(w, 2, MSG.record, [
    ['timestamp', 253, T.uint32],
    ['distance', 5, T.uint32],
    ['heartRate', 3, T.uint8],
    ['cadence', 4, T.uint8],
  ]);

  // Five points ten seconds apart at ~3.33 m/s: a 5:00 /km treadmill pace.
  for (let i = 0; i < 5; i += 1) {
    data(w, 2, record, {
      timestamp: secondsToFit(start) + i * 10,
      distance: Math.round(i * 33.33 * 100),
      heartRate: 150 + i,
      cadence: 82 + (i % 2), // one foot, so ~164 strides per minute
    });
  }

  return fitFile(w.bytes);
}

const FIXTURES = {
  'ride-with-sensors.fit': buildRide(),
  'treadmill-run.fit': buildTreadmillRun(),
};

for (const [name, bytes] of Object.entries(FIXTURES)) {
  writeFileSync(join(HERE, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
