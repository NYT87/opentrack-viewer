import { describe, expect, it } from 'vitest';
import { detectFormat, detectSupportedFormat, SUPPORTED_FORMATS } from './detectFormat';
import { ActivityError } from '../domain/errors';
import { fixtureFile, readBinaryFixture, readFixture } from '../test/helpers/fixtures';

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

describe('video detection (AV-902)', () => {
  const video = (fixture: string, name = fixture) =>
    new File([readBinaryFixture(fixture)], name, { type: 'video/mp4' });

  it('recognizes a GoPro video by the markers in its tail', async () => {
    // A camera writes `moov` at the end, so the head cannot answer this.
    await expect(detectFormat(video('gopro-with-telemetry.mp4'))).resolves.toEqual({
      format: 'gopro',
      via: 'signature',
    });
  });

  it('recognizes HERO7-style markers near the head', async () => {
    const bytes = new Uint8Array(128);
    bytes.set([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70]); // ftyp
    bytes.set(new TextEncoder().encode('GPRO HERO7 Black GPS5'), 24);

    await expect(detectFormat(new File([bytes], 'hero7-head-markers.mp4'))).resolves.toEqual({
      format: 'gopro',
      via: 'signature',
    });
  });

  it('recognizes a video with no telemetry as just a video', async () => {
    await expect(detectFormat(video('plain-video.mp4'))).resolves.toEqual({
      format: 'video',
      via: 'signature',
    });
  });

  it('trusts the container over the extension, either way', async () => {
    // A GoPro recording renamed `.mov`, and a text file renamed `.mp4`.
    await expect(detectFormat(video('gopro-with-telemetry.mp4', 'GX010042.mov'))).resolves
      .toMatchObject({ format: 'gopro', via: 'signature' });

    const notAVideo = new File(['not a video at all'], 'lies.mp4');
    await expect(detectFormat(notAVideo)).resolves.toEqual({
      format: 'video',
      via: 'extension',
    });
  });

  it('turns a video away for its own reason, not a generic one', async () => {
    await expect(detectSupportedFormat(video('plain-video.mp4'))).rejects.toMatchObject({
      code: 'unsupported_format',
      message: expect.stringMatching(/only GoPro videos carry the telemetry/i),
    });

    // ...and a GoPro file is told it was recognized, which is a different thing.
    await expect(detectSupportedFormat(video('gopro-with-telemetry.mp4'))).rejects.toMatchObject({
      code: 'unsupported_format',
      message: expect.stringMatching(/GoPro video with telemetry, but reading it is not available/i),
    });
  });

  it('reads only the head of a file that is not a video', async () => {
    // The tail sniff is the expensive half, and a GPX must never pay for it.
    const reads: [number, number][] = [];
    const gpx = fixtureFile('simple-route.gpx');
    const original = gpx.slice.bind(gpx);
    gpx.slice = ((start = 0, end = gpx.size) => {
      reads.push([start, end]);
      return original(start, end);
    }) as File['slice'];

    await detectFormat(gpx);

    expect(reads).toEqual([[0, 512]]);
  });

  it('recognizes a file an actual camera wrote', async () => {
    // The generated fixtures above are box shells; this is a real HERO8 clip,
    // with a real moov at the end. The design is only worth anything if it
    // works on that.
    const file = new File([readBinaryFixture('hero8.mp4')], 'GH010042.mp4');

    await expect(detectFormat(file)).resolves.toEqual({ format: 'gopro', via: 'signature' });
  });

  it('never reads a whole video, however large it claims to be', async () => {
    // The point of the whole approach: a multi-gigabyte recording is
    // identified from two small windows, not by loading it.
    const bytes = readBinaryFixture('gopro-with-telemetry.mp4');
    const file = new File([bytes], 'GX010042.mp4');
    const reads: [number, number][] = [];
    const original = file.slice.bind(file);
    file.slice = ((start = 0, end = file.size) => {
      reads.push([start, end === undefined ? file.size : end]);
      return original(start, end);
    }) as File['slice'];

    await detectFormat(file);

    // The head, then the tail — and nothing in between.
    expect(reads).toHaveLength(2);
    expect(reads[0]).toEqual([0, 512]);
    expect(reads[1]![0]).toBeGreaterThanOrEqual(512);
    const readBytes = reads.reduce((sum, [start, end]) => sum + (end - start), 0);
    expect(readBytes).toBeLessThan(file.size + 64 * 1024);
  });
});
