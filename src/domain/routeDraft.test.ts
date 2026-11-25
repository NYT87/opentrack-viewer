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
import { addPoint, appendJump, FAR_APPEND_METERS, beginsStretch, stretchLengths, discardSection, joinBefore, movePoint, removePoint, sectionBounds, splitBefore, validatePlace, type DraftPoint } from './routeDraft';

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

describe('editing by hand (AV-1104)', () => {
  const base = () => unwrap(draftFromActivity(recording(), { id: 'd' }));

  it('refuses a place that is not on the planet, and says which part', () => {
    expect(validatePlace({ lat: 91, lon: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_point', message: /Latitude/ } });
    expect(validatePlace({ lat: 0, lon: -181 })).toMatchObject({ ok: false, error: { code: 'invalid_point', message: /Longitude/ } });
    expect(validatePlace({ lat: Number.NaN, lon: 0 }).ok).toBe(false);
    expect(validatePlace({ lat: 0, lon: 0, elevationMeters: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validatePlace({ lat: -90, lon: 180, elevationMeters: -5 })).toMatchObject({ ok: true, value: { lat: -90, lon: 180, elevationMeters: -5 } });
  });

  it('adds a point at the end, in the last stretch, marked as the reader’s own', () => {
    const draft = deepFreeze(base());
    const next = unwrap(addPoint(draft, { lat: 10.5, lon: 20.5, elevationMeters: 30 }));
    const added = next.points[next.points.length - 1]!;
    expect(added).toMatchObject({ lat: 10.5, lon: 20.5, elevationMeters: 30, origin: { kind: 'manual' }, edit: { kind: 'added' } });
    expect(added.segmentIndex).toBe(draft.points[draft.points.length - 1]!.segmentIndex);
    expect(added.id).toBe(`p${draft.counters.point}`);
    expect(next.counters.point).toBe(draft.counters.point + 1);
    expect(next.points.length).toBe(draft.points.length + 1);
    // Untouched points are the same objects; the draft given is as it was.
    expect(next.points[0]).toBe(draft.points[0]);
    expect(draft.points.length).toBe(base().points.length);
  });

  it('starts an empty draft’s first stretch with its first point', () => {
    const next = unwrap(addPoint(createBlankDraft({ id: 'b' }), { lat: 1, lon: 2 }));
    expect(next.points).toHaveLength(1);
    expect(next.points[0]).toMatchObject({ id: 'p0', segmentIndex: 0 });
  });

  it('adds a point after a chosen one, joining that point’s stretch', () => {
    const draft = base();
    const anchor = draft.points[1]!;
    const next = unwrap(addPoint(draft, { lat: 10.1, lon: 20.1 }, { afterId: anchor.id }));
    expect(next.points[2]).toMatchObject({ lat: 10.1, segmentIndex: anchor.segmentIndex });
    expect(next.points[1]).toBe(anchor);
    expect(addPoint(draft, { lat: 1, lon: 1 }, { afterId: 'nope' })).toMatchObject({ ok: false, error: { code: 'unknown_point' } });
  });

  it('refuses an invalid place and changes nothing', () => {
    const draft = deepFreeze(base());
    const refused = addPoint(draft, { lat: 100, lon: 0 });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_point' } });
    expect(draft.points.length).toBe(base().points.length);
  });

  it('removes a point, leaving its neighbours in their stretches', () => {
    const draft = deepFreeze(base());
    const gone = draft.points[2]!;
    const next = unwrap(removePoint(draft, gone.id));
    expect(next.points.map((p) => p.id)).not.toContain(gone.id);
    expect(next.points.length).toBe(draft.points.length - 1);
    expect(next.points[1]).toBe(draft.points[1]);
    expect(next.points[2]).toBe(draft.points[3]);
    expect(removePoint(draft, 'nope')).toMatchObject({ ok: false, error: { code: 'unknown_point' } });
  });

  it('moves a point and remembers where the source had it, once', () => {
    const draft = deepFreeze(base());
    const target = draft.points[1]!;
    const once = unwrap(movePoint(draft, target.id, { lat: 11, lon: 21 }));
    expect(once.points[1]).toMatchObject({ id: target.id, lat: 11, lon: 21, edit: { kind: 'moved', fromLat: target.lat, fromLon: target.lon } });
    // Origin, elevation and time are kept: it is the same point, elsewhere.
    expect(once.points[1]!.origin).toEqual(target.origin);
    expect(once.points[1]!.elevationMeters).toBe(target.elevationMeters);

    const twice = unwrap(movePoint(once, target.id, { lat: 12, lon: 22 }));
    expect(twice.points[1]!.edit).toEqual({ kind: 'moved', fromLat: target.lat, fromLon: target.lon });
    expect(draft.points[1]!.lat).toBe(target.lat);
  });

  it('keeps an added point marked as added when it is moved', () => {
    const withAdded = unwrap(addPoint(base(), { lat: 1, lon: 1 }));
    const added = withAdded.points[withAdded.points.length - 1]!;
    const moved = unwrap(movePoint(withAdded, added.id, { lat: 2, lon: 2 }));
    expect(moved.points[moved.points.length - 1]!.edit).toEqual({ kind: 'added' });
  });

  it('refuses to move to an invalid place or an unknown point', () => {
    const draft = base();
    expect(movePoint(draft, draft.points[0]!.id, { lat: 0, lon: 200 })).toMatchObject({ ok: false, error: { code: 'invalid_point' } });
    expect(movePoint(draft, 'nope', { lat: 1, lon: 1 })).toMatchObject({ ok: false, error: { code: 'unknown_point' } });
  });

  it('feeds edits straight into the generated activity', () => {
    const edited = unwrap(addPoint(unwrap(removePoint(base(), 'p0')), { lat: 10.5, lon: 20.5 }));
    const activity = unwrap(draftToActivity(edited));
    expect(activity.points.length).toBe(edited.points.length);
    expect(activity.points[activity.points.length - 1]).toMatchObject({ lat: 10.5, lon: 20.5 });
  });
});

describe('discarding a section (AV-1105)', () => {
  // Ten points in one stretch, p0..p9 along a line.
  const line = () => {
    let draft = createBlankDraft({ id: 'line' });
    for (let i = 0; i < 10; i += 1) draft = unwrap(addPoint(draft, { lat: 10 + i * 0.001, lon: 20 }));
    return draft;
  };
  const ids = (draft: RouteDraft) => draft.points.map((p) => p.id);
  const segments = (draft: RouteDraft) => draft.points.map((p) => p.segmentIndex ?? 0);

  it('reads a section the same way whichever end was given first', () => {
    const draft = line();
    expect(unwrap(sectionBounds(draft, { fromId: 'p2', toId: 'p5' }))).toEqual({ start: 2, end: 5 });
    expect(unwrap(sectionBounds(draft, { fromId: 'p5', toId: 'p2' }))).toEqual({ start: 2, end: 5 });
    expect(unwrap(sectionBounds(draft, { fromId: 'p4', toId: 'p4' }))).toEqual({ start: 4, end: 4 });
    expect(sectionBounds(draft, { fromId: 'p4', toId: 'nope' })).toMatchObject({ ok: false, error: { code: 'unknown_point' } });
  });

  it('takes a middle section out and joins the road either side, forward or reverse', () => {
    const draft = deepFreeze(line());
    const forward = unwrap(discardSection(draft, { fromId: 'p3', toId: 'p6' }));
    const reverse = unwrap(discardSection(draft, { fromId: 'p6', toId: 'p3' }));
    expect(ids(forward)).toEqual(['p0', 'p1', 'p2', 'p7', 'p8', 'p9']);
    expect(ids(reverse)).toEqual(ids(forward));
    expect(new Set(segments(forward)).size).toBe(1);
    expect(forward.points[3]).toBe(draft.points[7]);
    expect(draft.points).toHaveLength(10);
  });

  it('keeps a gap when asked: what follows the cut starts a stretch of its own', () => {
    const gapped = unwrap(discardSection(line(), { fromId: 'p3', toId: 'p6' }, { keepGap: true }));
    expect(ids(gapped)).toEqual(['p0', 'p1', 'p2', 'p7', 'p8', 'p9']);
    expect(segments(gapped)).toEqual([0, 0, 0, 1, 1, 1]);
    // And the generated track counts no distance across the gap.
    const activity = unwrap(draftToActivity(gapped));
    const joined = unwrap(draftToActivity(unwrap(discardSection(line(), { fromId: 'p3', toId: 'p6' }))));
    expect(activity.derived!.distanceMeters!).toBeLessThan(joined.derived!.distanceMeters!);
  });

  it('discards from the start, from the end, the whole track, and a one-point track without crashing', () => {
    const draft = line();
    expect(ids(unwrap(discardSection(draft, { fromId: 'p0', toId: 'p2' })))).toEqual(['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
    expect(ids(unwrap(discardSection(draft, { fromId: 'p7', toId: 'p9' })))).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    const emptied = unwrap(discardSection(draft, { fromId: 'p0', toId: 'p9' }));
    expect(emptied.points).toEqual([]);
    expect(draftToActivity(emptied)).toMatchObject({ ok: false, error: { code: 'empty_draft' } });
    const one = unwrap(addPoint(createBlankDraft({ id: 'one' }), { lat: 1, lon: 1 }));
    expect(unwrap(discardSection(one, { fromId: 'p0', toId: 'p0' })).points).toEqual([]);
    // Edges with a gap asked for: nothing to split at an edge.
    expect(segments(unwrap(discardSection(draft, { fromId: 'p0', toId: 'p2' }, { keepGap: true })))).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('joins across a cut that straddled two stretches, and leaves later stretches alone', () => {
    // Three appended routes: p0-2 | p3-5 | p6-8, then p9 appended as a fourth.
    const draft = unwrap(
      draftFromImports([
        makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }, { lat: 10.002, lon: 20 }]),
        makeActivity([{ lat: 11, lon: 20 }, { lat: 11.001, lon: 20 }, { lat: 11.002, lon: 20 }]),
        makeActivity([{ lat: 12, lon: 20 }, { lat: 12.001, lon: 20 }, { lat: 12.002, lon: 20 }]),
        makeActivity([{ lat: 13, lon: 20 }]),
      ]),
    );
    expect(segments(draft)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3]);
    // Cut from inside the first route to inside the third: the remainder of
    // the third joins the first; the fourth stays its own.
    const cut = unwrap(discardSection(draft, { fromId: 'p1', toId: 'p7' }));
    expect(ids(cut)).toEqual(['p0', 'p8', 'p9']);
    expect(segments(cut)).toEqual([0, 0, 3]);
  });

  it('joins and splits stretches by hand, and says when there is nothing to do', () => {
    const draft = unwrap(
      draftFromImports([
        makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }]),
        makeActivity([{ lat: 11, lon: 20 }, { lat: 11.001, lon: 20 }]),
      ]),
    );
    expect(segments(draft)).toEqual([0, 0, 1, 1]);
    expect(beginsStretch(draft, 'p0')).toBe(true);
    expect(beginsStretch(draft, 'p1')).toBe(false);
    expect(beginsStretch(draft, 'p2')).toBe(true);

    const joined = unwrap(joinBefore(draft, 'p2'));
    expect(segments(joined)).toEqual([0, 0, 0, 0]);
    expect(joinBefore(joined, 'p2')).toMatchObject({ ok: false, error: { code: 'invalid_range', message: /already joined/ } });
    expect(joinBefore(draft, 'p0')).toMatchObject({ ok: false, error: { code: 'invalid_range' } });

    const split = unwrap(splitBefore(joined, 'p1'));
    expect(segments(split)).toEqual([0, 1, 1, 1]);
    expect(splitBefore(split, 'p1')).toMatchObject({ ok: false, error: { code: 'invalid_range', message: /already begins/ } });
    expect(splitBefore(draft, 'nope')).toMatchObject({ ok: false, error: { code: 'unknown_point' } });
    // Nothing given was changed.
    expect(segments(draft)).toEqual([0, 0, 1, 1]);
    expect(segments(joined)).toEqual([0, 0, 0, 0]);
  });

  it('splits only the run at the point, not a later run that reused the number', () => {
    // p0 p1 | p2 p3 | p4 p5, then join p4 to the previous: [0,0,1,1,1,1].
    let draft = unwrap(
      draftFromImports([
        makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }]),
        makeActivity([{ lat: 11, lon: 20 }, { lat: 11.001, lon: 20 }]),
        makeActivity([{ lat: 12, lon: 20 }, { lat: 12.001, lon: 20 }]),
      ]),
    );
    draft = unwrap(joinBefore(draft, 'p4'));
    expect(segments(draft)).toEqual([0, 0, 1, 1, 1, 1]);
    // Splitting at p3 gives p3..p5 the next free number, leaving p2 in stretch 1.
    expect(segments(unwrap(splitBefore(draft, 'p3')))).toEqual([0, 0, 1, 2, 2, 2]);
  });
});

