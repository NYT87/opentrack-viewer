import { describe, expect, it } from 'vitest';
import { classifyOverlayFile, sortOverlayFiles, type OverlayFileKind } from './overlayFiles';
import { binaryFixtureFile, readFixture } from '../test/helpers/fixtures';

const named = (name: string, content: BlobPart = 'x') => new File([content], name);
const entry = (name: string, kind: OverlayFileKind | undefined) => ({ file: named(name), kind });

describe('what a file is (AV-1014)', () => {
  it('takes an ISO base media box for a video, whatever the name says', async () => {
    const mp4 = binaryFixtureFile('hero8.mp4');
    expect(await classifyOverlayFile(mp4)).toBe('video');
    const mislabelled = new File([await mp4.arrayBuffer()], 'ride.gpx');
    expect(await classifyOverlayFile(mislabelled)).toBe('video');
  });

  it('takes the FIT signature, or a GPX, TCX or KML root, for an activity, whatever the name says', async () => {
    const fit = binaryFixtureFile('impossible-coordinates.fit');
    expect(await classifyOverlayFile(fit)).toBe('activity');
    const mislabelledFit = new File([await fit.arrayBuffer()], 'ride.mp4');
    expect(await classifyOverlayFile(mislabelledFit)).toBe('activity');

    const gpx = readFixture('simple-route.gpx');
    expect(await classifyOverlayFile(named('ride.mov', gpx))).toBe('activity');
    expect(
      await classifyOverlayFile(
        named('a.txt', '<?xml version="1.0"?><TrainingCenterDatabase></TrainingCenterDatabase>'),
      ),
    ).toBe('activity');
    expect(await classifyOverlayFile(named('a.txt', '<kml xmlns="x"></kml>'))).toBe('activity');
  });

  it('falls back to the extension when the first bytes say nothing', async () => {
    expect(await classifyOverlayFile(named('clip.MP4'))).toBe('video');
    expect(await classifyOverlayFile(named('clip.mov'))).toBe('video');
    for (const extension of ['gpx', 'fit', 'tcx', 'kml']) {
      expect(await classifyOverlayFile(named(`ride.${extension}`))).toBe('activity');
    }
  });

  it('is neither for a file that nothing says is a video or an activity', async () => {
    expect(await classifyOverlayFile(named('notes.txt', 'hello'))).toBeUndefined();
    expect(await classifyOverlayFile(named('ride.csv', 'a,b'))).toBeUndefined();
    expect(await classifyOverlayFile(named('no-extension'))).toBeUndefined();
  });
});

describe('sorting one pick (AV-1014)', () => {
  it('takes one video and one activity together', () => {
    const sorted = sortOverlayFiles([entry('a.mp4', 'video'), entry('b.gpx', 'activity')]);
    expect(sorted.video?.name).toBe('a.mp4');
    expect(sorted.activity?.name).toBe('b.gpx');
    expect(sorted.refusal).toBeUndefined();
  });

  it('refuses two videos, naming them, and still takes the activity', () => {
    const sorted = sortOverlayFiles([
      entry('a.mp4', 'video'),
      entry('b.mp4', 'video'),
      entry('c.gpx', 'activity'),
    ]);
    expect(sorted.video).toBeUndefined();
    expect(sorted.activity?.name).toBe('c.gpx');
    expect(sorted.refusal).toBe('Choose one video at a time: "a.mp4" and "b.mp4" are both videos.');
  });

  it('refuses three activities, all named, and still takes the video', () => {
    const sorted = sortOverlayFiles([
      entry('a.gpx', 'activity'),
      entry('b.fit', 'activity'),
      entry('c.tcx', 'activity'),
      entry('d.mov', 'video'),
    ]);
    expect(sorted.activity).toBeUndefined();
    expect(sorted.video?.name).toBe('d.mov');
    expect(sorted.refusal).toBe(
      'Choose one activity at a time: "a.gpx", "b.fit" and "c.tcx" are all activities.',
    );
  });

  it('names a file that is neither, and takes the rest', () => {
    const sorted = sortOverlayFiles([entry('a.mp4', 'video'), entry('notes.txt', undefined)]);
    expect(sorted.video?.name).toBe('a.mp4');
    expect(sorted.refusal).toMatch(/"notes\.txt" is neither a video nor an activity/);
  });
});
