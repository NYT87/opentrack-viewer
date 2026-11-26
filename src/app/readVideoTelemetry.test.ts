import { describe, expect, it } from 'vitest';
import { readVideoTelemetry } from './readVideoTelemetry';
import { readBinaryFixture } from '../test/helpers/fixtures';
import { buildGoproMp4 } from '../test/helpers/goproMp4.mjs';
import { formatStartTimecode } from '../overlay/timecode';

const payload = () => new Uint8Array(readBinaryFixture('hero7.raw'));
const video = (options: Partial<Parameters<typeof buildGoproMp4>[0]> = {}) =>
  new File([Uint8Array.from(buildGoproMp4({ payload: payload(), videoFrames: 510, ...options }))], 'clip.mp4');

describe('the timecode beside the telemetry (AV-1026)', () => {
  it('returns the timecode track’s timecode with the activity', async () => {
    const read = await readVideoTelemetry(
      video({ timecode: { counter: 1800, timescale: 30000, frameDuration: 1001, framesPerSecond: 30, flags: 1 } }),
    );
    expect(read.activity).toBeDefined();
    expect(formatStartTimecode(read.timecode!)).toBe('00:01:00;02');
    expect(read.timecode?.source).toBe('timecode-track');
  });

  it('falls back to the creation time, and says so', async () => {
    const read = await readVideoTelemetry(video({ createdAt: new Date('2024-06-01T10:20:30Z') }));
    expect(read.timecode?.source).toBe('creation-time');
    expect(formatStartTimecode(read.timecode!)).toBe('10:20:30:00');
  });

  it('keeps the timecode of a video with no telemetry track, beside the reason it has no activity', async () => {
    const read = await readVideoTelemetry(
      video({
        omitTelemetryTrack: true,
        timecode: { counter: 25 * 60, timescale: 25_000, frameDuration: 1000, framesPerSecond: 25 },
      }),
    );
    expect(read.activity).toBeUndefined();
    expect(read.timing).toBeUndefined();
    expect(read.activityError?.code).toBe('no_telemetry_track');
    expect(formatStartTimecode(read.timecode!)).toBe('00:01:00:00');
  });

  it('has none for a video with neither a timecode track nor a creation time', async () => {
    const read = await readVideoTelemetry(video({ createdAt: new Date(-2_082_844_800_000) }));
    expect('timecode' in read).toBe(false);
  });
});

describe('where the video starts (#54)', () => {
  it('is taken from the GPS clock, not the camera’s creation time, which keeps local time with no zone', async () => {
    const createdAt = new Date('2001-01-01T09:00:00Z');
    const read = await readVideoTelemetry(video({ createdAt }));
    const firstFix = read.activity!.points[0]!.time!.getTime();
    const start = read.timing!.start!.getTime();
    expect(start).not.toBe(createdAt.getTime());
    // The first fix lies within the video's first seconds.
    expect(firstFix - start).toBeGreaterThanOrEqual(0);
    expect(firstFix - start).toBeLessThan(5_000);
  });
});

describe('time-lapse and TimeWarp footage (AV-1027)', () => {
  it('reads no warp from a clip at real time', async () => {
    const read = await readVideoTelemetry(video());
    expect(read.timing?.warp).toBeUndefined();
  });

  it('reads the camera’s timing from telemetry that runs about ten times faster than its video', async () => {
    const read = await readVideoTelemetry(video({ sampleDurationMs: 100 }));
    const warp = read.timing?.warp;
    expect(warp?.kind).toBe('map');
    if (warp?.kind !== 'map') return;
    expect(warp.video[0]).toBe(0);
    expect(warp.real[0]).toBe(0);
    const last = warp.video.length - 1;
    expect(warp.real[last]! / warp.video[last]!).toBeGreaterThan(8);
    expect(warp.real[last]! / warp.video[last]!).toBeLessThan(12);
    // The video's start allows for the first fix being warped time into it.
    const firstFix = read.activity!.points[0]!.time!.getTime();
    expect(read.timing!.start!.getTime()).toBeLessThanOrEqual(firstFix);
  });
});
