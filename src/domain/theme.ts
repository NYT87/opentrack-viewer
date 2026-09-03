/** AV-009. Session theme preference; `system` follows the OS/browser. */
export type ThemeMode = 'system' | 'dark' | 'light';

/** What actually gets painted. `system` always resolves to one of these. */
export type ResolvedTheme = 'dark' | 'light';

export const THEME_MODES: ThemeMode[] = ['system', 'dark', 'light'];

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  system: 'System',
  dark: 'Dark',
  light: 'Light',
};

/**
 * Resolves the preference into the theme to paint.
 *
 * `prefersDark` is undefined when the browser cannot report a colour-scheme
 * preference. The plan fixes the fallback at light rather than dark, so an
 * environment without `matchMedia` gets a defined, readable result instead of
 * whichever default happened to be first in the stylesheet.
 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean | undefined): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return prefersDark === true ? 'dark' : 'light';
}

/** True/false from the OS, or undefined when the browser cannot tell us. */
export function detectPrefersDark(): boolean | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    // Some embedded browsers throw on an unsupported media query.
    return undefined;
  }
}
