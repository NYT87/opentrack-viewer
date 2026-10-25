import type { MeasureText } from './staticImage';

let measuring: CanvasRenderingContext2D | null | undefined;

/**
 * Text width as the browser will draw it: a canvas's own `measureText`, in
 * the same font. Without a canvas (a test's jsdom), a fixed estimate stands in,
 * so the layout logic still runs.
 */
export const measureText: MeasureText = (text, font) => {
  if (measuring === undefined) {
    try {
      measuring = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    } catch {
      measuring = null;
    }
  }
  if (measuring) {
    measuring.font = font;
    const width = measuring.measureText?.(text)?.width;
    if (typeof width === 'number' && Number.isFinite(width)) return width;
  }
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  return text.length * size * 0.56;
};

