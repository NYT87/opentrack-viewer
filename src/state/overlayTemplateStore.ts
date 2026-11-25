import { create } from 'zustand';
import type { UnitSystem } from '../domain/units';
import { BUILT_IN_TEMPLATES, type OverlayTemplate } from '../overlays/template';
import { setUnits } from '../overlays/templateEdit';

export const CUSTOM_TEMPLATE_ID = 'custom';
export const DEFAULT_TEMPLATE_ID = BUILT_IN_TEMPLATES[0].id;

interface OverlayTemplateState {
  /** A built-in's id, or `custom` for an imported project. */
  selectedId: string;
  /** The unit system chosen on the page; absent until the user chooses one. */
  units?: UnitSystem;
  /** Edited templates by id. A built-in with no entry here is shown as shipped. */
  saved: Record<string, OverlayTemplate>;
  select: (id: string, units: UnitSystem) => void;
  save: (template: OverlayTemplate) => void;
  setUnits: (units: UnitSystem, current: OverlayTemplate) => void;
  importTemplate: (template: OverlayTemplate) => void;
  /** Discards the edits to the selected template. */
  reset: () => void;
}

/**
 * AV-1005. The user's edits to overlay templates, for as long as the tab is
 * open — "style persistence for the session". In memory only: nothing is
 * written to storage (§5), so a reload starts from the shipped templates, and
 * keeping a look for good is what the project file is for.
 *
 * Each template keeps its own edits, so trying another one and coming back
 * does not lose what was done to the first.
 */
export const useOverlayTemplateStore = create<OverlayTemplateState>((set) => ({
  selectedId: DEFAULT_TEMPLATE_ID,
  units: undefined,
  saved: {},

  select: (id, units) =>
    set((state) => {
      const existing = state.saved[id];
      // An edited template follows the unit system chosen now, not the one it
      // was last shown in.
      return {
        selectedId: id,
        saved: existing ? { ...state.saved, [id]: setUnits(existing, units) } : state.saved,
      };
    }),

  save: (template) => set((state) => ({ saved: { ...state.saved, [state.selectedId]: template } })),

  setUnits: (units, current) =>
    set((state) => ({
      units,
      saved: { ...state.saved, [state.selectedId]: setUnits(current, units) },
    })),

  importTemplate: (template) =>
    set((state) => ({
      selectedId: CUSTOM_TEMPLATE_ID,
      saved: { ...state.saved, [CUSTOM_TEMPLATE_ID]: template },
      units: template.units,
    })),

  reset: () =>
    set((state) => {
      const { [state.selectedId]: _discarded, ...rest } = state.saved;
      void _discarded;
      // Nothing is left to show for an imported template once it is discarded.
      return {
        saved: rest,
        selectedId: state.selectedId === CUSTOM_TEMPLATE_ID ? DEFAULT_TEMPLATE_ID : state.selectedId,
      };
    }),
}));

/** The template to show: the user's edited copy, or the shipped one. */
export function currentTemplate(
  state: Pick<OverlayTemplateState, 'selectedId' | 'saved'>,
  units: UnitSystem,
): OverlayTemplate {
  const saved = state.saved[state.selectedId];
  if (saved) return saved;
  const entry = BUILT_IN_TEMPLATES.find((t) => t.id === state.selectedId) ?? BUILT_IN_TEMPLATES[0];
  return entry.create(units);
}
