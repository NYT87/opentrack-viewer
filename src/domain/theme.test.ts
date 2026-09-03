import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_MODES, detectPrefersDark, resolveTheme } from './theme';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTheme (AV-009)', () => {
  it('offers exactly three modes', () => {
    expect(THEME_MODES).toEqual(['system', 'dark', 'light']);
  });

  it('forces the explicit modes regardless of the system preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('follows the system preference in system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('falls back to light when the preference cannot be detected', () => {
    expect(resolveTheme('system', undefined)).toBe('light');
  });
});

describe('detectPrefersDark', () => {
  it('reads the media query', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    expect(detectPrefersDark()).toBe(true);

    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    expect(detectPrefersDark()).toBe(false);
  });

  it('reports undetectable rather than guessing when matchMedia is absent', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(detectPrefersDark()).toBeUndefined();
  });

  it('survives a browser that throws on the query', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => {
      throw new Error('unsupported media query');
    }));
    expect(detectPrefersDark()).toBeUndefined();
  });
});
