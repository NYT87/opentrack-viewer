import { describe, expect, it } from 'vitest';
import { parsePace } from '../components/MomentEditors';
import { makeActivity } from '../test/helpers/activity';
import {
  DEFAULT_DIAL,
  DIAL_LIMITS,
  activityRange,
  dialAngle,
  dialTickLabel,
  dialTicks,
  dialToStored,
  dialUnitLabel,
  fromDialUnits,
  niceRange,
  niceStep,
  paceStep,
  rangeFraction,
  storedToDial,
  toDialUnits,
} from './dial';
import { buildOverlayTimeline } from './timeline';

/** AV-1019 (TD-087). The dial's pure part: the needle's angle, the range and the ticks. */

const deg = (radians: number) => (radians * 180) / Math.PI;

describe('where the needle points', () => {
  it('starts half the sweep left of the top and ends half of it right, the arc centred at the top', () => {
    for (const sweep of [180, 240, 300]) {
      expect(deg(dialAngle(sweep, 0))).toBeCloseTo(-90 - sweep / 2, 9);
      expect(deg(dialAngle(sweep, 1))).toBeCloseTo(-90 + sweep / 2, 9);
      expect(deg(dialAngle(sweep, 0.5))).toBeCloseTo(-90, 9);
    }
    // A 180 degree dial runs along the top, west to east.
    expect(deg(dialAngle(180, 0))).toBeCloseTo(-180, 9);
    expect(deg(dialAngle(180, 1))).toBeCloseTo(0, 9);
  });

  it('turns clockwise with the value, in proportion', () => {
    const quarter = dialAngle(240, 0.25) - dialAngle(240, 0);
    expect(deg(quarter)).toBeCloseTo(60, 9);
    expect(dialAngle(240, 0.75)).toBeGreaterThan(dialAngle(240, 0.5));
  });

  it('pins a fraction beyond the range at its ends, and a missing one at the start', () => {
    expect(dialAngle(240, -3)).toBe(dialAngle(240, 0));
    expect(dialAngle(240, 7)).toBe(dialAngle(240, 1));
    expect(dialAngle(240, Number.NaN)).toBe(dialAngle(240, 0));
  });

  it('finds the fraction of a value, pinned at the ends of the range', () => {
    const range = { min: 20, max: 120 };
    expect(rangeFraction(20, range)).toBe(0);
    expect(rangeFraction(70, range)).toBe(0.5);
    expect(rangeFraction(120, range)).toBe(1);
    expect(rangeFraction(-50, range)).toBe(0);
    expect(rangeFraction(500, range)).toBe(1);
    expect(rangeFraction(5, { min: 3, max: 3 })).toBe(0);
  });
});

describe('the range an activity gives', () => {
  it('rounds the activity’s own range outward to a step of 1, 2 or 5 times a power of ten', () => {
    expect(niceRange(0, 12.7, true)).toEqual({ min: 0, max: 14 });
    expect(niceRange(61, 187, true)).toEqual({ min: 60, max: 200 });
    expect(niceRange(0, 1000, true)).toEqual({ min: 0, max: 1000 });
    expect(niceRange(37, 41, true)).toEqual({ min: 37, max: 41 });
    for (const [low, high] of [[3, 97], [0.2, 0.9], [112, 4380]] as const) {
      const range = niceRange(low, high, true);
      expect(range.min).toBeLessThanOrEqual(low);
      expect(range.max).toBeGreaterThanOrEqual(high);
      const step = niceStep(high - low);
      expect(Math.log10(step) - Math.floor(Math.log10(step)) === 0 || [2, 5].includes(Math.round(step / 10 ** Math.floor(Math.log10(step))))).toBe(true);
    }
  });

  it('never starts under zero for a figure that cannot go there, and may for one that can', () => {
    expect(niceRange(-0.4, 9, true).min).toBe(0);
    expect(niceRange(-6.3, 11, false)).toEqual({ min: -10, max: 15 });
  });

  it('gives a flat figure a step of room', () => {
    const range = niceRange(50, 50, true);
    expect(range.max).toBeGreaterThan(range.min);
  });

  it('comes from the activity: its lowest and highest speed, from zero', () => {
    const ride = makeActivity(Array.from({ length: 31 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 1) + i * 1000), speedMetersPerSecond: 3 + (i % 10) })));
    const timeline = buildOverlayTimeline(ride);
    // 3 to 12 m/s is 10.8 to 43.2 km/h: in steps of 5 km/h, 10 to 45, kept in m/s (AV-1020).
    const metric = activityRange(timeline, { kind: 'metric', metric: 'speed' })!;
    expect(toDialUnits('speed', metric.min, 'metric')).toBeCloseTo(10, 6);
    expect(toDialUnits('speed', metric.max, 'metric')).toBeCloseTo(45, 6);
    // 6.7 to 26.8 mph: in steps of 5 mph, 5 to 30.
    const imperial = activityRange(timeline, { kind: 'metric', metric: 'speed' }, 'imperial')!;
    expect(toDialUnits('speed', imperial.min, 'imperial')).toBeCloseTo(5, 6);
    expect(toDialUnits('speed', imperial.max, 'imperial')).toBeCloseTo(30, 6);
  });

  it('is the moving pace, not the pace of a stop', () => {
    const ride = makeActivity(Array.from({ length: 31 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 1) + i * 1000), speedMetersPerSecond: i < 5 ? 0.05 : 3 + (i % 4) })));
    const range = activityRange(buildOverlayTimeline(ride), { kind: 'metric', metric: 'pace' })!;
    // 3 to 6 m/s is 333 down to 167 s/km; the 0.05 m/s of the stop (20,000 s/km) is not in it.
    expect(range.max).toBeLessThan(400);
    expect(range.min).toBeGreaterThanOrEqual(0);
  });

  it('is nothing for a source the activity does not have', () => {
    const ride = makeActivity(Array.from({ length: 5 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 1) + i * 1000), speedMetersPerSecond: 3 })));
    expect(activityRange(buildOverlayTimeline(ride), { kind: 'metric', metric: 'power' })).toBeUndefined();
    expect(activityRange(buildOverlayTimeline(undefined), { kind: 'metric', metric: 'speed' })).toBeUndefined();
  });
});

