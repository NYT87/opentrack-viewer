import { describe, expect, it } from 'vitest';
import type { Activity } from '../domain/activity';
import { computeDistance } from '../domain/stats';
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

/*
 * AV-1019 (TD-087). The profile is now the series of elevation along distance. This is AV-1211's projection as it
 * was before, kept whole as the reference, so the test below holds the new one to its output point for point: a
 * profile draws the same pixels, and the cursor lands on the same place.
 */
type LegacyPoint = [number, number];
interface LegacyProfile {
  runs: LegacyPoint[][];
  at(progress: number): LegacyPoint | undefined;
}
const LEGACY_COLUMNS = 1000;
const LEGACY_TOP = 0.12;
const LEGACY_BOTTOM = 0.08;
type Point = LegacyPoint;

/** The profile of `activity`, or `undefined` when it has no two places with an elevation along it. */
function legacyProjectProfile(activity: Activity): LegacyProfile | undefined {
  const { points } = activity;
  const distance = computeDistance(points).cumulativeMeters;
  const along: (number | undefined)[] = new Array(points.length).fill(undefined);
  let first: number | undefined;
  let last: number | undefined;
  for (let i = 0; i < points.length; i += 1) {
    const meters = distance[i];
    if (typeof meters !== 'number' || !Number.isFinite(meters)) continue;
    first ??= meters;
    last = meters;
    along[i] = meters;
  }
  // No distance at all: along by time, as the timeline's progress is then.
  if (first === undefined || last === undefined || last <= first) {
    first = undefined;
    last = undefined;
    for (let i = 0; i < points.length; i += 1) {
      const ms = points[i]!.time?.getTime();
      along[i] = typeof ms === 'number' && Number.isFinite(ms) ? ms / 1000 : undefined;
      if (along[i] === undefined) continue;
      first ??= along[i];
      last = along[i];
    }
  }
  if (first === undefined || last === undefined || last <= first) return undefined;

  let low = Infinity;
  let high = -Infinity;
  for (const point of points) {
    const elevation = point.elevationMeters;
    if (typeof elevation !== 'number' || !Number.isFinite(elevation)) continue;
    low = Math.min(low, elevation);
    high = Math.max(high, elevation);
  }
  if (!Number.isFinite(low)) return undefined;
  const span = last - first;
  const x = (value: number) => Math.min(1, Math.max(0, (value - first) / span));
  // A flat profile is a line across the middle of where a hilly one would be.
  const y = (elevation: number) =>
    high > low ? 1 - LEGACY_BOTTOM - ((elevation - low) / (high - low)) * (1 - LEGACY_TOP - LEGACY_BOTTOM) : (1 + LEGACY_TOP - LEGACY_BOTTOM) / 2;

  // Every point with both, in runs; then each run kept to its lowest and highest point per column.
  const full: Point[][] = [];
  let run: Point[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const elevation = points[i]!.elevationMeters;
    const where = along[i];
    if (where === undefined || typeof elevation !== 'number' || !Number.isFinite(elevation)) {
      if (run.length) full.push(run);
      run = [];
      continue;
    }
    run.push([x(where), y(elevation)]);
  }
  if (run.length) full.push(run);
  const runs = full.map(thin).filter((line) => line.length > 0);
  if (runs.length === 0) return undefined;

  // For the cursor: every run's points in order along, to search.
  const ordered = runs.flatMap((line, index) => line.map((point) => ({ point, run: index })));
  return {
    runs,
    at(progress) {
      const target = Math.min(1, Math.max(0, progress));
      let lo = 0;
      let hi = ordered.length - 1;
      if (target < ordered[0]!.point[0] || target > ordered[hi]!.point[0]) return undefined;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ordered[mid]!.point[0] <= target) lo = mid;
        else hi = mid;
      }
      const a = ordered[lo]!;
      const b = ordered[hi]!;
      if (a.point[0] === target || lo === hi) return [target, a.point[1]];
      // Between two runs is a gap: no elevation there.
      if (a.run !== b.run) return undefined;
      const t = (target - a.point[0]) / (b.point[0] - a.point[0] || 1);
      return [target, a.point[1] + (b.point[1] - a.point[1]) * t];
    },
  };
}

/** A run with at most two points a column: its lowest and highest there, in the order they come along. */
function thin(run: Point[]): Point[] {
  if (run.length <= LEGACY_COLUMNS * 2) return run;
  const out: Point[] = [];
  let column = -1;
  let lowest: Point | undefined;
  let highest: Point | undefined;
  const flush = () => {
    if (!lowest || !highest) return;
    if (lowest === highest) out.push(lowest);
    else out.push(...(lowest[0] <= highest[0] ? [lowest, highest] : [highest, lowest]));
  };
  for (const point of run) {
    const at = Math.min(LEGACY_COLUMNS - 1, Math.floor(point[0] * LEGACY_COLUMNS));
    if (at !== column) {
      flush();
      column = at;
      lowest = point;
      highest = point;
      continue;
    }
    // y is down: the lowest place has the largest y.
    if (point[1] > lowest![1]) lowest = point;
    if (point[1] < highest![1]) highest = point;
  }
  flush();
  return out;
}

describe('the profile as a case of the series (AV-1019, TD-087)', () => {
  const T0 = Date.UTC(2026, 10, 1, 8);
  const fixtures: [string, Activity][] = [
    ['a hill', hill],
    ['a gap in the elevation', activityThrough(straightNorth(1000, 10, 5).map((point) => (point.north > 400 && point.north < 600 ? point : { ...point, elevation: 100 + point.north / 10 })))],
    ['two segments', activityThrough(straightNorth(1000, 10, 5).map((point, i) => ({ ...point, elevation: 100 + (i % 9), segment: i < 50 ? 0 : 1 })))],
    ['a long ride', activityThrough(Array.from({ length: 30_001 }, (_, i) => ({ north: i, east: Math.sin(i / 900) * 200, second: i / 5, elevation: 100 + Math.sin(i / 700) * 30 + (i % 4000 === 1 ? 300 : 0) })))],
    ['no distance, by time', makeActivity(Array.from({ length: 101 }, (_, i) => ({ time: new Date(T0 + i * 1000), elevationMeters: 100 + (i < 50 ? i : 100 - i) })))],
    ['a flat ride', activityThrough(straightNorth(500, 10, 5).map((point) => ({ ...point, elevation: 42 })))],
    ['elevation at the ends missing', activityThrough(straightNorth(500, 10, 5).map((point, i) => (i < 3 || i > 45 ? point : { ...point, elevation: 10 + i })))],
    ['a recorded distance', makeActivity(Array.from({ length: 80 }, (_, i) => ({ time: new Date(T0 + i * 1000), distanceMeters: i * 3 + (i > 40 ? 50 : 0), elevationMeters: 300 + Math.cos(i / 6) * 40 })))],
  ];

  for (const [name, activity] of fixtures) {
    it(`has the runs and the cursor of AV-1211's projection on ${name}`, () => {
      const before = legacyProjectProfile(activity);
      const after = projectProfile(activity);
      expect(after === undefined).toBe(before === undefined);
      if (!before || !after) return;
      expect(after.runs).toEqual(before.runs);
      for (let i = -1; i <= 101; i += 1) expect(after.at(i / 100)).toEqual(before.at(i / 100));
    });
  }

  it('has its distance measured as the timeline measures it', () => {
    expect(projectProfile(hill)!.axis).toBe('distance');
    expect(projectProfile(hill)!.last - projectProfile(hill)!.first).toBeCloseTo(computeDistance(hill.points).totalMeters!, 6);
  });
});
