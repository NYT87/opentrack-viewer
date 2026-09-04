import { describe, expect, it } from 'vitest';
import {
  buildSeries,
  downsampleSeries,
  findNearestSample,
  getXAxisAvailability,
  resolveXAxis,
} from './series';
import { makeActivity } from '../test/helpers/activity';

describe('buildSeries (AV-501)', () => {
  it('builds an elevation series against distance when coordinates exist', () => {
    const series = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 10 },
        { lat: 1, lon: 0.0001, elevationMeters: 30 },
      ]),
      'elevation',
      'distance',
    );

    expect(series.xAxis).toBe('distance');
    expect(series.samples).toHaveLength(2);
    expect(series.samples[0]).toMatchObject({ x: 0, y: 10, pointIndex: 0 });
    expect(series.yMin).toBe(10);
    expect(series.yMax).toBe(30);
    expect(series.isEmpty).toBe(false);
  });

  it('plots elapsed seconds on the time axis', () => {
    const series = buildSeries(
      makeActivity([
        { elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
        { elevationMeters: 30, time: new Date('2024-01-01T10:00:30Z') },
        { elevationMeters: 20, time: new Date('2024-01-01T10:02:00Z') },
      ]),
      'elevation',
      'time',
    );

    expect(series.xAxis).toBe('time');
    // Seconds since the activity start, not absolute epoch values.
    expect(series.samples.map((sample) => sample.x)).toEqual([0, 30, 120]);
    expect(series.xMin).toBe(0);
    expect(series.xMax).toBe(120);
  });

  it('skips points that lack a value on the requested axis', () => {
    const series = buildSeries(
      makeActivity([
        { elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
        { elevationMeters: 20 },
        { elevationMeters: 30, time: new Date('2024-01-01T10:01:00Z') },
      ]),
      'elevation',
      'time',
    );

    expect(series.samples.map((sample) => sample.pointIndex)).toEqual([0, 2]);
  });

  it('falls back to the point index only when neither axis is available', () => {
    const activity = makeActivity([
      { elevationMeters: 10 },
      { elevationMeters: 20 },
      { elevationMeters: 15 },
    ]);
    const resolved = resolveXAxis(activity);
    const series = buildSeries(activity, 'elevation', resolved);

    expect(series.xAxis).toBe('index');
    expect(series.samples.map((sample) => sample.x)).toEqual([0, 1, 2]);
  });

  it('skips points that lack the measured field', () => {
    const series = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 10 },
        { lat: 0.5, lon: 0.0001 },
        { lat: 1, lon: 0.0001, elevationMeters: 30 },
      ]),
      'elevation',
      'distance',
    );

    expect(series.samples.map((sample) => sample.pointIndex)).toEqual([0, 2]);
  });

  it('reports an empty series when the field is absent everywhere', () => {
    const series = buildSeries(makeActivity([{ lat: 0, lon: 0.0001 }]), 'elevation', 'distance');

    expect(series.isEmpty).toBe(true);
    expect(series.samples).toHaveLength(0);
  });

  it('builds sensor series for FIT-style data (AV-704)', () => {
    const series = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, heartRateBpm: 100 },
        { lat: 1, lon: 0.0001, heartRateBpm: 160 },
      ]),
      'heartRate',
      'distance',
    );

    expect(series.label).toBe('Heart rate');
    expect(series.unit).toBe('bpm');
    expect(series.yMax).toBe(160);
  });
});

