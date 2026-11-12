import { describe, expect, it } from 'vitest';
import { makeActivity } from '../test/helpers/activity';
import { DEFAULT_DIAL, DIAL_LIMITS, activityRange, dialAngle, dialTicks, niceRange, niceStep, rangeFraction } from './dial';
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
    // 3 to 12 m/s: from 0, in steps of 2.
    expect(activityRange(timeline, { kind: 'metric', metric: 'speed' })).toEqual({ min: 2, max: 12 });
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
    expect(ticks[0]).toEqual({ fraction: 0, major: true });
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
