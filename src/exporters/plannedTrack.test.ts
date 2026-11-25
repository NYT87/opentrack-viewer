import { describe, expect, it } from 'vitest';
import {
  addPoint,
  appendImportedRoute,
  createBlankDraft,
  draftFromActivity,
  splitBefore,
  type RouteDraft,
} from '../domain/routeDraft';
import { parseActivityFile } from '../parsers';
import { makeActivity } from '../test/helpers/activity';
import {
  exportPlannedTrack,
  hasExportableRoute,
  plannedTrackFileStem,
  plannedTrackFormats,
} from './plannedTrack';

const T0 = Date.parse('2024-06-01T08:00:00Z');

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** A recorded ride with times, heart rate and power: a draft copied from it carries none of those. */
const recordedRide = () =>
  makeActivity(
    Array.from({ length: 6 }, (_, i) => ({
      lat: 43 + i * 0.001,
      lon: -8 + (i % 2) * 0.0005,
      elevationMeters: 100 + i,
      time: new Date(T0 + i * 10_000),
      heartRateBpm: 140 + i,
      powerWatts: 200 + i,
    })),
  );

const planned = (): RouteDraft => unwrap(draftFromActivity(recordedRide(), { name: 'Sunday loop', id: 'd1' }));

describe('what a planned track can be written to (AV-1107)', () => {
  it('is a route only once some stretch has two points', () => {
    let draft = createBlankDraft({ id: 'b' });
    expect(hasExportableRoute(draft)).toBe(false);
    draft = unwrap(addPoint(draft, { lat: 1, lon: 1 }));
    expect(hasExportableRoute(draft)).toBe(false);
    draft = unwrap(addPoint(draft, { lat: 1.001, lon: 1 }));
    expect(hasExportableRoute(draft)).toBe(true);
    // Two points in separate stretches are two dots, not a line.
    expect(hasExportableRoute(unwrap(splitBefore(draft, 'p1')))).toBe(false);
  });

  it('offers GPX, and lists FIT and TCX as unavailable with why', () => {
    const formats = plannedTrackFormats(planned());
    expect(formats.map((f) => [f.format, f.available])).toEqual([
      ['gpx', true],
      ['fit', false],
      ['tcx', false],
    ]);
    expect(formats.find((f) => f.format === 'fit')!.reason).toMatch(/recorded activity.*invented times/);
    expect(formats.find((f) => f.format === 'tcx')!.reason).toMatch(/recorded activity.*invented times/);
  });

  it('makes GPX unavailable too, with a reason, when the draft is not a route', () => {
    const one = unwrap(addPoint(createBlankDraft({ id: 'one' }), { lat: 1, lon: 1 }));
    expect(plannedTrackFormats(one).find((f) => f.format === 'gpx')).toMatchObject({
      available: false,
      reason: /two joined points/,
    });
  });

  it('refuses, with a typed error, exactly what it does not offer', async () => {
    await expect(exportPlannedTrack(planned(), 'fit')).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(exportPlannedTrack(planned(), 'tcx')).rejects.toMatchObject({ code: 'unsupported_format' });
    const one = unwrap(addPoint(createBlankDraft({ id: 'one' }), { lat: 1, lon: 1 }));
    await expect(exportPlannedTrack(one, 'gpx')).rejects.toMatchObject({ code: 'no_route_points' });
  });
});

