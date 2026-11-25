import { describe, expect, it } from 'vitest';
import type { MeasureText } from '../overlay/staticImage';
import { MAX_PANEL_SHARE, fitText, planPanel, type PanelContent, type PanelItem } from './panel';

/** Every character the same width, a little over half the type's size: a stand-in for the browser's own. */
const measure: MeasureText = (text, font) => text.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)![1]) * 0.56;

const figures = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ caption: ['Distance', 'Moving time', 'Elevation gain', 'Avg pace', 'Elapsed time', 'Avg heart rate', 'Avg speed'][i]!, value: ['42.20 km', '3:12:44', '1,240 m', '4:33 /km', '3:20:01', '151 bpm', '13.2 km/h'][i]! }));

const full: PanelContent = { title: 'Morning ride over the pass', date: 'Thursday 24 September 2026, 08:15', figures: figures(6), profile: true };

const texts = (items: PanelItem[], role: string) => items.filter((item): item is Extract<PanelItem, { kind: 'text' }> => item.kind === 'text' && item.role === role);
const rows = (items: PanelItem[]) => new Set(texts(items, 'value').map((item) => item.y)).size;
const columns = (items: PanelItem[]) => new Set(texts(items, 'value').map((item) => item.x)).size;

describe('the map image’s panel (AV-1013)', () => {
  it('is nothing at all with nothing chosen, and the map has the whole image', () => {
    expect(planPanel({ figures: [], profile: false }, { width: 1080, height: 1350 }, measure)).toEqual({ height: 0, scale: 1, items: [] });
  });

  it('grows with what it holds: a title, then figures, then the profile, each adding height', () => {
    const size = { width: 1080, height: 1350 };
    const title = planPanel({ title: 'Ride', figures: [], profile: false }, size, measure).height;
    const withFigures = planPanel({ title: 'Ride', figures: figures(3), profile: false }, size, measure).height;
    const withProfile = planPanel({ title: 'Ride', figures: figures(3), profile: true }, size, measure).height;
    expect(title).toBeGreaterThan(0);
    expect(withFigures).toBeGreaterThan(title);
    expect(withProfile).toBeGreaterThan(withFigures);
    // A second row of figures adds a row's height, not a fixed box's.
    const sixFigures = planPanel({ title: 'Ride', figures: figures(6), profile: false }, size, measure);
    expect(rows(sixFigures.items)).toBe(2);
    expect(sixFigures.height).toBeGreaterThan(withFigures);
  });

  it('sets as many even columns as the widest figure allows, balanced so no row is one figure alone', () => {
    const wide = planPanel({ figures: figures(5), profile: false }, { width: 1920, height: 1080 }, measure);
    expect(rows(wide.items)).toBe(1);
    expect(columns(wide.items)).toBe(5);
    const narrow = planPanel({ figures: figures(5), profile: false }, { width: 1080, height: 1350 }, measure);
    // Four would fit across, but 4 + 1 is set as 3 + 2.
    expect(columns(narrow.items)).toBe(3);
    expect(rows(narrow.items)).toBe(2);
    // Every figure stays inside the panel's side margins.
    for (const item of texts(narrow.items, 'value')) expect(item.x + item.maxWidth).toBeLessThanOrEqual(1080 - 40);
  });

  it('keeps the same share of each image shape, and never more than half of it', () => {
    for (const size of [
      { width: 1080, height: 1350 },
      { width: 1080, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1200, height: 630 },
      { width: 1920, height: 1080 },
      { width: 3840, height: 2160 },
    ]) {
      const panel = planPanel(full, size, measure);
      expect(panel.height, `${size.width} × ${size.height}`).toBeGreaterThan(size.height * 0.15);
      expect(panel.height, `${size.width} × ${size.height}`).toBeLessThanOrEqual(size.height * MAX_PANEL_SHARE + 1);
      // Everything inside the panel.
      for (const item of panel.items) {
        const bottom = item.kind === 'profile' ? item.y + item.h : item.y + item.size * 1.2;
        expect(bottom).toBeLessThanOrEqual(panel.height);
      }
    }
    // The same details at twice the pixels take the same share.
    const hd = planPanel(full, { width: 1920, height: 1080 }, measure).height / 1080;
    const uhd = planPanel(full, { width: 3840, height: 2160 }, measure).height / 2160;
    expect(uhd).toBeCloseTo(hd, 2);
  });

  it('sets the type smaller on a short image rather than let the panel take it over', () => {
    const link = planPanel(full, { width: 1200, height: 630 }, measure);
    const natural = Math.sqrt(1200 * 630) / Math.sqrt(1080 * 1350);
    expect(link.scale).toBeLessThan(natural);
    expect(link.height).toBeLessThanOrEqual(630 * MAX_PANEL_SHARE + 1);
  });

  it('cuts a title too long for the image with an ellipsis', () => {
    const panel = planPanel({ title: 'A very long name for a ride that goes on and on and on over every pass in the Alps', figures: [], profile: false }, { width: 1080, height: 1350 }, measure);
    const [title] = texts(panel.items, 'title');
    expect(title!.text.endsWith('…')).toBe(true);
    expect(measure(title!.text, title!.font)).toBeLessThanOrEqual(title!.maxWidth);
    expect(fitText('Short', '20px sans-serif', 500, measure)).toBe('Short');
  });
});
