import { describe, expect, it } from 'vitest';
import {
  DROP_FRAME_IGNORED_NOTE,
  addSeconds,
  formatStartTimecode,
  frameCountToTimecode,
  framesPerDay,
  makeSourceTimecode,
  rateFromFps,
  reduceRate,
  sameFrameRate,
  timecodeFromCreationTime,
  timecodeLine,
  timecodeToFrameCount,
  type SourceTimecode,
} from './timecode';

const NTSC = { numerator: 30000, denominator: 1001 };
const NTSC_60 = { numerator: 60000, denominator: 1001 };

const make = (
  startFrame: number,
  rate = NTSC,
  timebase = 30,
  dropFrame = true,
  source: SourceTimecode['source'] = 'timecode-track',
) => makeSourceTimecode({ startFrame, rate, timebase, dropFrame, source })!;

describe('drop-frame counting, against SMPTE 12M (AV-1026)', () => {
  const df30 = make(0);
  const df60 = make(0, NTSC_60, 60);

  it('counts 29.97 without dropping inside the first minute, with a semicolon', () => {
    expect(frameCountToTimecode(0, df30)).toBe('00:00:00;00');
    expect(frameCountToTimecode(29, df30)).toBe('00:00:00;29');
    expect(frameCountToTimecode(30, df30)).toBe('00:00:01;00');
    expect(frameCountToTimecode(1799, df30)).toBe('00:00:59;29');
  });

  it('skips labels 00 and 01 at each minute that is not a tenth', () => {
    expect(frameCountToTimecode(1800, df30)).toBe('00:01:00;02');
    expect(frameCountToTimecode(1801, df30)).toBe('00:01:00;03');
    // The second minute holds 1798 frames: the last of it, then the third begins at ;02.
    expect(frameCountToTimecode(1800 + 1798 - 1, df30)).toBe('00:01:59;29');
    expect(frameCountToTimecode(1800 + 1798, df30)).toBe('00:02:00;02');
  });

  it('keeps all the labels at every tenth minute', () => {
    expect(frameCountToTimecode(17981, df30)).toBe('00:09:59;29');
    expect(frameCountToTimecode(17982, df30)).toBe('00:10:00;00');
    expect(frameCountToTimecode(17983, df30)).toBe('00:10:00;01');
    expect(frameCountToTimecode(17982 + 1800, df30)).toBe('00:11:00;02');
  });

  it('keeps to the clock: an hour is 107892 frames and lands on 01:00:00;00', () => {
    expect(frameCountToTimecode(107_892, df30)).toBe('01:00:00;00');
    expect(frameCountToTimecode(107_891, df30)).toBe('00:59:59;29');
  });

  it('drops four at 59.94, and the first minute keeps its 3600', () => {
    expect(frameCountToTimecode(3599, df60)).toBe('00:00:59;59');
    expect(frameCountToTimecode(3600, df60)).toBe('00:01:00;04');
    expect(frameCountToTimecode(35_964, df60)).toBe('00:10:00;00');
    expect(frameCountToTimecode(35_963, df60)).toBe('00:09:59;59');
  });

  it('wraps at the end of the day, which is 2,589,408 frames at 29.97', () => {
    expect(framesPerDay(df30)).toBe(2_589_408);
    expect(frameCountToTimecode(2_589_407, df30)).toBe('23:59:59;29');
    expect(frameCountToTimecode(2_589_408, df30)).toBe('00:00:00;00');
    const df60 = make(0, NTSC_60, 60);
    expect(framesPerDay(df60)).toBe(5_178_816);
    expect(frameCountToTimecode(5_178_815, df60)).toBe('23:59:59;59');
    expect(frameCountToTimecode(5_178_816, df60)).toBe('00:00:00;00');
  });

  it('turns a label back into its counter, and refuses one that was dropped', () => {
    expect(timecodeToFrameCount('00:01:00;02', df30)).toBe(1800);
    expect(timecodeToFrameCount('00:10:00;00', df30)).toBe(17_982);
    expect(timecodeToFrameCount('00:01:00;04', df60)).toBe(3600);
    expect(timecodeToFrameCount('00:01:00;00', df30)).toBeUndefined();
    expect(timecodeToFrameCount('00:01:00;01', df30)).toBeUndefined();
    expect(timecodeToFrameCount('00:10:00;00', df30)).toBe(17_982);
    expect(timecodeToFrameCount('nonsense', df30)).toBeUndefined();
    expect(timecodeToFrameCount('00:00:00;30', df30)).toBeUndefined();
  });

  it('round-trips every frame of the first hour at 29.97 and of ten minutes at 59.94', () => {
    for (let frame = 0; frame <= 107_892; frame += 1) {
      expect(timecodeToFrameCount(frameCountToTimecode(frame, df30), df30)).toBe(frame);
    }
    for (let frame = 0; frame <= 35_964; frame += 1) {
      expect(timecodeToFrameCount(frameCountToTimecode(frame, df60), df60)).toBe(frame);
    }
  });
});

