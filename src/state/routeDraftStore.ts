import { create } from 'zustand';
import type { Activity, ActivityPointRange } from '../domain/activity';
import {
  addPoint,
  appendImportedRoute,
  createBlankDraft,
  draftFromActivity,
  movePoint,
  removePoint,
  type AddPointOptions,
  type DraftPlace,
  RouteDraftError,
  type DraftResult,
  type RouteDraft,
} from '../domain/routeDraft';

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
  clear: () => void;
}

const noDraft = (): DraftResult<RouteDraft> => ({
  ok: false,
  error: new RouteDraftError('empty_draft', 'There is no planned track to edit.'),
});

export const useRouteDraftStore = create<RouteDraftState>((set, get) => ({
  draft: undefined,

  startBlank: (name) => set({ draft: createBlankDraft({ name }) }),

  setDraft: (draft) => set({ draft }),

  importTrack: (activity, options) => {
    const held = get().draft;
    const result = held
      ? appendImportedRoute(held, activity, options)
      : draftFromActivity(activity, options);
    if (result.ok) set({ draft: result.value });
    return result;
  },

  addPoint: (place, options) => {
    const held = get().draft;
    if (!held) return noDraft();
    const result = addPoint(held, place, options);
    if (result.ok) set({ draft: result.value });
    return result;
  },

  removePoint: (id) => {
    const held = get().draft;
    if (!held) return noDraft();
    const result = removePoint(held, id);
    if (result.ok) set({ draft: result.value });
    return result;
  },

  movePoint: (id, place) => {
    const held = get().draft;
    if (!held) return noDraft();
    const result = movePoint(held, id, place);
    if (result.ok) set({ draft: result.value });
    return result;
  },

  clear: () => set({ draft: undefined }),
}));
