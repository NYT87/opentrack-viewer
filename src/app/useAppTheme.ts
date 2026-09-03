import { useEffect, useSyncExternalStore } from 'react';
import { detectPrefersDark, resolveTheme } from '../domain/theme';
import { useInteractionStore } from '../state/interactionStore';

function colorSchemeQuery(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    // Some embedded browsers throw on an unsupported media query.
    return undefined;
  }
}

/** Subscribes to OS colour-scheme changes; a no-op where it cannot be observed. */
function subscribe(onChange: () => void): () => void {
  const query = colorSchemeQuery();
  if (!query) return () => {};

  // addListener is the pre-2021 Safari spelling; still worth the fallback.
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

/**
 * AV-009. Applies the resolved theme to the document, and keeps following the
 * OS while the preference is `system` — so a user switching their system theme
 * sees the app follow without touching a setting or reloading.
 *
 * The OS preference is read through `useSyncExternalStore` because that is what
 * it is: an external store. It returns a plain boolean/undefined, so the
 * snapshot is stable between reads.
 */
export function useAppTheme(): void {
  const themeMode = useInteractionStore((state) => state.themeMode);
  const prefersDark = useSyncExternalStore(subscribe, detectPrefersDark, () => undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(themeMode, prefersDark);
  }, [themeMode, prefersDark]);
}
