import { describe, expect, it } from 'vitest';
import {
  chartableStreamKeys,
  decideSensorRead,
  readSensorStreams,
  type GoproStream,
} from './sensorStreams';

/** Points one second apart, on the camera clock. */
const SECONDLY = [0, 1_000, 2_000];

const stream = (samples: GoproStream['samples']): GoproStream => ({ samples });

/**
 * The real reader gets two things: every stream the file announces, from the
 * cheap listing pass, and the samples of only the ones worth parsing. This
 * models that — anything with samples is also declared.
 */
const read = (
  parsed: Record<string, GoproStream>,
  pointCtsMs: number[] | undefined,
  alsoDeclared: Record<string, string> = {},
) => {
  const declared = Object.fromEntries(Object.keys(parsed).map((key) => [key, key]));
  return readSensorStreams({ ...declared, ...alsoDeclared }, parsed, pointCtsMs);
};

const find = (result: ReturnType<typeof readSensorStreams>, key: string) =>
  result.sensorStreams.find((entry) => entry.key === key);

describe('reducing a stream onto the activity points (AV-905)', () => {
  it('averages a vector stream by magnitude over each point window', () => {
    const result = read(
      {
        ACCL: stream([
          // First window: magnitudes 3-4-5 and 6-8-10, mean 7.5.
          { cts: 0, value: [3, 4, 0] },
          { cts: 500, value: [6, 8, 0] },
          // Second window: magnitude 1.
          { cts: 1_000, value: [1, 0, 0] },
          // Third: nothing, so the point has no value at all.
        ]),
      },
      SECONDLY,
    );

    expect(find(result, 'ACCL')?.valuesByPoint).toEqual([7.5, 1, undefined]);
  });

  it('is unmoved by which axis order the camera wrote', () => {
    // A HERO7 labels its accelerometer (z,x,y); a HERO11 does not. Magnitude
    // is the same measurement either way, which is why it is the reduction.
    const asWritten = read({ ACCL: stream([{ cts: 0, value: [3, 4, 12] }]) }, [0]);
    const reordered = read({ ACCL: stream([{ cts: 0, value: [12, 3, 4] }]) }, [0]);

    expect(find(asWritten, 'ACCL')?.valuesByPoint).toEqual(find(reordered, 'ACCL')?.valuesByPoint);
  });

  it('gives the last point the median interval, so the tail is not dropped', () => {
    const result = read(
      { GYRO: stream([{ cts: 2_400, value: [2, 0, 0] }]) },
      SECONDLY,
    );

    // 2,400 ms falls past the last point at 2,000 ms — inside its window only
    // because the last point is given one.
    expect(find(result, 'GYRO')?.valuesByPoint).toEqual([undefined, undefined, 2]);
  });

  it('reports the sample rate the samples themselves establish', () => {
    const result = read(
      {
        ACCL: stream([
          { cts: 0, value: [1, 0, 0] },
          { cts: 100, value: [1, 0, 0] },
          { cts: 200, value: [1, 0, 0] },
        ]),
      },
      SECONDLY,
    );

    expect(find(result, 'ACCL')?.sampleRateHz).toBe(10);
    expect(find(result, 'ACCL')?.sourceSampleCount).toBe(3);
  });
});

