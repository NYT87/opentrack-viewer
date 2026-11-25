import { describe, expect, it } from 'vitest';
import { KML_PARSER_VERSION, parseKml } from './parseKml';
import { ActivityError } from '../../domain/errors';
import { readFixture } from '../../test/helpers/fixtures';

const parse = (fixture: string) =>
  parseKml(readFixture(fixture), { fileName: fixture, idFactory: () => 'fixed-id' });

const codes = (fixture: string) => parse(fixture).warnings.map((warning) => warning.code);

describe('parseKml (AV-761): routes', () => {
  it('reads a LineString as an untimed route, longitude first', () => {
    const activity = parse('route-linestring.kml');

    expect(activity.points).toHaveLength(5);
    // KML tuples are lon,lat,alt — the reverse of every other format here.
    expect(activity.points[0]).toMatchObject({ index: 0, segmentIndex: 0, elevationMeters: 100 });
    expect(activity.points[0]?.lat).toBeCloseTo(51.5, 6);
    expect(activity.points[0]?.lon).toBeCloseTo(0, 6);
    expect(activity.points[2]?.lon).toBeCloseTo(0.001, 6);
    expect(activity.points.every((point) => point.time === undefined)).toBe(true);

    expect(activity.streams).toMatchObject({
      hasLocation: true,
      hasElevation: true,
      hasTime: false,
    });
    expect(activity.derived?.distanceMeters).toBeGreaterThan(400);
    expect(activity.derived?.durationSeconds).toBeUndefined();
  });

  it('records source metadata, and no sport', () => {
    const activity = parse('route-linestring.kml');

    expect(activity.source).toEqual({
      format: 'kml',
      fileName: 'route-linestring.kml',
      fileSizeBytes: undefined,
      parserVersion: KML_PARSER_VERSION,
    });
    // A single placemark names the activity, as a GPX <trk> does.
    expect(activity.metadata.name).toBe('Riverside loop');
    // KML describes a place, not a workout: the viewer gets to ask (AV-908).
    expect(activity.metadata.sport).toBe('unknown');
    expect(activity.id).toBe('fixed-id');
  });

  it('keeps a description as plain text, with its markup removed and never run', () => {
    const activity = parse('route-linestring.kml');

    expect(activity.metadata.description).toBe('A planned route. Drawn by hand.');
    expect(activity.metadata.description).not.toMatch(/<|script|img|example\.invalid/);
  });

  it('drops a script written as XML elements, body and all', () => {
    const xml = readFixture('route-linestring.kml').replace(
      /<description>.*<\/description>/s,
      '<description>Hi <script>stealSecret()</script><style>b{}</style> there</description>',
    );

    expect(parseKml(xml).metadata.description).toBe('Hi there');
  });

  it('says the file has no clock, and that this limits conversion', () => {
    const activity = parse('route-linestring.kml');

    expect(activity.warnings).toContainEqual(
      expect.objectContaining({ code: 'no_time_data', severity: 'info' }),
    );
    // Presentation is reported as info: nothing an activity holds was lost.
    expect(activity.warnings).toContainEqual(
      expect.objectContaining({ code: 'kml_styles_ignored', severity: 'info' }),
    );
    // An <img> inside a description is text to this parser, not a link: only
    // an <href> element counts, and this file has none.
    expect(codes('route-linestring.kml')).not.toContain('kml_external_links_not_fetched');
  });
});

describe('parseKml (AV-761): timed tracks', () => {
  it('pairs each <when> with its <gx:coord>', () => {
    const activity = parse('track-timed.kml');

    expect(activity.points).toHaveLength(5);
    expect(activity.points[0]?.time?.toISOString()).toBe('2024-03-02T08:00:00.000Z');
    expect(activity.points[4]?.time?.toISOString()).toBe('2024-03-02T08:02:00.000Z');
    expect(activity.points[4]?.lat).toBeCloseTo(51.504, 6);
    expect(activity.points[4]?.elevationMeters).toBe(108);

    expect(activity.streams.hasTime).toBe(true);
    expect(activity.derived?.durationSeconds).toBe(120);
    expect(activity.metadata.startTime?.toISOString()).toBe('2024-03-02T08:00:00.000Z');
    expect(activity.metadata.name).toBe('Morning track');
  });

  it('turns away a timed track in which no sample has a position', () => {
    const xml = readFixture('track-timed.kml').replace(/<gx:coord>[^<]*<\/gx:coord>/g, '<gx:coord/>');

    expect(() => parseKml(xml)).toThrow(
      expect.objectContaining({
        code: 'no_route_points',
        message: expect.stringMatching(/5 timed samples carry no position/),
      }),
    );
  });

  it('reads the sensor arrays Google Earth and Garmin write beside a track', () => {
    const activity = parse('track-timed.kml');

    expect(activity.points[0]).toMatchObject({
      heartRateBpm: 120,
      runningCadenceSpm: 80,
      powerWatts: 200,
    });
    expect(activity.points[4]).toMatchObject({
      heartRateBpm: 160,
      runningCadenceSpm: 88,
      powerWatts: 240,
    });
    expect(activity.streams).toMatchObject({
      hasHeartRate: true,
      hasRunningCadence: true,
      hasCyclingCadence: false,
      hasPower: true,
    });
  });

  it('reads each track of a gx:MultiTrack as its own segment', () => {
    const activity = parse('paused-track.kml');

    expect(activity.points.map((point) => point.segmentIndex)).toEqual([0, 0, 0, 1, 1]);
    // ~222 m of first track plus ~111 m of second: the 3.5 km gap between them
    // is not ground covered.
    expect(activity.derived?.distanceMeters).toBeGreaterThan(330);
    expect(activity.derived?.distanceMeters).toBeLessThan(340);
    expect(activity.warnings).toContainEqual(expect.objectContaining({ code: 'multiple_segments' }));
  });
});