describe('pace series (AV-505)', () => {
  /** A run at a steady 3 m/s, which is 5:33 per kilometre. */
  const steadyRun = (count = 12) =>
    makeActivity(
      Array.from({ length: count }, (_, index) => ({
        lat: 0 + index * 0.000027 * 10,
        lon: 0.0001,
        time: new Date(Date.UTC(2024, 0, 1, 10, 0, index * 10)),
      })),
    );

  it('derives seconds per kilometre from distance and time', () => {
    const series = buildSeries(steadyRun(), 'pace', 'time');

    expect(series.isEmpty).toBe(false);
    // 3 m/s is 1000/3 = 333 s/km. Allow for the spherical distance model.
    for (const sample of series.samples) {
      expect(sample.y).toBeGreaterThan(320);
      expect(sample.y).toBeLessThan(345);
    }
  });

  it('marks the series inverted so faster pace plots higher', () => {
    expect(buildSeries(steadyRun(), 'pace', 'time').invertY).toBe(true);
  });

  it('gaps stationary stretches instead of plotting an infinite pace', () => {
    const withPause = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.00027, lon: 0.0001, time: new Date('2024-01-01T10:00:10Z') },
      // Same position for the next two samples: no distance covered.
      { lat: 0.00027, lon: 0.0001, time: new Date('2024-01-01T10:00:20Z') },
      { lat: 0.00027, lon: 0.0001, time: new Date('2024-01-01T10:00:30Z') },
    ]);

    const series = buildSeries(withPause, 'pace', 'time');
    const plotted = series.samples.map((sample) => sample.pointIndex);

    expect(plotted).not.toContain(3);
    expect(series.samples.every((sample) => Number.isFinite(sample.y))).toBe(true);
  });

  it('ignores a negative recorded speed and derives instead', () => {
    // A speed below zero is meaningless, so the positions are believed instead.
    const faulty = makeActivity([
      { lat: 0, lon: 0.0001, speedMetersPerSecond: -5, time: new Date('2024-01-01T10:00:00Z') },
      {
        lat: 0.00072,
        lon: 0.0001,
        speedMetersPerSecond: -5,
        time: new Date('2024-01-01T10:00:10Z'),
      },
    ]);

    const values = buildSeries(faulty, 'speed', 'time').samples.map((sample) => sample.y);
    expect(values).not.toContain(-5);
    expect(values.every((value) => value >= 0)).toBe(true);
    expect(values.at(-1)).toBeCloseTo(8, 0);
  });

  it('ignores an absurd recorded speed and derives instead', () => {
    // 300 m/s is over 1000 km/h: a sensor fault, not a descent.
    const faulty = makeActivity([
      { lat: 0, lon: 0.0001, speedMetersPerSecond: 300, time: new Date('2024-01-01T10:00:00Z') },
      {
        lat: 0.00072,
        lon: 0.0001,
        speedMetersPerSecond: 300,
        time: new Date('2024-01-01T10:00:10Z'),
      },
    ]);

    const values = buildSeries(faulty, 'speed', 'time').samples.map((sample) => sample.y);
    expect(values).not.toContain(300);
    expect(values.at(-1)).toBeCloseTo(8, 0);
  });

  it('gaps a faulty recorded speed that cannot be derived from positions', () => {
    // Nothing to fall back on: better an empty chart than a fabricated spike.
    const faulty = makeActivity([
      { speedMetersPerSecond: -5 },
      { speedMetersPerSecond: 9000 },
    ]);

    expect(buildSeries(faulty, 'speed', 'distance').isEmpty).toBe(true);
  });

  it('drops implausibly fast intervals', () => {
    // ~1100 m in one second is a GPS glitch, not a sprint.
    const glitch = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.01, lon: 0.0001, time: new Date('2024-01-01T10:00:01Z') },
    ]);

    expect(buildSeries(glitch, 'pace', 'time').isEmpty).toBe(true);
  });

  it('is empty without timestamps', () => {
    const noTime = makeActivity([
      { lat: 0, lon: 0.0001 },
      { lat: 0.00027, lon: 0.0001 },
    ]);

    expect(buildSeries(noTime, 'pace', 'distance').isEmpty).toBe(true);
  });
});

