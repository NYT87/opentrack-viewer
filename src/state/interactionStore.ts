import { create } from 'zustand';
import type { ActivityPointRange, ChartXAxisMode } from '../domain/activity';
import { localeUnitSystem, readStoredTheme, storeTheme } from '../domain/preferences';
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
  /**
   * AV-601 / AV-604. The focused section, in `point.index` terms so it means
   * the same thing to the charts and the map. Shared rather than local to the
   * chart panel precisely because the map has to follow it.
   */
  selectedRange?: ActivityPointRange;
  /** User preference: draw the basemap, or route-only for privacy (§5). */
  basemapEnabled: boolean;
  /** Defaulted from the browser's locale (§17); a session preference. */
  unitSystem: UnitSystem;
  /**
   * AV-009. Defaults to following the OS, and is the one preference kept
   * between visits rather than for the session.
   */
  themeMode: ThemeMode;
  /**
   * The lap the reader asked to see. Deliberately separate from
   * `selectedRange`: a chart selection focuses the view and moves the camera,
   * while a lap only recolours its stretch of the route where it already is.
   */
  selectedLapIndex?: number;
  /**
   * Preferred chart x-axis (§17 open question resolved: it persists for the
   * session, like units). Undefined means "let the activity decide". A stored
   * preference an activity cannot support is not cleared — the chart falls back
   * for that file and the preference applies again to the next one.
   */
  chartXAxisMode?: ChartXAxisMode;

  setHoveredPoint: (index: number | undefined, source?: 'map' | 'chart') => void;
  setSelectedPoint: (index: number | undefined) => void;
  setSelectedRange: (range: ActivityPointRange | undefined) => void;
  setBasemapEnabled: (enabled: boolean) => void;
  setUnitSystem: (units: UnitSystem) => void;
  setThemeMode: (mode: ThemeMode) => void;
  /** AV-407 follow-up: which lap the map should pick out, if any. */
  setSelectedLapIndex: (index: number | undefined) => void;
  setChartXAxisMode: (mode: ChartXAxisMode) => void;
  reset: () => void;
}

export const useInteractionStore = create<InteractionState>((set) => ({
  basemapEnabled: true,
  // The browser's own locale decides the starting unit system; the Settings
  // control overrides it, and that override lasts the session.
  unitSystem: localeUnitSystem(),
  // A stored theme wins over `system`, so a reader who chose dark keeps it.
  themeMode: readStoredTheme() ?? 'system',

  setHoveredPoint(index, source) {
    set({ hoveredPointIndex: index, hoverSource: index === undefined ? undefined : source });
  },

  setSelectedPoint(index) {
    set({ selectedPointIndex: index });
  },

  setSelectedRange(range) {
    set({ selectedRange: range });
  },

  setBasemapEnabled(enabled) {
    set({ basemapEnabled: enabled });
  },

  setUnitSystem(units) {
    set({ unitSystem: units });
  },

  setSelectedLapIndex(index) {
    set({ selectedLapIndex: index });
  },

  setThemeMode(mode) {
    set({ themeMode: mode });
    // The one preference written to disk. Everything else is session state.
    storeTheme(mode);
  },

  setChartXAxisMode(mode) {
    set({ chartXAxisMode: mode });
  },

  reset() {
    set({
      hoveredPointIndex: undefined,
      selectedPointIndex: undefined,
      hoverSource: undefined,
      // A range refers to points in the activity that produced it.
      selectedRange: undefined,
      // ...and so does a lap.
      selectedLapIndex: undefined,
    });
  },
}));

/** The point the UI should highlight: hover wins over selection. */
export function activePointIndex(state: {
  hoveredPointIndex?: number;
  selectedPointIndex?: number;
}): number | undefined {
  return state.hoveredPointIndex ?? state.selectedPointIndex;
}
