import { describe, expect, it } from 'vitest';
import { parseActivityFile } from './index';
import { binaryFixtureFile, fixtureFile, readBinaryFixture } from '../test/helpers/fixtures';

describe('parseActivityFile (AV-304 pipeline)', () => {
  it('detects, parses and validates a GPX file end to end', async () => {
    const { activity, detection } = await parseActivityFile(fixtureFile('route-with-elevation.gpx'));

    expect(detection.format).toBe('gpx');
    expect(activity.points).toHaveLength(4);
    expect(activity.derived?.distanceMeters).toBeGreaterThan(0);
    expect(activity.derived?.elevationGainMeters).toBeCloseTo(30);
    expect(activity.source.fileName).toBe('route-with-elevation.gpx');
  });

  it('surfaces malformed XML as a typed error', async () => {
    await expect(parseActivityFile(fixtureFile('malformed.gpx'))).rejects.toMatchObject({
      code: 'invalid_gpx_xml',
    });
  });

  it('surfaces an unsupported file as a typed error', async () => {
    await expect(
      parseActivityFile(fixtureFile('not-gpx.txt', 'text/plain')),
    ).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('surfaces a point-free track as no_route_points', async () => {
    await expect(parseActivityFile(fixtureFile('no-points.gpx'))).rejects.toMatchObject({
      code: 'no_route_points',
    });
  });

  it('makes no network request while parsing (privacy regression)', async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error('network access is not allowed during parsing'));
    }) as typeof fetch;

    try {
      await parseActivityFile(fixtureFile('simple-route.gpx'));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(0);
  });
});

describe('FIT intake (AV-702)', () => {
  it('routes a .fit file through the same pipeline as GPX', async () => {
    const { activity, detection } = await parseActivityFile(
      binaryFixtureFile('ride-with-sensors.fit'),
    );

    expect(detection).toMatchObject({ format: 'fit', via: 'signature' });
    expect(activity.source.format).toBe('fit');
    expect(activity.points).toHaveLength(6);
    expect(activity.derived?.distanceMeters).toBeGreaterThan(0);
  });

  it('detects FIT by signature even when the file is misnamed', async () => {
    const bytes = await binaryFixtureFile('ride-with-sensors.fit').arrayBuffer();
    const misnamed = new File([bytes], 'ride.gpx', { type: 'application/gpx+xml' });

    const { activity, detection } = await parseActivityFile(misnamed);

    expect(detection.via).toBe('signature');
    expect(activity.source.format).toBe('fit');
  });

  it('reports a truncated FIT file as a FIT failure, with FIT-specific advice', async () => {
    const bytes = new Uint8Array(await binaryFixtureFile('ride-with-sensors.fit').arrayBuffer());

    await expect(
      parseActivityFile(new File([bytes.slice(0, 60)], 'broken.fit')),
    ).rejects.toMatchObject({ code: 'fit_parse_failed' });
  });

  it('says a FIT file carried no records rather than blaming the format', async () => {
    // Scribbling over the record data leaves a readable file with nothing in it.
    const bytes = new Uint8Array(await binaryFixtureFile('ride-with-sensors.fit').arrayBuffer());
    bytes.set([0xff, 0xff, 0xff, 0xff], 20);

    await expect(
      parseActivityFile(new File([bytes], 'empty.fit')),
    ).rejects.toMatchObject({ code: 'no_route_points' });
  });

  it('keeps an indoor FIT activity usable despite having no route', async () => {
    const { activity } = await parseActivityFile(binaryFixtureFile('treadmill-run.fit'));

    expect(activity.streams.hasLocation).toBe(false);
    expect(activity.points).toHaveLength(5);
    // Validation adds the warning, and must not reject the activity...
    const noGps = activity.warnings.filter((w) => w.code === 'no_location_stream');
    expect(noGps).toHaveLength(1);
    // ...exactly once: the reader should not be told the same thing twice.
    expect(new Set(activity.warnings.map((w) => w.message)).size).toBe(activity.warnings.length);
  });
});

describe('video is not accepted by the generic intake (AV-907)', () => {
  it('refuses a GoPro video here, however well it could be read elsewhere', async () => {
    // `extractGpmf` and `parseGopro` can read this exact file. The refusal is
    // the plan: AV-907 gives video a route of its own, with the progress and
    // cancellation a multi-gigabyte read needs. If this test ever fails
    // because someone added `gopro` to SUPPORTED_FORMATS, check AV-907 first.
    const video = new File([readBinaryFixture('hero8.mp4')], 'GH010042.mp4', {
      type: 'video/mp4',
    });

    await expect(parseActivityFile(video)).rejects.toMatchObject({
      code: 'unsupported_format',
      message: expect.stringMatching(/GoPro video with telemetry, but reading it is not available/i),
    });
  });
});
