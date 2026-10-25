import { describe, expect, it } from 'vitest';
import FitParser from 'fit-file-parser';
import { exportMergedTrack, hasStretchesTouchingInFit, mergedTrackFileStem, mergedTrackFormats } from './mergedTrack';
import { mergeTracks, type MergeSource } from '../domain/mergeTracks';
import type { Activity } from '../domain/activity';
import { ActivityError } from '../domain/errors';
import { parseActivityFile } from '../parsers';
import { makeActivity } from '../test/helpers/activity';

const T0 = Date.parse('2026-09-24T08:00:00Z');

/** A short ride, one point every two seconds, with a stop halfway where the rider stands still. */
function ride(fileName: string, fromSecond: number, lat0: number): MergeSource {
  let lat = lat0;
  const activity = makeActivity(
    Array.from({ length: 40 }, (_, i) => {
      if (i > 0 && (i < 18 || i > 22)) lat += 12 / 111_320;
      return {
        time: new Date(T0 + (fromSecond + i * 2) * 1000),
        lat,
        lon: 7,
        elevationMeters: 100 + (i % 10),
        heartRateBpm: 120 + i,
      };
    }),
  );
  return {
    fileName,
    activity: {
      ...activity,
      id: fileName,
      source: { ...activity.source, fileName },
      metadata: { name: 'Lunch Ride', sport: 'cycling' },
    },
  };
}

function merged(): Activity {
  const result = mergeTracks([ride('second.gpx', 3600, 46.01), ride('first.gpx', 0, 46)]);
  if (!result.ok) throw new Error(result.error.message);
  return result.activity;
}

const totals = (activity: Activity) => {
  const derived = activity.derived!;
  return {
    points: activity.points.length,
    start: derived.startTime?.toISOString(),
    end: derived.endTime?.toISOString(),
    elapsed: derived.durationSeconds,
  };
};

describe('which formats a merged track can be written to (AV-1109, TD-060)', () => {
  it('offers GPX and FIT, which carry the pause, and names why TCX cannot', () => {
    const formats = mergedTrackFormats(merged());
    expect(formats.filter((entry) => entry.available).map((entry) => entry.format)).toEqual(['gpx', 'fit']);
    expect(formats.find((entry) => entry.format === 'tcx')).toMatchObject({
      available: false,
      reason: expect.stringMatching(/one lap .+ pause .+ riding/),
    });
  });

  it('refuses TCX with the same reason, rather than writing the pause as riding time', async () => {
    await expect(exportMergedTrack(merged(), 'tcx')).rejects.toBeInstanceOf(ActivityError);
    await expect(exportMergedTrack(merged(), 'tcx')).rejects.toThrow(/one lap/);
  });

  it('names the file as merged', () => {
    expect(mergedTrackFileStem(merged())).toBe('Lunch-Ride-merged');
    const unnamed = { ...merged(), metadata: { name: undefined } };
    expect(mergedTrackFileStem(unnamed)).toBe('activity-merged');
  });
});

