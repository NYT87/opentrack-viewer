import { describe, expect, it } from 'vitest';
import {
  DRAFT_DROPPED_FIELDS,
  DRAFT_RETAINED_FIELDS,
  RouteDraftError,
  appendImportedRoute,
  createBlankDraft,
  draftFromActivity,
  draftFromImports,
  draftToActivity,
  type RouteDraft,
} from './routeDraft';
import { haversineMeters, withDerivedStats } from './stats';
import type { Activity } from './activity';
import { makeActivity } from '../test/helpers/activity';

const T0 = new Date('2024-06-01T08:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

/** A recording with every kind of data a draft is meant to drop, and some it keeps. */
function recording(): Activity {
  const base = makeActivity(
    Array.from({ length: 8 }, (_, i) => ({
      time: at(i),
      lat: 10 + i * 0.001,
      lon: 20 + i * 0.002,
      elevationMeters: 100 + i,
      distanceMeters: i * 50,
      heartRateBpm: 120 + i,
      powerWatts: 200 + i,
      runningCadenceSpm: 80,
      cyclingCadenceRpm: 90,
      temperatureCelsius: 15,
      speedMetersPerSecond: 5,
      gradePercent: 1,
      accuracyMeters: 3,
      segmentIndex: i < 4 ? 0 : 1,
      extensions: { vendor: { secret: i } },
    })),
  );
  return {
    ...base,
    id: 'rec-1',
    source: { format: 'gpx', fileName: 'morning-ride.gpx', parserVersion: 'test' },
    metadata: {
      name: 'Morning ride',
      sport: 'cycling',
      device: { manufacturer: 'Acme', serialNumber: 'SN-123' },
    },
    laps: [{ index: 1, distanceMeters: 100, caloriesKcal: 40 }],
    events: [{ type: 'lap', pointIndex: 3 }],
    sensorStreams: [
      { key: 'ACCL', label: 'Acceleration', display: 'chart', valuesByPoint: Array.from({ length: 8 }, () => 1) },
    ],
    warnings: [{ code: 'x', message: 'a warning', severity: 'warning' }],
  };
}

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as object).forEach(deepFreeze);
  }
  return value;
};

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: RouteDraftError }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe('createBlankDraft (AV-1101)', () => {
  it('is an empty planned track with a name and an id', () => {
    const draft = createBlankDraft({ id: 'd1' });
    expect(draft).toMatchObject({ id: 'd1', name: 'Planned track', kind: 'blank', points: [], sources: [] });
    expect(draft.dropped.unlocatedPoints).toBe(0);
  });

  it('takes a name, trimmed, and falls back when it is blank', () => {
    expect(createBlankDraft({ name: '  Sunday loop ' }).name).toBe('Sunday loop');
    expect(createBlankDraft({ name: '   ' }).name).toBe('Planned track');
  });

  it('makes a different id each time when none is given', () => {
    expect(createBlankDraft().id).not.toBe(createBlankDraft().id);
  });

  it('is refused as a track, with a reason, until it has points', () => {
    const result = draftToActivity(createBlankDraft({ id: 'd' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(RouteDraftError);
      expect(result.error.code).toBe('empty_draft');
    }
  });
});

describe('draftFromActivity (AV-1101)', () => {
  it('copies place, order, elevation, time and segment, with a note of where each point came from', () => {
    const activity = recording();
    const draft = unwrap(draftFromActivity(activity, { id: 'd' }));
    expect(draft.kind).toBe('copied');
    expect(draft.name).toBe('Morning ride');
    expect(draft.points).toHaveLength(8);
    draft.points.forEach((point, i) => {
      expect(point.lat).toBe(10 + i * 0.001);
      expect(point.lon).toBe(20 + i * 0.002);
      expect(point.elevationMeters).toBe(100 + i);
      expect(point.time).toEqual(at(i));
      expect(point.distanceMeters).toBe(i * 50);
      expect(point.segmentIndex).toBe(i < 4 ? 0 : 1);
      expect(point.origin).toEqual({ kind: 'activity', sourceId: 's0', pointIndex: i });
      expect(point.edit).toBeUndefined();
    });
    expect(draft.sources).toEqual([
      {
        id: 's0',
        role: 'copied',
        fileName: 'morning-ride.gpx',
        name: 'Morning ride',
        sourcePointCount: 8,
        usedPointCount: 8,
      },
    ]);
  });

  it('gives every point an id of its own', () => {
    const draft = unwrap(draftFromActivity(recording(), { id: 'd' }));
    expect(new Set(draft.points.map((point) => point.id)).size).toBe(8);
  });

  it('drops what describes the athlete and the device, by the documented policy', () => {
    const draft = unwrap(draftFromActivity(recording(), { id: 'd' }));
    const serialized = JSON.stringify(draft);
    for (const leaked of [
      'heartRateBpm',
      'powerWatts',
      'runningCadenceSpm',
      'cyclingCadenceRpm',
      'temperatureCelsius',
      'speedMetersPerSecond',
      'gradePercent',
      'accuracyMeters',
      'extensions',
      'vendor',
      'laps',
      'events',
      'sensorStreams',
      'ACCL',
      'serialNumber',
      'SN-123',
      'Acme',
      'a warning',
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    const point = draft.points[0]!;
    expect(Object.keys(point).sort()).toEqual(
      ['distanceMeters', 'elevationMeters', 'id', 'lat', 'lon', 'origin', 'segmentIndex', 'time'].sort(),
    );
  });

  it('states the policy it applies, and the two lists do not overlap', () => {
    expect(DRAFT_RETAINED_FIELDS).toEqual(expect.arrayContaining(['lat', 'lon', 'elevationMeters', 'time', 'segmentIndex']));
    expect(DRAFT_DROPPED_FIELDS).toEqual(expect.arrayContaining(['heartRateBpm', 'powerWatts', 'laps', 'metadata.device']));
    const retained = new Set(DRAFT_RETAINED_FIELDS.map((field) => field.split(' ')[0]));
    for (const field of DRAFT_DROPPED_FIELDS) expect(retained.has(field)).toBe(false);
  });

  it('leaves out points with no usable location, and counts them', () => {
    const activity = makeActivity([
      { lat: 10, lon: 20 },
      { elevationMeters: 5 },
      { lat: 99, lon: 20 },
      { lat: Number.NaN, lon: 20 },
      { lat: 10.001, lon: 20.001 },
    ]);
    const draft = unwrap(draftFromActivity(activity, { id: 'd' }));
    expect(draft.points.map((point) => point.origin)).toEqual([
      { kind: 'activity', sourceId: 's0', pointIndex: 0 },
      { kind: 'activity', sourceId: 's0', pointIndex: 4 },
    ]);
    expect(draft.dropped.unlocatedPoints).toBe(3);
    expect(draft.sources[0]).toMatchObject({ sourcePointCount: 5, usedPointCount: 2 });
  });

  it('copies a section by point index, as the viewer selects it', () => {
    const draft = unwrap(draftFromActivity(recording(), { id: 'd', range: { startIndex: 2, endIndex: 5 } }));
    expect(draft.points.map((point) => point.origin)).toEqual(
      [2, 3, 4, 5].map((pointIndex) => ({ kind: 'activity', sourceId: 's0', pointIndex })),
    );
    expect(draft.sources[0]!.range).toEqual({ startIndex: 2, endIndex: 5 });
    expect(draft.sources[0]!.sourcePointCount).toBe(4);
    // Segments are renumbered from zero for what was taken.
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 0, 1, 1]);
  });

  it.each([
    ['a reversed range', { startIndex: 5, endIndex: 2 }, 'invalid_range'],
    ['a fractional range', { startIndex: 1.5, endIndex: 3 }, 'invalid_range'],
    ['a range past the end', { startIndex: 50, endIndex: 60 }, 'no_route_points'],
  ] as const)('refuses %s', (_name, range, code) => {
    const result = draftFromActivity(recording(), { id: 'd', range });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('refuses an activity with no usable location at all, saying so', () => {
    const result = draftFromActivity(makeActivity([{ elevationMeters: 1 }, { elevationMeters: 2 }]), { id: 'd' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no_route_points');
      expect(result.error.message).toMatch(/usable location/);
    }
  });

  it('names the draft for the option, then the activity, then a default', () => {
    expect(unwrap(draftFromActivity(recording(), { name: 'Mine' })).name).toBe('Mine');
    const unnamed = { ...makeActivity([{ lat: 1, lon: 2 }]), metadata: {} };
    expect(unwrap(draftFromActivity(unnamed)).name).toBe('Planned track');
  });
});

describe('stretches with no location (AV-1101)', () => {
  const withGap = makeActivity([
    { lat: 10, lon: 20 },
    { elevationMeters: 1 },
    { lat: 11, lon: 20 },
  ]);

  it('starts a new segment after a dropped point, so no line or distance crosses it', () => {
    const draft = unwrap(draftFromActivity(withGap, { id: 'd' }));
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 1]);
    const activity = unwrap(draftToActivity(draft));
    expect(activity.derived!.distanceMeters).toBe(0);
  });

  it('counts one break for a run of dropped points, and none at the ends', () => {
    const activity = makeActivity([
      { elevationMeters: 1 },
      { lat: 10, lon: 20 },
      { lat: 10.001, lon: 20 },
      { lat: 99, lon: 20 },
      { elevationMeters: 2 },
      { lat: 10.002, lon: 20 },
      { lat: 10.003, lon: 20 },
      { elevationMeters: 3 },
    ]);
    const draft = unwrap(draftFromActivity(activity, { id: 'd' }));
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 0, 1, 1]);
    const leg = haversineMeters(10, 20, 10.001, 20);
    expect(unwrap(draftToActivity(draft)).derived!.distanceMeters).toBeCloseTo(2 * leg, 1);
  });

  it('keeps a recorded segment boundary and a gap distinct, in order', () => {
    const activity = makeActivity([
      { lat: 10, lon: 20, segmentIndex: 0 },
      { elevationMeters: 1, segmentIndex: 0 },
      { lat: 10.1, lon: 20, segmentIndex: 0 },
      { lat: 10.2, lon: 20, segmentIndex: 1 },
    ]);
    const draft = unwrap(draftFromActivity(activity, { id: 'd' }));
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 1, 2]);
  });

  it('does the same for an appended import, after the segments already there', () => {
    const first = unwrap(draftFromImports([makeActivity([{ lat: 5, lon: 5 }, { lat: 5.001, lon: 5 }])], { id: 'd' }));
    const more = unwrap(appendImportedRoute(first, withGap));
    expect(more.points.map((point) => point.segmentIndex)).toEqual([0, 0, 1, 2]);
  });

  it('keeps a draft with no unlocated points in one segment per recorded segment, as before', () => {
    const draft = unwrap(draftFromActivity(recording(), { id: 'd' }));
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});

describe('appending imported routes (AV-1101)', () => {
  const route = (lat0: number, count = 3, extra: object = {}) =>
    makeActivity(Array.from({ length: count }, (_, i) => ({ lat: lat0 + i * 0.001, lon: 20, ...extra })));

  it('adds the points after the ones already there, in order, with their own source', () => {
    const first = unwrap(appendImportedRoute(createBlankDraft({ id: 'd' }), route(10)));
    const second = unwrap(appendImportedRoute(first, route(11, 2)));
    expect(second.kind).toBe('appended');
    expect(second.points.map((point) => point.lat)).toEqual([10, 10.001, 10.002, 11, 11.001]);
    expect(second.points.map((point) => point.origin)).toEqual([
      { kind: 'import', sourceId: 's0', pointIndex: 0 },
      { kind: 'import', sourceId: 's0', pointIndex: 1 },
      { kind: 'import', sourceId: 's0', pointIndex: 2 },
      { kind: 'import', sourceId: 's1', pointIndex: 0 },
      { kind: 'import', sourceId: 's1', pointIndex: 1 },
    ]);
    expect(second.sources.map((source) => [source.id, source.role])).toEqual([
      ['s0', 'imported'],
      ['s1', 'imported'],
    ]);
    expect(new Set(second.points.map((point) => point.id)).size).toBe(5);
  });

  it('does not join the routes: each starts a segment of its own, so no line or distance crosses the jump', () => {
    const draft = unwrap(draftFromImports([route(10), route(11), route(12)], { id: 'd' }));
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    const activity = unwrap(draftToActivity(draft));
    // Three roughly 222 m legs of two steps each, and nothing for the 111 km jumps between them.
    const oneRoute = haversineMeters(10, 20, 10.002, 20);
    expect(activity.derived!.distanceMeters).toBeCloseTo(3 * oneRoute, 3);
  });

  it('keeps a copied draft its kind when something is appended to it', () => {
    const copied = unwrap(draftFromActivity(recording(), { id: 'd' }));
    const more = unwrap(appendImportedRoute(copied, route(30)));
    expect(more.kind).toBe('copied');
    expect(more.points).toHaveLength(11);
    // Past the copied recording's two segments.
    expect(more.points[8]!.segmentIndex).toBe(2);
  });

  it('appends a section of an import', () => {
    const draft = unwrap(appendImportedRoute(createBlankDraft({ id: 'd' }), route(10, 6), { range: { startIndex: 1, endIndex: 2 } }));
    expect(draft.points.map((point) => point.lat)).toEqual([10.001, 10.002]);
  });

  it('refuses an import with nothing usable, and leaves the draft as it was', () => {
    const draft = unwrap(appendImportedRoute(createBlankDraft({ id: 'd' }), route(10)));
    const result = appendImportedRoute(draft, makeActivity([{ elevationMeters: 2 }]));
    expect(result.ok).toBe(false);
    expect(draft.points).toHaveLength(3);
    expect(draft.sources).toHaveLength(1);
  });

  it('builds a draft from imports, and refuses none and the first that fails', () => {
    const none = draftFromImports([], { id: 'd' });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe('empty_draft');
    const bad = draftFromImports([route(10), makeActivity([{ elevationMeters: 1 }])]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('no_route_points');
  });

  it('counts the unlocated points of every source', () => {
    const withGaps = makeActivity([{ lat: 10, lon: 20 }, { elevationMeters: 1 }, { lat: 10.1, lon: 20 }]);
    const draft = unwrap(draftFromImports([withGaps, withGaps], { id: 'd' }));
    expect(draft.dropped.unlocatedPoints).toBe(2);
  });
});

describe('draftToActivity (AV-1101)', () => {
  const copy = () => unwrap(draftFromActivity(recording(), { id: 'd' }));

  it('makes a normalized, route-oriented activity numbered from zero in draft order', () => {
    const activity = unwrap(draftToActivity(copy()));
    expect(activity.points.map((point) => point.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(activity.points[3]).toMatchObject({ lat: 10.003, lon: 20.006, elevationMeters: 103, segmentIndex: 0 });
    expect(activity.points[3]!.time).toEqual(at(3));
    expect(activity.metadata.name).toBe('Morning ride');
    expect(activity.id).toBe('d');
    expect(activity.source.format).toBe('unknown');
    expect(activity.streams).toMatchObject({ hasLocation: true, hasElevation: true, hasTime: true, hasHeartRate: false, hasPower: false });
    expect(activity.laps).toBeUndefined();
    expect(activity.events).toBeUndefined();
    expect(activity.sensorStreams).toBeUndefined();
    expect(activity.metadata.device).toBeUndefined();
    expect(activity.source.fileName).toBeUndefined();
  });

  it('carries no recorded distance, so the totals come from the geometry, not a stale odometer', () => {
    const activity = unwrap(draftToActivity(copy()));
    expect(activity.points.every((point) => point.distanceMeters === undefined)).toBe(true);
    // 8 points, two segments of 4: three legs in each.
    const leg = haversineMeters(10, 20, 10.001, 20.002);
    // Legs differ by a centimetre or so with latitude; a stale odometer would be 150 m off.
    expect(activity.derived!.distanceMeters).toBeCloseTo(6 * leg, 1);
    expect(activity.derived!.pointCount).toBe(8);
    expect(activity.derived!.durationSeconds).toBe(7);
  });

  it('makes an activity of a draft with no clock or elevation', () => {
    const draft = unwrap(draftFromImports([makeActivity([{ lat: 1, lon: 2 }, { lat: 1.001, lon: 2 }])], { id: 'd' }));
    const activity = unwrap(draftToActivity(draft));
    expect(activity.streams.hasTime).toBe(false);
    expect(activity.streams.hasElevation).toBe(false);
    expect(activity.derived!.distanceMeters).toBeGreaterThan(100);
  });

  it('says in a warning when points were left out, and not otherwise', () => {
    const gappy = makeActivity([{ lat: 10, lon: 20 }, { elevationMeters: 1 }, { lat: 10.001, lon: 20 }]);
    const withGap = unwrap(draftToActivity(unwrap(draftFromActivity(gappy, { id: 'd' }))));
    expect(withGap.warnings.map((warning) => warning.code)).toContain('draft_unlocated_points_dropped');
    expect(withGap.warnings.find((w) => w.code === 'draft_unlocated_points_dropped')!.message).toMatch(/1 point without a location was left out/);
    const clean = unwrap(draftToActivity(copy()));
    expect(clean.warnings.map((warning) => warning.code)).not.toContain('draft_unlocated_points_dropped');
  });

  it('honours an id for the activity', () => {
    expect(unwrap(draftToActivity(copy(), { id: 'out' })).id).toBe('out');
  });

  it('shares nothing with the draft: a changed activity point does not reach the draft', () => {
    const draft = copy();
    const activity = unwrap(draftToActivity(draft));
    activity.points[0]!.lat = 0;
    activity.points[0]!.time!.setTime(0);
    expect(draft.points[0]!.lat).toBe(10);
    expect(draft.points[0]!.time).toEqual(at(0));
  });
});

describe('elevation totals of appended routes (AV-1101)', () => {
  const flat = (elevationMeters: number) =>
    makeActivity(Array.from({ length: 3 }, (_, i) => ({ lat: 10 + i * 0.001, lon: 20, elevationMeters })));

  it('does not count the height between two separate routes as climbed or descended', () => {
    const up = unwrap(draftToActivity(unwrap(draftFromImports([flat(100), flat(1000)], { id: 'd' }))));
    expect(up.derived!.elevationGainMeters).toBe(0);
    expect(up.derived!.elevationLossMeters).toBe(0);
    expect([up.derived!.minElevationMeters, up.derived!.maxElevationMeters]).toEqual([100, 1000]);

    const down = unwrap(draftToActivity(unwrap(draftFromImports([flat(1000), flat(100)], { id: 'd' }))));
    expect(down.derived!.elevationGainMeters).toBe(0);
    expect(down.derived!.elevationLossMeters).toBe(0);
  });
});

describe('immutability (AV-1101)', () => {
  it('never changes the activity it copies, appends or reads, and shares none of its objects', () => {
    const activity = deepFreeze(recording());
    const before = JSON.stringify(activity);
    const draft = unwrap(draftFromActivity(activity, { id: 'd' }));
    const more = unwrap(appendImportedRoute(draft, activity));
    unwrap(draftToActivity(more));
    expect(JSON.stringify(activity)).toBe(before);
    for (const point of more.points) {
      for (const source of activity.points) {
        expect(point).not.toBe(source);
        if (point.time && source.time) expect(point.time).not.toBe(source.time);
      }
    }
    // Mutating the draft's copy does not reach the original.
    draft.points[0]!.time!.setTime(0);
    expect(activity.points[0]!.time).toEqual(at(0));
  });

  it('does not change a draft it appends to or converts', () => {
    const draft: RouteDraft = deepFreeze(unwrap(draftFromActivity(recording(), { id: 'd' })));
    const before = JSON.stringify(draft);
    unwrap(appendImportedRoute(draft, makeActivity([{ lat: 50, lon: 5 }, { lat: 50.1, lon: 5 }])));
    unwrap(draftToActivity(draft));
    expect(JSON.stringify(draft)).toBe(before);
  });

  it('returns a new draft, with new arrays, from every operation', () => {
    const draft = unwrap(draftFromActivity(recording(), { id: 'd' }));
    const more = unwrap(appendImportedRoute(draft, makeActivity([{ lat: 50, lon: 5 }])));
    expect(more).not.toBe(draft);
    expect(more.points).not.toBe(draft.points);
    expect(more.sources).not.toBe(draft.sources);
    expect(more.counters).not.toBe(draft.counters);
    // Points that did not change are the same objects: a draft is cheap to keep many of.
    expect(more.points[0]).toBe(draft.points[0]);
  });

  it('is deterministic: the same inputs make the same draft', () => {
    const a = unwrap(draftFromActivity(recording(), { id: 'd' }));
    const b = unwrap(draftFromActivity(recording(), { id: 'd' }));
    expect(b).toEqual(a);
  });

  it('feeds the same derived-stats path as a parsed activity', () => {
    const activity = unwrap(draftToActivity(unwrap(draftFromActivity(recording(), { id: 'd' }))));
    expect(withDerivedStats({ ...activity, warnings: [] }).derived!.pointCount).toBe(8);
  });
});
