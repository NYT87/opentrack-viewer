import { describe, expect, it } from 'vitest';
import { makeActivity } from '../test/helpers/activity';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { MAX_PROFILE_COLUMNS, projectProfile } from './elevationProfile';
import { buildOverlayTimeline } from './timeline';

/** 1 km north, 10 m a point, up from 100 m to 200 m at the middle and back down. */
const hill = activityThrough(straightNorth(1000, 10, 5).map((point) => ({ ...point, elevation: 200 - Math.abs(point.north - 500) / 5 })));

describe('the elevation profile (AV-1211)', () => {
  it('runs along the activity on x and up with the height, the highest point near the top and the lowest near the bottom', () => {
    const profile = projectProfile(hill)!;
    expect(profile.runs).toHaveLength(1);
    const [run] = profile.runs;
    expect(run![0]![0]).toBe(0);
    expect(run![run!.length - 1]![0]).toBe(1);
    const top = Math.min(...run!.map(([, y]) => y));
    const bottom = Math.max(...run!.map(([, y]) => y));
    expect(top).toBeCloseTo(0.12, 9);
    expect(bottom).toBeCloseTo(0.92, 9);
    // The summit is half way along.
    expect(run!.find(([, y]) => y === top)![0]).toBeCloseTo(0.5, 9);
  });

  it('puts the cursor where the timeline\'s progress is, on the line', () => {
    const profile = projectProfile(hill)!;
    expect(profile.at(0.5)).toEqual([0.5, expect.closeTo(0.12, 9)]);
    expect(profile.at(0.25)![1]).toBeCloseTo(0.52, 6);
    // The timeline's progress at a moment and the profile agree on where along it is: the same distance.
    const timeline = buildOverlayTimeline(hill, { video: { durationSeconds: 1000 } });
    const sample = timeline.sampleAt(50)!; // 250 m in at 5 m/s
    expect(sample.progress).toBeCloseTo(0.25, 6);
    expect(profile.at(sample.progress!)![1]).toBeCloseTo(0.52, 6);
  });

  it('leaves a gap where the elevation is missing, and puts no dot on the cursor there', () => {
    const gappy = activityThrough(
      straightNorth(1000, 10, 5).map((point) => (point.north > 400 && point.north < 600 ? point : { ...point, elevation: 100 + point.north / 10 })),
    );
    const profile = projectProfile(gappy)!;
    expect(profile.runs).toHaveLength(2);
    expect(profile.at(0.5)).toBeUndefined();
    expect(profile.at(0.2)).toBeDefined();
    expect(profile.at(0.8)).toBeDefined();
  });

  it('is nothing for an activity without elevation, or with it in one place only', () => {
    expect(projectProfile(activityThrough(straightNorth(1000)))).toBeUndefined();
    expect(projectProfile(activityThrough([{ north: 0, east: 0, second: 0, elevation: 50 }]))).toBeUndefined();
  });

  it('runs by time where the activity has no distance, as the timeline\'s progress then does', () => {
    const T0 = Date.UTC(2026, 10, 1, 8);
    const indoors = makeActivity(
      Array.from({ length: 101 }, (_, i) => ({ time: new Date(T0 + i * 1000), elevationMeters: 100 + (i < 50 ? i : 100 - i) })),
    );
    const profile = projectProfile(indoors)!;
    expect(profile.at(0.5)![1]).toBeCloseTo(0.12, 6);
    const timeline = buildOverlayTimeline(indoors, { video: { durationSeconds: 100 } });
    expect(timeline.sampleAt(25)!.progress).toBeCloseTo(0.25, 6);
  });

  it('draws a long activity with at most two points a column, and keeps its peaks', () => {
    // 100 km, a point a metre, a spike every 7 km.
    const points = Array.from({ length: 100_001 }, (_, i) => ({ north: i, east: 0, second: i / 5, elevation: i % 7000 === 3500 ? 900 : 100 + Math.sin(i / 3000) * 20 }));
    const profile = projectProfile(activityThrough(points))!;
    const drawn = profile.runs.reduce((sum, run) => sum + run.length, 0);
    expect(drawn).toBeLessThanOrEqual(MAX_PROFILE_COLUMNS * 2);
    // Every spike is still drawn at the top.
    expect(profile.runs[0]!.filter(([, y]) => y < 0.13)).toHaveLength(14);
  });
});
