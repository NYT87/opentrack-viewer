import { describe, expect, it } from 'vitest';
import { makeActivity } from '../test/helpers/activity';
import { activityThrough, straightNorth, type TestPoint } from '../test/helpers/mapVideoRoutes';
import {
  bearingDegrees,
  cardinalLetters,
  circularMeanDegrees,
  deriveGrade,
  deriveHeading,
  formatHeading,
  lerpDegrees,
  normalizeDegrees,
} from './derivedSeries';
import { buildOverlayTimeline, canSmooth, smoothedValueAt, type OverlayDataSource } from './timeline';

/** AV-1019 (TD-087). The derived grade and the heading: the bearing, the circular smoothing, the stops and the gaps. */

const HEADING: OverlayDataSource = { kind: 'metric', metric: 'heading' };
const GRADE: OverlayDataSource = { kind: 'metric', metric: 'grade' };
const T0 = Date.UTC(2026, 10, 10, 8);

describe('the bearing', () => {
  it('is 0 north, 90 east, 180 south and 270 west', () => {
    const o = { lat: 46, lon: 7 };
    expect(bearingDegrees(o, { lat: 46.01, lon: 7 })).toBeCloseTo(0, 6);
    expect(bearingDegrees(o, { lat: 46, lon: 7.01 })).toBeCloseTo(90, 1);
    expect(bearingDegrees(o, { lat: 45.99, lon: 7 })).toBeCloseTo(180, 6);
    expect(bearingDegrees(o, { lat: 46, lon: 6.99 })).toBeCloseTo(270, 1);
    expect(bearingDegrees(o, { lat: 46.01, lon: 7.01 })).toBeGreaterThan(0);
    expect(bearingDegrees(o, { lat: 46.01, lon: 7.01 })).toBeLessThan(90);
  });

  it('is the same across the antimeridian and the poles’ meridian wrap', () => {
    expect(bearingDegrees({ lat: 0.5, lon: 179.999 }, { lat: 0.5, lon: -179.999 })).toBeCloseTo(90, 1);
  });
});

describe('angles', () => {
  it('normalizes into [0, 360) and never returns 360', () => {
    expect(normalizeDegrees(-1)).toBe(359);
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(725)).toBe(5);
    expect(normalizeDegrees(-1e-15)).toBeLessThan(360);
    expect(normalizeDegrees(-360)).toBe(0);
  });

  it('takes the circular mean of 359 and 1 as north, not south', () => {
    const rad = (d: number) => (d * Math.PI) / 180;
    const mean = circularMeanDegrees(Math.sin(rad(359)) + Math.sin(rad(1)), Math.cos(rad(359)) + Math.cos(rad(1)), 2)!;
    expect(Math.min(mean, 360 - mean)).toBeCloseTo(0, 6);
    // The mean of the degrees would be 180.
  });

  it('has no mean for opposite headings, or for none', () => {
    expect(circularMeanDegrees(0, 0, 0)).toBeUndefined();
    expect(circularMeanDegrees(Math.sin(0) + Math.sin(Math.PI), Math.cos(0) + Math.cos(Math.PI), 2)).toBeUndefined();
  });

  it('turns the short way between two headings', () => {
    expect(lerpDegrees(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpDegrees(10, 350, 0.25)).toBeCloseTo(5, 6);
    expect(lerpDegrees(0, 90, 0.5)).toBeCloseTo(45, 6);
    expect(lerpDegrees(90, 270, 0)).toBeCloseTo(90, 6);
  });

  it('writes a heading as rounded degrees and an 8-point letter, the two always agreeing', () => {
    expect(formatHeading(0)).toBe('0° N');
    expect(formatHeading(123)).toBe('123° SE');
    expect(formatHeading(22.4)).toBe('22° N');
    expect(formatHeading(22.5)).toBe('23° NE');
    expect(formatHeading(359.6)).toBe('0° N');
    expect(formatHeading(337.4)).toBe('337° NW');
    expect(formatHeading(337.5)).toBe('338° N');
    expect(formatHeading(270)).toBe('270° W');
    expect(formatHeading(-90)).toBe('270° W');
    expect(cardinalLetters(45)).toBe('NE');
    expect(cardinalLetters(180)).toBe('S');
  });
});

