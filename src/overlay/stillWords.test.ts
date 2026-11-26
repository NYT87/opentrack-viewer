import { describe, expect, it } from 'vitest';
import { extractRoute } from './routeImage';
import {
  defaultStaticLayout,
  layoutStillText,
  newStillComponent,
  parseStillLayout,
  serializeStillLayout,
  stillValue,
  type MeasureText,
  type StillImageContext,
} from './staticImage';
import { LABEL_MAX_LENGTH, parseOverlayTemplate, type OverlayComponent } from './template';
import type { Activity } from '../domain/activity';
import { makeActivity } from '../test/helpers/activity';

const T0 = Date.parse('2026-03-05T10:00:00Z');
const ride = (distanceMeters = 9990): Activity => {
  const activity = makeActivity(
    Array.from({ length: 61 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + i / 20_000, lon: 7 })),
  );
  return { ...activity, derived: { ...activity.derived, distanceMeters } } as Activity;
};
const contextOf = (activity: Activity): StillImageContext => ({
  activity,
  route: extractRoute(activity),
  units: 'metric',
  readerTimeZone: 'UTC',
});
const measure: MeasureText = (text) => text.length * 10;
const figure = (summary: NonNullable<OverlayComponent['summary']>): OverlayComponent => ({
  ...newStillComponent(defaultStaticLayout().template, summary.stat, { width: 1920, height: 1080 }),
  summary,
});
const date = (extra: Partial<NonNullable<OverlayComponent['date']>> = {}): OverlayComponent => {
  const made = newStillComponent(defaultStaticLayout().template, 'date', { width: 1920, height: 1080 });
  // A new date speaks the browser's language; these tests start from an older layout's, which has none.
  return { ...made, date: { format: 'medium', withTime: false, timeZone: 'reader', ...extra } };
};
const value = (component: OverlayComponent, activity = ride()) => stillValue(component, contextOf(activity));

describe('a figure in the reader’s words (AV-1032, TD-104)', () => {
  it('replaces the caption, and an empty caption keeps the app’s', () => {
    expect(value(figure({ stat: 'distance', caption: 'How far' }))).toMatchObject({ ok: true, caption: 'How far', value: '9.99 km' });
    expect(value(figure({ stat: 'distance', caption: '' }))).toMatchObject({ caption: 'Distance' });
    expect(value(figure({ stat: 'distance' }))).toMatchObject({ caption: 'Distance' });
  });

  it('draws the caption replaced, and hides it as before', () => {
    const shown = layoutStillText(figure({ stat: 'distance', caption: 'How far' }), value(figure({ stat: 'distance', caption: 'How far' })) as never, '#fff', { width: 1920, height: 1080 }, measure);
    expect(shown.lines.map((line) => line.text)).toEqual(['HOW FAR', '9.99 km']);
    const hidden = { ...figure({ stat: 'distance', caption: 'How far' }), text: { align: 'left' as const, weight: 'bold' as const, caption: false } };
    const plain = layoutStillText(hidden, value(hidden) as never, '#fff', { width: 1920, height: 1080 }, measure);
    expect(plain.lines.map((line) => line.text)).toEqual(['9.99 km']);
  });

  it('writes the decimals asked for: 9.99 km as 10 km', () => {
    expect(value(figure({ stat: 'distance', decimals: 0 }))).toMatchObject({ value: '10 km' });
    expect(value(figure({ stat: 'distance', decimals: 1 }))).toMatchObject({ value: '10.0 km' });
    expect(value(figure({ stat: 'distance', decimals: 2 }))).toMatchObject({ value: '9.99 km' });
    expect(value(figure({ stat: 'climb', decimals: 1 }), { ...ride(), derived: { ...ride().derived, elevationGainMeters: 12.34 } } as Activity)).toMatchObject({ value: '12.3 m' });
  });

  it('leaves clocks as they are whatever the decimals', () => {
    expect(value(figure({ stat: 'elapsed', decimals: 2 }))).toEqual(value(figure({ stat: 'elapsed' })));
  });

  it('keeps a hand value to one line, as a caption is, in a layout and when drawn', () => {
    expect(value(figure({ stat: 'distance', ownValue: 'a\nb' }))).toMatchObject({ value: 'a' });
    expect(value(date({ ownValue: 'a\nb' }))).toMatchObject({ value: 'a' });
  });

  it('writes decimals in km or mi even for a short distance, as asked', () => {
    expect(value(figure({ stat: 'distance', decimals: 1 }), ride(900))).toMatchObject({ value: '0.9 km' });
  });

  it('draws a hand-written value as written, and never recalculates it', () => {
    const own = figure({ stat: 'distance', ownValue: 'about 10 km' });
    expect(value(own)).toEqual({ ok: true, caption: 'Distance', value: 'about 10 km' });
    expect(value(own, ride(42_000))).toEqual({ ok: true, caption: 'Distance', value: 'about 10 km' });
    expect(value(figure({ stat: 'distance', ownValue: '' }))).toMatchObject({ ok: false });
  });

  it('cleans and limits the reader’s text: control characters out, at most the free-text length', () => {
    const long = 'x'.repeat(LABEL_MAX_LENGTH + 50);
    const own = value(figure({ stat: 'distance', ownValue: `a\u0000b\u0007${long}` }));
    expect(own).toMatchObject({ ok: true });
    if (own.ok) {
      expect(own.value.startsWith('ab')).toBe(true);
      expect(own.value.length).toBe(LABEL_MAX_LENGTH);
    }
    const caption = value(figure({ stat: 'distance', caption: `<b>Hi</b>\nsecond line\u0001` }));
    expect(caption).toMatchObject({ caption: '<b>Hi</b>' });
  });
});

