import { create } from 'zustand';
import { cleanFigure, type PersonalKey } from '../overlay/zones';
import type { PersonalFigures } from '../overlay/template';

/**
 * AV-1018 (TD-086). The reader's own maximum heart rate and FTP: what a zones
 * component measured in percent is measured against.
 *
 * In memory only, for the session, like the overlay settings (TD-040): nothing
 * but the theme is ever written to device storage, and a reload forgets them.
 * They are given to the renderer and sent to an export worker with the request,
 * which is the page talking to its own code; they are never logged, never put in a
 * URL or a request, and written to a layout file only when the reader ticks the
 * box for it. Whether to keep them across reloads is left to the maintainer
 * (TD-086).
 */
interface PersonalState {
  personal: PersonalFigures;
  /** Sets one figure, kept inside its limits; `undefined` (or a value that is no number) lets it go. */
  setFigure: (key: PersonalKey, value: number | undefined) => void;
  /** Takes the figures a layout held: each one that is there, over what the session has. */
  adopt: (figures: PersonalFigures) => void;
  clear: () => void;
}

export const usePersonalStore = create<PersonalState>((set) => ({
  personal: {},
  setFigure: (key, value) =>
    set((state) => {
      const next = { ...state.personal };
      const clean = cleanFigure(key, value);
      if (clean === undefined) delete next[key];
      else next[key] = clean;
      return { personal: next };
    }),
  adopt: (figures) =>
    set((state) => {
      const next = { ...state.personal };
      const maxHeartRate = cleanFigure('maxHeartRate', figures.maxHeartRate);
      if (maxHeartRate !== undefined) next.maxHeartRate = maxHeartRate;
      const ftp = cleanFigure('ftp', figures.ftp);
      if (ftp !== undefined) next.ftp = ftp;
      return { personal: next };
    }),
  clear: () => set({ personal: {} }),
}));
