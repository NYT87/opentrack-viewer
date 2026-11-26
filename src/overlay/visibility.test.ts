import { describe, expect, it } from 'vitest';
import { parseVisibility, visibilityAt } from './visibility';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, parseOverlayTemplate, serializeOverlayTemplate, type OverlayTemplate } from './template';

const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 };

describe('the window a component is shown for (AV-1029, TD-101)', () => {
  it('is always shown without a window, and nothing outside [from, to)', () => {
    expect(visibilityAt(undefined, 123)).toBe(1);
    const window = { from: 10, to: 20 };
    expect([9.999, 10, 15, 19.999, 20, 21].map((t) => visibilityAt(window, t))).toEqual([0, 1, 1, 1, 0, 0]);
    expect(visibilityAt({ to: 5 }, 0)).toBe(1);
    expect(visibilityAt({ from: 5 }, 1e6)).toBe(1);
  });

  it('rises and falls linearly, and multiplies where the fades overlap', () => {
    const window = { from: 10, to: 20, fadeIn: 2, fadeOut: 4 };
    expect(visibilityAt(window, 10)).toBe(0);
    expect(visibilityAt(window, 11)).toBeCloseTo(0.5);
    expect(visibilityAt(window, 12)).toBe(1);
    expect(visibilityAt(window, 18)).toBeCloseTo(0.5);
    expect(visibilityAt(window, 19.9)).toBeCloseTo(0.025);
    // Fades that meet: 3 s window, 2 s each way. At 1.5 s both are 0.75.
    expect(visibilityAt({ from: 0, to: 3, fadeIn: 2, fadeOut: 2 }, 1.5)).toBeCloseTo(0.75 * 0.75);
    // A fade out needs an end to fall to.
    expect(visibilityAt({ fadeOut: 5 }, 100)).toBe(1);
  });

  it('reads a saved window as it may be used', () => {
    expect(parseVisibility({ from: 2.00049, to: 9.1239 })).toEqual({ from: 2, to: 9.124 });
    expect(parseVisibility({ from: -4, to: 8 })).toEqual({ to: 8 });
    // `to` must come after `from`; missing `from` is 0.
    expect(parseVisibility({ from: 10, to: 10 })).toEqual({ from: 10 });
    expect(parseVisibility({ from: 10, to: 4 })).toEqual({ from: 10 });
    expect(parseVisibility({ to: 0 })).toBeUndefined();
    // Fades: 0 to 10 s, and no longer than the window.
    expect(parseVisibility({ fadeIn: 99, fadeOut: -1 })).toEqual({ fadeIn: 10 });
    expect(parseVisibility({ from: 1, to: 4, fadeIn: 8, fadeOut: 2 })).toEqual({ from: 1, to: 4, fadeIn: 3, fadeOut: 2 });
    // A fade out falls toward an end: without one it says nothing.
    expect(parseVisibility({ fadeOut: 5 })).toBeUndefined();
    expect(parseVisibility({ from: 1e306 })).toBeUndefined();
    // Nothing that says anything is left out, and non-numbers are dropped.
    for (const nothing of [undefined, null, 5, 'x', {}, { from: 'a', to: null, fadeIn: Number.NaN, fadeOut: 0 }]) expect(parseVisibility(nothing)).toBeUndefined();
  });

  it('round-trips through the layout file, and a layout without it is unchanged', () => {
    const base = { id: 'a', type: 'text' as const, visible: true, rect, unitMode: 'auto' as const, style: {}, source: { kind: 'metric' as const, metric: 'speed' as const } };
    const timed: OverlayTemplate = { version: OVERLAY_TEMPLATE_VERSION, name: 'x', style: DEFAULT_OVERLAY_STYLE, components: [{ ...base, visibility: { from: 5, to: 15, fadeIn: 1, fadeOut: 2 } }, { ...base, id: 'b' }] };
    expect(parseOverlayTemplate(serializeOverlayTemplate(timed))).toEqual({ ok: true, template: timed, warnings: [] });
    const older = parseOverlayTemplate(JSON.stringify({ version: 2, name: 'x', components: [{ id: 'a', type: 'text', rect, source: { kind: 'metric', metric: 'speed' } }] }));
    expect(older.ok && older.template.components[0]).not.toHaveProperty('visibility');
  });
});