describe('parseKml (AV-761): several geometries', () => {
  it('reads placemarks and MultiGeometry members as segments, in document order', () => {
    const activity = parse('multi-segment.kml');

    // Leg one (3), then each LineString of leg two (2 + 2); folders are transparent.
    expect(activity.points.map((point) => point.segmentIndex)).toEqual([0, 0, 0, 1, 1, 2, 2]);
    expect(activity.points[3]?.lon).toBeCloseTo(0.01, 6);
    expect(activity.points[5]?.lon).toBeCloseTo(0.02, 6);
  });

  it('names several segments after the document, not the first of them', () => {
    expect(parse('multi-segment.kml').metadata.name).toBe('Three-part route');
  });

  it('declines point placemarks and says so, rather than drawing or dropping them silently', () => {
    const activity = parse('multi-segment.kml');

    const warning = activity.warnings.find((entry) => entry.code === 'kml_points_not_read');
    // The café placemark and the point inside the MultiGeometry.
    expect(warning).toMatchObject({ severity: 'warning' });
    expect(warning?.message).toMatch(/^2 point placemarks were not read/);
    // Neither became a vertex of a route.
    expect(activity.points.some((point) => Math.abs((point.lat ?? 0) - 51.5025) < 1e-6)).toBe(false);
  });

  it('does not apply a placemark date to every vertex', () => {
    const activity = parse('multi-segment.kml');

    expect(activity.streams.hasTime).toBe(false);
    expect(activity.warnings).toContainEqual(
      expect.objectContaining({ code: 'kml_placemark_time_ignored', severity: 'info' }),
    );
  });
});

