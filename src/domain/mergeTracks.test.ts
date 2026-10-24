import { describe, expect, it } from 'vitest';
import { assessMergeSource, FAR_PAUSE_JUMP_METERS, mergeTracks, type MergeSource } from './mergeTracks';
import { computeStats } from './stats';
import type { ActivityPoint } from './activity';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { makeActivity } from '../test/helpers/activity';
import {
  AFTERNOON_RIDE,
  MORNING_RIDE,
  PAUSE_SECONDS,
  buildMergeRideActivities,
  buildMergeRides,
} from '../test/helpers/mergeFixtures';

const T0 = Date.parse('2026-09-24T08:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

/** A ride north along a meridian: one point a second, `speed` metres a second, from `fromSecond`. */
function ride(
  fileName: string,
  fromSecond: number,
  count: number,
  options: { lat0?: number; speed?: number; extra?: (i: number) => Partial<ActivityPoint> } = {},
): MergeSource {
  const { lat0 = 46, speed = 5, extra = () => ({}) } = options;
  const activity = makeActivity(
    Array.from({ length: count }, (_, i) => ({
      time: at(fromSecond + i),
      lat: lat0 + (i * speed) / 111_320,
      lon: 7,
      elevationMeters: 100 + i,
      ...extra(i),
    })),
  );
  return { fileName, activity: { ...activity, id: fileName, metadata: { ...activity.metadata, name: 'Ride', sport: 'cycling' } } };
}

let built: { morning: MergeSource; afternoon: MergeSource } | undefined;

/** The two rides, built once for the file. */
function fixtureSources(): { morning: MergeSource; afternoon: MergeSource } {
  if (built) return built;
  const { morning, afternoon } = buildMergeRideActivities();
  built = {
    morning: { fileName: MORNING_RIDE.fileName, activity: morning },
    afternoon: { fileName: AFTERNOON_RIDE.fileName, activity: afternoon },
  };
  return built;
}

describe('the synthesized Imabari rides (AV-1109 fixture)', () => {
  it('keep the originals’ shape: counts, first and last times, one segment each', () => {
    const { morning, afternoon } = fixtureSources();
    for (const [source, expected] of [
      [morning, MORNING_RIDE],
      [afternoon, AFTERNOON_RIDE],
    ] as const) {
      expect(source.activity.points).toHaveLength(expected.pointCount);
      expect(source.activity.points[0]!.time?.toISOString()).toBe(expected.start);
      expect(source.activity.points.at(-1)!.time?.toISOString()).toBe(expected.end);
      expect(new Set(source.activity.points.map((point) => point.segmentIndex ?? 0)).size).toBe(1);
    }
  });
});

describe('the synthesized rides as GPX (AV-1109 fixture)', () => {
  it('read back to the activities the unit tests build, point for point', () => {
    // The head of the file only: jsdom reads XML slowly, and the browser tests read it whole.
    const { morning } = buildMergeRides();
    const head = morning.split('\n').slice(0, 7 + 200).join('\n') + '\n    </trkseg>\n  </trk>\n</gpx>\n';
    const read = parseGpx(head, { fileName: MORNING_RIDE.fileName });
    const expected = fixtureSources().morning.activity.points.slice(0, 200);
    expect(read.points.map(({ time, lat, lon, elevationMeters }) => ({ time, lat, lon, elevationMeters }))).toEqual(
      expected.map(({ time, lat, lon, elevationMeters }) => ({ time, lat, lon, elevationMeters })),
    );
    expect(read.metadata).toMatchObject({ name: MORNING_RIDE.name, sport: 'cycling' });
  });
});

describe('merging the two rides (AV-1109)', () => {
  it('makes one ride of 16,282 points with a 74-minute pause, whichever file comes first', () => {
    const { morning, afternoon } = fixtureSources();
    const forward = mergeTracks([morning, afternoon]);
    const backward = mergeTracks([afternoon, morning]);
    if (!forward.ok || !backward.ok) throw new Error('merge failed');

    expect(forward.activity.points).toHaveLength(16_282);
    expect(forward.parts.map((part) => part.fileName)).toEqual([MORNING_RIDE.fileName, AFTERNOON_RIDE.fileName]);
    expect(forward.pauses).toHaveLength(1);
    expect(forward.pauses[0]!.seconds).toBe(PAUSE_SECONDS);
    expect(Math.round(forward.pauses[0]!.seconds / 60)).toBe(74);
    expect(forward.pauses[0]!.far).toBe(false);

    // The same merge, point for point and total for total.
    expect(backward.activity.points).toEqual(forward.activity.points);
    expect(backward.activity.derived).toEqual(forward.activity.derived);
    expect(backward.activity.id).toBe(forward.activity.id);
  });

  it('builds it as one recording: in time order, a segment run per file, no point invented', () => {
    const { morning, afternoon } = fixtureSources();
    const merged = mergeTracks([afternoon, morning]);
    if (!merged.ok) throw new Error('merge failed');
    const { points } = merged.activity;

    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!.time!.getTime()).toBeGreaterThanOrEqual(points[i - 1]!.time!.getTime());
      expect(points[i]!.index).toBe(i);
    }
    const boundary = MORNING_RIDE.pointCount;
    expect(points.slice(0, boundary).every((point) => point.segmentIndex === 0)).toBe(true);
    expect(points.slice(boundary).every((point) => point.segmentIndex === 1)).toBe(true);
    // The original points, with their own times and heights, and nothing between.
    expect(points[boundary - 1]!.time!.toISOString()).toBe(MORNING_RIDE.end);
    expect(points[boundary]!.time!.toISOString()).toBe(AFTERNOON_RIDE.start);
    expect(points[boundary]!.elevationMeters).toBe(afternoon.activity.points[0]!.elevationMeters);
    // No distance across the jump: the second file starts where the first's distance ended.
    expect(points[boundary]!.distanceMeters).toBe(points[boundary - 1]!.distanceMeters);
  });

  it('totals equal the sum of the parts, with the pause in elapsed time only', () => {
    const { morning, afternoon } = fixtureSources();
    const merged = mergeTracks([morning, afternoon]);
    if (!merged.ok) throw new Error('merge failed');
    const parts = [morning, afternoon].map((source) => computeStats(source.activity.points).stats);
    const total = merged.activity.derived!;
    const sum = (key: keyof (typeof parts)[number]) =>
      parts.reduce((acc, stats) => acc + (stats[key] as number), 0);

    expect(total.distanceMeters).toBeCloseTo(sum('distanceMeters'), 6);
    expect(total.movingDurationSeconds).toBeCloseTo(sum('movingDurationSeconds'), 6);
    expect(total.elevationGainMeters).toBeCloseTo(sum('elevationGainMeters'), 6);
    expect(total.elevationLossMeters).toBeCloseTo(sum('elevationLossMeters'), 6);
    expect(total.durationSeconds).toBe(sum('durationSeconds') + PAUSE_SECONDS);
    // Each ride's own stop is still a stop, and the pause is not moving time either.
    expect(total.movingDurationSeconds!).toBeLessThan(
      sum('durationSeconds') - MORNING_RIDE.stopSeconds - AFTERNOON_RIDE.stopSeconds + 1,
    );
    expect(total.averageMovingSpeedMetersPerSecond).toBeCloseTo(total.distanceMeters! / total.movingDurationSeconds!, 9);
    expect(total.averageSpeedMetersPerSecond).toBeCloseTo(total.distanceMeters! / total.durationSeconds!, 9);
    // The parts reported beside the merge are the same sums.
    expect(merged.parts.map((part) => part.distanceMeters)).toEqual(parts.map((stats) => stats.distanceMeters));
  });

  it('is named as merged, keeps the sport, and records the pause as an event', () => {
    const { morning, afternoon } = fixtureSources();
    const merged = mergeTracks([morning, afternoon]);
    if (!merged.ok) throw new Error('merge failed');
    expect(merged.activity.metadata.name).toBe('Imabari City Cycling (merged)');
    expect(merged.activity.metadata.sport).toBe('cycling');
    expect(merged.activity.events?.map((event) => event.type)).toEqual(['pause', 'resume']);
    expect(merged.activity.events?.[0]!.time?.toISOString()).toBe(MORNING_RIDE.end);
  });
});

