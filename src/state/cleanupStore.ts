import { useMemo } from 'react';
import { create } from 'zustand';
import type { Activity } from '../domain/activity';
import {
  DEFAULT_CLEANUP_SETTINGS,
  cleanActivity,
  type CleanupReport,
  type CleanupSettings,
} from '../domain/cleanup';
import { useInteractionStore } from './interactionStore';

/** A change to the settings: the pause and smoothing sections given are merged over the ones held. */
export type CleanupSettingsPatch = Partial<Omit<CleanupSettings, 'pause' | 'smoothing'>> & {
  pause?: Partial<CleanupSettings['pause']>;
  smoothing?: Partial<CleanupSettings['smoothing']>;
};

interface CleanupState {
  settings: CleanupSettings;
  update: (patch: CleanupSettingsPatch) => void;
  reset: () => void;
}

/**
 * AV-1024 (TD-093). The telemetry clean-up's settings: off by default, kept for
 * the session in memory only (nothing but the theme is stored, §5). They belong
 * to the reader, not to a file, so they stay across activities and pages.
 *
 * A change can drop, add or move points, and the selected range, the hover and
 * the chosen lap are indexes into the points: the interaction state is reset
 * with every change, as it is for a new activity.
 */
export const useCleanupStore = create<CleanupState>((set) => ({
  settings: DEFAULT_CLEANUP_SETTINGS,
  update: (patch) => {
    useInteractionStore.getState().reset();
    set((state) => ({
      settings: {
        ...state.settings,
        ...patch,
        pause: { ...state.settings.pause, ...patch.pause },
        smoothing: { ...state.settings.smoothing, ...patch.smoothing },
      },
    }));
  },
  reset: () => {
    useInteractionStore.getState().reset();
    set({ settings: DEFAULT_CLEANUP_SETTINGS });
  },
}));

/**
 * The activity a page should read: the cleaned view of the one its store holds
 * when the clean-up is on, the activity itself when it is off. Every page that
 * reads an activity from a store goes through this, so the charts, the stats,
 * the overlay, the map video and the exports all agree. Referentially stable
 * while the activity and the settings are.
 */
export function useCleanedActivity(raw: Activity | undefined): Activity | undefined {
  const settings = useCleanupStore((state) => state.settings);
  return useMemo(() => (raw ? cleanActivity(raw, settings).activity : undefined), [raw, settings]);
}

/** The clean-up's report for an activity (its counts and the before/after figures). */
export function useCleanupReport(raw: Activity | undefined): CleanupReport | undefined {
  const settings = useCleanupStore((state) => state.settings);
  return useMemo(() => (raw ? cleanActivity(raw, settings).report : undefined), [raw, settings]);
}