describe('the heading metric', () => {
  const north = activityThrough(straightNorth(200, 5, 5));
  const timeline = buildOverlayTimeline(north, { video: { durationSeconds: 40 } });

  it('is the bearing of the last 20 m of the route', () => {
    expect(timeline.available.has('metric:heading')).toBe(true);
    const heading = timeline.sampleAt(20)!.values['metric:heading']!;
    expect(Math.min(heading, 360 - heading)).toBeLessThan(0.01);
  });

  it('is absent until the activity has moved 20 m', () => {
    // 5 m/s: 20 m at 4 s.
    expect(timeline.sampleAt(0)!.values['metric:heading']).toBeUndefined();
    expect(timeline.sampleAt(3.5)!.values['metric:heading']).toBeUndefined();
    expect(timeline.sampleAt(4)!.values['metric:heading']).toBeDefined();
  });

  it('is east, south and west for rides that way', () => {
    const along = (dx: number, dy: number) => {
      const points: TestPoint[] = Array.from({ length: 21 }, (_, i) => ({ north: dy * i * 5, east: dx * i * 5, second: i }));
      return buildOverlayTimeline(activityThrough(points), { video: { durationSeconds: 20 } }).sampleAt(15)!.values['metric:heading']!;
    };
    expect(along(1, 0)).toBeCloseTo(90, 0);
    expect(along(0, -1)).toBeCloseTo(180, 0);
    expect(along(-1, 0)).toBeCloseTo(270, 0);
  });

  it('turns through north without a jump: 350 to 10 degrees passes through 0, never through 180', () => {
    // Ride at heading 350 for 40 m, then at 10 for 40 m, one second a 5 m step.
    const rad = (d: number) => (d * Math.PI) / 180;
    const points: TestPoint[] = [];
    let n = 0;
    let e = 0;
    for (let i = 0; i <= 16; i += 1) {
      points.push({ north: n, east: e, second: i });
      const h = i < 8 ? 350 : 10;
      n += 5 * Math.cos(rad(h));
      e += 5 * Math.sin(rad(h));
    }
    const t = buildOverlayTimeline(activityThrough(points), { video: { durationSeconds: 16 } });
    for (let s = 5; s <= 16; s += 0.25) {
      const value = t.sampleAt(s)?.values['metric:heading'];
      if (value === undefined) continue;
      expect(Math.min(value, 360 - value), `at ${s}`).toBeLessThan(25);
    }
    // And a smoothed one, across the turn, is a heading near north, not the mean of 350 and 10 read as 180.
    const smoothed = smoothedValueAt(t, HEADING, 14, 6)!;
    expect(Math.min(smoothed, 360 - smoothed)).toBeLessThan(25);
  });

  it('holds through a stop: the value the stop began with, not zero (TD-080)', () => {
    // A ride north, then a 60 s gap with no points (a stop), then on.
    const points: TestPoint[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ north: i * 5, east: 0, second: i })),
      ...Array.from({ length: 5 }, (_, i) => ({ north: 40, east: i * 5, second: 68 + i })),
    ];
    const t = buildOverlayTimeline(activityThrough(points), { video: { durationSeconds: 72 } });
    const before = t.sampleAt(8)!.values['metric:heading']!;
    const during = t.sampleAt(40)!.values['metric:heading'];
    expect(during).toBe(before);
    expect(t.sampleAt(40)!.values['metric:speed']).toBe(0);
  });

  it('is not smoothed across a missing span differently from any other metric: the samples without a value are left out', () => {
    const points: TestPoint[] = Array.from({ length: 31 }, (_, i) => ({ north: i * 5, east: 0, second: i }));
    const t = buildOverlayTimeline(activityThrough(points), { video: { durationSeconds: 30 } });
    // The first 4 s have no heading; a window over them averages the ones that do.
    const value = smoothedValueAt(t, HEADING, 6, 6)!;
    expect(Math.min(value, 360 - value)).toBeLessThan(0.01);
    expect(smoothedValueAt(t, HEADING, 2, 2)).toBeUndefined();
  });

  it('can be smoothed, as any reading can', () => {
    expect(canSmooth(HEADING)).toBe(true);
  });

  it('is absent without positions, and across a pause between recorded segments', () => {
    const none = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: new Date(T0 + i * 1000), distanceMeters: i * 5 })));
    expect(buildOverlayTimeline(none).available.has('metric:heading')).toBe(false);
    const segments = activityThrough(straightNorth(100, 5, 5).map((p, i) => ({ ...p, segment: i < 11 ? 0 : 1, north: i < 11 ? p.north : p.north + 5000 })));
    const deriveAt = deriveHeading(segments.points, segments.points.map((_, i) => i * 5));
    // The first point after the pause has no 20 m behind it in its own segment.
    expect(deriveAt[11]).toBeUndefined();
    expect(deriveAt[14]).toBeUndefined();
    expect(deriveAt[15]).toBeDefined();
  });

  it('ignores a stationary jitter: the 20 m is of distance, so it looks further back until the route has gone that far', () => {
    const points = activityThrough([
      { north: 0, east: 0, second: 0 },
      { north: 0, east: 0, second: 1 },
      { north: 0, east: 0, second: 2 },
      { north: 10, east: 0, second: 3 },
      { north: 25, east: 0, second: 4 },
    ]);
    const heading = deriveHeading(points.points, [0, 0, 0, 10, 25]);
    expect(heading[3]).toBeUndefined();
    expect(heading[4]).toBeCloseTo(0, 1);
  });
});