describe('non-drop counting (AV-1026)', () => {
  const pal = make(0, { numerator: 25, denominator: 1 }, 25, false);

  it('counts a plain 25 fps clock with a colon', () => {
    expect(frameCountToTimecode(0, pal)).toBe('00:00:00:00');
    expect(frameCountToTimecode(24, pal)).toBe('00:00:00:24');
    expect(frameCountToTimecode(25, pal)).toBe('00:00:01:00');
    expect(frameCountToTimecode(25 * 3723 + 7, pal)).toBe('01:02:03:07');
    expect(framesPerDay(pal)).toBe(2_160_000);
  });

  it('counts 29.97 non-drop with no skips, which is what a flags word of zero says', () => {
    const nd = make(1800, NTSC, 30, false);
    expect(nd.dropFrame).toBe(false);
    expect(formatStartTimecode(nd)).toBe('00:01:00:00');
  });

  it('reads a label back', () => {
    expect(timecodeToFrameCount('01:02:03:07', pal)).toBe(25 * 3723 + 7);
    expect(timecodeToFrameCount('00:00:00:25', pal)).toBeUndefined();
  });
});

describe('what a source states (AV-1026)', () => {
  it('treats drop-frame at a rate that has none as non-drop, and says so', () => {
    const pal = make(100, { numerator: 25, denominator: 1 }, 25, true);
    expect(pal.dropFrame).toBe(false);
    expect(pal.note).toBe(DROP_FRAME_IGNORED_NOTE);
    // 30 fps flat is not 29.97 either.
    expect(make(0, { numerator: 30, denominator: 1 }, 30, true).dropFrame).toBe(false);
    expect(make(0).note).toBeUndefined();
  });

  it('refuses what cannot be a timecode', () => {
    const fields = { startFrame: 0, rate: NTSC, timebase: 30, dropFrame: false, source: 'timecode-track' } as const;
    expect(makeSourceTimecode({ ...fields, startFrame: -1 })).toBeUndefined();
    expect(makeSourceTimecode({ ...fields, startFrame: 1.5 })).toBeUndefined();
    expect(makeSourceTimecode({ ...fields, rate: { numerator: 0, denominator: 1 } })).toBeUndefined();
    expect(makeSourceTimecode({ ...fields, timebase: 0 })).toBeUndefined();
  });

  it('reduces a rate to its lowest fraction and names the usual ones exactly', () => {
    expect(reduceRate(90_000, 3003)).toEqual(NTSC);
    expect(reduceRate(48_000, 1001)).toEqual({ numerator: 48_000, denominator: 1001 });
    expect(rateFromFps(29.97)).toEqual(NTSC);
    expect(rateFromFps(30000 / 1001)).toEqual(NTSC);
    expect(rateFromFps(59.94)).toEqual(NTSC_60);
    expect(rateFromFps(25)).toEqual({ numerator: 25, denominator: 1 });
    expect(rateFromFps(12.5)).toEqual({ numerator: 25, denominator: 2 });
    expect(rateFromFps(0)).toBeUndefined();
  });

  it('knows whether an export rate is the source’s', () => {
    const tc = make(0);
    expect(sameFrameRate(30000 / 1001, tc)).toBe(true);
    expect(sameFrameRate(29.97, tc)).toBe(true);
    expect(sameFrameRate(30, tc)).toBe(false);
    expect(sameFrameRate(25, tc)).toBe(false);
  });
});

