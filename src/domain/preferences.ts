import type { UnitSystem } from './units';
import { THEME_MODES, type ThemeMode } from './theme';

/**
 * Display and privacy preference keys. Namespaced because a GitHub
 * Pages sub-path shares an origin with every other project published there.
 */
export const THEME_STORAGE_KEY = 'opentrack-viewer:theme';
export const BASEMAP_STORAGE_KEY = 'opentrack-viewer:basemap';

/**
 * Locales whose *distance* convention is miles, used only when the browser
 * cannot tell us its measurement system directly.
 *
 * The United States, Liberia and Myanmar. The United Kingdom is deliberately
 * absent: it measures road distance in miles but runs, rides and swims in
 * kilometres, and a viewer of activity files is closer to the second. It is a
 * default either way — the Settings control overrides it in one click.
 */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/**
 * The unit system to start with, read from the browser's locale.
 *
 * Prefers `Intl.Locale`'s `measurementSystem`, which is CLDR's own answer and
 * needs no list to maintain. Where that is unavailable — Firefox, at the time
 * of writing — it falls back to the region. `uk` is CLDR's mixed system and is
 * treated as metric here, for the reason given above.
 */
export function localeUnitSystem(
  locales: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): UnitSystem {
  for (const tag of locales) {
    try {
      const locale = new Intl.Locale(tag);
      const measurementSystem = (locale as Intl.Locale & { measurementSystem?: string })
        .measurementSystem;

      if (measurementSystem) return measurementSystem === 'us' ? 'imperial' : 'metric';

      const region = locale.maximize().region;
      if (region) return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
    } catch {
      // A malformed tag tells us nothing; try the next one.
      continue;
    }
  }
  return 'metric';
}

/** The stored theme preference, or `undefined` when there is none to read. */
export function readStoredTheme(): ThemeMode | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : undefined;
  } catch {
    // Private browsing and blocked site data both throw on access.
    return undefined;
  }
}

/**
 * Persists a display choice, never activity data.
 */
export function storeTheme(mode: ThemeMode): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage being unavailable is not an error worth surfacing: the app
    // works, it simply forgets.
  }
}

/** Missing or inaccessible storage keeps the existing enabled default. */
export function readStoredBasemap(): boolean {
  try {
    return globalThis.localStorage?.getItem(BASEMAP_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function storeBasemap(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(BASEMAP_STORAGE_KEY, String(enabled));
  } catch {
    // A denied preference store does not prevent route-only mode this session.
  }
}