describe('speed series (AV-513)', () => {
  /** A ride at a steady 8 m/s, which is 28.8 km/h. */
  const steadyRide = (count = 12) =>
    makeActivity(
      Array.from({ length: count }, (_, index) => ({
        // 0.00072 degrees of latitude is ~80 m: 8 m/s over a 10 s interval.
        lat: index * 0.00072,
        lon: 0.0001,
        time: new Date(Date.UTC(2024, 0, 1, 10, 0, index * 10)),
      })),
    );

  it('derives metres per second from distance and time', () => {
    const series = buildSeries(steadyRide(), 'speed', 'time');

    expect(series.isEmpty).toBe(false);
    for (const sample of series.samples) {
      expect(sample.y).toBeGreaterThan(7.5);
      expect(sample.y).toBeLessThan(8.5);
    }
  });

  it('trusts a recorded speed over deriving one', () => {
    // Positions say ~8 m/s; the wheel sensor says 3. The sensor wins.
    const ride = makeActivity([
      { lat: 0, lon: 0.0001, speedMetersPerSecond: 3, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.00072, lon: 0.0001, speedMetersPerSecond: 3, time: new Date('2024-01-01T10:00:10Z') },
    ]);

    expect(buildSeries(ride, 'speed', 'time').samples.map((s) => s.y)).toEqual([3, 3]);
  });

  it('drops implausibly fast intervals', () => {
    // ~1100 m in a second is a GPS glitch, not a descent.
    const glitch = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.01, lon: 0.0001, time: new Date('2024-01-01T10:00:01Z') },
    ]);

    expect(buildSeries(glitch, 'speed', 'time').isEmpty).toBe(true);
  });

  it('plots a stationary stretch as zero rather than gapping it', () => {
    // Standing still is a real speed; standing still is not a pace.
    const paused = makeActivity([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:10Z') },
    ]);

    expect(buildSeries(paused, 'speed', 'time').samples.map((s) => s.y)).toEqual([0]);
  });

  it('is empty without timestamps or recorded speed', () => {
    const noTime = makeActivity([
      { lat: 0, lon: 0.0001 },
      { lat: 0.00072, lon: 0.0001 },
    ]);

    expect(buildSeries(noTime, 'speed', 'distance').isEmpty).toBe(true);
  });
});

describe('cadence series (AV-506, AV-515)', () => {
  it('reads running cadence and labels it in strides per minute', () => {
    const series = buildSeries(
      makeActivity([
        { lat: 0, lon: 0.0001, runningCadenceSpm: 168, time: new Date('2024-01-01T10:00:00Z') },
        { lat: 0.001, lon: 0.0001, runningCadenceSpm: 174, time: new Date('2024-01-01T10:00:30Z') },
      ]),
      'cadence',
      'time',
    );

    expect(series.samples.map((sample) => sample.y)).toEqual([168, 174]);
    expect(series.yMax).toBe(174);
    // AV-515: never rpm for running cadence.
    expect(series.unit).toBe('spm');
  });

  it('is empty when no point recorded cadence', () => {
    expect(
      buildSeries(makeActivity([{ lat: 0, lon: 0.0001 }]), 'cadence', 'distance').isEmpty,
    ).toBe(true);
  });
});

describe('getXAxisAvailability (AV-501)', () => {
  const withBoth = makeActivity([
    { lat: 0, lon: 0.0001, elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
    { lat: 1, lon: 0.0001, elevationMeters: 30, time: new Date('2024-01-01T10:10:00Z') },
  ]);

  it('reports both axes for an activity with GPS and timestamps', () => {
    expect(getXAxisAvailability(withBoth)).toEqual([
      { mode: 'distance', available: true },
      { mode: 'time', available: true },
    ]);
  });

  it('explains why distance is unavailable', () => {
    const entries = getXAxisAvailability(
      makeActivity([
        { elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
        { elevationMeters: 30, time: new Date('2024-01-01T10:01:00Z') },
      ]),
    );

    expect(entries[0]).toMatchObject({ mode: 'distance', available: false });
    expect(entries[0]?.reason).toMatch(/no distance or GPS/i);
    expect(entries[1]?.available).toBe(true);
  });

  it('explains why time is unavailable', () => {
    const entries = getXAxisAvailability(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 10 },
        { lat: 1, lon: 0.0001, elevationMeters: 30 },
      ]),
    );

    expect(entries[1]).toMatchObject({ mode: 'time', available: false });
    expect(entries[1]?.reason).toMatch(/no usable timestamps/i);
  });

  it('rejects a zero-width time axis', () => {
    // Every point shares one timestamp, so elapsed time never advances.
    const sameInstant = new Date('2024-01-01T10:00:00Z');
    const entries = getXAxisAvailability(
      makeActivity([
        { lat: 0, lon: 0.0001, elevationMeters: 10, time: sameInstant },
        { lat: 1, lon: 0.0001, elevationMeters: 30, time: sameInstant },
      ]),
    );

    expect(entries[1]?.available).toBe(false);
  });
});

