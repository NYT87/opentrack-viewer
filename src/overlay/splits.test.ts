import { describe, expect, it } from 'vitest';
import type { Activity, ActivityLap, ActivityPoint } from '../domain/activity';
import {
  DEFAULT_SPLITS,
  SPLITS_NO_DISTANCE,
  SPLITS_NO_START_TIMES,
  SPLITS_NO_TIME,
  buildSplits,
  createSplitTimes,
  splitRateText,
  splitTimesFor,
  splitsContentHeight,
  splitsMetrics,
  splitsRate,
  splitsSourceOf,
  splitsUnavailableReason,
  splitsView,
  unitMeters,
  type SplitBuildOptions,
  type SplitStreams,
} from './splits';
import { parseOverlayTemplate, resolveOverlayComponent, serializeOverlayTemplate, unavailableBindings, type OverlayComponent, type OverlaySplitsSetting } from './template';
import { canvasTemplate, newSplitsComponent } from './customCanvas';
import { buildOverlayTimeline } from './timeline';
import { parseFit } from '../parsers/fit/parseFit';
import { parseTcx } from '../parsers/tcx/parseTcx';
import { makeActivity } from '../test/helpers/activity';
import { readBinaryFixture, readFixture } from '../test/helpers/fixtures';

/** AV-1021 (TD-090). Splits: where they are, what they take, how they compare, and what a frame shows. */

