import type { Activity } from '../domain/activity';
import { computeDistance } from '../domain/stats';

/**
 * AV-1019 (TD-087). A series of values along an activity, fitted into a unit
 * box: along the activity on x (by distance, or by time), the value on y (down),
 * with the highest value near the top. It is AV-1211's elevation profile made
 * general: `projectProfile` is the series of elevation along distance, and its
 * runs come out exactly as they did, so a profile draws the same pixels. A
 * chart is the series of any figure, whole or through a window around now.
 *
 * Along is measured as the timeline's `progress` is (TD-041): by the recorded
 * or derived distance (`computeDistance`) where the activity has one. A stretch
 * with no value is a gap in the line, not a line drawn across it; a chart also
 * ends a run where the recording was paused or lost (see `breakAtPauses`).
 */
export type SeriesAxis = 'time' | 'distance';

/** A point in the series' box, `[x, y]`, both 0..1 and y down. */
export type SeriesPoint = [number, number];

export interface ProjectedSeries {
  /** Runs of normalized points over the whole activity; a stretch without a value ends one. */
  runs: SeriesPoint[][];
  /** The line's point `progress` (0..1) of the way along the whole activity, or `undefined` in a gap. */
  at(progress: number): SeriesPoint | undefined;
  /** What the series is along: `time` is seconds since the epoch, `distance` metres from the activity's first recorded distance's odometer. */
  axis: SeriesAxis;
  /** The along-values at the series' start and end, in seconds or metres. */
  first: number;
  last: number;
  /** The lowest and highest value, in the figure's own unit. */
  low: number;
  high: number;
  /** Where a value falls on the whole series' y, 0..1 down, kept inside the box. */
  y(value: number): number;
  /**
   * The part of the series within `half` either side of `centre` (in the axis' unit),
   * with x 0..1 across that window, so `centre` is at 0.5 whether or not the activity
   * reaches that far, and y fitted to the window's own lowest and highest value.
   * `undefined` when the activity has no value in it. Costs a search and the points
   * in the window, never the whole activity.
   */
  window(centre: number, half: number): SeriesWindow | undefined;
}

export interface SeriesWindow {
  runs: SeriesPoint[][];
  low: number;
  high: number;
  /** The along-values at the window's left and right edges. */
  from: number;
  to: number;
  /** Where a value falls on this window's y, 0..1 down, kept inside the box. */
  y(value: number): number;
}

export interface SeriesOptions {
  /** With no distance, measure along by time instead (the profile's rule); off, the series has none. */
  fallbackToTime?: boolean;
  /** End a run at a change of recorded segment and at a gap of over 10 s: nothing is drawn across a pause or a dropout. */
  breakAtPauses?: boolean;
}

/** The most points a series is drawn with: two per column of a 1000 px box, the lowest and the highest. */
export const MAX_SERIES_COLUMNS = 1000;
/** The share of the box left clear above the highest point and below the lowest. */
const TOP_MARGIN = 0.12;
const BOTTOM_MARGIN = 0.08;
/** A gap longer than this between two points is a pause or a dropout: the timeline's own limit. */
const PAUSE_GAP_SECONDS = 10;

interface Raw {
  x: number[];
  v: number[];
}

/**
 * The series of `read` along `activity`, or `undefined` when it has no two
 * places with a value along it. `read` is given a point's index in
 * `activity.points`.
 */
