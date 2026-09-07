import { describe, expect, it } from 'vitest';
import { detectFormat, detectSupportedFormat, SUPPORTED_FORMATS } from './detectFormat';
import { ActivityError } from '../domain/errors';
import { fixtureFile, readFixture } from '../test/helpers/fixtures';

const fileOf = (name: string, content: string, type = ''): File =>
  new File([content], name, { type });

describe('detectFormat (AV-103)', () => {
  it('detects GPX from the XML root element', async () => {
    const detection = await detectFormat(fixtureFile('simple-route.gpx'));

    expect(detection).toEqual({ format: 'gpx', via: 'xml-root' });
  });

  it('detects GPX by root element even when the extension is wrong', async () => {
    const detection = await detectFormat(fileOf('route.dat', readFixture('simple-route.gpx')));

    expect(detection.format).toBe('gpx');
    expect(detection.via).toBe('xml-root');
  });

  it('falls back to the file extension', async () => {
    const detection = await detectFormat(fileOf('activity.gpx', 'not yet valid xml'));

    expect(detection).toEqual({ format: 'gpx', via: 'extension' });
  });

  it('detects a FIT file by its ".FIT" header signature', async () => {
    const header = new Uint8Array(16);
    header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT" at byte 8
    const file = new File([header], 'ride.bin');

    expect(await detectFormat(file)).toEqual({ format: 'fit', via: 'signature' });
  });

  it('detects TCX and KML roots', async () => {
    const tcx = fileOf('a.xml', '<?xml version="1.0"?><TrainingCenterDatabase/>');
    const kml = fileOf('b.xml', '<?xml version="1.0"?><kml/>');

    expect((await detectFormat(tcx)).format).toBe('tcx');
    expect((await detectFormat(kml)).format).toBe('kml');
  });

  it('throws a typed error for unknown files', async () => {
    await expect(detectFormat(fixtureFile('not-gpx.txt', 'text/plain'))).rejects.toBeInstanceOf(
      ActivityError,
    );
    await expect(detectFormat(fixtureFile('not-gpx.txt'))).rejects.toMatchObject({
      code: 'unsupported_format',
    });
  });
});

describe('detectSupportedFormat', () => {
  it('passes GPX through', async () => {
    expect((await detectSupportedFormat(fixtureFile('simple-route.gpx'))).format).toBe('gpx');
  });

  it('accepts FIT, which this build now parses (AV-702)', async () => {
    const header = new Uint8Array(16);
    header.set([0x2e, 0x46, 0x49, 0x54], 8);

    await expect(detectSupportedFormat(new File([header], 'ride.fit'))).resolves.toMatchObject({
      format: 'fit',
      via: 'signature',
    });
  });

  it('accepts TCX, which this build now parses (AV-751)', async () => {
    const tcx =
      '<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" />';

    await expect(detectSupportedFormat(new File([tcx], 'ride.tcx'))).resolves.toMatchObject({
      format: 'tcx',
    });
  });

  it('names every format the build reads when it turns one away', async () => {
    // User-facing text that must not outlive the format list it describes.
    let hint = '';
    try {
      await detectSupportedFormat(new File(['<kml />'], 'route.kml'));
    } catch (error) {
      hint = (error as ActivityError).hint;
    }

    expect(hint).not.toBe('');
    for (const format of SUPPORTED_FORMATS) {
      expect(hint).toContain(`.${format}`);
    }
  });

  it('rejects recognized-but-unimplemented formats', async () => {
    // KML is recognized, but is only ever evaluated on user need.
    await expect(detectSupportedFormat(new File(['<kml />'], 'route.kml'))).rejects.toMatchObject({
      code: 'unsupported_format',
    });
  });
});