const T0 = Date.parse('2026-09-24T08:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const FRAME = { width: 1920, height: 1080 };
/** The metres in a degree of latitude as the app's own distance reads them (a 6,371 km sphere). */
const METERS_PER_DEGREE = (Math.PI * 6_371_000) / 180;
const metricOptions = (over: Partial<SplitBuildOptions> = {}): SplitBuildOptions => ({ source: 'distance', everyMeters: 1000, time: 'moving', unitMeters: 1000, ...over });

/** Points every 10 s whose recorded distance at each second is `metres(t)`. */
function recorded(seconds: number, metres: (t: number) => number, extra: Partial<ActivityPoint> = {}, extraAt: (t: number) => Partial<ActivityPoint> = () => ({})): Activity {
  return makeActivity(
    Array.from({ length: seconds / 10 + 1 }, (_, i) => ({
      time: at(i * 10),
      lat: 10 + metres(i * 10) / METERS_PER_DEGREE,
      lon: 20,
      distanceMeters: metres(i * 10),
      ...extra,
      ...extraAt(i * 10),
    })),
  );
}

const streamsOf = (activity: Activity): SplitStreams => buildOverlayTimeline(activity, { video: { durationSeconds: 1000 } }).splitStreams!();
const splitsOf = (activity: Activity, options: Partial<SplitBuildOptions> = {}) => buildSplits(streamsOf(activity), metricOptions(options))!;

describe('distance splits', () => {
  // 5 m/s for 300 s: 1500 m.
  const run = recorded(300, (t) => 5 * t);

  it('cut at every kilometre, the last one short, interpolated between points (metric)', () => {
    const { splits } = splitsOf(run);
    expect(splits.map((split) => split.number)).toEqual([1, 2]);
    expect(splits.map((split) => [split.startSeconds, split.endSeconds])).toEqual([[0, 200], [200, 300]]);
    expect(splits.map((split) => split.meters)).toEqual([1000, 500]);
    expect(splits.map((split) => split.seconds)).toEqual([200, 100]);
  });

  it('cut at every mile in imperial: a mile is 1609.344 m, so 1.5 km is one short split', () => {
    const { splits } = splitsOf(run, { unitMeters: unitMeters('imperial'), everyMeters: unitMeters('imperial') });
    expect(splits).toHaveLength(1);
    expect(splits[0]!.meters).toBeCloseTo(1500, 6);
    expect(splits[0]!.seconds).toBe(300);
    const longer = splitsOf(recorded(400, (t) => 5 * t), { unitMeters: 1609.344, everyMeters: 1609.344 }).splits;
    expect(longer.map((split) => split.meters)).toEqual([1609.344, expect.closeTo(390.656, 3)]);
    expect(longer[0]!.endSeconds).toBeCloseTo(1609.344 / 5, 6);
  });

  it('cut at a distance the reader sets, found between two points', () => {
    const { splits } = splitsOf(run, { everyMeters: 400 });
    expect(splits.map((split) => split.endSeconds)).toEqual([80, 160, 240, 300]);
    expect(splits.map((split) => split.meters)).toEqual([400, 400, 400, 300]);
    // 330 m falls between the points at 60 s (300 m) and 70 s (350 m).
    const odd = splitsOf(run, { everyMeters: 330 }).splits;
    expect(odd[0]!.endSeconds).toBeCloseTo(66, 9);
    expect(odd[1]!.endSeconds).toBeCloseTo(132, 9);
  });

  it('has no extra split when the distance ends exactly on a boundary, and none for a sliver under a metre', () => {
    expect(splitsOf(run, { everyMeters: 500 }).splits.map((split) => split.number)).toEqual([1, 2, 3]);
    const sliver = recorded(200, (t) => (t === 200 ? 1000.5 : 5 * t));
    expect(splitsOf(sliver).splits).toHaveLength(1);
    const kept = recorded(200, (t) => (t === 200 ? 1002 : (1002 * t) / 200));
    expect(splitsOf(kept).splits.map((split) => split.meters)).toEqual([1000, expect.closeTo(2, 6)]);
  });

  it('is numbered from the start of the activity, from its first distance, wherever the odometer began', () => {
    const odometer = recorded(300, (t) => 40_000 + 5 * t);
    expect(splitsOf(odometer).splits.map((split) => split.meters)).toEqual([1000, 500]);
  });

  it('finds nothing without a distance, or with a distance that does not move', () => {
    const noDistance = makeActivity(Array.from({ length: 5 }, (_, i) => ({ time: at(i * 10) })));
    expect(buildOverlayTimeline(noDistance, { video: { durationSeconds: 40 } }).splitSources).toEqual({ laps: false, distance: false });
    expect(buildSplits(streamsOf(noDistance), metricOptions())).toBeUndefined();
    const standing = recorded(60, () => 100);
    expect(buildSplits(streamsOf(standing), metricOptions())).toBeUndefined();
  });
});

describe('the time a split takes: moving or elapsed, through a stop (TD-058, TD-080)', () => {
  // 0 to 100 s at 5 m/s (500 m), standing still to 200 s, then 5 m/s again to 300 s (1000 m).
  const stop = recorded(300, (t) => (t <= 100 ? 5 * t : t <= 200 ? 500 : 500 + 5 * (t - 200)));

  it('moving time leaves the stop out of the split it falls in, elapsed time keeps it', () => {
    const moving = splitsOf(stop, { everyMeters: 600, time: 'moving' }).splits;
    const elapsed = splitsOf(stop, { everyMeters: 600, time: 'elapsed' }).splits;
    // 600 m is reached 20 s into the second run of movement, at 220 s.
    expect(moving[0]!.endSeconds).toBeCloseTo(220, 9);
    expect(moving[0]!.seconds).toBeCloseTo(120, 9);
    expect(elapsed[0]!.seconds).toBeCloseTo(220, 9);
    expect(moving[1]!.seconds).toBeCloseTo(80, 9);
    expect(elapsed[1]!.seconds).toBeCloseTo(80, 9);
  });

  it('the current split’s clock holds through the stop when moving and runs when elapsed', () => {
    const movingAt = (t: number) => splitsOf(stop, { everyMeters: 600, time: 'moving' }).at(t);
    const elapsedAt = (t: number) => splitsOf(stop, { everyMeters: 600, time: 'elapsed' }).at(t);
    expect(movingAt(100).seconds).toBe(100);
    expect(movingAt(150).seconds).toBe(100);
    expect(movingAt(199).seconds).toBe(100);
    expect(elapsedAt(100).seconds).toBe(100);
    expect(elapsedAt(150).seconds).toBe(150);
    expect(elapsedAt(199).seconds).toBe(199);
    expect(movingAt(210).seconds).toBeCloseTo(110, 9);
  });

  it('a stop makes the pace of the split it is in slower, by the clock chosen', () => {
    // Over its 600 m, the first split took 120 s of movement (200 s/km) or 220 s elapsed (366.7 s/km).
    const split = (time: 'moving' | 'elapsed') => splitsOf(stop, { everyMeters: 600, time }).splits[0]!;
    expect(split('moving').seconds / (split('moving').meters! / 1000)).toBeCloseTo(200, 6);
    expect(split('elapsed').seconds / (split('elapsed').meters! / 1000)).toBeCloseTo(366.667, 2);
  });

  it('falls back to elapsed time where the activity has no distance to count moving time by', () => {
    const laps = lapsOf([0, 100, 200]);
    const streams: SplitStreams = { seconds: [], meters: [], moving: [], spanSeconds: 300, laps };
    const { splits } = buildSplits(streams, metricOptions({ source: 'laps', time: 'moving' }))!;
    expect(splits.map((split) => split.seconds)).toEqual([100, 100, 100]);
  });
});

describe('a segment break inside a split', () => {
  // Six points to 250 m, then the recorder was paused for 250 s and a second segment began 5 km away.
  const broken = makeActivity([
    ...Array.from({ length: 6 }, (_, i) => ({ time: at(i * 10), lat: 10 + (5 * i * 10) / METERS_PER_DEGREE, lon: 20, segmentIndex: 0 })),
    ...Array.from({ length: 6 }, (_, i) => ({ time: at(300 + i * 10), lat: 10.05 + (5 * i * 10) / METERS_PER_DEGREE, lon: 20, segmentIndex: 1 })),
  ]);

  it('adds no distance, so the split still ends at its distance, found in the second segment', () => {
    const { splits } = splitsOf(broken, { everyMeters: 300 });
    expect(splits.map((split) => split.meters)).toEqual([300, expect.closeTo(200, 1)]);
    // 300 m is 50 m into the second segment: its first point stands at 250 m, the next at 300 m.
    expect(splits[0]!.endSeconds).toBeCloseTo(310, 3);
  });

  it('moving time never counts the step across the break, and elapsed time runs through it', () => {
    const moving = splitsOf(broken, { everyMeters: 300, time: 'moving' }).splits[0]!;
    const elapsed = splitsOf(broken, { everyMeters: 300, time: 'elapsed' }).splits[0]!;
    expect(moving.seconds).toBeCloseTo(60, 3);
    expect(elapsed.seconds).toBeCloseTo(310, 3);
  });

  it('a boundary inside the break is where the distance first reaches it', () => {
    const { splits } = splitsOf(broken, { everyMeters: 250 });
    expect(splits[0]!.endSeconds).toBeCloseTo(50, 3);
    const inside = splitsOf(broken, { everyMeters: 260 }).splits[0]!;
    // 260 m is 10 m past the second segment's start, 2 s into its first step.
    expect(inside.endSeconds).toBeCloseTo(302, 3);
    expect(inside.seconds).toBeCloseTo(52, 3);
  });
});

/** Laps starting at these seconds, each with the distance it states. */
function lapsOf(starts: number[], meters?: (number | undefined)[]) {
  return starts.map((startSeconds, i) => ({ startSeconds, ...(meters?.[i] !== undefined ? { meters: meters[i] } : {}) }));
}

describe('laps', () => {
  it('start at their start times and end where the next starts, the last at the end of the activity', () => {
    const streams: SplitStreams = { seconds: [0, 300], meters: [0, 1500], moving: [0, 300], spanSeconds: 300, laps: lapsOf([0, 100, 250], [500, 750, 250]) };
    const { splits } = buildSplits(streams, metricOptions({ source: 'laps' }))!;
    expect(splits.map((split) => [split.startSeconds, split.endSeconds, split.seconds, split.meters])).toEqual([
      [0, 100, 100, 500],
      [100, 250, 150, 750],
      [250, 300, 50, 250],
    ]);
  });

  it('take the stream’s distance between their start and end where the file states none', () => {
    const streams: SplitStreams = { seconds: [0, 300], meters: [0, 1500], moving: [0, 300], spanSeconds: 300, laps: lapsOf([0, 100, 250]) };
    const { splits } = buildSplits(streams, metricOptions({ source: 'laps' }))!;
    expect(splits.map((split) => split.meters)).toEqual([expect.closeTo(500, 6), expect.closeTo(750, 6), expect.closeTo(250, 6)]);
  });

  it('read from a TCX file: the laps’ start times, with a pause in the second', () => {
    const tcx = parseTcx(readFixture('run-with-laps.tcx'), { fileName: 'run-with-laps.tcx', idFactory: () => 'lap-tcx' });
    const timeline = buildOverlayTimeline(tcx, { video: { durationSeconds: 400 } });
    expect(timeline.splitSources).toEqual({ laps: true, distance: true });
    const { splits } = buildSplits(timeline.splitStreams!(), metricOptions({ source: 'laps', time: 'elapsed' }))!;
    // Lap 1 starts with the activity; lap 2 30 s in, and runs to the activity's end 300 s in (the pause is inside it).
    expect(splits.map((split) => [split.startSeconds, split.endSeconds])).toEqual([[0, 30], [30, 300]]);
    expect(splits.map((split) => split.seconds)).toEqual([30, 270]);
    // The file states each lap's distance: 66.7 m.
    expect(splits.map((split) => split.meters)).toEqual([66.7, 66.7]);
    // Moving time leaves the five-minute pause (a new <Track>, whose first step is not counted) out of the second lap.
    const moving = buildSplits(timeline.splitStreams!(), metricOptions({ source: 'laps', time: 'moving' }))!.splits;
    expect(moving.map((split) => split.seconds)).toEqual([30, 0]);
  });

  it('read from a FIT file with lap messages', async () => {
    const fit = await parseFit(readBinaryFixture('run-with-laps.fit'), { fileName: 'run-with-laps.fit', idFactory: () => 'lap-fit' });
    expect(fit.laps).toHaveLength(3);
    const timeline = buildOverlayTimeline(fit, { video: { durationSeconds: 200 } });
    expect(timeline.splitSources).toEqual({ laps: true, distance: true });
    const { splits } = buildSplits(timeline.splitStreams!(), metricOptions({ source: 'laps' }))!;
    expect(splits.map((split) => [split.startSeconds, split.endSeconds, split.seconds, split.meters])).toEqual([
      [0, 50, 50, 200],
      [50, 90, 40, 200],
      [90, 120, 30, 90],
    ]);
    // 250 s/km, then 200, then 333: faster, then slower.
    expect(splits.map((split) => split.verdict)).toEqual([undefined, 'faster', 'slower']);
    // The same file split by distance: 1 km would be one short split, 100 m is five.
    const byDistance = buildSplits(timeline.splitStreams!(), metricOptions({ everyMeters: 100 }))!.splits;
    expect(byDistance.map((split) => split.meters)).toEqual([100, 100, 100, 100, 90]);
  });
});

describe('which sources an activity has', () => {
  const lap = (start: number | undefined, index: number): ActivityLap => ({ index, ...(start !== undefined ? { startTime: at(start) } : {}) });
  const withLaps = (laps: ActivityLap[]) => ({ ...recorded(300, (t) => 5 * t), laps });
  const sourcesOf = (activity: Activity) => buildOverlayTimeline(activity, { video: { durationSeconds: 300 } }).splitSources;

  it('needs two or more laps, every one with a start time', () => {
    expect(sourcesOf(withLaps([lap(0, 0), lap(100, 1)]))).toEqual({ laps: true, distance: true });
    expect(sourcesOf(withLaps([lap(0, 0)]))).toEqual({ laps: false, distance: true });
    expect(sourcesOf(recorded(300, (t) => 5 * t))).toEqual({ laps: false, distance: true });
  });

  it('is told a lap has no start time, and then has no laps at all', () => {
    expect(sourcesOf(withLaps([lap(0, 0), lap(undefined, 1), lap(200, 2)]))).toEqual({ laps: false, lapsIssue: 'no_start_times', distance: true });
  });

  it('places laps in order, one that starts before the first point at the first point, drops one after the last, and merges two that start together', () => {
    const timeline = buildOverlayTimeline(withLaps([lap(250, 2), lap(-20, 0), lap(100, 1), lap(100, 3), lap(900, 4)]), { video: { durationSeconds: 300 } });
    expect(timeline.splitStreams!().laps.map((entry) => entry.startSeconds)).toEqual([0, 100, 250]);
    expect(timeline.splitSources!.laps).toBe(true);
    // Two laps that collapse into one are no laps.
    expect(sourcesOf(withLaps([lap(100, 0), lap(100, 1)]))!.laps).toBe(false);
    expect(sourcesOf(withLaps([lap(0, 0), lap(900, 1)]))!.laps).toBe(false);
  });

  it('a laps component reads the distance where the file has no usable laps, and nothing where it has neither', () => {
    expect(splitsSourceOf('laps', { laps: true, distance: true })).toBe('laps');
    expect(splitsSourceOf('laps', { laps: false, distance: true })).toBe('distance');
    expect(splitsSourceOf('distance', { laps: true, distance: true })).toBe('distance');
    expect(splitsSourceOf('distance', { laps: true, distance: false })).toBeUndefined();
    expect(splitsSourceOf('laps', { laps: false, distance: false })).toBeUndefined();
    expect(splitsSourceOf('laps', undefined)).toBeUndefined();
  });

  it('says why an activity cannot be split', () => {
    expect(splitsUnavailableReason(true, undefined)).toBe(SPLITS_NO_TIME);
    expect(splitsUnavailableReason(false, { laps: false, distance: false })).toBe(SPLITS_NO_DISTANCE);
    expect(splitsUnavailableReason(false, { laps: false, lapsIssue: 'no_start_times', distance: false })).toBe(SPLITS_NO_START_TIMES);
    expect(splitsUnavailableReason(false, { laps: false, lapsIssue: 'no_start_times', distance: true })).toBeUndefined();
    expect(splitsUnavailableReason(false, { laps: true, distance: false })).toBeUndefined();
  });

  it('a timeline that cannot sample has no sources and no streams', () => {
    const empty = buildOverlayTimeline(undefined);
    expect(empty.splitSources).toBeUndefined();
    expect(empty.splitStreams).toBeUndefined();
    expect(splitTimesFor(empty, metricOptions())).toBeUndefined();
    expect(createSplitTimes(empty.splitStreams)(metricOptions())).toBeUndefined();
  });
});

describe('faster, slower and the same, by pace (AV-1021)', () => {
  /** Laps of the given seconds and metres, one after another. */
  function lapsRun(laps: [seconds: number, meters: number | undefined][]) {
    let t = 0;
    const starts: { startSeconds: number; meters?: number }[] = [];
    for (const [seconds, meters] of laps) {
      starts.push({ startSeconds: t, ...(meters !== undefined ? { meters } : {}) });
      t += seconds;
    }
    const streams: SplitStreams = { seconds: [], meters: [], moving: [], spanSeconds: t, laps: starts };
    return buildSplits(streams, metricOptions({ source: 'laps' }))!.splits.map((split) => split.verdict);
  }

  it('compares splits of different lengths by pace, so a short fast split is not slower for being short', () => {
    // 300 s for 1000 m, then 100 s for 250 m (400 s/km: slower by pace although shorter in time), then 40 s for 200 m (200 s/km).
    expect(lapsRun([[300, 1000], [100, 250], [40, 200]])).toEqual([undefined, 'slower', 'faster']);
    // 100 s for 500 m, then 150 s for 1000 m: 200 then 150 s/km, faster though it took longer.
    expect(lapsRun([[100, 500], [150, 1000]])).toEqual([undefined, 'faster']);
  });

  it('is the same under half a second per kilometre, and faster or slower from it', () => {
    expect(lapsRun([[300, 1000], [300.4, 1000]])).toEqual([undefined, 'same']);
    expect(lapsRun([[300, 1000], [299.6, 1000]])).toEqual([undefined, 'same']);
    expect(lapsRun([[300, 1000], [300.5, 1000]])).toEqual([undefined, 'slower']);
    expect(lapsRun([[300, 1000], [299.5, 1000]])).toEqual([undefined, 'faster']);
    expect(lapsRun([[300, 1000], [300, 1000]])).toEqual([undefined, 'same']);
  });

  it('is half a second per mile in imperial units', () => {
    const streams: SplitStreams = { seconds: [], meters: [], moving: [], spanSeconds: 1200, laps: [{ startSeconds: 0, meters: 1609.344 }, { startSeconds: 600, meters: 1609.344 }] };
    const verdict = (second: number) => buildSplits({ ...streams, spanSeconds: 600 + second }, metricOptions({ source: 'laps', unitMeters: 1609.344 }))!.splits[1]!.verdict;
    expect(verdict(600.4)).toBe('same');
    expect(verdict(600.5)).toBe('slower');
    // 0.6 s over a mile is 0.37 s over a kilometre: slower in miles, the same in kilometres.
    expect(verdict(600.6)).toBe('slower');
    expect(buildSplits({ ...streams, spanSeconds: 1200.6 }, metricOptions({ source: 'laps' }))!.splits[1]!.verdict).toBe('same');
  });

  it('compares a short last split by its pace, not its time', () => {
    // 1200 m in 240 s: a kilometre in 200 s, then 200 m in 40 s, the same pace; and then 200 m in 30 s, faster.
    const run = recorded(240, (t) => 5 * t);
    expect(splitsOf(run).splits.map((split) => split.verdict)).toEqual([undefined, 'same']);
    const quick = recorded(230, (t) => (t <= 200 ? 5 * t : 1000 + (t - 200) * (200 / 30)));
    const last = splitsOf(quick).splits.at(-1)!;
    expect(last.meters).toBeCloseTo(200, 4);
    expect(last.seconds).toBeCloseTo(30, 4);
    expect(last.verdict).toBe('faster');
  });

  it('compares by time where either split has no distance', () => {
    expect(lapsRun([[300, undefined], [310, undefined]])).toEqual([undefined, 'slower']);
    expect(lapsRun([[300, 1000], [290, undefined]])).toEqual([undefined, 'faster']);
    expect(lapsRun([[300, undefined], [300.2, undefined]])).toEqual([undefined, 'same']);
  });

  it('is by the pace of the clock chosen: a stop slows an elapsed split but not a moving one', () => {
    const stop = recorded(400, (t) => (t <= 100 ? 5 * t : t <= 200 ? 500 : 500 + 5 * (t - 200)));
    // 500 m, then 500 m with a stop between: the same moving pace, a slower elapsed one.
    const verdicts = (time: 'moving' | 'elapsed') => splitsOf(stop, { everyMeters: 500, time }).splits.map((split) => split.verdict);
    expect(verdicts('moving')).toEqual([undefined, 'same', 'same']);
    expect(verdicts('elapsed')).toEqual([undefined, 'slower', 'faster']);
  });
});

describe('a moment: which split, how long, how many finished', () => {
  const times = splitsOf(recorded(300, (t) => 5 * t));

  it('is the first split from the start, with the time so far and the distance so far', () => {
    expect(times.at(0)).toEqual({ index: 0, seconds: 0, meters: 0, finished: 0 });
    expect(times.at(50)).toEqual({ index: 0, seconds: 50, meters: 250, finished: 0 });
  });

  it('changes split exactly when one ends, and starts the next at 0', () => {
    expect(times.at(199.999).index).toBe(0);
    expect(times.at(200)).toEqual({ index: 1, seconds: 0, meters: 0, finished: 1 });
    expect(times.at(250)).toMatchObject({ index: 1, seconds: 50, finished: 1 });
  });

  it('stays on the last split, with its whole time, once it has ended and beyond', () => {
    expect(times.at(300)).toEqual({ index: 1, seconds: 100, meters: 500, finished: 2 });
    expect(times.at(1e6)).toEqual({ index: 1, seconds: 100, meters: 500, finished: 2 });
  });

  it('holds before the start and on a number that is not one', () => {
    expect(times.at(-5)).toMatchObject({ index: 0, seconds: 0, finished: 0 });
    expect(times.at(Number.NaN)).toMatchObject({ index: 0, seconds: 0, finished: 0 });
  });

  it('is found once per renderer, and kept: the same object for the same options', () => {
    let made = 0;
    const streams = streamsOf(recorded(300, (t) => 5 * t));
    const of = createSplitTimes(() => {
      made += 1;
      return streams;
    });
    const first = of(metricOptions());
    expect(of(metricOptions())).toBe(first);
    of(metricOptions({ everyMeters: 400 }));
    of(metricOptions());
    expect(made).toBe(2);
    const timeline = buildOverlayTimeline(recorded(300, (t) => 5 * t), { video: { durationSeconds: 300 } });
    expect(splitTimesFor(timeline, metricOptions())).toBe(splitTimesFor(timeline, metricOptions()));
    expect(splitTimesFor(timeline, metricOptions())).not.toBe(splitTimesFor(timeline, metricOptions({ time: 'elapsed' })));
  });

  it('is O(n) to build and a search to look up: a hundred thousand points, ten thousand splits', () => {
    const n = 100_000;
    const seconds = Array.from({ length: n }, (_, i) => i);
    const meters = seconds.map((s) => s * 5);
    const big = buildSplits({ seconds, meters, moving: seconds, spanSeconds: n - 1, laps: [] }, metricOptions({ everyMeters: 50 }))!;
    expect(big.splits).toHaveLength(10_000);
    let sum = 0;
    for (let i = 0; i < 200_000; i += 1) sum += big.at((i * 7) % n).index;
    expect(sum).toBeGreaterThan(0);
    expect(big.at(55.5)).toMatchObject({ index: 5, finished: 5 });
  });
});

describe('what a frame shows', () => {
  const run = recorded(600, (t) => (t <= 300 ? 5 * t : 1500 + 4 * (t - 300)));
  const times = splitsOf(run, { everyMeters: 500 });
  const view = (t: number, setting: Partial<OverlaySplitsSetting> = {}, rate: 'pace' | 'speed' | 'none' = 'pace', units: 'metric' | 'imperial' = 'metric') =>
    splitsView(times, times.at(t), { ...DEFAULT_SPLITS, ...setting }, rate, units);

  it('has the split under way, with its time and rate so far, and no last split before one has finished', () => {
    const shown = view(50);
    expect(shown.current).toMatchObject({ number: 1, text: '0:50', seconds: 50, meters: 250, rateText: '3:20 /km' });
    expect(shown.last).toBeUndefined();
    expect(shown.list).toEqual([]);
  });

  it('has the last finished split with its verdict against the one before it', () => {
    // Splits of 500 m at 5 m/s (100 s each) for 3, then 4 m/s (125 s): the fourth is slower.
    const shown = view(450);
    expect(shown.current.number).toBe(5);
    expect(shown.last).toMatchObject({ number: 4, text: '2:05', verdict: 'slower', rateText: '4:10 /km' });
    expect(view(150).last).toMatchObject({ number: 1 });
    expect(view(150).last!.verdict).toBeUndefined();
    expect(view(250).last).toMatchObject({ number: 2, verdict: 'same' });
  });

  it('lists the last N finished, newest first, no more than have finished', () => {
    expect(view(450, { list: 2 }).list.map((row) => row.number)).toEqual([4, 3]);
    expect(view(450, { list: 10 }).list.map((row) => row.number)).toEqual([4, 3, 2, 1]);
    expect(view(450, { list: 0 }).list).toEqual([]);
    expect(view(450, { list: 2 }).list[0]!.verdict).toBe('slower');
  });

  it('leaves the last split out when asked to', () => {
    expect(view(450, { showLast: false }).last).toBeUndefined();
    expect(view(450, { showLast: false, list: 1 }).list).toHaveLength(1);
  });

  it('writes the pace in the reader’s units, or the average speed, or nothing', () => {
    expect(view(450, {}, 'speed').last!.rateText).toBe('14.4 km/h');
    expect(view(450, {}, 'speed', 'imperial').last!.rateText).toBe('8.9 mph');
    expect(view(450, {}, 'pace', 'imperial').last!.rateText).toBe('6:42 /mi');
    expect(view(450, {}, 'none').last!.rateText).toBeUndefined();
    expect(view(450, {}, 'none').current.rateText).toBeUndefined();
  });

  it('has no rate for a split that has no distance, or too little, or no time', () => {
    expect(splitRateText('pace', 100, undefined, 'metric')).toBeUndefined();
    expect(splitRateText('pace', 100, 5, 'metric')).toBeUndefined();
    expect(splitRateText('pace', 0, 500, 'metric')).toBeUndefined();
    expect(splitRateText('speed', 100, 500, 'metric')).toBe('18.0 km/h');
  });

  it('is pace for a run and speed for anything else, unless the reader chose', () => {
    expect(splitsRate({}, 'running')).toBe('pace');
    expect(splitsRate({}, 'cycling')).toBe('speed');
    expect(splitsRate({}, undefined)).toBe('speed');
    expect(splitsRate({ rate: 'none' }, 'running')).toBe('none');
    expect(splitsRate({ rate: 'speed' }, 'running')).toBe('speed');
  });

  it('sizes its lines in one place, so a longer list needs a taller box', () => {
    const em = 40;
    const metrics = splitsMetrics(em, 1920, undefined);
    const plain = splitsContentHeight(metrics, { showLast: false, list: 0 }, em);
    expect(splitsContentHeight(metrics, { showLast: true, list: 0 }, em)).toBeGreaterThan(plain);
    expect(splitsContentHeight(metrics, { showLast: true, list: 10 }, em)).toBeGreaterThan(splitsContentHeight(metrics, { showLast: true, list: 1 }, em));
    expect(splitsContentHeight(splitsMetrics(em, 1920, { showLabel: false }), { showLast: true, list: 0 }, em)).toBeLessThan(splitsContentHeight(metrics, { showLast: true, list: 0 }, em));
  });
});

describe('a splits component in a layout and against an activity', () => {
  const base = newSplitsComponent(canvasTemplate([]), FRAME);

  it('reads its setting as it may be drawn, by the defaults where it does not read', () => {
    const read = (splits: unknown) => {
      const text = serializeOverlayTemplate({ version: 2, name: 'x', style: { textColor: '#ffffff', accentColor: '#ff6a00', backgroundOpacity: 0.35, fontScale: 1 }, components: [{ ...base, splits: splits as never }] });
      const parsed = parseOverlayTemplate(text);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.template.components[0]!.splits;
    };
    expect(read(undefined)).toEqual(DEFAULT_SPLITS);
    expect(read('nonsense')).toEqual(DEFAULT_SPLITS);
    expect(read({ source: 'distance', every: 5000, time: 'elapsed', showLast: false, list: 4, rate: 'speed', fasterColor: '#00FF00', slowerColor: '#ff0000' })).toEqual({
      source: 'distance',
      every: 5000,
      time: 'elapsed',
      showLast: false,
      list: 4,
      rate: 'speed',
      fasterColor: '#00ff00',
      slowerColor: '#ff0000',
    });
  });

  it('keeps the list a whole number from 0 to 10, a distance from 0.1 km to 100 miles, and drops what is not a choice', () => {
    const read = (splits: unknown) => {
      const parsed = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', components: [{ ...base, splits }] }));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.template.components[0]!.splits!;
    };
    expect(read({ list: 99 }).list).toBe(10);
    expect(read({ list: -3 }).list).toBe(0);
    expect(read({ list: 2.6 }).list).toBe(3);
    expect(read({ list: 'many' }).list).toBe(0);
    expect(read({ every: 5 }).every).toBe(100);
    expect(read({ every: 1e12 }).every).toBeCloseTo(160934.4, 1);
    expect(read({ every: 0 }).every).toBeUndefined();
    expect(read({ every: 'far' }).every).toBeUndefined();
    expect(read({ rate: 'fast' }).rate).toBeUndefined();
    expect(read({ source: 'chaos', time: 'chaos' })).toMatchObject({ source: 'laps', time: 'moving' });
    expect(read({ fasterColor: 'green', slowerColor: '#12' })).toMatchObject({ fasterColor: DEFAULT_SPLITS.fasterColor, slowerColor: DEFAULT_SPLITS.slowerColor });
  });

  it('has no data source, so a file without one is read, and a component with none is hidden by what the activity has', () => {
    const noSource: Partial<OverlayComponent> = { ...base };
    delete noSource.source;
    const parsed = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', components: [noSource] }));
    expect(parsed.ok).toBe(true);
    const run = recorded(300, (t) => 5 * t);
    const timeline = buildOverlayTimeline(run, { video: { durationSeconds: 300 } });
    const template = canvasTemplate([base]);
    const ready = resolveOverlayComponent(template, base, timeline.sampleAt(10), timeline, 'imperial');
    expect(ready).toMatchObject({ status: 'ready', label: 'Split', splits: { source: 'distance', unitSystem: 'imperial' } });
    const bare = buildOverlayTimeline(makeActivity([{ time: at(0) }, { time: at(10) }]), { video: { durationSeconds: 10 } });
    expect(resolveOverlayComponent(template, base, bare.sampleAt(5), bare, 'metric')).toMatchObject({ status: 'hidden', reason: 'no_data' });
    expect(resolveOverlayComponent(template, { ...base, splits: { ...DEFAULT_SPLITS, source: 'distance' } }, bare.sampleAt(5), bare, 'metric')).toMatchObject({ status: 'hidden' });
    expect(resolveOverlayComponent(template, { ...base, unitMode: 'metric' }, timeline.sampleAt(10), timeline, 'imperial')).toMatchObject({ splits: { unitSystem: 'metric' } });
  });

  it('warns of splits an activity cannot give, with the reason', () => {
    const bare = buildOverlayTimeline(makeActivity([{ time: at(0) }, { time: at(10) }]), { video: { durationSeconds: 10 } });
    const warnings = unavailableBindings(canvasTemplate([base]), bare);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(SPLITS_NO_DISTANCE);
    const run = buildOverlayTimeline(recorded(300, (t) => 5 * t), { video: { durationSeconds: 300 } });
    expect(unavailableBindings(canvasTemplate([base]), run)).toEqual([]);
    expect(unavailableBindings(canvasTemplate([{ ...base, visible: false }]), bare)).toEqual([]);
  });

  it('is made as a card with the defaults, and the rate left to the sport unless the entry asks', () => {
    expect(base).toMatchObject({ type: 'splits', splits: DEFAULT_SPLITS });
    expect(base.splits!.rate).toBeUndefined();
    expect(newSplitsComponent(canvasTemplate([]), FRAME, 'pace').splits!.rate).toBe('pace');
    expect(base.rect.x + base.rect.width).toBeLessThanOrEqual(1);
    expect(base.rect.y + base.rect.height).toBeLessThanOrEqual(1);
    const component: OverlayComponent = base;
    expect(component.id).toBe('splits-1');
  });
});
