import { describe, expect, it } from 'vitest';
import { parseActivityFile } from './index';
import { fixtureFile } from '../test/helpers/fixtures';

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
