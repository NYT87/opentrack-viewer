import { create } from 'zustand';
import { createBlankDraft, type RouteDraft } from '../domain/routeDraft';

/** Enough to undo a long editing session without holding unbounded copies. */
const MAX_HISTORY = 100;

interface RouteDraftState {
  /** The route being edited, or none before one is started or handed over. */
  draft?: RouteDraft;
  past: RouteDraft[];
  future: RouteDraft[];
  /** Replaces the draft and forgets its history: a different route, not an edit. */
  setDraft: (draft: RouteDraft) => void;
  startBlank: () => void;
  /** An edit: the previous draft becomes the undo step. */
  applyEdit: (draft: RouteDraft) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

/**
 * AV-1101/1102. In-memory only, like the activity store: a reload leaves Route
 * Builder empty, which is what the privacy model asks for (§5) — a planned
 * route is never written to storage or sent anywhere.
 *
 * History holds earlier drafts by reference. That is cheap because every draft
 * operation returns a new draft and never changes one in place.
 */
export const useRouteDraftStore = create<RouteDraftState>((set) => ({
  draft: undefined,
  past: [],
  future: [],
  setDraft: (draft) => set({ draft, past: [], future: [] }),
  startBlank: () => set({ draft: createBlankDraft(), past: [], future: [] }),
  applyEdit: (draft) =>
    set((state) => ({
      draft,
      past: state.draft ? [...state.past, state.draft].slice(-MAX_HISTORY) : state.past,
      future: [],
    })),
  undo: () =>
    set((state) => {
      const previous = state.past.at(-1);
      if (!previous || !state.draft) return state;
      return {
        draft: previous,
        past: state.past.slice(0, -1),
        future: [state.draft, ...state.future],
      };
    }),
  redo: () =>
    set((state) => {
      const next = state.future[0];
      if (!next || !state.draft) return state;
      return { draft: next, past: [...state.past, state.draft], future: state.future.slice(1) };
    }),
  clear: () => set({ draft: undefined, past: [], future: [] }),
}));
