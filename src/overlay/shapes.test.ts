import { describe, expect, it } from 'vitest';
import { drawShape, type ShapeContext } from './shapes';
import { DEFAULT_SHAPE, type OverlayShapeSetting } from './template';

/** Records each path call, and the colour, alpha and width at each fill and stroke. */
function recorder() {
  const calls: string[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: number[]) => {
        const at = key === 'fill' ? ` ${String(target.fillStyle)} ${String(target.globalAlpha)}` : key === 'stroke' ? ` ${String(target.strokeStyle)} ${String(target.globalAlpha)} ${String(target.lineWidth)}` : '';
        calls.push(`${key}(${args.map((arg) => Math.round(arg * 100) / 100).join(', ')})${at}`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as ShapeContext;
  return { ctx, calls };
}

const shape = (patch: Partial<OverlayShapeSetting>): OverlayShapeSetting => ({ ...DEFAULT_SHAPE, ...patch });
const box = { x: 100, y: 50, w: 200, h: 100 };

describe('drawing a shape (AV-1011)', () => {
  it('fills and borders a rounded rectangle, the border inside the box, at their own transparencies', () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, box, shape({ fill: '#123456', fillOpacity: 0.4, stroke: '#ffffff', strokeOpacity: 0.9, strokeWidth: 0.01, radius: 0.05 }), 1000);
    expect(calls).toEqual([
      'save()',
      'beginPath()',
      'roundRect(105, 55, 190, 90, 45)',
      'fill() #123456 0.4',
      'beginPath()',
      'roundRect(105, 55, 190, 90, 45)',
      'stroke() #ffffff 0.9 10',
      'restore()',
    ]);
  });

  it('draws no fill when it is fully transparent, and no border when that is', () => {
    const { ctx, calls } = recorder();
    drawShape(ctx, box, shape({ kind: 'rect', fillOpacity: 0, strokeOpacity: 0 }), 1000);
    expect(calls).toEqual(['save()', 'restore()']);
  });

  it('draws an ellipse in its box, and a line corner to corner as a stroke only', () => {
    const ellipse = recorder();
    drawShape(ellipse.ctx, box, shape({ kind: 'ellipse', strokeOpacity: 0 }), 1000);
    expect(ellipse.calls).toContain('ellipse(200, 100, 100, 50, 0, 0, 6.28)');
    const line = recorder();
    drawShape(line.ctx, box, shape({ kind: 'line', fillOpacity: 1, strokeOpacity: 1, strokeWidth: 0.004 }), 1000);
    expect(line.calls).toEqual(['save()', 'beginPath()', 'moveTo(102, 52)', 'lineTo(298, 148)', `stroke() ${DEFAULT_SHAPE.stroke} 1 4`, 'restore()']);
  });

  it('keeps an oversized border inside a narrow box, and a thick line from turning back on itself', () => {
    const narrow = { x: 0, y: 0, w: 10, h: 100 };
    const card = recorder();
    // 50 px asked for, in a box 10 px wide: the border is 5 px, filling the box, and starts at its edge.
    drawShape(card.ctx, narrow, shape({ kind: 'rect', fillOpacity: 0, strokeOpacity: 1, strokeWidth: 0.05 }), 1000);
    expect(card.calls).toEqual(['save()', 'beginPath()', 'rect(2.5, 2.5, 5, 95)', `stroke() ${DEFAULT_SHAPE.stroke} 1 5`, 'restore()']);
    const ellipse = recorder();
    drawShape(ellipse.ctx, narrow, shape({ kind: 'ellipse', fillOpacity: 0, strokeOpacity: 1, strokeWidth: 0.05 }), 1000);
    expect(ellipse.calls).toContain('ellipse(5, 50, 2.5, 47.5, 0, 0, 6.28)');
    // A line 50 px thick in a box 10 px tall: 10 px thick, level, and still running left to right.
    const line = recorder();
    drawShape(line.ctx, { x: 0, y: 0, w: 200, h: 10 }, shape({ kind: 'line', strokeOpacity: 1, strokeWidth: 0.05 }), 1000);
    expect(line.calls).toEqual(['save()', 'beginPath()', 'moveTo(5, 5)', 'lineTo(195, 5)', `stroke() ${DEFAULT_SHAPE.stroke} 1 10`, 'restore()']);
    // Nothing at all in a box with no room.
    const flat = recorder();
    drawShape(flat.ctx, { x: 0, y: 0, w: 100, h: 0 }, shape({ kind: 'line', strokeOpacity: 1 }), 1000);
    expect(flat.calls).toEqual(['save()', 'restore()']);
  });
});