export function projectSeries(
  activity: Activity,
  read: (index: number) => number | undefined,
  axis: SeriesAxis,
  options: SeriesOptions = {},
): ProjectedSeries | undefined {
  const { points } = activity;
  const along: (number | undefined)[] = new Array(points.length).fill(undefined);
  let first: number | undefined;
  let last: number | undefined;
  let measured: SeriesAxis = axis;
  // The order the points are walked in: the file's, except along time (TD-088).
  let order: number[] = points.map((_, i) => i);

  const alongTime = () => {
    first = undefined;
    last = undefined;
    for (let i = 0; i < points.length; i += 1) {
      const ms = points[i]!.time?.getTime();
      along[i] = typeof ms === 'number' && Number.isFinite(ms) ? ms / 1000 : undefined;
    }
    // TD-088 (TD-087). Time runs forward whatever order the file lists its points in: the timed points
    // are put in time order (a tie keeps the file's order) in the places the timed points held, so a
    // point with no time still ends a run where it was.
    const slots = order.filter((i) => along[i] !== undefined);
    const sorted = [...slots].sort((a, b) => along[a]! - along[b]! || a - b);
    order = order.slice();
    slots.forEach((slot, k) => {
      order[slot] = sorted[k]!;
    });
    for (const i of order) {
      if (along[i] === undefined) continue;
      first ??= along[i];
      last = along[i];
    }
  };
  if (axis === 'distance') {
    const distance = computeDistance(points).cumulativeMeters;
    for (let i = 0; i < points.length; i += 1) {
      const meters = distance[i];
      if (typeof meters !== 'number' || !Number.isFinite(meters)) continue;
      first ??= meters;
      last = meters;
      along[i] = meters;
    }
    // No distance at all: along by time, as the timeline's progress is then.
    if (first === undefined || last === undefined || last <= first) {
      if (!options.fallbackToTime) return undefined;
      measured = 'time';
      alongTime();
    }
  } else {
    alongTime();
  }
  if (first === undefined || last === undefined || last <= first) return undefined;

  let low = Infinity;
  let high = -Infinity;
  const values: (number | undefined)[] = new Array(points.length);
  for (let i = 0; i < points.length; i += 1) {
    const value = read(i);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    values[i] = value;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  if (!Number.isFinite(low)) return undefined;
  const start = first;
  const span = last - first;
  const x = (value: number) => Math.min(1, Math.max(0, (value - start) / span));
  const yOf = (lowest: number, highest: number) => (value: number) =>
    // A flat series is a line across the middle of where a hilly one would be.
    highest > lowest ? 1 - BOTTOM_MARGIN - ((value - lowest) / (highest - lowest)) * (1 - TOP_MARGIN - BOTTOM_MARGIN) : (1 + TOP_MARGIN - BOTTOM_MARGIN) / 2;
  const y = yOf(low, high);

  // Every point with both, in runs; then each run kept to its lowest and highest point per column.
  const raw: Raw[] = [];
  let run: Raw = { x: [], v: [] };
  let previous = -1;
  const flush = () => {
    if (run.x.length) raw.push(run);
    run = { x: [], v: [] };
  };
  for (const i of order) {
    const value = values[i];
    const where = along[i];
    if (where === undefined || value === undefined) {
      flush();
      previous = -1;
      continue;
    }
    if (options.breakAtPauses && previous >= 0 && endsRun(points[previous]!, points[i]!)) flush();
    run.x.push(where);
    run.v.push(value);
    previous = i;
  }
  flush();

  const full: SeriesPoint[][] = raw.map((entry) => entry.x.map((where, k) => [x(where), y(entry.v[k]!)] as SeriesPoint));
  const runs = full.map(thin).filter((line) => line.length > 0);
  if (runs.length === 0) return undefined;

  // For the cursor: every run's points in order along, to search.
  const ordered = runs.flatMap((line, index) => line.map((point) => ({ point, run: index })));
  return {
    runs,
    axis: measured,
    first,
    last,
    low,
    high,
    y: (value) => Math.min(1, Math.max(0, y(value))),
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
      // Between two runs is a gap: no value there.
      if (a.run !== b.run) return undefined;
      const t = (target - a.point[0]) / (b.point[0] - a.point[0] || 1);
      return [target, a.point[1] + (b.point[1] - a.point[1]) * t];
    },
    window(centre, half) {
      if (!Number.isFinite(centre) || !(half > 0)) return undefined;
      return windowOf(raw, centre, half);
    },
  };

  function endsRun(a: Activity['points'][number], b: Activity['points'][number]): boolean {
    if ((a.segmentIndex ?? 0) !== (b.segmentIndex ?? 0)) return true;
    const ta = a.time?.getTime();
    const tb = b.time?.getTime();
    return typeof ta === 'number' && typeof tb === 'number' && Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(tb - ta) / 1000 > PAUSE_GAP_SECONDS;
  }
}

