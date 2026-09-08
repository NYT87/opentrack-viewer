import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  localeUnitSystem,
  readStoredTheme,
  storeTheme,
} from './preferences';

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    // Nothing to clear where storage is unavailable.
  }
});

describe('units follow the browser locale', () => {
  it('gives the United States miles', () => {
    expect(localeUnitSystem(['en-US'])).toBe('imperial');
  });

  it('gives everywhere else kilometres', () => {
    for (const locale of ['en-GB', 'es-ES', 'de-DE', 'ja-JP', 'pt-BR']) {
      expect(localeUnitSystem([locale]), locale).toBe('metric');
    }
  });

  it('keeps the United Kingdom metric, deliberately', () => {
    // The UK measures road distance in miles but runs and rides in kilometres,
    // and this is a viewer of activity files.
    expect(localeUnitSystem(['en-GB'])).toBe('metric');
  });

  it('reads a bare language tag through its likely region', () => {
    // `en` maximizes to en-Latn-US, which is the case worth getting right.
    expect(localeUnitSystem(['en'])).toBe('imperial');
  });

  it('takes the first locale it can make sense of', () => {
    expect(localeUnitSystem(['not a locale', 'en-US'])).toBe('imperial');
  });

  it('falls back to metric when the browser offers nothing', () => {
    expect(localeUnitSystem([])).toBe('metric');
  });

  it('falls back to a region list where the browser cannot report a system', () => {
    // Firefox has no `measurementSystem`; the region has to answer instead.
    // A plain function, not an arrow: this is called with `new`.
    vi.spyOn(Intl, 'Locale').mockImplementation(function (tag: unknown) {
      return {
        maximize: () => ({ region: String(tag).split('-')[1] }),
      } as unknown as Intl.Locale;
    } as unknown as typeof Intl.Locale);

    expect(localeUnitSystem(['en-US'])).toBe('imperial');
    expect(localeUnitSystem(['en-GB'])).toBe('metric');
  });
});

describe('the theme preference is remembered', () => {
  it('stores and reads a choice back', () => {
    storeTheme('dark');

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('has nothing to read before a choice is made', () => {
    expect(readStoredTheme()).toBeUndefined();
  });

  it('ignores a stored value that is not a theme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');

    expect(readStoredTheme()).toBeUndefined();
  });

  it('namespaces its key, because a Pages sub-path shares an origin', () => {
    expect(THEME_STORAGE_KEY).toBe('opentrack-viewer:theme');
  });

  it('survives storage being unavailable', () => {
    // Private browsing and blocked site data both throw on access.
    const denied = () => {
      throw new Error('SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);

    expect(() => storeTheme('dark')).not.toThrow();
    expect(readStoredTheme()).toBeUndefined();
  });
});