describe('what is charted and what is only declared (AV-905)', () => {
  it('declares a stream that was never parsed', () => {
    // How it really arrives: announced by the listing pass, with no samples,
    // because a per-frame quaternion is megabytes with nothing to say on a
    // chart and parsing it to count it would defeat the point.
    const result = readSensorStreams({ CORI: 'CameraOrientation' }, {}, SECONDLY);

    const cori = find(result, 'CORI');
    expect(cori?.display).toBe('hidden');
    expect(cori?.label).toBe('Camera orientation');
    expect(cori?.valuesByPoint).toBeUndefined();
    expect(cori?.sourceSampleCount).toBeUndefined();
    expect(cori?.sampleRateHz).toBeUndefined();
  });

  it('asks for only the streams that earn a chart', () => {
    const declared = {
      ACCL: 'Accelerometer',
      GYRO: 'Gyroscope',
      CORI: 'CameraOrientation',
      WBAL: 'White Balance temperature (Kelvin)',
      GPS9: 'GPS',
      XYZW: 'Something new',
    };

    // What the second parsing pass is told to read. Everything absent here is
    // skipped while parsing rather than built and discarded (TD-034).
    expect(chartableStreamKeys(declared).sort()).toEqual(['ACCL', 'GYRO']);
  });

  it('declares one face stream however many faces the camera found', () => {
    const face = stream([{ cts: 0, value: [0.1, 0.2, 0.3, 0.4] }]);
    const result = read({ FACE1: face, FACE2: face, FACE3: face }, SECONDLY);

    const faces = result.sensorStreams.filter((entry) => entry.key === 'FACE');
    expect(faces).toHaveLength(1);
    expect(faces[0]?.display).toBe('hidden');
    expect(result.warnings).toEqual([]);
  });

  it('leaves the GPS streams to the route parser', () => {
    const result = read(
      {
        GPS5: stream([{ cts: 0, value: [42, -8, 100, 1, 1] }]),
        GPS9: stream([{ cts: 0, value: [42, -8, 100, 1, 1, 0, 0, 1, 3] }]),
      },
      SECONDLY,
    );

    expect(result.sensorStreams).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('puts the charted streams first, so the reader meets those first', () => {
    const result = read(
      {
        WBAL: stream([{ cts: 0, value: 5500 }]),
        GYRO: stream([{ cts: 0, value: [1, 0, 0] }]),
        CORI: stream([{ cts: 0, value: [1, 0, 0, 0] }]),
        ACCL: stream([{ cts: 0, value: [1, 0, 0] }]),
      },
      SECONDLY,
    );

    expect(result.sensorStreams.map((entry) => entry.key)).toEqual([
      'ACCL',
      'GYRO',
      'CORI',
      'WBAL',
    ]);
  });
});

describe('camera temperature (AV-905)', () => {
  /**
   * Stated once per payload and implied thereafter — the same rule the GPS fix
   * follows. Reading it per sample would find a temperature for the two samples
   * that state one and nothing for the rest.
   */
  const imu = stream([
    { cts: 0, value: [1, 0, 0], sticky: { 'temperature [°C]': 40 } },
    { cts: 500, value: [1, 0, 0] },
    { cts: 1_000, value: [1, 0, 0], sticky: { 'temperature [°C]': 44 } },
    { cts: 1_500, value: [1, 0, 0] },
  ]);

  it('carries a sticky reading forward across the samples that imply it', () => {
    const temperature = find(read({ ACCL: imu }, SECONDLY), 'TMPC');

    expect(temperature?.valuesByPoint).toEqual([40, 44, undefined]);
    // What the file stated, not what carrying it forward produced.
    expect(temperature?.sourceSampleCount).toBe(2);
  });

  /**
   * The case that separates carrying forward from reading per sample. A window
   * containing a stating sample gets the same answer either way — averaging
   * skips the samples that state nothing — so only a window with *no* stating
   * sample can tell the two apart. A real HERO11 is mostly those: 11 statements
   * across 110 points.
   */
  it('gives a temperature to points no stating sample falls in', () => {
    // As a camera actually writes it: the IMU runs far faster than the GPS,
    // and states a temperature on only the occasional sample.
    const fast = stream(
      [0, 200, 400, 600, 800, 1_000, 1_200, 1_400, 1_600].map((cts) => ({
        cts,
        value: [1, 0, 0],
        ...(cts === 0 ? { sticky: { 'temperature [°C]': 40 } } : {}),
        ...(cts === 1_000 ? { sticky: { 'temperature [°C]': 44 } } : {}),
      })),
    );

    const temperature = find(read({ ACCL: fast }, [0, 500, 1_000, 1_500]), 'TMPC');

    // Only the first and third windows contain a statement; the others are
    // covered because the last one stated is still in force.
    expect(temperature?.valuesByPoint).toEqual([40, 40, 44, 44]);
    expect(temperature?.sourceSampleCount).toBe(2);
  });

  it('says plainly that it is the camera, not the air', () => {
    const temperature = find(read({ ACCL: imu }, SECONDLY), 'TMPC');

    expect(temperature?.label).toBe('Camera temperature');
    expect(temperature?.note).toMatch(/not the air/i);
  });

  it('is absent when the camera never stated one', () => {
    const result = read({ ACCL: stream([{ cts: 0, value: [1, 0, 0] }]) }, SECONDLY);

    expect(find(result, 'TMPC')).toBeUndefined();
  });

  it('prefers a TMPC stream of its own over the sticky reading', () => {
    const result = read(
      { TMPC: stream([{ cts: 0, value: 31 }]), ACCL: imu },
      SECONDLY,
    );

    expect(result.sensorStreams.filter((entry) => entry.key === 'TMPC')).toHaveLength(1);
    expect(find(result, 'TMPC')?.valuesByPoint?.[0]).toBe(31);
  });
});

describe('telemetry this app does not recognize (AV-905)', () => {
  it('names it in a warning rather than dropping it silently', () => {
    const result = readSensorStreams(
      { XYZW: 'Something New', QRST: 'QRST' },
      {},
      SECONDLY,
    );

    expect(result.sensorStreams).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('gopro_unrecognized_streams');
    // Named as the file names it, so a reader can look it up rather than
    // being handed four letters.
    expect(result.warnings[0]?.message).toContain('Something New (XYZW)');
    expect(result.warnings[0]?.message).toContain('QRST');
    expect(result.warnings[0]?.severity).toBe('info');
  });
});

describe('without a camera clock to align to (AV-905)', () => {
  it('declares every stream, and calls none of them charted', () => {
    const result = read(
      {
        ACCL: stream([{ cts: 0, value: [1, 0, 0] }]),
        CORI: stream([{ cts: 0, value: [1, 0, 0, 0] }]),
      },
      undefined,
    );

    expect(result.sensorStreams.map((entry) => entry.key).sort()).toEqual(['ACCL', 'CORI']);
    for (const entry of result.sensorStreams) {
      // Aligning to a timeline that does not exist would put the values in the
      // wrong places rather than in none.
      expect(entry.valuesByPoint).toBeUndefined();
      /*
       * And it is declared rather than left calling itself charted: the charts
       * skip a stream with no values, so a stream that claimed a chart it
       * cannot have would fall out of both the charts and this list.
       */
      expect(entry.display).toBe('hidden');
    }
  });

  it('declares a stream whose samples fall outside every point window', () => {
    const result = read({ ACCL: stream([{ cts: 99_000, value: [1, 0, 0] }]) }, SECONDLY);

    expect(find(result, 'ACCL')?.display).toBe('hidden');
    expect(find(result, 'ACCL')?.valuesByPoint).toBeUndefined();
    // Still counted and rated, because these samples were read.
    expect(find(result, 'ACCL')?.sourceSampleCount).toBe(1);
  });
});

describe('a recording too long to read the motion sensors from (AV-905)', () => {
  /** Points a second apart, for as many minutes as asked. */
  const minutes = (count: number) =>
    Array.from({ length: count * 60 }, (_, index) => index * 1_000);

  it('reads them for a recording of ordinary length', () => {
    expect(decideSensorRead(minutes(10), 600)).toEqual({ read: true });
  });

  it('leaves them unread once the recording runs long', () => {
    // At ~200 Hz, an hour is ~720,000 samples per stream, built before they can
    // be grouped — on the main thread, in a tab that also holds the route.
    expect(decideSensorRead(minutes(60), 3_600)).toEqual({
      read: false,
      reason: 'too_long',
      minutes: 60,
    });
  });

  /**
   * A fix comes and goes. Judged on the GPS points alone, a two-hour ride that
   * held satellites for five minutes looks like a five-minute recording — and
   * the accelerometer behind it is still two hours long.
   */
  it('judges a long video by the video, not by its brief window of GPS', () => {
    expect(decideSensorRead(minutes(5), 2 * 60 * 60)).toEqual({
      read: false,
      reason: 'too_long',
      minutes: 120,
    });
  });

  it('judges by the points when the container understates the duration', () => {
    // The reverse case: a container that reports nothing useful should not
    // wave through telemetry that plainly runs for an hour.
    expect(decideSensorRead(minutes(60), 0)).toMatchObject({ reason: 'too_long' });
    expect(decideSensorRead(minutes(60), undefined)).toMatchObject({ reason: 'too_long' });
  });

  it('separates having no clock from having too much recording', () => {
    // Not a zero-minute recording: a different situation, and one that wants
    // different words in front of the reader.
    expect(decideSensorRead(undefined, 30)).toEqual({ read: false, reason: 'no_camera_clock' });
  });
});
