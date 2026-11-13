import { METERS_PER_MILE, formatDuration, formatPace, formatSpeed, type UnitSystem } from '../domain/units';
import type { OverlayFigureSetting, OverlaySplitsSetting, SplitsRate } from './template';

/**
 * AV-1021 (TD-090). Splits: the pure part. The defaults, the limits, where the
 * splits of an activity are (its laps, or every kilometre or mile), the time each
 * took by the clock the reader chose, how each compares with the one before it,
 * and what a frame shows of them. Nothing here draws, stores or reads a file:
 * the renderer, the editor, the layout parser and the contract all call it, so
 * they cannot disagree about a split.
 */

/** How many finished splits a list can show. */
export const SPLITS_LIST_LIMITS = { min: 0, max: 10 } as const;

/** A distance the reader sets, in kilometres or miles: 0.1 to 100 of them. */
export const SPLITS_EVERY_UNITS = { min: 0.1, max: 100 } as const;

/**
 * The same, in the metres a layout stores, for a reader whose units are not
 * known where it is read: the smallest in kilometres to the largest in miles.
 */
export const SPLITS_EVERY_METERS = { min: SPLITS_EVERY_UNITS.min * 1000, max: SPLITS_EVERY_UNITS.max * METERS_PER_MILE } as const;

/** Faster or slower needs a pace this far apart, in seconds per kilometre or mile; under it two splits are the same. */
export const SPLITS_TIE_SECONDS = 0.5;

/** A split shorter than this at the end of an activity is not one: it is where the last was cut. */
export const SPLITS_MIN_LAST_METERS = 1;

/** A rate is not written for less than this: a pace over a few metres is noise. */
export const SPLITS_MIN_RATE_METERS = 10;

/** Faster and slower: a green and a red that read on the default dark background, 12.1:1 and 7.6:1 against black. */
export const DEFAULT_SPLITS: OverlaySplitsSetting = {
  source: 'laps',
  time: 'moving',
  showLast: true,
  list: 0,
  fasterColor: '#4ade80',
  slowerColor: '#f87171',
};

/** The metres in a kilometre or a mile: the unit a pace and a distance split are in. */
export const unitMeters = (units: UnitSystem): number => (units === 'imperial' ? METERS_PER_MILE : 1000);

/** The distance a distance split covers, in metres: the reader's, or a kilometre or a mile. */
export const splitEveryMeters = (setting: Pick<OverlaySplitsSetting, 'every'>, units: UnitSystem): number => setting.every ?? unitMeters(units);

/** What the rate is when the reader has not chosen: a runner reads pace, everyone else speed. */
export const splitsRate = (setting: Pick<OverlaySplitsSetting, 'rate'>, sport: string | undefined): SplitsRate => setting.rate ?? (sport === 'running' ? 'pace' : 'speed');

export const SPLITS_NO_START_TIMES = 'The file’s laps have no start times.';
export const SPLITS_NO_DISTANCE = 'This activity has no distance to split by.';
export const SPLITS_NO_TIME = 'This activity has no timestamps.';

// ---------------------------------------------------------------------------
// What the timeline hands over

/** Which ways an activity can be split. The laps need two or more with a start; the distance needs a distance. */
export interface SplitSources {
  laps: boolean;
  /** `no_start_times`: the file has laps, but one has no start, so none can be placed. */
  lapsIssue?: 'no_start_times';
  distance: boolean;
}

/**
 * The activity's streams as splits read them, on the activity's own clock (seconds since its
 * first timed point). The `seconds`, `meters` and `moving` arrays are of the points that have
 * a distance, in time order, so the three share an index; `meters` is from the first of them and
 * never falls, and `moving` is the viewer's moving time so far (TD-058). All are empty for an
 * activity with no distance, whose moving time is then its elapsed time.
 */
export interface SplitStreams {
  seconds: readonly number[];
  meters: readonly number[];
  moving: readonly number[];
  /** Seconds from the first timed point to the last. */
  spanSeconds: number;
  /** The laps that can be placed, ascending by start, each with the distance the file states for it. Empty unless `SplitSources.laps`. */
  laps: readonly { startSeconds: number; meters?: number }[];
}

/** Why an activity cannot be split, or `undefined` when it can; the Add list's words. */
export function splitsUnavailableReason(timelineUnavailable: boolean, sources: SplitSources | undefined): string | undefined {
  if (timelineUnavailable || !sources) return SPLITS_NO_TIME;
  if (sources.laps || sources.distance) return undefined;
  return sources.lapsIssue === 'no_start_times' ? SPLITS_NO_START_TIMES : SPLITS_NO_DISTANCE;
}

/**
 * Where a component's splits come from here: the laps when it asks for them and
 * the file has usable ones, otherwise the distance, and nothing when neither is
 * there (a distance source on an activity with no distance, or no splits at all).
 */