describe('stretch repairs on a long track (AV-1105, review)', () => {
  it('splits and joins near the start of a 60,000-point stretch in one pass', () => {
    const points: DraftPoint[] = Array.from({ length: 60_000 }, (_, i) => ({
      id: `p${i}`,
      lat: 10 + i * 0.00001,
      lon: 20,
      segmentIndex: 0,
      origin: { kind: 'manual' },
    }));
    const draft: RouteDraft = { ...createBlankDraft({ id: 'long' }), points, counters: { point: points.length, source: 0 } };

    const started = performance.now();
    const split = unwrap(splitBefore(draft, 'p1'));
    const joined = unwrap(joinBefore(split, 'p1'));
    const gapped = unwrap(discardSection(draft, { fromId: 'p2', toId: 'p3' }, { keepGap: true }));
    const elapsed = performance.now() - started;

    expect(split.points[0]!.segmentIndex).toBe(0);
    expect(split.points[1]!.segmentIndex).toBe(1);
    expect(split.points[59_999]!.segmentIndex).toBe(1);
    expect(joined.points.every((point) => point.segmentIndex === 0)).toBe(true);
    expect(gapped.points[2]!.segmentIndex).toBe(1);
    expect(gapped.points[59_997]!.segmentIndex).toBe(1);
    // Three edits over 180,000 points: linear, so well under a second even on a loaded machine (quadratic was ~9 s per edit).
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('joining keeps the boundary after the joined run (AV-1105, review)', () => {
  it('does not also join a following stretch that happens to carry the target number', () => {
    // p0 p1 | p2 p3 | p4 p5 with runs numbered 0, 1, 0 — the shape a cut can leave.
    const points: DraftPoint[] = [0, 0, 1, 1, 0, 0].map((segmentIndex, i) => ({
      id: `p${i}`,
      lat: 10 + i,
      lon: 20,
      segmentIndex,
      origin: { kind: 'manual' },
    }));
    const draft: RouteDraft = { ...createBlankDraft({ id: 'runs' }), points, counters: { point: 6, source: 0 } };

    const joined = unwrap(joinBefore(draft, 'p2'));

    expect(joined.points.map((p) => p.segmentIndex)).toEqual([0, 0, 0, 0, 2, 2]);
    // p3 → p4 stays a break: no distance is counted across it.
    const before = unwrap(draftToActivity(draft)).derived!.distanceMeters!;
    const after = unwrap(draftToActivity(joined)).derived!.distanceMeters!;
    const p1p2 = haversineMeters(points[1]!.lat, points[1]!.lon, points[2]!.lat, points[2]!.lon);
    expect(after - before).toBeCloseTo(p1p2, 0);
    expect(draft.points.map((p) => p.segmentIndex)).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('keeps the same boundary when a discard joins across a cut', () => {
    // p0 p1 | p2 p3 p4 | p5 p6 numbered 0, 1, 0; discarding p2–p3 joins p4 to p1
    // and must leave p5 p6 as their own stretch.
    const points: DraftPoint[] = [0, 0, 1, 1, 1, 0, 0].map((segmentIndex, i) => ({
      id: `p${i}`,
      lat: 10 + i,
      lon: 20,
      segmentIndex,
      origin: { kind: 'manual' },
    }));
    const draft: RouteDraft = { ...createBlankDraft({ id: 'cut' }), points, counters: { point: 7, source: 0 } };
    const cut = unwrap(discardSection(draft, { fromId: 'p2', toId: 'p3' }));
    expect(cut.points.map((p) => [p.id, p.segmentIndex])).toEqual([['p0', 0], ['p1', 0], ['p4', 0], ['p5', 2], ['p6', 2]]);
  });
});

describe('the jump an append makes (AV-1106)', () => {
  const at = (lat: number) => makeActivity([{ lat, lon: 20 }, { lat: lat + 0.001, lon: 20 }]);

  it('measures from the end of the draft to the start of what was appended', () => {
    const first = unwrap(draftFromActivity(at(10)));
    const near = unwrap(appendImportedRoute(first, at(10.002)));
    const jump = appendJump(first, near)!;
    expect(jump.firstId).toBe(near.points[2]!.id);
    expect(jump.meters).toBeCloseTo(haversineMeters(10.001, 20, 10.002, 20), 3);
    expect(jump.far).toBe(false);

    const far = unwrap(appendImportedRoute(first, at(11)));
    expect(appendJump(first, far)).toMatchObject({ far: true });
    expect(appendJump(first, far)!.meters).toBeGreaterThan(FAR_APPEND_METERS);
  });

  it('keeps the appended points in their original order, after the draft’s, in a stretch of their own', () => {
    const first = unwrap(draftFromActivity(at(10)));
    const next = unwrap(appendImportedRoute(first, makeActivity([{ lat: 11, lon: 1 }, { lat: 11, lon: 2 }, { lat: 11, lon: 3 }])));
    expect(next.points.slice(2).map((p) => p.lon)).toEqual([1, 2, 3]);
    expect(next.points.slice(2).map((p) => p.origin)).toMatchObject([{ pointIndex: 0 }, { pointIndex: 1 }, { pointIndex: 2 }]);
    expect(beginsStretch(next, next.points[2]!.id)).toBe(true);
  });

  it('has no jump to measure from an empty draft', () => {
    const blank = createBlankDraft({ id: 'b' });
    expect(appendJump(blank, unwrap(appendImportedRoute(blank, at(10))))).toBeUndefined();
  });
});

describe('stretchLengths (AV-1107, review)', () => {
  const pts = (segments: (number | undefined)[]) =>
    segments.map((segmentIndex, i) => ({ id: `p${i}`, lat: 1, lon: 1, segmentIndex, origin: { kind: 'manual' as const } }));

  it('reads runs of adjacent points, so a number that comes back starts a new stretch', () => {
    expect(stretchLengths(pts([]))).toEqual([]);
    expect(stretchLengths(pts([0, 0, 0]))).toEqual([3]);
    expect(stretchLengths(pts([0, 1, 0]))).toEqual([1, 1, 1]);
    expect(stretchLengths(pts([0, 0, 1, 1, 0, 0]))).toEqual([2, 2, 2]);
    expect(stretchLengths(pts([undefined, 0, 2]))).toEqual([2, 1]);
  });
});

describe('0°, 0° is refused like the rest of the app refuses it (AV-1107, review)', () => {
  it('will not place a point the map and every writer would drop', () => {
    expect(validatePlace({ lat: 0, lon: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_point', message: /0, longitude 0/ } });
    expect(addPoint(createBlankDraft({ id: 'z' }), { lat: 0, lon: 0 })).toMatchObject({ ok: false });
    // Either one alone is a real place.
    expect(validatePlace({ lat: 0, lon: 1 }).ok).toBe(true);
    expect(validatePlace({ lat: 1, lon: 0 }).ok).toBe(true);
  });
});

describe('large drafts (AV-1108)', () => {
  it('edits, discards, appends and previews a 30,000-point draft without a quadratic step', () => {
    const recording = makeActivity(
      Array.from({ length: 15_000 }, (_, i) => ({ lat: 43 + i * 0.00001, lon: -8 + (i % 7) * 0.00001, elevationMeters: 100 })),
    );
    const started = performance.now();
    let draft = unwrap(draftFromActivity(recording));
    draft = unwrap(appendImportedRoute(draft, recording));
    expect(draft.points).toHaveLength(30_000);
    draft = unwrap(addPoint(draft, { lat: 44, lon: -8 }));
    draft = unwrap(movePoint(draft, 'p100', { lat: 43.5, lon: -8 }));
    draft = unwrap(removePoint(draft, 'p200'));
    draft = unwrap(discardSection(draft, { fromId: 'p1000', toId: 'p2000' }));
    draft = unwrap(joinBefore(draft, 'p15000'));
    draft = unwrap(splitBefore(draft, 'p20000'));
    const activity = unwrap(draftToActivity(draft));
    const elapsed = performance.now() - started;

    expect(activity.points).toHaveLength(30_000 + 1 - 1 - 1001);
    expect(stretchLengths(draft.points)).toHaveLength(2);
    // Linear work over 30,000 points, eight operations and one preview: three seconds
    // is a generous ceiling on a loaded machine; anything quadratic takes minutes.
    expect(elapsed).toBeLessThan(3_000);
  });
});
