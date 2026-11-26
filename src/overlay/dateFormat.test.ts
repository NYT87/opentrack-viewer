import { describe, expect, it } from 'vitest';
import { formatStillDate, supportedLocale } from './dateFormat';

const UTC = { kind: 'zone', timeZone: 'UTC' } as const;
const march = new Date('2026-03-05T10:00:00Z');
const FORMATS = ['iso', 'medium', 'numeric', 'long'] as const;

describe('formatStillDate with a language (AV-1032, TD-104)', () => {
  it('writes English exactly as before when there is no locale, and for any English locale', () => {
    const was = ['2026-03-05 10:00', '5 Mar 2026, 10:00', '05/03/2026 10:00', 'Thursday 5 March 2026, 10:00'];
    for (const locale of [undefined, 'en', 'en-US', 'en-GB']) {
      expect(FORMATS.map((format) => formatStillDate(march, format, true, UTC, locale))).toEqual(was);
    }
    // Every month of the year, in both names, as the old tables wrote them (en-GB would say "Sept").
    const sept = new Date('2026-09-24T10:00:00Z');
    expect(formatStillDate(sept, 'medium', false, UTC, 'en-GB')).toBe('24 Sep 2026');
    expect(formatStillDate(sept, 'long', false, UTC)).toBe('Thursday 24 September 2026');
  });

  it('writes the month and weekday names of es, fr, de and ja in each format, keeping the order', () => {
    const at = (locale: string) => FORMATS.map((format) => formatStillDate(march, format, true, UTC, locale));
    expect(at('es')).toEqual(['2026-03-05 10:00', '5 mar 2026, 10:00', '05/03/2026 10:00', 'jueves 5 marzo 2026, 10:00']);
    expect(at('fr')).toEqual(['2026-03-05 10:00', '5 mars 2026, 10:00', '05/03/2026 10:00', 'jeudi 5 mars 2026, 10:00']);
    expect(at('de')).toEqual(['2026-03-05 10:00', '5 März 2026, 10:00', '05/03/2026 10:00', 'Donnerstag 5 März 2026, 10:00']);
    expect(at('ja')).toEqual(['2026-03-05 10:00', '5 3月 2026, 10:00', '05/03/2026 10:00', '木曜日 5 3月 2026, 10:00']);
  });

  it('declines a month where the language does beside a day (Polish "marca")', () => {
    expect(formatStillDate(march, 'long', false, UTC, 'pl')).toBe('czwartek 5 marca 2026');
  });

  it('writes every listed language without failing', () => {
    for (const locale of ['es', 'fr', 'de', 'it', 'pt', 'nl', 'ca', 'pl', 'sv', 'ja', 'zh', 'ko', 'ar']) {
      expect(formatStillDate(march, 'long', true, UTC, locale)).toMatch(/10:00$/);
    }
  });

  it('accepts only tags the browser can write dates in', () => {
    expect(supportedLocale('de')).toBe('de');
    expect(supportedLocale('pt-BR')).toBe('pt-BR');
    expect(supportedLocale('not a tag')).toBeUndefined();
    expect(supportedLocale('')).toBeUndefined();
  });
});