export function splitsSourceOf(asked: OverlaySplitsSetting['source'], sources: SplitSources | undefined): OverlaySplitsSetting['source'] | undefined {
  if (!sources) return undefined;
  if (asked === 'laps' && sources.laps) return 'laps';
  return sources.distance ? 'distance' : undefined;
}

// ---------------------------------------------------------------------------
// The splits of an activity

export type SplitVerdict = 'faster' | 'slower' | 'same';

/** One finished split, from its start to its end on the activity's clock. */
export interface SplitRecord {
  /** From 1, at the start of the activity. */
  number: number;
  startSeconds: number;
  endSeconds: number;
  /** The time it took by the clock chosen: moving or elapsed. */
  seconds: number;
  /** Its distance in metres; absent where the activity has none for it. */
  meters?: number;
  /** Against the split before it; the first has none. */
  verdict?: SplitVerdict;
}

/** The splits at one moment: which is current, how long it has run, and how many have finished. */
export interface SplitMoment {
  /** 0-based: the split under way, and after the last has finished, the last. */
  index: number;
  /** Counted by the chosen clock, since the split began. */
  seconds: number;
  /** Since the split began; absent without a distance. */
  meters?: number;
  /** How many have ended by now; `splits[finished - 1]` is the last. */
  finished: number;
}

export interface SplitTimes {
  splits: readonly SplitRecord[];
  at: (activitySeconds: number) => SplitMoment;
}

export interface SplitBuildOptions {
  source: OverlaySplitsSetting['source'];
  /** Distance splits: metres in each. */
  everyMeters: number;
  time: OverlaySplitsSetting['time'];
  /** The metres in the unit a pace is per, for comparing: 1000 or 1609.344. */
  unitMeters: number;
}

/** `ys` at `x`, linearly between the two entries of `xs` it falls between and held at either end; `undefined` when empty. */
function interpolate(xs: readonly number[], ys: readonly number[], x: number): number | undefined {
  const n = xs.length;
  if (n === 0) return undefined;
  if (x <= xs[0]!) return ys[0];
  if (x >= xs[n - 1]!) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  const span = xs[lo + 1]! - xs[lo]!;
  return span > 0 ? ys[lo]! + ((ys[lo + 1]! - ys[lo]!) * (x - xs[lo]!)) / span : ys[lo];
}

/**
 * The splits of an activity, found once: boundaries by the distance along the whole
 * activity (or the laps' starts), each split's time by the clock the reader chose, read
 * from the points' own values interpolated at the boundary, and each compared with the
 * one before it by pace. A lookup at a moment is two binary searches.
 *
 * A boundary at a distance is where the distance crosses it, interpolated between the
 * two points either side. A step across a segment break adds no distance (the distance
 * stream says so), so a split with a break in it simply ends at its distance. Moving time
 * is the stream's, which never counts a step across a break and holds through a stop;
 * elapsed time is the activity's clock, which runs through both (TD-080).
 *
 * `undefined` where there is nothing to split: no laps placed, or no distance to cut.
 */
