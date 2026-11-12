import { describe, expect, it } from 'vitest';
import { makeActivity } from '../test/helpers/activity';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { projectSeries } from './series';

/** AV-1019 (TD-087). The series projection under a chart: the axes, the gaps, the window and the cursor. */

/** 1 km north at 5 m/s, a point every 10 m; the value is the metres north. */
const ride = activityThrough(straightNorth(1000, 10, 5));
const north = (index: number) => index * 10;

describe('a series along distance', () => {
  const series = projectSeries(ride, north, 'distance')!;

  it('runs from the first to the last distance, the highest value near the top', () => {
    expect(series.axis).toBe('distance');
    expect(series.last - series.first).toBeCloseTo(1000, 0);
    expect(series.low).toBe(0);
    expect(series.high).toBe(1000);
    const [run] = series.runs;
    expect(run![0]![0]).toBe(0);
    expect(run![run!.length - 1]![0]).toBe(1);
    expect(Math.min(...run!.map(([, y]) => y))).toBeCloseTo(0.12, 9);
    expect(Math.max(...run!.map(([, y]) => y))).toBeCloseTo(0.92, 9);
  });

  it('has nothing for an activity with no distance, unless it may fall back to time', () => {
    const indoors = makeActivity(Array.from({ length: 30 }, (_, i) => ({ time: new Date(Date.UTC(2026, 0, 1) + i * 1000), heartRateBpm: 100 + i })));
    expect(projectSeries(indoors, (i) => indoors.points[i]!.heartRateBpm, 'distance')).toBeUndefined();
    const byTime = projectSeries(indoors, (i) => indoors.points[i]!.heartRateBpm, 'distance', { fallbackToTime: true })!;
    expect(byTime.axis).toBe('time');
  });
});

describe('a series along time', () => {
  const series = projectSeries(ride, north, 'time')!;

  it('is the activity’s clock, in seconds', () => {
    expect(series.axis).toBe('time');
    expect(series.last - series.first).toBeCloseTo(200, 6);
  });

  it('has nothing for an activity with no times', () => {
    const untimed = makeActivity([{ elevationMeters: 1 }, { elevationMeters: 2 }]);
    expect(projectSeries(untimed, (i) => untimed.points[i]!.elevationMeters, 'time')).toBeUndefined();
  });
});

describe('a series along time, from a file in another order (TD-088)', () => {
  // Timestamps 0, 10 and 5 s: the third point was written last and happened between the others.
  const shuffled = makeActivity([0, 10, 5].map((second, i) => ({ time: new Date(Date.UTC(2026, 0, 1) + second * 1000), elevationMeters: [0, 100, 10][i] })));
  const value = (index: number) => shuffled.points[index]!.elevationMeters;

  it('spans the whole clock, and draws the line in time order', () => {
    const series = projectSeries(shuffled, value, 'time')!;
    expect(series.last - series.first).toBe(10);
    const [run] = series.runs;
    expect(run!.map(([x]) => x)).toEqual([0, 0.5, 1]);
    expect(run!.map(([, y]) => y)).toEqual([series.y(0), series.y(10), series.y(100)]);
  });

  it('does not pin a cursor at 8 s to the end, and searches a window on the sorted series', () => {
    const series = projectSeries(shuffled, value, 'time')!;
    const at = series.at(0.8)!;
    expect(at[0]).toBeCloseTo(0.8, 9);
    // Between 5 s (10) and 10 s (100): 64, not the 80 a file-order walk would give.
    expect(at[1]).toBeCloseTo(series.y(64), 9);
    const window = series.window(series.first + 8, 1)!;
    expect(window.from).toBe(series.first + 7);
    expect(window.low).toBeCloseTo(46, 9);
    expect(window.high).toBeCloseTo(82, 9);
  });

  it('leaves the distance axis to follow distance, as the profile always has', () => {
    const ordered = projectSeries(ride, north, 'distance')!;
    expect(ordered.last - ordered.first).toBeCloseTo(1000, 0);
  });
});

describe('gaps in a series', () => {
  it('is a gap in the line where the value is missing, and a cursor has no point there', () => {
    const series = projectSeries(ride, (i) => (i >= 40 && i <= 60 ? undefined : north(i)), 'distance')!;
    expect(series.runs).toHaveLength(2);
    expect(series.at(0.5)).toBeUndefined();
    expect(series.at(0.2)).toBeDefined();
    expect(series.at(0.8)).toBeDefined();
  });

  it('ends a run at a recorded pause or a long gap when asked to, and joins across it when not', () => {
    const paused = activityThrough(straightNorth(1000, 10, 5).map((p, i) => ({ ...p, second: i < 50 ? p.second : p.second! + 600 })));
    const joined = projectSeries(paused, north, 'distance')!;
    expect(joined.runs).toHaveLength(1);
    const broken = projectSeries(paused, north, 'distance', { breakAtPauses: true })!;
    expect(broken.runs).toHaveLength(2);
    const segmented = activityThrough(straightNorth(1000, 10, 5).map((p, i) => ({ ...p, segment: i < 50 ? 0 : 1 })));
    expect(projectSeries(segmented, north, 'time', { breakAtPauses: true })!.runs).toHaveLength(2);
  });

  it('does not end a run at an ordinary step, even a slow sensor’s few seconds', () => {
    const slow = activityThrough(straightNorth(1000, 50, 5).map((p, i) => ({ ...p, second: i * 8 })));
    expect(projectSeries(slow, (i) => i, 'time', { breakAtPauses: true })!.runs).toHaveLength(1);
  });
});

