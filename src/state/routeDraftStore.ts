import { create } from 'zustand';
import type { Activity, ActivityPointRange } from '../domain/activity';
import {
  addPoint,
  appendImportedRoute,
  createBlankDraft,
  discardSection,
  draftFromActivity,
  joinBefore,
  movePoint,
  removePoint,
  RouteDraftError,
  splitBefore,
  type AddPointOptions,
  type DiscardOptions,
  type DraftPlace,
  type DraftResult,
  type DraftSection,
  type RouteDraft,
} from '../domain/routeDraft';

/**
 * AV-1105. How many edits can be undone. Drafts share the points an edit did
 * not touch (TD-048), so a step costs little; the cap is there so a long
 * session does not grow without bound.
 */
export const UNDO_DEPTH = 50;

/**
 * AV-1102. What the Route Builder page holds: one planned track, or none.
 *
 * In memory only, like the viewer's activity (TD-025, §5): nothing is written to
 * storage, so a reload leaves it empty and the page says so. It is the handoff
 * the viewer will write to (AV-1103) and the page reads; a draft is never the
 * viewer's `Activity`, which stays as loaded (TD-006).
 */
interface RouteDraftState {
  draft: RouteDraft | undefined;
  /**
   * AV-1105. The drafts before each edit, newest last, so an edit can be taken
   * back. Cleared when a different draft arrives: there is nothing of it to go
   * back to.
   */
  history: RouteDraft[];
  /** Starts a new, empty planned track, replacing whatever was held. */
  startBlank: (name?: string) => void;
  /** Receives a draft handed over from elsewhere (the viewer), replacing whatever was held. */
  setDraft: (draft: RouteDraft) => void;
  /**
   * Takes a track in: the start of a new draft when none is held, or appended to
   * the one that is. Returns the outcome, so the page can say why a track was
   * refused; the held draft is untouched by a refusal.
   */
  importTrack: (
    activity: Activity,
    options?: { range?: ActivityPointRange },
  ) => DraftResult<RouteDraft>;
  /**
   * AV-1104. Edits by hand, each through the model's own operation: the
   * outcome is returned so the page can say why an edit was refused, and a
   * refusal leaves the held draft untouched. Without a draft there is nothing
   * to edit, which is reported the same way.
   */
  addPoint: (place: DraftPlace, options?: AddPointOptions) => DraftResult<RouteDraft>;
  removePoint: (id: string) => DraftResult<RouteDraft>;
  movePoint: (id: string, place: DraftPlace) => DraftResult<RouteDraft>;
  /** AV-1105. Takes a section out, joining the cut or keeping it as a gap. */
  discardSection: (section: DraftSection, options?: DiscardOptions) => DraftResult<RouteDraft>;
  /** AV-1105. Joins the stretch beginning at this point to the one before it. */
  joinBefore: (id: string) => DraftResult<RouteDraft>;
  /** AV-1105. Starts a new stretch at this point. */
  splitBefore: (id: string) => DraftResult<RouteDraft>;
  /** AV-1105. Takes the last edit back. Returns whether there was one. */
  undo: () => boolean;
  clear: () => void;
}

const noDraft = (): DraftResult<RouteDraft> => ({
  ok: false,
  error: new RouteDraftError('empty_draft', 'There is no planned track to edit.'),
});

export const useRouteDraftStore = create<RouteDraftState>((set, get) => {
  /** Applies an edit to the held draft, remembering the draft it replaced. */
  const edit = (operation: (held: RouteDraft) => DraftResult<RouteDraft>): DraftResult<RouteDraft> => {
    const held = get().draft;
    if (!held) return noDraft();
    const result = operation(held);
    if (result.ok) {
      set((state) => ({
        draft: result.value,
        history: [...state.history, held].slice(-UNDO_DEPTH),
      }));
    }
    return result;
  };

  return {
    draft: undefined,
    history: [],

    startBlank: (name) => set({ draft: createBlankDraft({ name }), history: [] }),

    setDraft: (draft) => set({ draft, history: [] }),

    importTrack: (activity, options) => {
      const held = get().draft;
      if (held) return edit((draft) => appendImportedRoute(draft, activity, options));
      const result = draftFromActivity(activity, options);
      if (result.ok) set({ draft: result.value, history: [] });
      return result;
    },

    addPoint: (place, options) => edit((draft) => addPoint(draft, place, options)),
    removePoint: (id) => edit((draft) => removePoint(draft, id)),
    movePoint: (id, place) => edit((draft) => movePoint(draft, id, place)),
    discardSection: (section, options) => edit((draft) => discardSection(draft, section, options)),
    joinBefore: (id) => edit((draft) => joinBefore(draft, id)),
    splitBefore: (id) => edit((draft) => splitBefore(draft, id)),

    undo: () => {
      const { history, draft: held } = get();
      const previous = history[history.length - 1];
      if (!previous) return false;
      /*
       * The counters never go back. A draft before an addition has a lower
       * point counter, and restoring it as it was would let the next point
       * take an id a point that no longer exists once had — and anything still
       * naming that id (a selection, a section mark) would quietly point at
       * the newcomer. Ids are only labels, so carrying the higher counters
       * forward changes nothing else; the draft is restored as the same object
       * whenever they already agree.
       */
      const counters = {
        point: Math.max(previous.counters.point, held?.counters.point ?? 0),
        source: Math.max(previous.counters.source, held?.counters.source ?? 0),
      };
      const restored =
        counters.point === previous.counters.point && counters.source === previous.counters.source
          ? previous
          : { ...previous, counters };
      set({ draft: restored, history: history.slice(0, -1) });
      return true;
    },

    clear: () => set({ draft: undefined, history: [] }),
  };
});