export function buildSplits(streams: SplitStreams, options: SplitBuildOptions): SplitTimes | undefined {
  const { seconds, meters, moving } = streams;
  const n = seconds.length;
  const distanceAt = (t: number): number | undefined => interpolate(seconds, meters, t);
  const counted = (t: number): number => (options.time === 'moving' && n > 0 ? (interpolate(seconds, moving, t) ?? t) : t);

  // Each split's start and end on the clock, and its distance where it is known by construction.
  const starts: number[] = [];
  const ends: number[] = [];
  const lengths: (number | undefined)[] = [];

  if (options.source === 'laps') {
    const { laps } = streams;
    if (laps.length < 2) return undefined;
    laps.forEach((lap, i) => {
      starts.push(lap.startSeconds);
      ends.push(i + 1 < laps.length ? laps[i + 1]!.startSeconds : Math.max(lap.startSeconds, streams.spanSeconds));
      // The file's own figure where it states one; the stream's, between the lap's start and end, where it does not.
      lengths.push(lap.meters !== undefined && lap.meters > 0 ? lap.meters : undefined);
    });
    lengths.forEach((length, i) => {
      if (length !== undefined || n < 2) return;
      const from = distanceAt(starts[i]!);
      const to = distanceAt(ends[i]!);
      if (from !== undefined && to !== undefined && to > from) lengths[i] = to - from;
    });
  } else {
    const total = n > 0 ? meters[n - 1]! : 0;
    const every = options.everyMeters;
    if (n < 2 || !(total > 0) || !(every > 0)) return undefined;
    const crossing = (target: number): number => {
      // The first point at or past the distance, and the moment between it and the one before.
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (meters[mid]! >= target) hi = mid;
        else lo = mid + 1;
      }
      if (lo === 0) return seconds[0]!;
      const before = meters[lo - 1]!;
      const span = meters[lo]! - before;
      return span > 0 ? seconds[lo - 1]! + ((seconds[lo]! - seconds[lo - 1]!) * (target - before)) / span : seconds[lo]!;
    };
    const whole = Math.floor((total + 1e-6) / every);
    const rest = total - whole * every;
    const short = rest >= SPLITS_MIN_LAST_METERS && rest > 1e-6;
    // The first split starts with the activity's clock, wherever its first distance is.
    let from = 0;
    for (let k = 1; k <= whole; k += 1) {
      // A boundary a hair past the last point (the sum of a float) is the last point's moment, not beyond it.
      const to = Math.min(crossing(k * every), seconds[n - 1]!);
      starts.push(from);
      ends.push(to);
      lengths.push(every);
      from = to;
    }
    if (short) {
      starts.push(from);
      ends.push(seconds[n - 1]!);
      lengths.push(rest);
    }
    if (starts.length === 0) return undefined;
  }

  const splits: SplitRecord[] = starts.map((start, i) => ({
    number: i + 1,
    startSeconds: start,
    endSeconds: Math.max(start, ends[i]!),
    seconds: Math.max(0, counted(ends[i]!) - counted(start)),
    ...(lengths[i] !== undefined ? { meters: lengths[i] } : {}),
  }));

  // Faster or slower by pace where both splits have one, so splits of different lengths compare fairly; by time where one has not.
  const paceOf = (split: SplitRecord): number | undefined =>
    split.meters !== undefined && split.meters > 0 && split.seconds > 0 ? split.seconds / (split.meters / options.unitMeters) : undefined;
  for (let i = 1; i < splits.length; i += 1) {
    const [before, now] = [splits[i - 1]!, splits[i]!];
    const [a, b] = [paceOf(before), paceOf(now)];
    const difference = a !== undefined && b !== undefined ? b - a : now.seconds - before.seconds;
    now.verdict = difference <= -SPLITS_TIE_SECONDS + 1e-9 ? 'faster' : difference >= SPLITS_TIE_SECONDS - 1e-9 ? 'slower' : 'same';
  }

  const endTimes = splits.map((split) => split.endSeconds);
  return {
    splits,
    at: (activitySeconds) => {
      const t = Number.isFinite(activitySeconds) ? activitySeconds : 0;
      // The splits that have ended by now: the last whose end is at or before the moment.
      let lo = 0;
      let hi = endTimes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (endTimes[mid]! <= t) lo = mid + 1;
        else hi = mid;
      }
      const index = Math.min(lo, splits.length - 1);
      const split = splits[index]!;
      const now = Math.min(Math.max(t, split.startSeconds), split.endSeconds);
      const since = distanceAt(now);
      const from = distanceAt(split.startSeconds);
      return {
        index,
        seconds: Math.max(0, counted(now) - counted(split.startSeconds)),
        ...(since !== undefined && from !== undefined ? { meters: Math.max(0, since - from) } : {}),
        finished: lo,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Kept per timeline, and what a frame shows

const cache = new WeakMap<object, Map<string, SplitTimes | null>>();

const splitsKey = (options: SplitBuildOptions) => `${options.source}|${options.everyMeters}|${options.time}|${options.unitMeters}`;

/**
 * TD-090 (TD-088). The splits for one renderer: built once for each source, distance,
 * clock and unit it is asked for, kept as long as the renderer is, with no cap, so each
 * splits component drawn is built once however many there are. The editor makes a new
 * renderer on an edit, so a reader typing a distance leaves a key a keystroke for as long
 * as that renderer lives and no longer.
 */
export function createSplitTimes(streamsOf: (() => SplitStreams) | undefined): (options: SplitBuildOptions) => SplitTimes | undefined {
  const kept = new Map<string, SplitTimes | null>();
  return (options) => {
    if (!streamsOf) return undefined;
    const key = splitsKey(options);
    let times = kept.get(key);
    if (times === undefined) {
      times = buildSplits(streamsOf(), options) ?? null;
      kept.set(key, times);
    }
    return times ?? undefined;
  };
}

/**
 * The splits for a timeline, kept per timeline: for a caller with no renderer of its
 * own to keep them (the contract adapter). The latest three keys are kept, an entry
 * being a few thousand numbers for a long recording.
 */
export function splitTimesFor(timeline: { splitStreams?: () => SplitStreams }, options: SplitBuildOptions): SplitTimes | undefined {
  if (!timeline.splitStreams) return undefined;
  let byKey = cache.get(timeline);
  if (!byKey) {
    byKey = new Map();
    cache.set(timeline, byKey);
  }
  const key = splitsKey(options);
  let times = byKey.get(key);
  if (times === undefined) {
    times = buildSplits(timeline.splitStreams(), options) ?? null;
    if (byKey.size >= 3) byKey.delete(byKey.keys().next().value as string);
    byKey.set(key, times);
  }
  return times ?? undefined;
}

/** One line of what a splits component shows. */
export interface SplitRow {
  /** From 1. */
  number: number;
  seconds: number;
  /** `seconds` written as a clock. */
  text: string;
  meters?: number;
  /** The pace or the average speed, in the reader's units; absent where it is not asked for or cannot be said. */
  rateText?: string;
  /** A finished split against the one before; absent for the current one and for the first. */
  verdict?: SplitVerdict;
}

export interface SplitsView {
  /** The split under way. */
  current: SplitRow;
  /** The last that finished, when asked for and there is one. */
  last?: SplitRow;
  /** The last `list` that finished, newest first. */
  list: SplitRow[];
}

/** A pace or an average speed in the reader's units, or `undefined` where the split has no distance worth a rate or no time. */
export function splitRateText(rate: SplitsRate, seconds: number, meters: number | undefined, units: UnitSystem): string | undefined {
  if (rate === 'none' || meters === undefined || !(meters >= SPLITS_MIN_RATE_METERS) || !(seconds > 0)) return undefined;
  return rate === 'pace' ? formatPace(seconds / (meters / 1000), units) : formatSpeed(meters / seconds, units);
}

/** What a frame shows of the splits at one moment: the current split, the last finished, and the list. */
export function splitsView(times: SplitTimes, moment: SplitMoment, setting: OverlaySplitsSetting, rate: SplitsRate, units: UnitSystem): SplitsView {
  const row = (record: SplitRecord): SplitRow => {
    const rateText = splitRateText(rate, record.seconds, record.meters, units);
    return {
      number: record.number,
      seconds: record.seconds,
      text: formatDuration(record.seconds),
      ...(record.meters !== undefined ? { meters: record.meters } : {}),
      ...(rateText !== undefined ? { rateText } : {}),
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
    };
  };
  const currentRate = splitRateText(rate, moment.seconds, moment.meters, units);
  const current: SplitRow = {
    number: moment.index + 1,
    seconds: moment.seconds,
    text: formatDuration(moment.seconds),
    ...(moment.meters !== undefined ? { meters: moment.meters } : {}),
    ...(currentRate !== undefined ? { rateText: currentRate } : {}),
  };
  const finished = (position: number) => times.splits[moment.finished - 1 - position];
  const lastRecord = moment.finished > 0 ? finished(0) : undefined;
  const list: SplitRow[] = [];
  for (let k = 0; k < setting.list && k < moment.finished; k += 1) list.push(row(finished(k)!));
  return { current, ...(setting.showLast && lastRecord ? { last: row(lastRecord) } : {}), list };
}

// ---------------------------------------------------------------------------
// How big the lines are

/**
 * The sizes a splits component's lines are drawn at, in pixels, from the type size and the
 * reader's figure settings (AV-1015). One place, so the drawing and the editor's growing of
 * the box agree on how tall the lines are.
 */
export interface SplitsMetrics {
  /** The inset from the box's left and right edges. */
  pad: number;
  showLabel: boolean;
  labelSize: number;
  /** The split under way. */
  valueSize: number;
  /** The last finished split: smaller, so the current one leads. */
  lastSize: number;
  /** A line of the list. */
  rowSize: number;
  /** From a label's top to its line's top. */
  labelAdvance: number;
}

export function splitsMetrics(em: number, frameWidth: number, figure: OverlayFigureSetting | undefined): SplitsMetrics {
  const labelSize = 0.55 * em * (figure?.labelScale ?? 1);
  const valueSize = 1.1 * em * (figure?.valueScale ?? 1);
  return {
    pad: 0.6 * em,
    showLabel: figure?.showLabel !== false,
    labelSize,
    valueSize,
    lastSize: valueSize * 0.8,
    rowSize: Math.max(labelSize * 1.15, 0.45 * em),
    labelAdvance: figure?.gap === undefined ? labelSize * 1.2 : labelSize + figure.gap * frameWidth,
  };
}

/** The height of everything a splits component draws, in pixels: the top and the bottom margin included. */
export function splitsContentHeight(metrics: SplitsMetrics, setting: Pick<OverlaySplitsSetting, 'showLast' | 'list'>, em: number): number {
  const label = metrics.showLabel ? metrics.labelAdvance : 0;
  let height = 0.5 * em + label + metrics.valueSize * 1.1;
  if (setting.showLast) height += 0.3 * em + label + metrics.lastSize * 1.1;
  if (setting.list > 0) height += 0.3 * em + setting.list * metrics.rowSize * 1.35;
  return height + 0.5 * em;
}