describe('a merged track written and read back (AV-1109)', () => {
  it('as GPX: the same points, times and totals, with the pause a gap between segments', async () => {
    const activity = merged();
    const result = await exportMergedTrack(activity, 'gpx');
    expect(result.fileName).toBe('Lunch-Ride-merged.gpx');
    const text = await result.blob.text();
    expect(text.match(/<trkseg>/g)).toHaveLength(2);
    expect(result.warnings[0]).toMatchObject({ code: 'merged_pauses_kept', message: expect.stringMatching(/segment per recorded stretch/) });

    const { activity: back } = await parseActivityFile(new File([text], result.fileName));
    expect(totals(back)).toEqual(totals(activity));
    expect(back.points.map((point) => point.time?.getTime())).toEqual(activity.points.map((point) => point.time?.getTime()));
    expect(back.metadata.name).toBe('Lunch Ride (merged)');
    // To the centimetre: GPX keeps coordinates to seven decimals.
    expect(back.derived!.distanceMeters).toBeCloseTo(activity.derived!.distanceMeters!, 1);
    expect(back.derived!.movingDurationSeconds).toBeCloseTo(activity.derived!.movingDurationSeconds!, 6);
    expect(back.derived!.elevationGainMeters).toBeCloseTo(activity.derived!.elevationGainMeters!, 6);
    expect(back.points.map((point) => point.heartRateBpm)).toEqual(activity.points.map((point) => point.heartRateBpm));
  });

  it('as FIT: the timer stops for the pause, and the totals read back the same', async () => {
    const activity = merged();
    const result = await exportMergedTrack(activity, 'fit');
    expect(result.fileName).toBe('Lunch-Ride-merged.fit');
    expect(result.warnings[0]?.message).toMatch(/timer stops .+ elapsed time and not in timer time/);

    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const { activity: back } = await parseActivityFile(new File([bytes], result.fileName));
    expect(totals(back)).toEqual(totals(activity));
    expect(back.laps?.map((lap) => [lap.startTime?.getTime(), lap.endTime?.getTime()])).toEqual(
      activity.laps?.map((lap) => [lap.startTime?.getTime(), lap.endTime?.getTime()]),
    );
    expect(back.derived!.distanceMeters).toBeCloseTo(activity.derived!.distanceMeters!, 0);
    expect(back.derived!.movingDurationSeconds).toBeCloseTo(activity.derived!.movingDurationSeconds!, 0);
    // The pause is in elapsed time, and not in moving time.
    expect(back.derived!.durationSeconds! - back.derived!.movingDurationSeconds!).toBeGreaterThan(3600 - 80);
  });
});

/** A recording whose odometer says much more than its positions do: a wheel sensor on a GPS that barely moves. */
function odometerRide(fileName: string, fromSecond: number): MergeSource {
  const activity = makeActivity(
    Array.from({ length: 21 }, (_, i) => ({
      time: new Date(T0 + (fromSecond + i) * 1000),
      lat: 46 + (i * 0.1) / 111_320,
      lon: 7,
      // 10 m a second by the wheel, 0.1 m a second by GPS; starting at zero, as every device does.
      distanceMeters: i * 10,
    })),
  );
  return { fileName, activity: { ...activity, id: fileName, metadata: { name: 'Wheel Ride', sport: 'cycling' } } };
}

describe('a merge of recorded odometers, written and read back (AV-1109, review R1-C2)', () => {
  const source = () => {
    const result = mergeTracks([odometerRide('a.fit', 0), odometerRide('b.fit', 600)]);
    if (!result.ok) throw new Error(result.error.message);
    return result.activity;
  };

  it('keeps the recorded distance through GPX, where GPX itself has no field for it', async () => {
    const activity = source();
    expect(activity.derived!.distanceMeters).toBe(400);
    const result = await exportMergedTrack(activity, 'gpx');
    const text = await result.blob.text();
    expect(text).toContain('<gpxdata:distance>400</gpxdata:distance>');
    const { activity: back } = await parseActivityFile(new File([text], result.fileName));
    expect(back.derived!.distanceMeters).toBe(400);
    expect(back.derived!.movingDurationSeconds).toBe(activity.derived!.movingDurationSeconds);
    expect(back.derived!.durationSeconds).toBe(activity.derived!.durationSeconds);
  });

  it('keeps it through FIT too', async () => {
    const activity = source();
    const result = await exportMergedTrack(activity, 'fit');
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const { activity: back } = await parseActivityFile(new File([bytes], result.fileName));
    expect(back.derived!.distanceMeters).toBeCloseTo(400, 1);
    expect(back.derived!.movingDurationSeconds).toBe(activity.derived!.movingDurationSeconds);
  });
});

describe('the FIT timer across a pause (AV-1109, review R1-C3)', () => {
  it('leaves the pause out of timer time, even when no moving time can be worked out', async () => {
    // Two stationary ten-second recordings, 90 seconds apart: nothing moves, so
    // there is no moving time to fall back on, and the timer must still stop.
    const still = (fileName: string, from: number): MergeSource => {
      const activity = makeActivity(
        Array.from({ length: 11 }, (_, i) => ({ time: new Date(T0 + (from + i) * 1000), lat: 46, lon: 7 })),
      );
      return { fileName, activity: { ...activity, id: fileName } };
    };
    const result = mergeTracks([still('a.fit', 0), still('b.fit', 100)]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.activity.derived!.movingDurationSeconds).toBeUndefined();

    const written = await exportMergedTrack(result.activity, 'fit');
    const decoded = await new FitParser({ mode: 'list' }).parseAsync(await written.blob.arrayBuffer());
    expect(decoded.sessions?.[0]?.total_elapsed_time).toBe(110);
    expect(decoded.sessions?.[0]?.total_timer_time).toBe(20);
    expect(decoded.activity?.total_timer_time).toBe(20);
  });
});

