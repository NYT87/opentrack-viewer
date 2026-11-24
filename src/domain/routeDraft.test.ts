import { describe, expect, it } from 'vitest';
import type { Activity, ActivityPoint } from './activity';
import { computeStreams } from './activity';
import {
  addPoint,
  appendActivity,
  canExportDraft,
  plannedFileBaseName,
  createBlankDraft,
  discardSection,
  draftDistanceMeters,
  draftFromActivity,
  draftToActivity,
  movePoint,
  nudgePoint,
  removePoint,
  type EditResult,
  type RouteDraft,
} from './routeDraft';

const point = (index: number, lat: number, lon: number, extra: Partial<ActivityPoint> = {}): ActivityPoint => ({
  index,
  lat,
  lon,
  ...extra,
});

const activityOf = (points: ActivityPoint[], fileName = 'ride.gpx'): Activity => ({
  id: 'a1',
  source: { format: 'gpx', fileName, parserVersion: 't' },
  metadata: { name: 'Morning ride', device: { name: 'Edge', serialNumber: '123456789' } },
  points,
  streams: computeStreams(points),
  warnings: [],
});

const ride = () =>
  activityOf([
    point(0, 42.0, -8.0, { elevationMeters: 10, heartRateBpm: 140, powerWatts: 200, time: new Date(0) }),
    point(1, 42.001, -8.0, { elevationMeters: 12, heartRateBpm: 150 }),
    point(2, 42.002, -8.0),
    point(3, 42.003, -8.0),
  ]);

const unwrap = (result: EditResult): RouteDraft => {
  if (!result.ok) throw new Error('expected ok');
  return result.draft;
};

