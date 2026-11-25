import { create } from 'zustand';
import type { Activity } from '../domain/activity';

interface OverlayState {
  /** What overlays are being made from, handed over or chosen on the page. */
  activity?: Activity;
  /** True when the viewer handed over a selected section, not the whole activity. */
  isSection: boolean;
  setActivity: (activity: Activity, options?: { isSection?: boolean }) => void;
  clear: () => void;
}

/**
 * AV-1002/1009. In memory only, like the other handoff stores (§5): a reload
 * leaves the Overlays page empty and asks for the file again.
 */
export const useOverlayStore = create<OverlayState>((set) => ({
  activity: undefined,
  isSection: false,
  setActivity: (activity, options) => set({ activity, isSection: options?.isSection ?? false }),
  clear: () => set({ activity: undefined, isSection: false }),
}));
