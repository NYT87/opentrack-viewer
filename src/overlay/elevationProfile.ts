import type { Activity } from '../domain/activity';
import { computeDistance } from '../domain/stats';

/**
 * AV-1211. An activity's elevation, fitted into a unit box for the elevation
 * profile: along the activity on x, the height on y (down), with a cursor at
 * the moment shown.
 *
 * Along is measured as the timeline's `progress` is (TD-041): by the recorded
 * or derived distance (`computeDistance`) where the activity has one, else by
 * time. So the cursor is put at `progress` and lands on the place the figures
 * are read from, on the overlay page and over the map video alike. A stretch
 * with no elevation is a gap in the line, not a line drawn across it.
 */
export interface ProjectedProfile {
  /** Runs of normalized `[x, y]` points, y down; a stretch without elevation ends one. */
  runs: Point[][];
  /** The line's point `progress` (0..1) of the way along, or `undefined` in a gap. */
  at(progress: number): Point | undefined;
}

type Point = [number, number];

/** The most points a profile is drawn with: two per column of a 1000 px box, the lowest and the highest. */
export const MAX_PROFILE_COLUMNS = 1000;
/** The share of the box left clear above the highest point and below the lowest. */
const TOP_MARGIN = 0.12;
const BOTTOM_MARGIN = 0.08;

/** The profile of `activity`, or `undefined` when it has no two places with an elevation along it. */
export function projectProfile(activity: Activity): ProjectedProfile | undefined {
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
    high > low ? 1 - BOTTOM_MARGIN - ((elevation - low) / (high - low)) * (1 - TOP_MARGIN - BOTTOM_MARGIN) : (1 + TOP_MARGIN - BOTTOM_MARGIN) / 2;

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
  if (run.length <= MAX_PROFILE_COLUMNS * 2) return run;
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
    const at = Math.min(MAX_PROFILE_COLUMNS - 1, Math.floor(point[0] * MAX_PROFILE_COLUMNS));
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
