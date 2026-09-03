import { create } from 'zustand';
import type { ChartXAxisMode } from '../domain/activity';
import type { ThemeMode } from '../domain/theme';
import type { UnitSystem } from '../domain/units';

/**
 * AV-601. Shared hover/selection state, expressed purely as indices into
 * `activity.points` so it stays independent of the source file format.
 */
interface InteractionState {
  hoveredPointIndex?: number;
  selectedPointIndex?: number;
  /** Where the current hover originated, to avoid feedback loops. */
  hoverSource?: 'map' | 'chart';
  /** User preference: draw the basemap, or route-only for privacy (§5). */
  basemapEnabled: boolean;
  /** Metric by default (§17); a session preference, not persisted. */
  unitSystem: UnitSystem;
  /** AV-009. Defaults to following the OS; session-scoped like the rest. */
  themeMode: ThemeMode;
  /**
   * Preferred chart x-axis (§17 open question resolved: it persists for the
   * session, like units). Undefined means "let the activity decide". A stored
   * preference an activity cannot support is not cleared — the chart falls back
   * for that file and the preference applies again to the next one.
   */
  chartXAxisMode?: ChartXAxisMode;

  setHoveredPoint: (index: number | undefined, source?: 'map' | 'chart') => void;
  setSelectedPoint: (index: number | undefined) => void;
  setBasemapEnabled: (enabled: boolean) => void;
  setUnitSystem: (units: UnitSystem) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setChartXAxisMode: (mode: ChartXAxisMode) => void;
  reset: () => void;
}

export const useInteractionStore = create<InteractionState>((set) => ({
  basemapEnabled: true,
  unitSystem: 'metric',
  themeMode: 'system',

  setHoveredPoint(index, source) {
    set({ hoveredPointIndex: index, hoverSource: index === undefined ? undefined : source });
  },

  setSelectedPoint(index) {
    set({ selectedPointIndex: index });
  },

  setBasemapEnabled(enabled) {
    set({ basemapEnabled: enabled });
  },

  setUnitSystem(units) {
    set({ unitSystem: units });
  },

  setThemeMode(mode) {
    set({ themeMode: mode });
  },

  setChartXAxisMode(mode) {
    set({ chartXAxisMode: mode });
  },

  reset() {
    set({ hoveredPointIndex: undefined, selectedPointIndex: undefined, hoverSource: undefined });
  },
}));

/** The point the UI should highlight: hover wins over selection. */
export function activePointIndex(state: {
  hoveredPointIndex?: number;
  selectedPointIndex?: number;
}): number | undefined {
  return state.hoveredPointIndex ?? state.selectedPointIndex;
}