describe('route draft (AV-1101)', () => {
  it('starts blank', () => {
    const draft = createBlankDraft();
    expect(draft.points).toEqual([]);
    expect(draft.origin.kind).toBe('blank');
  });

  it('copies an activity keeping only the route', () => {
    const draft = draftFromActivity(ride());
    expect(draft.points).toHaveLength(4);
    expect(draft.points[0]).toEqual({ lat: 42, lon: -8, elevationMeters: 10, segmentIndex: 0 });
    expect(JSON.stringify(draft)).not.toMatch(/heartRate|power|time|serial|Edge/);
    expect(draft.name).toBe('Morning ride');
  });

  it('drops points with no usable position and refuses an activity with none', () => {
    const draft = draftFromActivity(activityOf([point(0, 1, 1), { index: 1 }, point(2, 0, 0)]));
    expect(draft.points).toHaveLength(1);
    expect(() => draftFromActivity(activityOf([{ index: 0 }]))).toThrow(/no GPS/);
  });

  it('never mutates the source activity', () => {
    const source = ride();
    const snapshot = JSON.stringify(source);
    const draft = draftFromActivity(source);
    unwrap(addPoint(draft, { lat: 43, lon: -8 }));
    unwrap(removePoint(draft, 0));
    unwrap(discardSection(draft, 0, 1));
    appendActivity(draft, ride());
    draftToActivity(draft);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it('is not changed by its own operations', () => {
    const draft = draftFromActivity(ride());
    const before = JSON.stringify(draft);
    unwrap(addPoint(draft, { lat: 43, lon: -8 }));
    unwrap(movePoint(draft, 0, { lat: 44, lon: -8 }));
    expect(JSON.stringify(draft)).toBe(before);
  });

  describe('adding', () => {
    it('appends by default and inserts at a position', () => {
      const draft = draftFromActivity(ride());
      const end = unwrap(addPoint(draft, { lat: 43, lon: -8 }));
      expect(end.points.at(-1)?.lat).toBe(43);
      const start = unwrap(addPoint(draft, { lat: 41, lon: -8 }, { position: 0 }));
      expect(start.points[0]?.lat).toBe(41);
      const middle = unwrap(addPoint(draft, { lat: 42.0015, lon: -8 }, { position: 2 }));
      expect(middle.points.map((p) => p.lat)).toEqual([42, 42.001, 42.0015, 42.002, 42.003]);
    });

    it('builds a route from a blank draft', () => {
      let draft = createBlankDraft();
      draft = unwrap(addPoint(draft, { lat: 42, lon: -8 }));
      draft = unwrap(addPoint(draft, { lat: 42.001, lon: -8 }));
      expect(draft.points).toHaveLength(2);
      expect(draftDistanceMeters(draft)).toBeGreaterThan(100);
    });

    it('rejects invalid coordinates and positions', () => {
      const draft = createBlankDraft();
      for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 1 }, { lat: 0, lon: 0 }]) {
        expect(addPoint(draft, bad).ok).toBe(false);
      }
      expect(addPoint(draft, { lat: 1, lon: 1 }, { position: 5 }).ok).toBe(false);
    });
  });

  describe('removing and moving', () => {
    it('removes one point', () => {
      const draft = unwrap(removePoint(draftFromActivity(ride()), 1));
      expect(draft.points.map((p) => p.lat)).toEqual([42, 42.002, 42.003]);
    });

    it('rejects a point that is not there', () => {
      expect(removePoint(draftFromActivity(ride()), 9).ok).toBe(false);
      expect(removePoint(createBlankDraft(), 0).ok).toBe(false);
    });

    it('moves a point, dropping the elevation of the old place', () => {
      const draft = unwrap(movePoint(draftFromActivity(ride()), 0, { lat: 42.5, lon: -8.5 }));
      expect(draft.points[0]).toEqual({ lat: 42.5, lon: -8.5, segmentIndex: 0 });
      expect(movePoint(draftFromActivity(ride()), 0, { lat: 100, lon: 0 }).ok).toBe(false);
    });
  });

  describe('nudging', () => {
    it('steps a point by about the distance asked, in the direction asked', () => {
      const base = draftFromActivity(ride());
      const north = unwrap(nudgePoint(base, 1, 'north', 10));
      expect(north.points[1]!.lat).toBeGreaterThan(42.001);
      expect(north.points[1]!.lon).toBe(-8);
      const east = unwrap(nudgePoint(base, 1, 'east', 10));
      expect(east.points[1]!.lon).toBeGreaterThan(-8);
      expect(unwrap(nudgePoint(base, 1, 'south', 10)).points[1]!.lat).toBeLessThan(42.001);
      expect(unwrap(nudgePoint(base, 1, 'west', 10)).points[1]!.lon).toBeLessThan(-8);
    });

    it('rejects a missing point, and a step off the edge of the map', () => {
      expect(nudgePoint(draftFromActivity(ride()), 9, 'north', 10).ok).toBe(false);
      const edge = unwrap(addPoint(createBlankDraft(), { lat: 89.99999, lon: 10 }));
      expect(nudgePoint(edge, 0, 'north', 10_000).ok).toBe(false);
    });
  });

  describe('discarding a section', () => {
    const lats = (draft: RouteDraft) => draft.points.map((p) => p.lat);

    it('removes the middle and joins what remains', () => {
      const draft = unwrap(discardSection(draftFromActivity(ride()), 1, 2));
      expect(lats(draft)).toEqual([42, 42.003]);
      expect(new Set(draft.points.map((p) => p.segmentIndex)).size).toBe(1);
    });

    it('treats a reversed selection the same', () => {
      const forward = unwrap(discardSection(draftFromActivity(ride()), 1, 2));
      const reverse = unwrap(discardSection(draftFromActivity(ride()), 2, 1));
      expect(reverse).toEqual(forward);
    });

    it('handles the start, the end and everything', () => {
      const base = draftFromActivity(ride());
      expect(lats(unwrap(discardSection(base, 0, 1)))).toEqual([42.002, 42.003]);
      expect(lats(unwrap(discardSection(base, 2, 3)))).toEqual([42, 42.001]);
      expect(unwrap(discardSection(base, 0, 3)).points).toEqual([]);
    });

    it('handles a one-point route', () => {
      const one = unwrap(discardSection(draftFromActivity(ride()), 1, 3));
      expect(one.points).toHaveLength(1);
      expect(unwrap(discardSection(one, 0, 0)).points).toEqual([]);
    });

    it('can keep a gap instead of joining', () => {
      const draft = unwrap(discardSection(draftFromActivity(ride()), 1, 2, { keepGap: true }));
      expect(draft.points.map((p) => p.segmentIndex)).toEqual([0, 1]);
      expect(draftDistanceMeters(draft)).toBe(0);
    });

    it('rejects a section outside the route', () => {
      expect(discardSection(draftFromActivity(ride()), 2, 9).ok).toBe(false);
      expect(discardSection(draftFromActivity(ride()), -1, 1).ok).toBe(false);
    });

    it('shortens the distance', () => {
      const base = draftFromActivity(ride());
      const shorter = unwrap(discardSection(base, 3, 3));
      expect(draftDistanceMeters(shorter)).toBeLessThan(draftDistanceMeters(base));
    });
  });

  describe('appending', () => {
    const next = () => activityOf([point(0, 42.004, -8.0), point(1, 42.005, -8.0)], 'next.gpx');

    it('adds the route to the end in order', () => {
      const result = appendActivity(draftFromActivity(ride()), next());
      expect(result.draft.points.map((p) => p.lat)).toEqual([42, 42.001, 42.002, 42.003, 42.004, 42.005]);
      expect(result.farJoin).toBe(false);
      expect(result.gapMeters).toBeCloseTo(111, -1);
      expect(result.draft.origin).toEqual({ kind: 'appended', sources: ['ride.gpx', 'next.gpx'] });
    });

    it('flags a far join, and can break the line there', () => {
      const far = activityOf([point(0, 43, -8), point(1, 43.001, -8)], 'far.gpx');
      const joined = appendActivity(draftFromActivity(ride()), far);
      expect(joined.farJoin).toBe(true);
      const broken = appendActivity(draftFromActivity(ride()), far, { breakAtJoin: true });
      expect(broken.draft.points.at(-1)?.segmentIndex).toBe(1);
      expect(draftDistanceMeters(broken.draft)).toBeLessThan(draftDistanceMeters(joined.draft));
    });

    it('keeps the segment boundaries of what it appends', () => {
      const segmented = activityOf([
        point(0, 42.004, -8, { segmentIndex: 0 }),
        point(1, 42.005, -8, { segmentIndex: 1 }),
      ]);
      const draft = appendActivity(draftFromActivity(ride()), segmented).draft;
      expect(draft.points.slice(-2).map((p) => p.segmentIndex)).toEqual([0, 1]);
    });

    it('seeds a blank draft', () => {
      const result = appendActivity(createBlankDraft(), next());
      expect(result.draft.points).toHaveLength(2);
      expect(result.gapMeters).toBeUndefined();
      expect(result.farJoin).toBe(false);
    });

    it('refuses a file with no route', () => {
      expect(() => appendActivity(draftFromActivity(ride()), activityOf([{ index: 0 }]))).toThrow(/no route points/);
    });
  });

  describe('as an activity', () => {
    it('describes the draft for the map and the exporters', () => {
      const activity = draftToActivity(draftFromActivity(ride()));
      expect(activity.source.format).toBe('planned');
      expect(activity.points).toHaveLength(4);
      expect(activity.points.at(-1)?.distanceMeters).toBeCloseTo(333, -1);
      expect(activity.streams.hasLocation).toBe(true);
      expect(activity.streams.hasTime).toBe(false);
      expect(activity.streams.hasHeartRate).toBe(false);
      expect(activity.metadata.device).toBeUndefined();
      expect(activity.derived?.distanceMeters).toBeCloseTo(333, -1);
    });

    it('is an empty route for a blank draft', () => {
      const activity = draftToActivity(createBlankDraft());
      expect(activity.points).toEqual([]);
      expect(activity.streams.hasLocation).toBe(false);
    });
  });

  describe('large routes (AV-1108)', () => {
    const big = (count: number): RouteDraft => ({
      name: 'big',
      origin: { kind: 'blank' },
      points: Array.from({ length: count }, (_, i) => ({
        lat: 42 + i * 1e-6,
        lon: -8 + (i % 100) * 1e-6,
        segmentIndex: 0,
      })),
    });

    it('edits, appends and converts a 100,000-point route within a generous budget', () => {
      const draft = big(100_000);
      const started = performance.now();

      const added = unwrap(addPoint(draft, { lat: 43, lon: -8 }, { position: 50_000 }));
      const cut = unwrap(discardSection(added, 10_000, 60_000));
      const appended = appendActivity(
        cut,
        activityOf(Array.from({ length: 50_000 }, (_, i) => point(i, 44 + i * 1e-6, -8))),
      ).draft;
      const activity = draftToActivity(appended);
      const distance = draftDistanceMeters(appended);
      const elapsed = performance.now() - started;

      expect(appended.points).toHaveLength(100_001 - 50_001 + 50_000);
      expect(activity.points).toHaveLength(appended.points.length);
      expect(distance).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(5_000);
    });

    it('keeps old drafts valid for undo without copying their points', () => {
      const draft = big(100_000);
      const next = unwrap(movePoint(draft, 5, { lat: 50, lon: 50 }));
      expect(draft.points[5]!.lat).not.toBe(50);
      // Untouched points are shared, not duplicated.
      expect(next.points[6]).toBe(draft.points[6]);
    });
  });

  describe('export', () => {
    it('needs at least two points', () => {
      expect(canExportDraft(undefined)).toBe(false);
      expect(canExportDraft(createBlankDraft())).toBe(false);
      expect(canExportDraft(unwrap(addPoint(createBlankDraft(), { lat: 1, lon: 1 })))).toBe(false);
      expect(canExportDraft(draftFromActivity(ride()))).toBe(true);
    });

    it('names the file as a planned route, safely', () => {
      expect(plannedFileBaseName({ ...createBlankDraft(), name: 'Morning ride' })).toBe('morning-ride-planned-route');
      expect(plannedFileBaseName({ ...createBlankDraft(), name: 'Vuelta a Galicia: etapa 3 / ñandú' })).toBe(
        'vuelta-a-galicia-etapa-3-nandu-planned-route',
      );
      expect(plannedFileBaseName({ ...createBlankDraft(), name: '../../etc' })).toBe('etc-planned-route');
      expect(plannedFileBaseName({ ...createBlankDraft(), name: '***' })).toBe('planned-route');
    });
  });
});
