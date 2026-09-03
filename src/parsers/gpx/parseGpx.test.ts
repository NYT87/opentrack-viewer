import { describe, expect, it } from 'vitest';
import { parseGpx, GPX_PARSER_VERSION } from './parseGpx';
import { ActivityError } from '../../domain/errors';
import { readFixture } from '../../test/helpers/fixtures';

const parse = (fixture: string) =>
  parseGpx(readFixture(fixture), { fileName: fixture, idFactory: () => 'fixed-id' });

describe('parseGpx', () => {
  it('extracts track points with coordinates and time', () => {
    const activity = parse('simple-route.gpx');

    expect(activity.points).toHaveLength(4);
    expect(activity.points[0]).toMatchObject({ index: 0, lat: 51.5, lon: 0 });
    expect(activity.points[0]?.time?.toISOString()).toBe('2024-01-01T10:00:00.000Z');
    expect(activity.streams).toMatchObject({
      hasLocation: true,
      hasTime: true,
      hasElevation: false,
    });
  });

  it('records source metadata (AV-202)', () => {
    const activity = parse('simple-route.gpx');

    expect(activity.source).toEqual({
      format: 'gpx',
      fileName: 'simple-route.gpx',
      fileSizeBytes: undefined,
      parserVersion: GPX_PARSER_VERSION,
    });
    expect(activity.metadata.name).toBe('Simple Route');
    expect(activity.metadata.creator).toBe('OpenTrackViewerTestFixture');
    expect(activity.metadata.sport).toBe('running');
  });

  it('extracts elevation and Garmin sensor extensions', () => {
    const activity = parse('route-with-elevation.gpx');

    expect(activity.points.map((point) => point.elevationMeters)).toEqual([100, 110, 130, 105]);
    expect(activity.points.map((point) => point.heartRateBpm)).toEqual([120, 130, 150, 140]);
    expect(activity.points.map((point) => point.cadenceRpm)).toEqual([80, 82, 84, 78]);
    expect(activity.streams.hasHeartRate).toBe(true);
    expect(activity.streams.hasCadence).toBe(true);
  });

  it('populates derived stats and time metadata', () => {
    const activity = parse('route-with-elevation.gpx');

    expect(activity.derived?.pointCount).toBe(4);
    expect(activity.derived?.durationSeconds).toBe(180);
    expect(activity.metadata.startTime?.toISOString()).toBe('2024-01-01T10:00:00.000Z');
    expect(activity.metadata.endTime?.toISOString()).toBe('2024-01-01T10:03:00.000Z');
  });

  it('warns when optional streams are absent instead of failing', () => {
    const activity = parse('simple-route.gpx');
    const codes = activity.warnings.map((warning) => warning.code);

    expect(codes).toContain('no_elevation_data');
    expect(activity.points).toHaveLength(4);
  });

  it('rejects malformed XML as invalid_gpx_xml', () => {
    expect(() => parse('malformed.gpx')).toThrowError(ActivityError);
    try {
      parse('malformed.gpx');
    } catch (error) {
      expect((error as ActivityError).code).toBe('invalid_gpx_xml');
    }
  });

  it('rejects a non-GPX root element', () => {
    try {
      parseGpx('<kml><Document/></kml>');
      throw new Error('expected a parse failure');
    } catch (error) {
      expect((error as ActivityError).code).toBe('invalid_gpx_xml');
    }
  });

  it('rejects an empty document', () => {
    try {
      parseGpx('   ');
      throw new Error('expected a parse failure');
    } catch (error) {
      expect((error as ActivityError).code).toBe('invalid_gpx_xml');
    }
  });

  it('reports a track with no points as no_route_points', () => {
    try {
      parse('no-points.gpx');
      throw new Error('expected a parse failure');
    } catch (error) {
      expect((error as ActivityError).code).toBe('no_route_points');
    }
  });

  it('skips points with unusable coordinates and warns', () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
      <trkpt lat="51.5" lon="0.0"><ele>10</ele></trkpt>
      <trkpt lat="not-a-number" lon="0.0"><ele>11</ele></trkpt>
      <trkpt lat="51.6" lon="0.1"><ele>12</ele></trkpt>
    </trkseg></trk></gpx>`;

    const activity = parseGpx(xml);

    expect(activity.points).toHaveLength(3);
    expect(activity.points[1]?.lat).toBeUndefined();
    expect(activity.points[1]?.elevationMeters).toBe(11);
    expect(activity.warnings.map((warning) => warning.code)).toContain(
      'points_missing_coordinates',
    );
  });

  it('falls back to <rte>/<rtept> when no track is recorded', () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><rte>
      <rtept lat="51.5" lon="0.0"/><rtept lat="51.6" lon="0.1"/>
    </rte></gpx>`;

    const activity = parseGpx(xml);

    expect(activity.points).toHaveLength(2);
    expect(activity.warnings.map((warning) => warning.code)).toContain('route_instead_of_track');
  });

  it('reads every track in a multi-track file', () => {
    // Regression: only the first <trk> was read, silently discarding the rest.
    const activity = parse('multi-track.gpx');

    expect(activity.points).toHaveLength(5);
    expect(activity.points.map((point) => point.elevationMeters)).toEqual([
      100, 110, 120, 130, 140,
    ]);
    expect(activity.derived?.endTime?.toISOString()).toBe('2024-01-01T10:04:00.000Z');

    const codes = activity.warnings.map((warning) => warning.code);
    expect(codes).toContain('multiple_tracks');
    expect(codes).toContain('multiple_segments');
  });

  it('keeps segment identity on every point', () => {
    // Regression: segmentIndex was dropped during normalization, so distance
    // and the drawn route treated discontinuous segments as continuous.
    const activity = parse('multi-track.gpx');

    expect(activity.points.map((point) => point.segmentIndex)).toEqual([0, 0, 1, 1, 2]);
  });

  it('excludes a recording gap from the distance', () => {
    const activity = parse('paused-run.gpx');

    // Two 111 m legs; the ~5.5 km gap between them is not ground covered.
    expect(activity.derived?.distanceMeters).toBeCloseTo(222, 0);
  });

  it('takes activity metadata from the first track', () => {
    const activity = parse('multi-track.gpx');

    expect(activity.metadata.name).toBe('Leg One');
    expect(activity.metadata.sport).toBe('hiking');
  });

  it('reads every route when falling back to <rte>', () => {
    // Regression: only the first <rte> was read.
    const xml = `<?xml version="1.0"?><gpx version="1.1">
      <rte><rtept lat="51.5" lon="0.0"/><rtept lat="51.6" lon="0.1"/></rte>
      <rte><rtept lat="51.7" lon="0.2"/></rte>
    </gpx>`;

    const activity = parseGpx(xml);

    expect(activity.points).toHaveLength(3);
    const codes = activity.warnings.map((warning) => warning.code);
    expect(codes).toContain('route_instead_of_track');
    expect(codes).toContain('multiple_routes');
  });

  it('prefers tracks over routes when both are present', () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1">
      <trk><trkseg><trkpt lat="51.5" lon="0.0"/><trkpt lat="51.6" lon="0.1"/></trkseg></trk>
      <rte><rtept lat="40.0" lon="-3.0"/></rte>
    </gpx>`;

    const activity = parseGpx(xml);

    expect(activity.points).toHaveLength(2);
    expect(activity.points[0]?.lat).toBe(51.5);
    expect(activity.warnings.map((warning) => warning.code)).not.toContain(
      'route_instead_of_track',
    );
  });

  it('joins multiple track segments and notes it', () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><trk>
      <trkseg><trkpt lat="51.5" lon="0.0"/></trkseg>
      <trkseg><trkpt lat="51.6" lon="0.1"/></trkseg>
    </trk></gpx>`;

    const activity = parseGpx(xml);

    expect(activity.points.map((point) => point.index)).toEqual([0, 1]);
    expect(activity.warnings.map((warning) => warning.code)).toContain('multiple_segments');
  });
});