describe('a date in the reader’s language and words (AV-1032, TD-104)', () => {
  it('is English when the layout says no language, and in the language when it does', () => {
    expect(value(date({ format: 'long' }))).toMatchObject({ value: 'Thursday 5 March 2026' });
    expect(value(date({ format: 'long', locale: 'es' }))).toMatchObject({ value: 'jueves 5 marzo 2026' });
  });

  it('names the month in the Gregorian calendar whatever the language’s own', () => {
    const fa = value(date({ format: 'long', locale: 'fa' }));
    expect(fa.ok && fa.value).not.toMatch(/مهر|اسفند/);
    expect(value(date({ format: 'medium', locale: 'ar-SA-u-ca-islamic' }))).toMatchObject({ ok: true });
  });

  it('cleans a date’s own text and limits its length', () => {
    const own = value(date({ ownValue: `a\u0000${'y'.repeat(LABEL_MAX_LENGTH + 9)}` }));
    expect(own.ok && own.value.length).toBe(LABEL_MAX_LENGTH);
  });

  it('draws the reader’s text as written', () => {
    expect(value(date({ ownValue: 'Race day' }))).toEqual({ ok: true, caption: 'Date', value: 'Race day' });
    expect(value(date({ ownValue: '   ' }))).toMatchObject({ ok: false });
  });

  it('gives a new date the browser’s language', () => {
    const made = newStillComponent(defaultStaticLayout().template, 'date', { width: 1920, height: 1080 });
    expect(made.date?.locale).toBe(navigator.language);
  });
});

describe('the layout file with the reader’s words (AV-1032, TD-104)', () => {
  const layoutWith = (components: OverlayComponent[]) => {
    const layout = defaultStaticLayout();
    return { ...layout, template: { ...layout.template, components } };
  };

  it('round-trips caption, decimals, own values and the language, still in template version 2', () => {
    const layout = layoutWith([
      { ...figure({ stat: 'distance', caption: 'How far', decimals: 0, ownValue: '10 km' }), id: 'a' },
      { ...date({ locale: 'ja', ownValue: 'Race day' }), id: 'b' },
    ]);
    const text = serializeStillLayout(layout);
    expect(JSON.parse(text).template.version).toBe(2);
    const back = parseStillLayout(text);
    if (!back.ok) throw new Error(back.error);
    expect(back.warnings).toEqual([]);
    expect(back.layout.template.components.map((c) => c.summary ?? c.date)).toEqual([
      { stat: 'distance', caption: 'How far', decimals: 0, ownValue: '10 km' },
      { format: 'medium', withTime: false, timeZone: 'reader', locale: 'ja', ownValue: 'Race day' },
    ]);
  });

  it('opens an older layout unchanged: the app’s caption and value, an English date', () => {
    const old = layoutWith([
      { ...figure({ stat: 'distance' }), id: 'a' },
      { ...date(), id: 'b' },
    ]);
    const back = parseStillLayout(serializeStillLayout(old));
    if (!back.ok) throw new Error(back.error);
    const [a, b] = back.layout.template.components;
    expect(a!.summary).toEqual({ stat: 'distance' });
    expect(b!.date).toEqual({ format: 'medium', withTime: false, timeZone: 'reader' });
    expect(value(b!)).toMatchObject({ value: '5 Mar 2026' });
  });

  it('cleans what a layout file says: a made-up language, loose text and a bad decimal are dropped or cleaned', () => {
    const parsed = parseOverlayTemplate(
      JSON.stringify({
        ...JSON.parse(serializeStillLayout(layoutWith([{ ...figure({ stat: 'distance' }), id: 'a' }, { ...date(), id: 'b' }])) ).template,
      }).replace('"stat":"distance"', '"stat":"distance","caption":"Hi\\u0000\\nthere","decimals":7,"ownValue":"1\\u0000"').replace('"timeZone":"reader"', '"timeZone":"reader","locale":"zz not a tag"'),
    );
    if (!parsed.ok) throw new Error(String(parsed.error));
    const [a, b] = parsed.template.components;
    expect(a!.summary).toEqual({ stat: 'distance', caption: 'Hi', ownValue: '1' });
    expect(b!.date).toEqual({ format: 'medium', withTime: false, timeZone: 'reader' });
  });
});