describe('a window around now', () => {
  const series = projectSeries(ride, north, 'distance')!;
  const mid = series.first + 500;

  it('has the cursor in the middle, and x across the window', () => {
    const window = series.window(mid, 100)!;
    expect(window.from).toBeCloseTo(mid - 100, 9);
    expect(window.to).toBeCloseTo(mid + 100, 9);
    const [run] = window.runs;
    expect(run![0]![0]).toBeCloseTo(0, 9);
    expect(run![run!.length - 1]![0]).toBeCloseTo(1, 9);
    // The metres north are the distance along, so the line is straight and the middle is half way up its own range.
    expect(window.low).toBeCloseTo(400, 2);
    expect(window.high).toBeCloseTo(600, 2);
    expect(window.y(500)).toBeCloseTo((0.12 + 0.92) / 2, 4);
  });

  it('rescales y to the window’s own lowest and highest value', () => {
    const wide = series.window(mid, 400)!;
    const narrow = series.window(mid, 50)!;
    for (const window of [wide, narrow]) {
      const ys = window.runs.flat().map(([, y]) => y);
      expect(Math.min(...ys)).toBeCloseTo(0.12, 6);
      expect(Math.max(...ys)).toBeCloseTo(0.92, 6);
    }
    expect(narrow.low).toBeGreaterThan(wide.low);
  });

  it('cuts a run at the window’s edges, exactly, between points', () => {
    const window = series.window(mid + 3, 25)!;
    expect(window.low).toBeCloseTo(478, 2);
    expect(window.high).toBeCloseTo(528, 2);
    const xs = window.runs.flat().map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(1, 9);
  });

  it('keeps the cursor in the middle where the window reaches beyond the activity: x is the window’s, and the line stops where the activity does', () => {
    const start = series.window(series.first + 20, 100)!;
    const xs = start.runs.flat().map(([x]) => x);
    // The activity begins 20 m in: 80 of the 200 m window are before it, at x 0.4.
    expect(Math.min(...xs)).toBeCloseTo(0.4, 6);
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
    const end = series.window(series.last - 20, 100)!;
    expect(Math.max(...end.runs.flat().map(([x]) => x))).toBeCloseTo(0.6, 6);
  });

  it('is nothing where the window holds no data, or none can be asked for', () => {
    expect(series.window(series.last + 5000, 100)).toBeUndefined();
    expect(series.window(series.first - 5000, 100)).toBeUndefined();
    expect(series.window(mid, 0)).toBeUndefined();
    expect(series.window(Number.NaN, 10)).toBeUndefined();
  });

  it('gives a window that falls inside one step the line through it', () => {
    const window = series.window(mid + 5, 2)!;
    expect(window.runs).toHaveLength(1);
    expect(window.runs[0]).toHaveLength(2);
    expect(window.low).toBeCloseTo(503, 2);
    expect(window.high).toBeCloseTo(507, 2);
  });

  it('keeps a gap a gap: two runs in the window, none across it', () => {
    const gappy = projectSeries(ride, (i) => (i >= 45 && i <= 55 ? undefined : north(i)), 'distance')!;
    const window = gappy.window(mid, 150)!;
    expect(window.runs).toHaveLength(2);
    expect(window.runs[0]![window.runs[0]!.length - 1]![0]).toBeLessThan(window.runs[1]![0]![0]);
  });

  it('is a middle line for a flat value', () => {
    const flat = projectSeries(ride, () => 7, 'distance')!;
    const window = flat.window(mid, 100)!;
    expect(new Set(window.runs.flat().map(([, y]) => y)).size).toBe(1);
    expect(window.y(7)).toBeCloseTo(0.52, 9);
  });

  it('costs the points in the window, not the activity’s: a long ride is as quick to slice as a short one', () => {
    const long = activityThrough(Array.from({ length: 200_001 }, (_, i) => ({ north: i, east: 0, second: i / 5 })));
    const big = projectSeries(long, (i) => (i % 97) + Math.sin(i / 50), 'distance')!;
    const started = performance.now();
    for (let k = 0; k < 500; k += 1) big.window(big.first + 1000 + k * 300, 60);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
