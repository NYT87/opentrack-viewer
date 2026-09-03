import { describe, expect, it } from 'vitest';
import { TIME_TICK_STEP_SECONDS, buildXTicks, distanceTickStep, endpointFits, thinTicks } from './axis';

describe('buildXTicks (AV-514)', () => {
  it('puts a distance tick on every whole kilometre', () => {
    const ticks = buildXTicks(0, 3200, 'distance', 'metric');

    expect(ticks.map((tick) => tick.value)).toEqual([1000, 2000, 3000]);
    expect(ticks[0]?.label).toBe('1.00 km');
  });

  it('uses whole miles for imperial display', () => {
    const ticks = buildXTicks(0, 5000, 'distance', 'imperial');

    expect(distanceTickStep('imperial')).toBeCloseTo(1609.344);
    expect(ticks).toHaveLength(3);
    expect(ticks[0]?.label).toBe('1.00 mi');
  });

  it('puts a time tick every five minutes', () => {
    const ticks = buildXTicks(0, 1000, 'time');

    expect(TIME_TICK_STEP_SECONDS).toBe(300);
    expect(ticks.map((tick) => tick.value)).toEqual([300, 600, 900]);
    expect(ticks.map((tick) => tick.label)).toEqual(['5:00', '10:00', '15:00']);
  });

  it('starts at the first whole interval inside the range', () => {
    expect(buildXTicks(1200, 3100, 'distance', 'metric').map((tick) => tick.value)).toEqual([
      2000, 3000,
    ]);
  });

  it('returns nothing for a range shorter than one interval', () => {
    expect(buildXTicks(0, 400, 'distance', 'metric')).toEqual([]);
    expect(buildXTicks(0, 120, 'time')).toEqual([]);
  });

  it('rejects a degenerate range', () => {
    expect(buildXTicks(500, 500, 'distance')).toEqual([]);
    expect(buildXTicks(Number.NaN, 100, 'time')).toEqual([]);
  });

  it('picks readable round steps for the index fallback axis', () => {
    const ticks = buildXTicks(0, 50, 'index');

    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThan(12);
    // Every tick is a whole number the reader can place.
    expect(ticks.every((tick) => Number.isInteger(tick.value))).toBe(true);
  });
});

describe('thinTicks (AV-514)', () => {
  const ticks = buildXTicks(0, 20_000, 'distance', 'metric'); // 20 kilometre marks

  it('labels every tick when they are far enough apart', () => {
    const { labelled } = thinTicks(ticks, 0, 20_000, 2000, 64);

    expect(labelled).toHaveLength(ticks.length);
  });

  it('thins labels on a narrow axis but keeps every mark', () => {
    const narrow = thinTicks(ticks, 0, 20_000, 300, 64);

    expect(narrow.ticks).toHaveLength(ticks.length);
    expect(narrow.labelled.length).toBeLessThan(ticks.length);
    // Survivors stay evenly spaced rather than clustering.
    const gaps = narrow.labelled
      .slice(1)
      .map((tick, index) => tick.value - narrow.labelled[index]!.value);
    expect(new Set(gaps).size).toBe(1);
  });

  it('keeps generation at the real interval no matter how narrow', () => {
    const { ticks: generated } = thinTicks(ticks, 0, 20_000, 40, 64);

    expect(generated.map((tick) => tick.value)).toEqual(ticks.map((tick) => tick.value));
  });
});

describe('endpointFits (AV-514)', () => {
  it('allows an endpoint that no interval label crowds', () => {
    const ticks = buildXTicks(0, 9500, 'distance', 'metric');
    // The last label sits at 9 km, 500 m from the 9.5 km end — 100 px apart
    // across this axis, comfortably clear of the 64 px minimum.
    expect(endpointFits(9500, ticks, 0, 9500, 1900, 64)).toBe(true);
  });

  it('hides an endpoint that collides with an interval label', () => {
    const ticks = buildXTicks(0, 9020, 'distance', 'metric');
    // The 9 km label lands 20 m from the end: far too close to print both.
    expect(endpointFits(9020, ticks, 0, 9020, 902, 64)).toBe(false);
  });

  it('always fits when there are no interval labels', () => {
    expect(endpointFits(500, [], 0, 500, 800, 64)).toBe(true);
  });
});
