import { describe, expect, it } from 'vitest';
import { activityThrough, straightNorth } from '../../test/helpers/mapVideoRoutes';
import { buildMapVideoModel } from '../model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from '../project';
import { AUDIO_FADE_SECONDS, fitAudio } from './audio';
import { activityBaseName, planMapVideoExport, posterFileName } from './plan';

const ride = activityThrough(straightNorth(2000));
const named = { ...ride, source: { ...ride.source, fileName: 'Morning Ride (Imabari).GPX' } };
const plan = (patch: Partial<MapVideoSettings> = {}, format: 'mp4' | 'webm' = 'mp4') => {
  const settings = { ...DEFAULT_MAP_VIDEO_SETTINGS, ...patch };
  const built = buildMapVideoModel(named, settings);
  if (!built.ok) throw new Error(built.error);
  return planMapVideoExport(named, built.model, settings, format);
};

describe('planning a map video export (AV-1209)', () => {
  it('counts the frames, sizes the bitrate, and names the file for the activity', () => {
    expect(plan()).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 900,
      lengthSeconds: 30,
      format: 'mp4',
      codec: 'avc',
      bitrate: 9_953_280,
      estimatedBytes: 37_324_800,
      fileName: 'morning-ride-imabari-map-video-1920x1080.mp4',
    });
  });

  it('plans WebM as VP9, and 60 frames a second as twice the frames', () => {
    expect(plan({ output: { width: 1080, height: 1920, fps: 60 }, lengthSeconds: 10 }, 'webm')).toMatchObject({
      frameCount: 600,
      codec: 'vp9',
      fileName: 'morning-ride-imabari-map-video-1080x1920.webm',
    });
  });

  it('refuses a size or length the limits do not allow, saying why', () => {
    expect(plan({ output: { width: 3840, height: 2160, fps: 30 }, lengthSeconds: 90 })).toEqual({ problem: expect.stringContaining('1 minute above 1080p') });
  });

  it('names a file without a usable name after the activity, else plainly', () => {
    expect(activityBaseName({ ...ride, source: { ...ride.source, fileName: '..//?.gpx' }, metadata: {} })).toBe('activity');
    expect(activityBaseName({ ...ride, source: { ...ride.source, fileName: undefined }, metadata: { name: 'Col de la Croix' } })).toBe('col-de-la-croix');
    expect(posterFileName(named, 75.25)).toBe('morning-ride-imabari-map-video-poster-1m15_3s.png');
  });
});

describe('the reader\'s sound (AV-1209)', () => {
  const tone = (seconds: number, rate = 1000) => Float32Array.from({ length: seconds * rate }, () => 1);

  it('cuts longer sound at the video\'s end, fading it out', () => {
    const fitted = fitAudio([tone(60), tone(60), tone(60)], 1000, 30);
    expect(fitted).toMatchObject({ seconds: 30, trimmed: true });
    expect(fitted.channels).toHaveLength(2);
    const left = fitted.channels[0]!;
    expect(left).toHaveLength(30_000);
    expect(left[30_000 - AUDIO_FADE_SECONDS * 1000 - 1]).toBe(1);
    expect(left[29_000]).toBeCloseTo(0.5, 2);
    expect(left[29_999]).toBe(0);
  });

  it('leaves shorter sound as it is, ending before the video', () => {
    const fitted = fitAudio([tone(10)], 1000, 30);
    expect(fitted).toMatchObject({ seconds: 10, trimmed: false });
    expect(fitted.channels[0]!.every((sample) => sample === 1)).toBe(true);
  });
});
