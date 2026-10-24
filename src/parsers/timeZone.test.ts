import { describe, expect, it } from 'vitest';
import { utcOffsetFromIsoTime, utcOffsetFromLocalTimestamp } from './timeZone';
import { parseGpx } from './gpx/parseGpx';
import { parseTcx } from './tcx/parseTcx';

describe('the time zone a file states (AV-1010)', () => {
  it('reads an offset written into an ISO time, and none from Z or a bare time', () => {
    expect(utcOffsetFromIsoTime('2026-09-24T08:55:51+09:00')).toBe(540);
    expect(utcOffsetFromIsoTime('2026-09-24T08:55:51.250-0330')).toBe(-210);
    expect(utcOffsetFromIsoTime('2026-09-24T08:55:51+05:45')).toBe(345);
    expect(utcOffsetFromIsoTime('2026-09-23T23:55:51Z')).toBeUndefined();
    expect(utcOffsetFromIsoTime('2026-09-23T23:55:51')).toBeUndefined();
    expect(utcOffsetFromIsoTime('2026-09-24T08:55:51+23:00')).toBeUndefined();
    expect(utcOffsetFromIsoTime(undefined)).toBeUndefined();
  });

  it('reads a FIT local time against its UTC time, to the quarter hour', () => {
    const utc = new Date('2026-09-23T23:55:51Z');
    expect(utcOffsetFromLocalTimestamp(utc, new Date('2026-09-24T08:55:52Z'))).toBe(540);
    expect(utcOffsetFromLocalTimestamp(utc, new Date('2026-09-23T20:25:51Z'))).toBe(-210);
    expect(utcOffsetFromLocalTimestamp(utc, undefined)).toBeUndefined();
  });

  it('keeps the offset a GPX file’s times are written with, and none when they are in UTC', () => {
    const gpx = (time: string) =>
      `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="34" lon="133"><time>${time}</time></trkpt><trkpt lat="34.001" lon="133"><time>${time}</time></trkpt></trkseg></trk></gpx>`;
    expect(parseGpx(gpx('2026-09-24T08:55:51+09:00')).metadata.utcOffsetMinutes).toBe(540);
    expect(parseGpx(gpx('2026-09-23T23:55:51Z')).metadata.utcOffsetMinutes).toBeUndefined();
  });

  it('keeps the offset of a TCX activity’s Id', () => {
    const tcx = (id: string) =>
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking">' +
      `<Id>${id}</Id><Lap StartTime="${id}"><Track>` +
      `<Trackpoint><Time>${id}</Time><Position><LatitudeDegrees>34</LatitudeDegrees><LongitudeDegrees>133</LongitudeDegrees></Position></Trackpoint>` +
      '</Track></Lap></Activity></Activities></TrainingCenterDatabase>';
    expect(parseTcx(tcx('2026-09-24T08:55:51+09:00')).metadata.utcOffsetMinutes).toBe(540);
    expect(parseTcx(tcx('2026-09-23T23:55:51Z')).metadata.utcOffsetMinutes).toBeUndefined();
  });
});
