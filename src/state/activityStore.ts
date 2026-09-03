import { create } from 'zustand';
import type { Activity } from '../domain/activity';
import { ActivityError, toActivityError } from '../domain/errors';
import { parseActivityFile } from '../parsers';
import { useInteractionStore } from './interactionStore';

export type LoadStatus = 'empty' | 'readingFile' | 'processingFile' | 'ready' | 'error';

/**
 * AV-004. The explicit layout states from the plan (§8.1). The viewer renders
 * from this rather than inferring a state from a scatter of optional fields,
 * so a failed parse can never half-reveal the ready layout.
 */
export type ActivityViewerState =
  | { status: 'empty' }
  | { status: 'readingFile'; fileName?: string }
  | { status: 'processingFile'; fileName?: string }
  | { status: 'error'; error: ActivityError; fileName?: string }
  | { status: 'ready'; activity: Activity };

/** The data half of the store, without the actions. */
export interface ActivitySnapshot {
  status: LoadStatus;
  activity?: Activity;
  error?: ActivityError;
  /** File name shown in the UI. Never persisted (privacy constraint §5). */
  fileName?: string;
}

interface ActivityState extends ActivitySnapshot {
  loadFile: (file: File) => Promise<void>;
  clear: () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  status: 'empty',

  async loadFile(file: File) {
    // Loading a new file resets every derived interaction (AV-601).
    useInteractionStore.getState().reset();
    set({ status: 'readingFile', error: undefined, activity: undefined, fileName: file.name });

    try {
      const { activity } = await parseActivityFile(file, {
        // Reading bytes and parsing them are separate waits; a large file
        // spends most of its time in the second.
        onPhase: (phase) =>
          set({ status: phase === 'reading' ? 'readingFile' : 'processingFile' }),
      });
      set({ status: 'ready', activity, error: undefined });
    } catch (error) {
      set({
        status: 'error',
        activity: undefined,
        error: toActivityError(error, 'unsupported_format'),
      });
    }
  },

  clear() {
    useInteractionStore.getState().reset();
    set({ status: 'empty', activity: undefined, error: undefined, fileName: undefined });
  },
}));

/**
 * Narrows the store's fields into the discriminated state the UI renders from.
 * A plain function rather than a store selector: it builds a fresh object, and
 * zustand needs a referentially stable snapshot, so callers memoize it.
 */
export function selectViewerState(state: ActivitySnapshot): ActivityViewerState {
  if (state.status === 'ready' && state.activity) {
    return { status: 'ready', activity: state.activity };
  }
  if (state.status === 'error' && state.error) {
    return { status: 'error', error: state.error, fileName: state.fileName };
  }
  if (state.status === 'readingFile' || state.status === 'processingFile') {
    return { status: state.status, fileName: state.fileName };
  }
  return { status: 'empty' };
}