describe('what a merge refuses (AV-1109)', () => {
  it('refuses a file with no timestamps, with the reason, rather than placing it by guess', () => {
    const untimed = makeActivity([
      { lat: 46, lon: 7 },
      { lat: 46.001, lon: 7 },
    ]);
    expect(assessMergeSource(untimed)).toMatchObject({ code: 'merge_no_timestamps', message: expect.stringMatching(/no timestamps/) });
    expect(assessMergeSource(ride('a.gpx', 0, 3).activity)).toBeUndefined();

    // Even if one slips through, it is left out, never placed.
    const result = mergeTracks([ride('a.gpx', 0, 3), { fileName: 'b.gpx', activity: untimed }]);
    expect(result).toMatchObject({ ok: false, error: { code: 'merge_needs_two' } });
    expect(result.parts.map((part) => part.fileName)).toEqual(['a.gpx']);
  });

  it('needs at least two timed files', () => {
    expect(mergeTracks([])).toMatchObject({ ok: false, error: { code: 'merge_needs_two' } });
    expect(mergeTracks([ride('a.gpx', 0, 10)])).toMatchObject({ ok: false, error: { code: 'merge_needs_two' } });
  });

  it('refuses overlapping files, naming them and the overlap, rather than interleaving them', () => {
    const result = mergeTracks([ride('late.gpx', 50, 100), ride('early.gpx', 0, 100)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'merge_overlap', between: [0, 1], overlapSeconds: 49 });
    expect(result.error.message).toMatch(/late\.gpx starts at 08:00:50 UTC, before early\.gpx ends at 08:01:39 UTC/);
    expect(result.error.message).toMatch(/overlap by 49 s/);
    // The order is still reported, so the reader sees which two collide.
    expect(result.parts.map((part) => part.fileName)).toEqual(['early.gpx', 'late.gpx']);
  });

  it('refuses a file inside another, and the same file twice, each said for what it is', () => {
    const inside = mergeTracks([ride('all-day.gpx', 0, 1000), ride('lunch.gpx', 100, 50)]);
    expect(inside).toMatchObject({ ok: false, error: { code: 'merge_overlap', overlapSeconds: 49 } });
    const twice = mergeTracks([ride('a.gpx', 0, 10), ride('a-copy.gpx', 0, 10)]);
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.message).toMatch(/cover exactly the same time.+same recording/);
  });

  it('finds an overlap past the first pair, across three files', () => {
    const result = mergeTracks([ride('a.gpx', 0, 10), ride('b.gpx', 100, 10), ride('c.gpx', 105, 10)]);
    expect(result).toMatchObject({ ok: false, error: { code: 'merge_overlap', between: [1, 2] } });
  });
});

