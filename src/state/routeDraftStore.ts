import { create } from 'zustand';
import { createBlankDraft, type RouteDraft } from '../domain/routeDraft';

interface RouteDraftState {
  /** The route being edited, or none before one is started or handed over. */
  draft?: RouteDraft;
  setDraft: (draft: RouteDraft) => void;
  startBlank: () => void;
  clear: () => void;
}

/**
 * AV-1101/1102. In-memory only, like the activity store: a reload leaves Route
 * Builder empty, which is what the privacy model asks for (§5) — a planned
 * route is never written to storage or sent anywhere.
 */
export const useRouteDraftStore = create<RouteDraftState>((set) => ({
  draft: undefined,
  setDraft: (draft) => set({ draft }),
  startBlank: () => set({ draft: createBlankDraft() }),
  clear: () => set({ draft: undefined }),
}));
