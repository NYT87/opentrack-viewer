import { describe, expect, it } from 'vitest';
import { exportActivity, getExportAvailability } from './index';
import { mergedTrackFormats } from './mergedTrack';
import { buildTcx } from './tcx/buildTcx';
import { buildFit } from './fit/buildFit';
import { makeActivity } from '../test/helpers/activity';

const merged = (touching = false) => {
  const activity = makeActivity([0, 10, touching ? 10 : 100, 110].map((seconds, index) => ({
    time: new Date(Date.UTC(2026, 0, 1) + seconds * 1000),
    lat: 40 + index * 0.001, lon: -3, segmentIndex: index < 2 ? 0 : 1,
  })));
  return { ...activity, source: { ...activity.source, parserVersion: 'merge-1' } };
};

describe('export preservation across entry points', () => {
  it('offers the same formats after a merged recording is handed to the viewer', async () => {
    const activity = merged();
    expect(getExportAvailability(activity)).toEqual(mergedTrackFormats(activity));
    expect(getExportAvailability(activity).find((entry) => entry.format === 'tcx')?.available).toBe(false);
    await expect(exportActivity(activity, { format: 'tcx' })).rejects.toThrow(/one lap/);
    expect(() => buildTcx(activity)).toThrow(/one lap/);
  });

  it('allows a section wholly inside one recorded stretch', async () => {
    const activity = merged();
    const range = { startIndex: 0, endIndex: 1 };
    expect(getExportAvailability(activity, range).find((entry) => entry.format === 'tcx')?.available).toBe(true);
    const result = await exportActivity(activity, { format: 'tcx', range });
    expect(await result.blob.text()).toContain('<TotalTimeSeconds>10</TotalTimeSeconds>');
  });

  it('rejects ambiguous FIT boundaries at both generic and direct serializer entry points', async () => {
    const activity = merged(true);
    expect(getExportAvailability(activity).find((entry) => entry.format === 'fit')?.available).toBe(false);
    await expect(exportActivity(activity, { format: 'fit' })).rejects.toThrow(/whole second/);
    expect(() => buildFit(activity)).toThrow(/whole second/);
  });
});