describe('the planned GPX (AV-1107)', () => {
  it('is named as a planned track, from the draft’s name, safely', async () => {
    const result = await exportPlannedTrack(planned(), 'gpx');
    expect(result.fileName).toBe('Sunday-loop-planned-track.gpx');
    expect(result.mimeType).toBe('application/gpx+xml');
    const odd = { ...planned(), name: '../../etc/passwd: route?' };
    expect(plannedTrackFileStem(odd)).toBe('etc-passwd-route-planned-track');
    expect(plannedTrackFileStem({ ...planned(), name: '   ' })).toBe('route-planned-track');
  });

  it('writes places only: no times, no heart rate, no power, no device', async () => {
    const xml = await (await exportPlannedTrack(planned(), 'gpx')).blob.text();
    expect(xml).toContain('<trkpt lat="43.0000000" lon="-8.0000000">');
    expect(xml).toContain('<ele>100</ele>');
    expect(xml).not.toContain('<time>');
    // The writer always declares its extension namespaces; what matters is that no element uses them.
    expect(xml).not.toMatch(/<gpxtpx:|<gpxpx:|<extensions>/);
    expect(xml).toContain('<name>Sunday loop</name>');
  });

  it('says what it left out, and why', async () => {
    const { warnings } = await exportPlannedTrack(planned(), 'gpx');
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('planned_activity_data_omitted');
    expect(codes).toContain('planned_timestamps_omitted');
    expect(warnings.find((w) => w.code === 'planned_activity_data_omitted')!.message).toMatch(
      /Heart rate.*power.*laps.*recording device/,
    );
    expect(warnings.find((w) => w.code === 'planned_timestamps_omitted')!.message).toMatch(/recorded along the source/);
    // A single stretch gets no segment warning.
    expect(codes).not.toContain('planned_multiple_segments');
  });

  it('says a hand-drawn track has no times, without claiming anything was dropped', async () => {
    let draft = unwrap(addPoint(createBlankDraft({ id: 'h', name: 'Hand drawn' }), { lat: 1, lon: 1 }));
    draft = unwrap(addPoint(draft, { lat: 1.001, lon: 1 }));
    const { warnings } = await exportPlannedTrack(draft, 'gpx');
    expect(warnings.map((w) => w.code)).not.toContain('planned_activity_data_omitted');
    expect(warnings.find((w) => w.code === 'planned_timestamps_omitted')!.message).toBe(
      'The file has no timestamps: a planned track says where to go, not when.',
    );
  });

  it('writes one segment per stretch, and warns that devices may not treat them alike', async () => {
    const two = unwrap(
      appendImportedRoute(planned(), makeActivity([{ lat: 44, lon: -8 }, { lat: 44.001, lon: -8 }])),
    );
    const result = await exportPlannedTrack(two, 'gpx');
    const xml = await result.blob.text();
    expect(xml.match(/<trkseg>/g)).toHaveLength(2);
    expect(result.warnings.find((w) => w.code === 'planned_multiple_segments')!.message).toMatch(/2 separate track segments/);
  });

  it('re-imports through the viewer’s own intake as the same route, in order', async () => {
    const draft = planned();
    const result = await exportPlannedTrack(draft, 'gpx');
    const file = new File([await result.blob.text()], result.fileName, { type: 'application/gpx+xml' });

    const { activity } = await parseActivityFile(file);

    expect(activity.source.format).toBe('gpx');
    expect(activity.points.map((p) => [p.lat, p.lon, p.elevationMeters])).toEqual(
      draft.points.map((p) => [p.lat, p.lon, p.elevationMeters]),
    );
    expect(activity.points.every((p) => p.time === undefined)).toBe(true);
    expect(activity.metadata.name).toBe('Sunday loop');
  });

  it('leaves the draft as it was', async () => {
    const draft = planned();
    const before = JSON.stringify(draft);
    await exportPlannedTrack(draft, 'gpx');
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe('stretches whose numbers come back (AV-1107, review R1-C1)', () => {
  const withRuns = (segments: number[]): RouteDraft => ({
    ...createBlankDraft({ id: 'runs', name: 'Runs' }),
    points: segments.map((segmentIndex, i) => ({
      id: `p${i}`,
      lat: 43 + i * 0.001,
      lon: -8,
      segmentIndex,
      origin: { kind: 'manual' as const },
    })),
    counters: { point: segments.length, source: 0 },
  });

  it('is not a route when every stretch is a single point, whatever the numbers', () => {
    expect(hasExportableRoute(withRuns([0, 1, 0]))).toBe(false);
    expect(plannedTrackFormats(withRuns([0, 1, 0])).find((f) => f.format === 'gpx')!.available).toBe(false);
    expect(hasExportableRoute(withRuns([0, 1, 1, 0]))).toBe(true);
  });

  it('counts stretches as the writer writes them, and says the same number', async () => {
    const draft = withRuns([0, 0, 1, 1, 0, 0]);
    const result = await exportPlannedTrack(draft, 'gpx');
    const xml = await result.blob.text();
    expect(xml.match(/<trkseg>/g)).toHaveLength(3);
    expect(result.warnings.find((w) => w.code === 'planned_multiple_segments')!.message).toMatch(
      /3 separate track segments/,
    );
  });
});

describe('points the writer drops (AV-1107, review)', () => {
  /** A draft holding 0°, 0° as a handed-over or older draft could; the editor refuses it. */
  const withPlaces = (places: [number, number][]): RouteDraft => ({
    ...createBlankDraft({ id: 'null', name: 'Null island' }),
    points: places.map(([lat, lon], i) => ({ id: `p${i}`, lat, lon, segmentIndex: 0, origin: { kind: 'manual' as const } })),
    counters: { point: places.length, source: 0 },
  });

  it('is not a route when only one point is one the writer keeps', async () => {
    const draft = withPlaces([[0, 0], [1, 1]]);
    expect(hasExportableRoute(draft)).toBe(false);
    expect(plannedTrackFormats(draft).find((f) => f.format === 'gpx')!.available).toBe(false);
    await expect(exportPlannedTrack(draft, 'gpx')).rejects.toMatchObject({ code: 'no_route_points' });
  });

  it('is not a route when every point is 0°, 0°', async () => {
    const draft = withPlaces([[0, 0], [0, 0]]);
    expect(hasExportableRoute(draft)).toBe(false);
    await expect(exportPlannedTrack(draft, 'gpx')).rejects.toMatchObject({ code: 'no_route_points' });
  });

  it('writes the rest when enough remains, and says what it left out', async () => {
    const result = await exportPlannedTrack(withPlaces([[1, 1], [0, 0], [1.001, 1]]), 'gpx');
    const xml = await result.blob.text();
    expect(xml.match(/<trkpt /g)).toHaveLength(2);
    expect(result.warnings.find((w) => w.code === 'planned_points_without_location')!.message).toMatch(
      /^1 point at 0°, 0° was left out/,
    );
  });
});