describe('the derived grade (AV-1019, TD-087)', () => {
  const along = (n: number, step = 10) => Array.from({ length: n }, (_, i) => i * step);

  it('is the climb over the last 50 m of distance, in percent: up, down, flat', () => {
    const distance = along(21);
    const elevations = (slope: number) => distance.map((d) => 100 + (d * slope) / 100);
    const grade = (slope: number) => {
      const points = elevations(slope).map((elevationMeters, index) => ({ index, elevationMeters }));
      return deriveGrade(points, distance);
    };
    expect(grade(8)[20]).toBeCloseTo(8, 9);
    expect(grade(-5)[20]).toBeCloseTo(-5, 9);
    expect(grade(0)[20]).toBe(0);
  });

  it('is undefined within the first 50 m, and uses the nearest point at least 50 m back', () => {
    const distance = along(21, 7);
    const points = distance.map((d, index) => ({ index, elevationMeters: d * 0.1 }));
    const grade = deriveGrade(points, distance);
    // 7 m steps: the first point 50 m or more behind is 8 steps (56 m), at point 8.
    expect(grade.slice(0, 8).every((value) => value === undefined)).toBe(true);
    expect(grade[8]).toBeCloseTo(10, 9);
    expect(grade[9]).toBeCloseTo(10, 9);
  });

  it('is undefined where the activity has no elevation, at the point or where it looks back to', () => {
    const distance = along(21);
    const none = distance.map((_, index) => ({ index }));
    expect(deriveGrade(none, distance).every((value) => value === undefined)).toBe(true);
    const lacking = distance.map((d, index) => ({ index, elevationMeters: index === 10 ? undefined : d / 10 }));
    const grade = deriveGrade(lacking, distance);
    expect(grade[10]).toBeUndefined();
    expect(grade[15]).toBeUndefined();
    expect(grade[16]).toBeDefined();
  });

  it('is undefined where there is no distance, and does not look back across a recorded segment', () => {
    const distance: (number | undefined)[] = [...along(11), undefined, ...along(10, 10).map((d) => d + 200)];
    const points = distance.map((_, index) => ({ index, elevationMeters: 100 + index, segmentIndex: index < 11 ? 0 : 1 }));
    const grade = deriveGrade(points, distance);
    expect(grade[11]).toBeUndefined();
    // The first 50 m of the second segment: nothing to look back to in it.
    for (let i = 12; i < 17; i += 1) expect(grade[i], `point ${i}`).toBeUndefined();
    expect(grade[17]).toBeDefined();
  });

  it('prefers the file’s own grade where a point has one', () => {
    const distance = along(21);
    const points = distance.map((d, index) => ({ index, elevationMeters: 100 + d / 10, gradePercent: index === 12 ? 17 : undefined }));
    const grade = deriveGrade(points, distance);
    expect(grade[12]).toBe(17);
    expect(grade[13]).toBeCloseTo(10, 9);
  });

  it('gives a GPX with elevation and no recorded grade a gradient, in the timeline', () => {
    const climb = activityThrough(straightNorth(400, 10, 5).map((p) => ({ ...p, elevation: 100 + p.north * 0.06 })));
    const t = buildOverlayTimeline(climb, { video: { durationSeconds: 80 } });
    expect(t.available.has('metric:grade')).toBe(true);
    expect(t.sampleAt(40)!.values['metric:grade']).toBeCloseTo(6, 1);
    expect(t.sampleAt(2)!.values['metric:grade']).toBeUndefined();
  });

  it('is not offered without elevation', () => {
    const flat = activityThrough(straightNorth(400, 10, 5));
    expect(buildOverlayTimeline(flat, { video: { durationSeconds: 80 } }).available.has('metric:grade')).toBe(false);
  });

  it('keeps a recorded grade over the derived one in the timeline', () => {
    const climb = activityThrough(straightNorth(400, 10, 5).map((p) => ({ ...p, elevation: 100 + p.north * 0.06 })));
    const recorded = { ...climb, points: climb.points.map((p) => ({ ...p, gradePercent: -3 })) };
    expect(buildOverlayTimeline(recorded, { video: { durationSeconds: 80 } }).sampleAt(40)!.values['metric:grade']).toBeCloseTo(-3, 9);
  });

  it('is smoothed as any reading is', () => {
    expect(canSmooth(GRADE)).toBe(true);
  });
});
