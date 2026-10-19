import { beforeEach, describe, expect, it } from 'vitest';
import { useRouteDraftStore } from './routeDraftStore';
import { createBlankDraft } from '../domain/routeDraft';
import { makeActivity } from '../test/helpers/activity';

const route = (lat: number) =>
  makeActivity([{ lat, lon: 20 }, { lat: lat + 0.001, lon: 20 }, { lat: lat + 0.002, lon: 20 }]);

beforeEach(() => useRouteDraftStore.getState().clear());

describe('the route draft store (AV-1102)', () => {
  it('starts with no draft', () => {
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
  });

  it('starts a blank draft, named if asked, replacing what was held', () => {
    useRouteDraftStore.getState().startBlank('Loop');
    const first = useRouteDraftStore.getState().draft!;
    expect(first).toMatchObject({ kind: 'blank', name: 'Loop', points: [] });
    useRouteDraftStore.getState().startBlank();
    expect(useRouteDraftStore.getState().draft).not.toBe(first);
    expect(useRouteDraftStore.getState().draft!.name).toBe('Planned track');
  });

  it('receives a handed-over draft as it is', () => {
    const handed = createBlankDraft({ id: 'handed', name: 'From the viewer' });
    useRouteDraftStore.getState().setDraft(handed);
    expect(useRouteDraftStore.getState().draft).toBe(handed);
  });

  it('begins a draft from the first imported track, and appends the next', () => {
    expect(useRouteDraftStore.getState().importTrack(route(10)).ok).toBe(true);
    expect(useRouteDraftStore.getState().draft!.kind).toBe('copied');
    expect(useRouteDraftStore.getState().importTrack(route(20)).ok).toBe(true);
    const draft = useRouteDraftStore.getState().draft!;
    expect(draft.points).toHaveLength(6);
    expect(draft.sources.map((source) => source.role)).toEqual(['copied', 'imported']);
    expect(draft.points.map((point) => point.segmentIndex)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('refuses a track with nothing usable, with the reason, and holds what it held', () => {
    const empty = useRouteDraftStore.getState().importTrack(makeActivity([{ elevationMeters: 1 }]));
    expect(empty.ok).toBe(false);
    expect(useRouteDraftStore.getState().draft).toBeUndefined();

    useRouteDraftStore.getState().importTrack(route(10));
    const held = useRouteDraftStore.getState().draft;
    const refused = useRouteDraftStore.getState().importTrack(makeActivity([{ elevationMeters: 1 }]));
    expect(refused.ok).toBe(false);
    expect(useRouteDraftStore.getState().draft).toBe(held);
  });

  it('clears', () => {
    useRouteDraftStore.getState().startBlank();
    useRouteDraftStore.getState().clear();
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
  });
});

describe('editing through the store (AV-1104)', () => {
  it('adds, moves and removes points of the held draft, returning each outcome', () => {
    useRouteDraftStore.getState().startBlank();
    const added = useRouteDraftStore.getState().addPoint({ lat: 10, lon: 20 });
    expect(added.ok).toBe(true);
    const id = useRouteDraftStore.getState().draft!.points[0]!.id;

    expect(useRouteDraftStore.getState().movePoint(id, { lat: 11, lon: 21 }).ok).toBe(true);
    expect(useRouteDraftStore.getState().draft!.points[0]).toMatchObject({ lat: 11, lon: 21 });

    expect(useRouteDraftStore.getState().removePoint(id).ok).toBe(true);
    expect(useRouteDraftStore.getState().draft!.points).toEqual([]);
  });

  it('leaves the held draft untouched when an edit is refused', () => {
    useRouteDraftStore.getState().startBlank();
    useRouteDraftStore.getState().addPoint({ lat: 10, lon: 20 });
    const held = useRouteDraftStore.getState().draft;

    const refused = useRouteDraftStore.getState().addPoint({ lat: 95, lon: 20 });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_point' } });
    expect(useRouteDraftStore.getState().removePoint('nope').ok).toBe(false);
    expect(useRouteDraftStore.getState().draft).toBe(held);
  });

  it('reports that there is nothing to edit without a draft', () => {
    const result = useRouteDraftStore.getState().addPoint({ lat: 10, lon: 20 });
    expect(result).toMatchObject({ ok: false, error: { code: 'empty_draft' } });
    expect(useRouteDraftStore.getState().draft).toBeUndefined();
  });
});