describe('resolveXAxis (AV-504)', () => {
  const withBoth = makeActivity([
    { lat: 0, lon: 0.0001, elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
    { lat: 1, lon: 0.0001, elevationMeters: 30, time: new Date('2024-01-01T10:10:00Z') },
  ]);
  const timeOnly = makeActivity([
    { elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
    { elevationMeters: 30, time: new Date('2024-01-01T10:01:00Z') },
  ]);

  it('honours an available preference', () => {
    expect(resolveXAxis(withBoth, 'time')).toEqual({ axis: 'time', requested: 'time' });
  });

  it('defaults to distance when no preference is given', () => {
    expect(resolveXAxis(withBoth).axis).toBe('distance');
  });

  it('falls back to time when distance is unavailable, explaining why', () => {
    const resolved = resolveXAxis(timeOnly, 'distance');

    expect(resolved.axis).toBe('time');
    expect(resolved.requested).toBe('distance');
    expect(resolved.fallbackReason).toMatch(/no distance or GPS/i);
  });

  it('falls back to the index axis when neither is available', () => {
    const resolved = resolveXAxis(makeActivity([{ elevationMeters: 10 }]), 'time');

    expect(resolved.axis).toBe('index');
    expect(resolved.fallbackReason).toBeDefined();
  });

  it('carries the fallback reason onto the series it builds', () => {
    const series = buildSeries(timeOnly, 'elevation', resolveXAxis(timeOnly, 'distance'));

    expect(series.xAxis).toBe('time');
    expect(series.requestedXAxis).toBe('distance');
    expect(series.xAxisFallbackReason).toMatch(/no distance or GPS/i);
  });
});

describe('downsampleSeries', () => {
  const dense = buildSeries(
    makeActivity(
      Array.from({ length: 5000 }, (_, index) => ({
        elevationMeters: index === 2500 ? 9999 : 100 + (index % 5),
      })),
    ),
    'elevation',
    'index',
  );

  it('caps the sample count', () => {
    expect(downsampleSeries(dense, 200).samples.length).toBeLessThanOrEqual(202);
  });

  it('preserves the extreme peak', () => {
    const reduced = downsampleSeries(dense, 200);
    expect(reduced.samples.some((sample) => sample.y === 9999)).toBe(true);
  });

  it('keeps the first and last sample', () => {
    const reduced = downsampleSeries(dense, 200);
    expect(reduced.samples[0]?.pointIndex).toBe(0);
    expect(reduced.samples[reduced.samples.length - 1]?.pointIndex).toBe(4999);
  });

  it('returns the series untouched when it already fits', () => {
    const small = buildSeries(
      makeActivity([{ elevationMeters: 1 }, { elevationMeters: 2 }]),
      'elevation',
      'index',
    );
    expect(downsampleSeries(small, 500)).toBe(small);
  });
});

describe('findNearestSample', () => {
  const series = buildSeries(
    makeActivity([{ elevationMeters: 10 }, { elevationMeters: 20 }, { elevationMeters: 30 }]),
    'elevation',
    'index',
  );

  it('returns the closest sample to an x value', () => {
    expect(findNearestSample(series, 1.4)?.pointIndex).toBe(1);
    expect(findNearestSample(series, 100)?.pointIndex).toBe(2);
  });

  it('returns undefined for an empty series', () => {
    const empty = buildSeries(makeActivity([{ lat: 1, lon: 1 }]), 'elevation', 'index');
    expect(findNearestSample(empty, 0)).toBeUndefined();
  });
});
