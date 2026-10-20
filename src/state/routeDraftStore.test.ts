import { beforeEach, describe, expect, it } from 'vitest';
import { UNDO_DEPTH, useRouteDraftStore } from './routeDraftStore';
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

describe('sections, stretches and undo through the store (AV-1105)', () => {
  const fill = () => {
    useRouteDraftStore.getState().startBlank();
    for (let i = 0; i < 5; i += 1) useRouteDraftStore.getState().addPoint({ lat: 10 + i * 0.001, lon: 20 });
  };
  const ids = () => useRouteDraftStore.getState().draft!.points.map((p) => p.id);

  it('discards a section, and takes it back', () => {
    fill();
    expect(useRouteDraftStore.getState().discardSection({ fromId: 'p1', toId: 'p3' }).ok).toBe(true);
    expect(ids()).toEqual(['p0', 'p4']);

    expect(useRouteDraftStore.getState().undo()).toBe(true);
    expect(ids()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('undoes every kind of edit, newest first, and says when there is nothing left', () => {
    fill();
    const after5 = useRouteDraftStore.getState().draft;
    useRouteDraftStore.getState().movePoint('p0', { lat: 50, lon: 50 });
    useRouteDraftStore.getState().removePoint('p4');
    useRouteDraftStore.getState().splitBefore('p2');
    expect(useRouteDraftStore.getState().history).toHaveLength(8);

    useRouteDraftStore.getState().undo();
    expect(useRouteDraftStore.getState().draft!.points.map((p) => p.segmentIndex)).toEqual([0, 0, 0, 0]);
    useRouteDraftStore.getState().undo();
    expect(ids()).toHaveLength(5);
    useRouteDraftStore.getState().undo();
    expect(useRouteDraftStore.getState().draft).toBe(after5);
    for (let i = 0; i < 5; i += 1) expect(useRouteDraftStore.getState().undo()).toBe(true);
    expect(useRouteDraftStore.getState().undo()).toBe(false);
    expect(useRouteDraftStore.getState().draft!.points).toEqual([]);
  });

  it('remembers nothing of a draft that was replaced, and nothing for a refused edit', () => {
    fill();
    useRouteDraftStore.getState().startBlank();
    expect(useRouteDraftStore.getState().undo()).toBe(false);
    useRouteDraftStore.getState().addPoint({ lat: 1, lon: 1 });
    useRouteDraftStore.getState().addPoint({ lat: 95, lon: 1 });
    expect(useRouteDraftStore.getState().history).toHaveLength(1);
    useRouteDraftStore.getState().setDraft(createBlankDraft());
    expect(useRouteDraftStore.getState().history).toEqual([]);
  });

  it('keeps no more than the undo depth', () => {
    useRouteDraftStore.getState().startBlank();
    for (let i = 0; i < UNDO_DEPTH + 10; i += 1) useRouteDraftStore.getState().addPoint({ lat: 1, lon: 1 });
    expect(useRouteDraftStore.getState().history).toHaveLength(UNDO_DEPTH);
  });

  it('joins and splits stretches of the held draft', () => {
    useRouteDraftStore.getState().importTrack(makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }]));
    useRouteDraftStore.getState().importTrack(makeActivity([{ lat: 11, lon: 20 }, { lat: 11.001, lon: 20 }]));
    const seg = () => useRouteDraftStore.getState().draft!.points.map((p) => p.segmentIndex);
    expect(seg()).toEqual([0, 0, 1, 1]);
    expect(useRouteDraftStore.getState().joinBefore('p2').ok).toBe(true);
    expect(seg()).toEqual([0, 0, 0, 0]);
    expect(useRouteDraftStore.getState().splitBefore('p2').ok).toBe(true);
    expect(seg()).toEqual([0, 0, 1, 1]);
    // The first import is a new draft, so only the second import and the two repairs can be undone.
    expect(useRouteDraftStore.getState().history).toHaveLength(3);
  });
});

describe('ids after an undo (AV-1105, review)', () => {
  it('never gives a new point the id of one an undo took away', () => {
    useRouteDraftStore.getState().startBlank();
    useRouteDraftStore.getState().addPoint({ lat: 1, lon: 1 });
    useRouteDraftStore.getState().addPoint({ lat: 2, lon: 2 });
    expect(useRouteDraftStore.getState().draft!.points.map((p) => p.id)).toEqual(['p0', 'p1']);

    useRouteDraftStore.getState().undo();
    useRouteDraftStore.getState().addPoint({ lat: 3, lon: 3 });

    expect(useRouteDraftStore.getState().draft!.points.map((p) => p.id)).toEqual(['p0', 'p2']);
    // And the same for sources: an undone import's number is not reused.
    useRouteDraftStore.getState().importTrack(makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20 }]));
    useRouteDraftStore.getState().undo();
    useRouteDraftStore.getState().importTrack(makeActivity([{ lat: 11, lon: 20 }, { lat: 11.001, lon: 20 }]));
    expect(useRouteDraftStore.getState().draft!.sources.map((s) => s.id)).toEqual(['s1']);
  });

  it('restores the very same draft object when no counter has to be carried forward', () => {
    useRouteDraftStore.getState().startBlank();
    useRouteDraftStore.getState().addPoint({ lat: 1, lon: 1 });
    const before = useRouteDraftStore.getState().draft;
    useRouteDraftStore.getState().movePoint('p0', { lat: 5, lon: 5 });
    useRouteDraftStore.getState().undo();
    expect(useRouteDraftStore.getState().draft).toBe(before);
  });
});