describe('the edges of a merge (AV-1109)', () => {
  it('takes a file that starts the second the last one ends as a zero-length pause', () => {
    const result = mergeTracks([ride('a.gpx', 0, 11), ride('b.gpx', 10, 5)]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.pauses[0]).toMatchObject({ seconds: 0 });
  });

  it('warns about a pause across a long jump, and still counts nothing across it', () => {
    const near = ride('a.gpx', 0, 10, { lat0: 46 });
    const far = ride('b.gpx', 600, 10, { lat0: 46.05 }); // about 5.5 km north
    const result = mergeTracks([near, far]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.pauses[0]!.far).toBe(true);
    expect(result.pauses[0]!.jumpMeters!).toBeGreaterThan(FAR_PAUSE_JUMP_METERS);
    expect(result.activity.warnings.map((warning) => warning.code)).toContain('merge_far_jump');
    const parts = [near, far].map((source) => computeStats(source.activity.points).stats.distanceMeters!);
    expect(result.activity.derived!.distanceMeters).toBeCloseTo(parts[0]! + parts[1]!, 6);
  });

  it('puts a file’s own out-of-order points right, and leaves out its untimed ones with a note', () => {
    const shuffled = ride('a.gpx', 0, 5);
    const points = [...shuffled.activity.points];
    [points[1], points[3]] = [points[3]!, points[1]!];
    points.push({ index: 5, lat: 46.1, lon: 7 });
    const result = mergeTracks([{ fileName: 'a.gpx', activity: { ...shuffled.activity, points } }, ride('b.gpx', 100, 5)]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.activity.points).toHaveLength(10);
    expect(result.activity.points.slice(0, 5).map((point) => point.time!.getTime() - T0)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(result.parts[0]!.untimedPointCount).toBe(1);
    expect(result.activity.warnings.find((warning) => warning.code === 'merge_untimed_points')?.message).toMatch(
      /1 point of a\.gpx had no time/,
    );
  });

  it('continues a recorded odometer across files, and mixes one with GPS distance, as the sum of the parts', () => {
    // Both start their odometer at zero, as every device does: read naively, the
    // merged stream would go backwards at the second file and be thrown away.
    const a = ride('a.gpx', 0, 10, { extra: (i) => ({ distanceMeters: i * 7 }) });
    const b = ride('b.gpx', 100, 10, { extra: (i) => ({ distanceMeters: i * 7 }) });
    const gps = ride('c.gpx', 200, 10);
    const result = mergeTracks([a, b, gps]);
    if (!result.ok) throw new Error(result.error.message);
    const distances = result.activity.points.map((point) => point.distanceMeters!);
    for (let i = 1; i < distances.length; i += 1) expect(distances[i]!).toBeGreaterThanOrEqual(distances[i - 1]!);
    const parts = [a, b, gps].map((source) => computeStats(source.activity.points).stats.distanceMeters!);
    expect(parts[0]).toBe(63);
    expect(result.activity.derived!.distanceMeters).toBeCloseTo(parts[0]! + parts[1]! + parts[2]!, 6);
  });

  it('keeps a file’s own segments, apart from every other file’s', () => {
    const twoSegments = ride('a.gpx', 0, 6, { extra: (i) => ({ segmentIndex: i < 3 ? 0 : 1 }) });
    const result = mergeTracks([ride('b.gpx', 100, 3), twoSegments]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.activity.points.map((point) => point.segmentIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it('names a merge of differently named files after the oldest, and says when the sports differ', () => {
    const morning = ride('a.gpx', 0, 5);
    const evening = ride('b.gpx', 100, 5);
    const run = {
      ...evening,
      activity: { ...evening.activity, metadata: { ...evening.activity.metadata, name: 'Evening run', sport: 'running' as const } },
    };
    const result = mergeTracks([run, morning]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.activity.metadata.name).toBe('Ride (merged)');
    expect(result.activity.metadata.sport).toBeUndefined();
    expect(result.activity.warnings.map((warning) => warning.code)).toContain('merge_sports_differ');
  });

  it('carries every file’s laps, numbered afresh', () => {
    const a = ride('a.gpx', 0, 5);
    const b = ride('b.gpx', 100, 5);
    const withLaps = (source: MergeSource, start: number) => ({
      ...source,
      activity: { ...source.activity, laps: [{ index: 0, startTime: at(start), durationSeconds: 4 }] },
    });
    const result = mergeTracks([withLaps(b, 100), withLaps(a, 0)]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.activity.laps?.map((lap) => [lap.index, lap.startTime?.getTime()])).toEqual([
      [0, at(0).getTime()],
      [1, at(100).getTime()],
    ]);
  });
});