describe('recordings that meet within one second (AV-1109, reviews R2-C1, R3-C1, R4-C1)', () => {
  /** A recording of one point per listed second (fractions allowed), climbing 10 m a point from `ele`. */
  const at = (fileName: string, seconds: number[], ele: number): MergeSource => {
    const activity = makeActivity(
      seconds.map((second, i) => ({
        time: new Date(T0 + second * 1000),
        lat: 46 + i * 0.0001 + ele / 1e6,
        lon: 7,
        elevationMeters: ele + i * 10,
      })),
    );
    return { fileName, activity: { ...activity, id: fileName } };
  };
  const merge = (sources: MergeSource[]) => {
    const result = mergeTracks(sources);
    if (!result.ok) throw new Error(result.error.message);
    return result.activity;
  };
  const read = async (activity: Activity, format: 'gpx' | 'fit') => {
    const written = await exportMergedTrack(activity, format);
    const body = format === 'gpx' ? await written.blob.text() : new Uint8Array(await written.blob.arrayBuffer());
    return (await parseActivityFile(new File([body], written.fileName))).activity;
  };

  // Each of these meets in a second FIT cannot divide: the reviewer's cases, and a sub-second gap.
  const touching: [string, MergeSource[], number[]][] = [
    ['a file starting the second the last ends', [at('a.fit', [0, 1], 100), at('b.fit', [1, 2], 1000)], [0, 0, 1, 1]],
    ['three, the middle one second long', [at('a.fit', [0, 1], 100), at('b.fit', [1, 1], 500), at('c.fit', [1, 2], 1000)], [0, 0, 1, 1, 2, 2]],
    ['several records in the shared second', [at('a.fit', [0, 1, 1], 100), at('b.fit', [1, 2], 1000)], [0, 0, 0, 1, 1]],
    ['a half-second gap inside one FIT second', [at('a.fit', [0, 1.2], 100), at('b.fit', [1.7, 3], 1000)], [0, 0, 1, 1]],
  ];

  it.each(touching)('refuses FIT, with the reason, for %s', async (_case, sources) => {
    const activity = merge(sources);
    expect(hasStretchesTouchingInFit(activity)).toBe(true);
    expect(mergedTrackFormats(activity).find((entry) => entry.format === 'fit')).toMatchObject({
      available: false,
      reason: expect.stringMatching(/whole second.+same second the next begins/),
    });
    await expect(exportMergedTrack(activity, 'fit')).rejects.toThrow(/whole second/);
  });

  it.each(touching)('keeps them apart through GPX for %s: the same segments and climb', async (_case, sources, segments) => {
    const activity = merge(sources);
    expect(activity.points.map((point) => point.segmentIndex)).toEqual(segments);
    const back = await read(activity, 'gpx');
    expect(back.points.map((point) => point.segmentIndex)).toEqual(segments);
    expect(back.derived!.elevationGainMeters).toBe(activity.derived!.elevationGainMeters);
    expect(back.derived!.distanceMeters).toBeCloseTo(activity.derived!.distanceMeters!, 1);
  });

  it('still offers FIT across a real pause, and reads a one-second stretch back whole', async () => {
    // [0, 1], a nine-second pause, then two records in second 10 (review R3-C1).
    const activity = merge([at('a.fit', [0, 1], 100), at('b.fit', [10, 10], 1000)]);
    expect(hasStretchesTouchingInFit(activity)).toBe(false);
    expect(mergedTrackFormats(activity).find((entry) => entry.format === 'fit')?.available).toBe(true);
    const back = await read(activity, 'fit');
    expect(back.points.map((point) => point.segmentIndex)).toEqual([0, 0, 1, 1]);
    expect(back.derived!.elevationGainMeters).toBe(20);
  });
});
