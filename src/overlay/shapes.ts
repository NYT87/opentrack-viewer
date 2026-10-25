import type { OverlayShapeSetting } from './template';

/**
 * AV-1011. Draws a shape into its box: a card behind the figures, a frame, or
 * a rule. One function for every renderer, the video overlay's and the still
 * image's, so a shape looks the same in a preview, a PNG sequence, a burned-in
 * video and a still.
 *
 * Widths and radii are shares of the frame's shorter side, given here in
 * pixels, so a shape keeps its proportions at any resolution. The border is
 * drawn inside the box, so a shape never reaches past where it was placed: a
 * border wider than a narrow box allows is drawn as wide as the box allows.
 */

/** The part of a 2D context a shape needs: a canvas's and an offscreen canvas's alike. */
export interface ShapeContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  roundRect?: (x: number, y: number, w: number, h: number, radius: number) => void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  globalAlpha: number;
}

export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function drawShape(ctx: ShapeContext, box: ShapeBox, shape: OverlayShapeSetting, shorterSide: number): void {
  const narrowest = Math.max(0, Math.min(box.w, box.h));
  // A line can be as thick as its box is narrow; a border, half that, where it meets itself and fills the box.
  const room = shape.kind === 'line' ? narrowest : narrowest / 2;
  const stroke = Math.min(Math.max(0, shape.strokeWidth * shorterSide), room);
  const hasStroke = stroke > 0 && shape.strokeOpacity > 0;
  ctx.save();

  if (shape.kind === 'line') {
    // A line is its border: from one corner of its box to the other, its round
    // ends inset by half its width so they end inside the box too.
    if (hasStroke) {
      const inset = stroke / 2;
      ctx.beginPath();
      ctx.moveTo(box.x + inset, box.y + inset);
      ctx.lineTo(box.x + box.w - inset, box.y + box.h - inset);
      ctx.lineCap = 'round';
      ctx.lineWidth = stroke;
      ctx.strokeStyle = shape.stroke;
      ctx.globalAlpha = shape.strokeOpacity;
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // The border is inside the box: the path is inset by half its width.
  const inset = hasStroke ? stroke / 2 : 0;
  const inner = { x: box.x + inset, y: box.y + inset, w: Math.max(0, box.w - 2 * inset), h: Math.max(0, box.h - 2 * inset) };
  const path = () => {
    ctx.beginPath();
    if (shape.kind === 'ellipse') {
      ctx.ellipse(inner.x + inner.w / 2, inner.y + inner.h / 2, inner.w / 2, inner.h / 2, 0, 0, Math.PI * 2);
    } else if (shape.kind === 'roundedRect' && typeof ctx.roundRect === 'function') {
      const radius = Math.min(shape.radius * shorterSide, inner.w / 2, inner.h / 2);
      ctx.roundRect(inner.x, inner.y, inner.w, inner.h, Math.max(0, radius));
    } else {
      ctx.rect(inner.x, inner.y, inner.w, inner.h);
    }
  };

  if (shape.fillOpacity > 0) {
    path();
    ctx.fillStyle = shape.fill;
    ctx.globalAlpha = shape.fillOpacity;
    ctx.fill();
  }
  if (hasStroke) {
    path();
    ctx.lineWidth = stroke;
    ctx.strokeStyle = shape.stroke;
    ctx.globalAlpha = shape.strokeOpacity;
    ctx.stroke();
  }
  ctx.restore();
}