describe('the ticks', () => {
  it('has a major tick every step from the start, the last at the end of the range, and minor ones between', () => {
    const ticks = dialTicks({ min: 0, max: 100 }, { majorStep: 25, minorTicks: 4 });
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.fraction)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(ticks.filter((tick) => !tick.major)).toHaveLength(16);
    expect(ticks[0]).toEqual({ fraction: 0, major: true, value: 0 });
    expect(ticks[1]!.fraction).toBeCloseTo(0.05, 9);
    expect(ticks.every((tick, i) => i === 0 || tick.fraction > ticks[i - 1]!.fraction)).toBe(true);
  });

  it('finds a step for the range when none is given, and has no minor ticks when asked for none', () => {
    const ticks = dialTicks({ min: 0, max: 200 }, { minorTicks: 0 });
    expect(ticks.every((tick) => tick.major)).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  it('draws no tick past the end where the step does not divide the range', () => {
    const ticks = dialTicks({ min: 0, max: 100 }, { majorStep: 30, minorTicks: 2 });
    expect(ticks.filter((tick) => tick.major)).toHaveLength(4);
    expect(Math.max(...ticks.map((tick) => tick.fraction))).toBeLessThanOrEqual(1);
  });

  it('is bounded: a tiny step is raised, so a mistyped one is not a million lines a frame', () => {
    const ticks = dialTicks({ min: 0, max: 100000 }, { majorStep: 0.001, minorTicks: DIAL_LIMITS.minorTicks.max });
    expect(ticks.length).toBeLessThanOrEqual((DIAL_LIMITS.majorTicks + 1) * (DIAL_LIMITS.minorTicks.max + 1));
  });

  it('is nothing for a range with no width', () => {
    expect(dialTicks({ min: 5, max: 5 }, DEFAULT_DIAL)).toEqual([]);
  });
});

describe('typing a pace (AV-1020)', () => {
  it('reads m:ss and minutes, and refuses what is neither', () => {
    expect([parsePace('4:30'), parsePace('5'), parsePace('1,5'), parsePace('0:30')]).toEqual([270, 300, 90, 30]);
    expect([parsePace('5:60'), parsePace('5:'), parsePace('abc'), parsePace('')]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('a dial in the reader’s units (AV-1020, TD-089)', () => {
  const speed = { kind: 'metric', metric: 'speed' } as const;
  const rideAt = (low: number, high: number) =>
    buildOverlayTimeline(
      makeActivity(Array.from({ length: 31 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 1) + i * 1000), speedMetersPerSecond: low + ((high - low) * i) / 30 }))),
    );

  it('converts a speed and a pace both ways, and leaves the rest as stored', () => {
    expect(toDialUnits('speed', 10, 'metric')).toBeCloseTo(36, 9);
    expect(toDialUnits('speed', 10, 'imperial')).toBeCloseTo(22.369363, 5);
    expect(toDialUnits('pace', 300, 'metric')).toBe(300);
    expect(toDialUnits('pace', 300, 'imperial')).toBeCloseTo(482.8032, 6);
    for (const [metric, value] of [['speed', 7.3], ['pace', 281], ['power', 250], ['heartRate', 150], [undefined, 12]] as const) {
      for (const units of ['metric', 'imperial'] as const) {
        expect(fromDialUnits(metric, toDialUnits(metric, value, units), units)).toBeCloseTo(value, 9);
        expect(dialToStored(metric, storedToDial(metric, value, units), units)).toBeCloseTo(value, 8);
      }
    }
    expect(toDialUnits('power', 250, 'imperial')).toBe(250);
    expect([dialUnitLabel('speed', 'metric'), dialUnitLabel('speed', 'imperial'), dialUnitLabel('pace', 'metric'), dialUnitLabel('pace', 'imperial'), dialUnitLabel('power', 'metric')]).toEqual(['km/h', 'mph', 'min/km', 'min/mi', undefined]);
  });

  it('rounds the range an activity gives in km/h or mph, and a pace in seconds, and stores m/s and s/km', () => {
    const timeline = rideAt(0.5, 8);
    // 1.8 to 28.8 km/h: from 0 to 30 in steps of 5.
    const metric = activityRange(timeline, speed)!;
    expect(metric.min).toBe(0);
    expect(metric.max).toBeCloseTo(30 / 3.6, 6);
    // 1.1 to 17.9 mph: 0 to 20 in steps of 5... a whole step of mph.
    const imperial = activityRange(timeline, { kind: 'metric', metric: 'speed' }, 'imperial')!;
    expect(toDialUnits('speed', imperial.max, 'imperial')).toBeCloseTo(20, 6);
    // 125 to 2000 s/km: in steps of 300 s, 0 to 2100; per mile 201 to 3218 s, in steps of 600, 0 to 3600.
    const pace = activityRange(timeline, { kind: 'metric', metric: 'pace' })!;
    expect(pace).toEqual({ min: 0, max: 2100 });
    const paceMiles = activityRange(timeline, { kind: 'metric', metric: 'pace' }, 'imperial')!;
    expect(toDialUnits('pace', paceMiles.max, 'imperial')).toBeCloseTo(3600, 4);
  });

  it('finds the pace step from seconds a runner reads, with at most eight intervals', () => {
    expect(paceStep(60)).toBe(10);
    expect(paceStep(120)).toBe(15);
    expect(paceStep(240)).toBe(30);
    expect(paceStep(600)).toBe(120);
    expect(paceStep(10_000)).toBe(1800);
    for (const span of [7, 45, 180, 500, 3000]) expect(span / paceStep(span)).toBeLessThanOrEqual(8 + 1e-9);
  });

  it('has ticks of whole km/h or mph over a range stored in m/s, with the values to write', () => {
    const range = { min: 0, max: 30 / 3.6 };
    const metric = dialTicks(range, { minorTicks: 0 }, { metric: 'speed', units: 'metric' });
    expect(metric.map((tick) => tick.value)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    // The same stored range, in mph: 18.6 mph, so steps of 5 to 15, the needle not moved.
    const imperial = dialTicks(range, { minorTicks: 0 }, { metric: 'speed', units: 'imperial' });
    expect(imperial.map((tick) => tick.value)).toEqual([0, 5, 10, 15]);
    expect(imperial[3]!.fraction).toBeCloseTo(15 / toDialUnits('speed', range.max, 'imperial'), 9);
    expect(rangeFraction(5, range)).toBeCloseTo(5 / range.max, 9);
  });

  it('takes a typed step in the display units and keeps it stored in the stored ones', () => {
    const stored = dialToStored('speed', 10, 'metric');
    expect(stored).toBeCloseTo(10 / 3.6, 8);
    const ticks = dialTicks({ min: 0, max: 40 / 3.6 }, { majorStep: stored, minorTicks: 0 }, { metric: 'speed', units: 'metric' });
    expect(ticks.map((tick) => tick.value)).toEqual([0, 10, 20, 30, 40]);
    // A pace typed as 30 seconds a mile is 18.64 s/km stored, and a step of 30 in either system.
    const pace = dialToStored('pace', 30, 'imperial');
    expect(storedToDial('pace', pace, 'imperial')).toBe(30);
    const paceTicks = dialTicks({ min: 240, max: 480 }, { majorStep: pace, minorTicks: 0 }, { metric: 'pace', units: 'imperial' });
    expect(paceTicks[1]!.value! - paceTicks[0]!.value!).toBeCloseTo(30, 6);
  });

  it('writes pace as m:ss, and the rest with the fewest decimals the step needs', () => {
    expect(dialTickLabel('pace', 330, 30)).toBe('5:30');
    expect(dialTickLabel('pace', 5, 5)).toBe('0:05');
    expect(dialTickLabel('speed', 20, 5)).toBe('20');
    expect(dialTickLabel('speed', 2.5, 0.5)).toBe('2.5');
    // A tick off the whole numbers (a range stored in km/h, read in mph) is written as it is.
    expect(dialTickLabel('speed', 11.2137, 5)).toBe('11.2');
    expect(dialTickLabel('speed', 7.456, 7.456)).toBe('7.5');
    expect(dialTickLabel('speed', 0.25, 0.05)).toBe('0.25');
    expect(dialTickLabel('power', 0, 100)).toBe('0');
  });
});