describe('parseKml (AV-761): what is refused and what is reported', () => {
  it('reads the route out of a file full of features it does not support', () => {
    const activity = parse('unsupported-features.kml');

    expect(activity.points).toHaveLength(3);
    expect(activity.metadata.name).toBe('The actual route');
    expect(activity.metadata.description).toBe('Three points by the park.');
  });

  it('names every unsupported feature once, as a warning the viewer lists', () => {
    const activity = parse('unsupported-features.kml');

    const unsupported = activity.warnings.find((entry) => entry.code === 'kml_unsupported_features');
    expect(unsupported?.severity).toBe('warning');
    expect(unsupported?.message).toContain('1 polygon');
    expect(unsupported?.message).toContain('1 image overlay');
    expect(unsupported?.message).toContain('1 3D model');
    expect(unsupported?.message).toContain('1 tour');
    expect(unsupported?.message).toContain('1 network link');

    const links = activity.warnings.find((entry) => entry.code === 'kml_external_links_not_fetched');
    // The icon, the network link, the overlay image and the model: four hrefs.
    expect(links?.message).toMatch(/4 external resources/);
    // ...and no URL from the file is repeated into the warning.
    expect(links?.message).not.toContain('example.invalid');
  });

  it('never requests a URL it finds in the file', () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error('network access is not allowed during parsing'));
    }) as typeof fetch;
    XMLHttpRequest.prototype.open = function (...args: unknown[]) {
      calls.push(args);
      throw new Error('network access is not allowed during parsing');
    } as typeof XMLHttpRequest.prototype.open;

    try {
      parse('unsupported-features.kml');
    } finally {
      globalThis.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
    }

    expect(calls).toEqual([]);
    // Nothing in the description made it into the document as an element.
    expect(document.querySelector('script[src*="example.invalid"], iframe')).toBeNull();
  });

  it('skips coordinates that are not a place, and counts them', () => {
    const activity = parse('invalid-coordinates.kml');

    // The LineString: three of eight tuples survive. NaN altitude keeps the
    // position and drops the altitude; 0,0 is Null Island; 91 is past the pole.
    const line = activity.points.filter((point) => point.segmentIndex === 0);
    expect(line).toHaveLength(3);
    expect(line[0]?.elevationMeters).toBe(10);
    expect(line[1]?.elevationMeters).toBeUndefined();
    expect(line[1]?.lat).toBeCloseTo(51.501, 6);

    const invalid = activity.warnings.find((entry) => entry.code === 'kml_invalid_coordinates');
    expect(invalid?.severity).toBe('warning');
    // Five bad tuples on the line, one unpaired <when> on the track.
    expect(invalid?.message).toMatch(/^6 coordinates/);
  });

  it('keeps the pairs of a mismatched track that line up, and warns about the rest', () => {
    const activity = parse('invalid-coordinates.kml');

    const track = activity.points.filter((point) => point.segmentIndex === 1);
    // Four <when>, three <gx:coord>: three pairs. The empty coord keeps its
    // time and has no position.
    expect(track).toHaveLength(3);
    expect(track[1]?.time?.toISOString()).toBe('2024-03-02T08:00:30.000Z');
    expect(track[1]?.lat).toBeUndefined();
    expect(track[0]?.heartRateBpm).toBe(120);
    expect(track[2]?.heartRateBpm).toBeUndefined();

    expect(codes('invalid-coordinates.kml')).toEqual(
      expect.arrayContaining(['kml_track_count_mismatch', 'kml_sensor_count_mismatch']),
    );
  });

  it('refuses a DTD before the parser can expand it', () => {
    expect(() => parse('dtd-entity.kml')).toThrow(ActivityError);
    expect(() => parse('dtd-entity.kml')).toThrow(
      expect.objectContaining({ code: 'invalid_kml_xml', message: expect.stringMatching(/DTD/) }),
    );
  });

  it('refuses malformed XML, an empty string, and a non-KML root', () => {
    expect(() => parse('malformed.kml')).toThrow(
      expect.objectContaining({ code: 'invalid_kml_xml' }),
    );
    expect(() => parseKml('')).toThrow(expect.objectContaining({ code: 'invalid_kml_xml' }));
    expect(() => parseKml(readFixture('simple-route.gpx'))).toThrow(
      expect.objectContaining({ code: 'invalid_kml_xml', message: expect.stringMatching(/<kml>/) }),
    );
  });

  it('says when folders nested too deep hid part of the route, rather than drawing less', () => {
    const deep = 40;
    const buried =
      '<Folder>'.repeat(deep) +
      '<Placemark><name>Buried</name><LineString><coordinates>0.01,51.6 0.02,51.6</coordinates></LineString></Placemark>' +
      '</Folder>'.repeat(deep);
    const xml = readFixture('route-linestring.kml').replace('</Document>', `${buried}</Document>`);

    const activity = parseKml(xml);

    expect(activity.points.every((point) => point.segmentIndex === 0)).toBe(true);
    expect(activity.warnings).toContainEqual(
      expect.objectContaining({
        code: 'kml_nesting_too_deep',
        severity: 'warning',
        message: expect.stringMatching(/1 folder nested more than 32 levels deep, holding 1 placemark/),
      }),
    );
  });

  it('turns away a file whose only route is nested too deep, and says so', () => {
    const deep = 40;
    const xml = readFixture('route-linestring.kml').replace(
      /<Placemark>.*<\/Placemark>/s,
      (placemark) => '<Folder>'.repeat(deep) + placemark + '</Folder>'.repeat(deep),
    );

    expect(() => parseKml(xml)).toThrow(
      expect.objectContaining({
        code: 'no_route_points',
        message: expect.stringMatching(/nested more than 32 levels deep/),
      }),
    );
  });

  it('turns away a file with no route, naming what it held instead', () => {
    expect(() => parse('no-route.kml')).toThrow(
      expect.objectContaining({
        code: 'no_route_points',
        message: expect.stringMatching(/2 point placemarks, 1 polygon and 2 unreadable coordinates/),
      }),
    );
  });

  it('reads a legacy or unprefixed document, noting an unfamiliar namespace', () => {
    const legacy = readFixture('route-linestring.kml').replace(
      'http://www.opengis.net/kml/2.2',
      'http://example.invalid/kml/9.9',
    );
    const activity = parseKml(legacy);

    expect(activity.points).toHaveLength(5);
    expect(activity.warnings).toContainEqual(
      expect.objectContaining({ code: 'kml_unknown_namespace', severity: 'info' }),
    );

    const bare = readFixture('route-linestring.kml').replace(
      ' xmlns="http://www.opengis.net/kml/2.2"',
      '',
    );
    expect(parseKml(bare).points).toHaveLength(5);
  });

  it('cuts an overlong description to a label', () => {
    const long = readFixture('route-linestring.kml').replace(
      /<description>.*<\/description>/s,
      `<description>${'word '.repeat(300)}</description>`,
    );

    const { description } = parseKml(long).metadata;
    expect(description?.length).toBeLessThanOrEqual(500);
    expect(description?.endsWith('…')).toBe(true);
  });
});
