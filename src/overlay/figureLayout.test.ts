import { describe, expect, it } from 'vitest';
import { figureLayout, haloShadow, type FigureLayoutInput } from './figureLayout';

const base: FigureLayoutInput = {
  em: 40,
  frameWidth: 2000,
  label: 'Speed',
  value: '18.0 km/h',
  figure: undefined,
  track: false,
  measure: (text, font) => text.length * Number(/([\d.]+)px/.exec(font)![1]) * 0.5,
};

describe('a figure’s layout (AV-1015, TD-083)', () => {
  it('is today’s when nothing is set: 0.55 em over 1.1 em, the label’s line 1.2 times its size', () => {
    const laid = figureLayout(base);
    expect(laid.labelSize).toBe(0.55 * 40);
    expect(laid.valueSize).toBe(1.1 * 40);
    expect(laid.labelAdvance).toBe(0.55 * 40 * 1.2);
    expect(laid.contentHeight).toBe(0.55 * 40 * 1.2 + 1.1 * 40 * 1.1);
    expect(laid.padX).toBe(0.6 * 40);
    expect(laid.align).toBe('left');
    expect(laid.showLabel).toBe(true);
  });

  it('sizes each line on its own, and the gap in frame widths', () => {
    const laid = figureLayout({ ...base, figure: { labelScale: 2, valueScale: 0.5, gap: 0.01 } });
    expect(laid.labelSize).toBe(0.55 * 40 * 2);
    expect(laid.valueSize).toBe(1.1 * 40 * 0.5);
    expect(laid.labelAdvance).toBe(laid.labelSize + 0.01 * 2000);
  });

  it('leaves the label out of the height and the width when it is hidden, and adds a gauge’s track', () => {
    const shown = figureLayout({ ...base, label: 'A very long label indeed', track: true });
    const hidden = figureLayout({ ...base, label: 'A very long label indeed', track: true, figure: { showLabel: false } });
    expect(hidden.contentHeight).toBe(1.1 * 40 * 1.1 + 0.2 * 40 + 0.25 * 40);
    expect(shown.contentHeight - hidden.contentHeight).toBeCloseTo(0.55 * 40 * 1.2);
    expect(hidden.neededWidth).toBeLessThan(shown.neededWidth);
    expect(hidden.neededWidth).toBe(2 * 0.6 * 40 + '18.0 km/h'.length * 1.1 * 40 * 0.5);
  });

  it('needs the widest line, the inset either side, and the least top and bottom', () => {
    const laid = figureLayout(base);
    expect(laid.neededWidth).toBe(2 * 24 + Math.max('SPEED'.length * 22 * 0.5, '18.0 km/h'.length * 44 * 0.5));
    expect(laid.neededHeight).toBe(laid.contentHeight + 2 * 0.3 * 40);
  });

  it('measures nothing when it is only drawing: no more width than the inset', () => {
    expect(figureLayout({ ...base, measure: undefined }).neededWidth).toBe(2 * 0.6 * 40);
  });
});

describe('a figure’s halo (AV-1015, TD-083)', () => {
  it('is today’s black at 80 % when unset, the figure’s colour and opacity when set, and none at 0', () => {
    expect(haloShadow(undefined)).toBe('rgb(0 0 0 / 0.8)');
    expect(haloShadow({ halo: { color: '#ff8000', opacity: 0.5 } })).toBe('rgb(255 128 0 / 0.5)');
    expect(haloShadow({ halo: { color: '#ff8000', opacity: 0 } })).toBeUndefined();
  });
});