/** The raw runs cut to [centre - half, centre + half], an exact edge point where a run reaches beyond it. */
function windowOf(raw: Raw[], centre: number, half: number): SeriesWindow | undefined {
  const from = centre - half;
  const to = centre + half;
  // The first run that ends at or after `from`: runs are in order along.
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const xs = raw[mid]!.x;
    if (xs[xs.length - 1]! >= from) hi = mid;
    else lo = mid + 1;
  }
  const cut: { x: number; v: number }[][] = [];
  let low = Infinity;
  let high = -Infinity;
  for (let r = lo; r < raw.length; r += 1) {
    const { x: xs, v: vs } = raw[r]!;
    if (xs[0]! > to) break;
    // The first index at or after `from`, and the last at or before `to`.
    const a = lowerBound(xs, from);
    const b = upperBound(xs, to) - 1;
    const line: { x: number; v: number }[] = [];
    // Where the run reaches beyond an edge, the line is cut there, on the segment that crosses it.
    if (a > 0 && xs[a]! > from) line.push({ x: from, v: interpolate(xs, vs, a - 1, a, from) });
    for (let k = a; k <= b; k += 1) line.push({ x: xs[k]!, v: vs[k]! });
    if (b >= 0 && b < xs.length - 1 && xs[b]! < to) line.push({ x: to, v: interpolate(xs, vs, b, b + 1, to) });
    if (line.length === 0) continue;
    for (const point of line) {
      low = Math.min(low, point.v);
      high = Math.max(high, point.v);
    }
    cut.push(line);
  }
  if (cut.length === 0) return undefined;
  const width = 2 * half;
  const yOfWindow = (value: number) =>
    high > low ? 1 - BOTTOM_MARGIN - ((value - low) / (high - low)) * (1 - TOP_MARGIN - BOTTOM_MARGIN) : (1 + TOP_MARGIN - BOTTOM_MARGIN) / 2;
  const runs = cut
    .map((line) => thin(line.map((point) => [(point.x - from) / width, yOfWindow(point.v)] as SeriesPoint)))
    .filter((line) => line.length > 0);
  return { runs, low, high, from, to, y: (value) => Math.min(1, Math.max(0, yOfWindow(value))) };
}

/** The first index whose value is at least `target`, or the length. */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first index whose value is over `target`, or the length. */
function upperBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function interpolate(xs: number[], vs: number[], a: number, b: number, at: number): number {
  const span = xs[b]! - xs[a]!;
  return span > 0 ? vs[a]! + ((vs[b]! - vs[a]!) * (at - xs[a]!)) / span : vs[a]!;
}

/** A run with at most two points a column: its lowest and highest there, in the order they come along. */
function thin(run: SeriesPoint[]): SeriesPoint[] {
  if (run.length <= MAX_SERIES_COLUMNS * 2) return run;
  const out: SeriesPoint[] = [];
  let column = -1;
  let lowest: SeriesPoint | undefined;
  let highest: SeriesPoint | undefined;
  const flush = () => {
    if (!lowest || !highest) return;
    if (lowest === highest) out.push(lowest);
    else out.push(...(lowest[0] <= highest[0] ? [lowest, highest] : [highest, lowest]));
  };
  for (const point of run) {
    const at = Math.min(MAX_SERIES_COLUMNS - 1, Math.floor(point[0] * MAX_SERIES_COLUMNS));
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