describe('the cut moves the start (AV-1026, TD-081)', () => {
  it('adds the cut to the nearest whole source frame', () => {
    const tc = make(17_982 - 30); // one second before the tenth minute
    expect(formatStartTimecode(tc)).toBe('00:09:59;00');
    // 30000/1001 fps: one second is 29.97 frames, 30 after rounding.
    expect(formatStartTimecode(addSeconds(tc, 1))).toBe('00:10:00;00');
    expect(formatStartTimecode(addSeconds(tc, 0))).toBe('00:09:59;00');
    // 61 s is 1828.2 frames: 1828, one drop-frame minute in, 00:01:01;00.
    expect(formatStartTimecode(addSeconds(make(0), 61))).toBe('00:01:01;00');
  });

  it('adds across a drop-frame minute exactly, by counter', () => {
    const tc = make(0);
    // 60 s at 29.97 is 1798.2 frames: 1798, which is one frame short of the minute.
    expect(formatStartTimecode(addSeconds(tc, 60))).toBe('00:00:59;28');
    // 60.06 s is 1800.0 frames.
    expect(formatStartTimecode(addSeconds(tc, 60.06))).toBe('00:01:00;02');
  });

  it('moves a 25 fps clock by whole seconds and wraps past midnight', () => {
    const pal = make(25 * (86_400 - 1), { numerator: 25, denominator: 1 }, 25, false);
    expect(formatStartTimecode(pal)).toBe('23:59:59:00');
    expect(formatStartTimecode(addSeconds(pal, 2))).toBe('00:00:01:00');
    expect(formatStartTimecode(addSeconds(make(0, { numerator: 25, denominator: 1 }, 25, false), 90.52))).toBe('00:01:30:13');
  });

  it('keeps the source, the rate and the flags', () => {
    const moved = addSeconds(make(10), 5);
    expect(moved).toMatchObject({ rate: NTSC, timebase: 30, dropFrame: true, source: 'timecode-track' });
  });
});

describe('the creation time as a time of day (AV-1026)', () => {
  it('reads the UTC time of day at the file’s frame rate, without dropping', () => {
    const tc = timecodeFromCreationTime(new Date('2024-06-01T10:20:30Z'), 1001 / 30000)!;
    expect(tc).toMatchObject({ source: 'creation-time', dropFrame: false, rate: NTSC, timebase: 30 });
    expect(formatStartTimecode(tc)).toBe('10:20:30:00');
  });

  it('works at 25 fps', () => {
    const tc = timecodeFromCreationTime(new Date('2020-01-01T23:59:59Z'), 1 / 25)!;
    expect(formatStartTimecode(tc)).toBe('23:59:59:00');
  });

  it('has none without a creation time, with the epoch one, or without a rate', () => {
    expect(timecodeFromCreationTime(undefined, 1 / 25)).toBeUndefined();
    expect(timecodeFromCreationTime(new Date(NaN), 1 / 25)).toBeUndefined();
    expect(timecodeFromCreationTime(new Date(-2_082_844_800_000), 1 / 25)).toBeUndefined();
    expect(timecodeFromCreationTime(new Date('2024-06-01T10:00:00Z'), 0)).toBeUndefined();
  });
});

describe('the sentence the panels show (AV-1026)', () => {
  it('says where the timecode is from, and what each file holds', () => {
    const track = make(1800);
    expect(timecodeLine(track, 'png-sequence')).toBe(
      "Timecode at the first frame: 00:01:00;02 (from the video's timecode track). Drop-frame: the label skips numbers to keep to the clock. It is written in the metadata file.",
    );
    const created = timecodeFromCreationTime(new Date('2024-06-01T01:02:03Z'), 1 / 25)!;
    expect(timecodeLine(created, 'burned-in')).toBe(
      "Timecode at the first frame: 01:02:03:00 (from the file's creation time). This file does not carry the timecode itself; the PNG sequence's metadata file does.",
    );
    expect(timecodeLine(created, 'webm')).toContain('A WebM has no timecode track');
    expect(timecodeLine(undefined, 'webm')).toBe('The source has no timecode.');
  });
});
