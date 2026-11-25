import { figureLayout, haloShadow, FIGURE_MIN_TOP_EMS } from '../figureLayout';
import { DEFAULT_GRADIENT, gradientBand, gradientGlyph, type GradientGlyph } from '../gradient';
import { needsHalo, type ResolvedOverlayComponent } from '../template';
import type { Box, OverlayContext2D } from './drawOverlay';
import { drawLabelValue } from './drawText';

/**
 * AV-1019 (TD-087). Draws the gradient indicator in its box: the grade written
 * as a figure, with a glyph for up, down or flat, both in the colour of the
 * band the grade is in. The glyph is a path (a triangle or a bar), never a font
 * character, so every browser and the export's worker draw it alike. The caller
 * has clipped to the box and painted its background.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** The glyph's size, as a share of the value's type size. */
export const GLYPH_SHARE = 0.85;

/** Draws a glyph in a square whose top-left corner is `(x, y)`. */
export function drawGlyph(ctx: OverlayContext2D, kind: GradientGlyph, x: number, y: number, size: number): void {
  ctx.beginPath();
  if (kind === 'up') {
    ctx.moveTo(x + size / 2, y);
    ctx.lineTo(x + size, y + size);
    ctx.lineTo(x, y + size);
  } else if (kind === 'down') {
    ctx.moveTo(x, y);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x + size / 2, y + size);
  } else {
    ctx.rect(x, y + size * 0.38, size, size * 0.24);
  }
  ctx.closePath();
  ctx.fill();
}

export function drawGradient(ctx: OverlayContext2D, box: Box, ready: Ready, em: number, frameWidth: number): void {
  const setting = ready.component.gradient ?? DEFAULT_GRADIENT;
  const grade = ready.value;
  if (grade === undefined) return;
  const color = setting.bands[gradientBand(grade, setting.bands)]!.color;
  const figure = ready.component.figure;
  const layout = figureLayout({ em, frameWidth, label: ready.label, value: ready.text ?? '', figure, track: false });
  const { padX } = layout;
  const glyphSize = setting.glyph ? GLYPH_SHARE * layout.valueSize : 0;
  const glyphGap = setting.glyph ? 0.35 * em : 0;
  const top = box.y + Math.max(FIGURE_MIN_TOP_EMS * em, (box.h - layout.contentHeight) / 2);
  // The glyph is at the value's line, and the text is aligned as a figure's is, in what is left beside the glyph.
  const left = box.x + padX + glyphSize + glyphGap;
  const right = box.x + box.w - padX;
  const x = layout.align === 'center' ? (left + right) / 2 : layout.align === 'right' ? right : left;
  drawLabelValue(ctx, ready, layout, em, { x, top, align: layout.align, maxWidth: Math.max(1, right - left), valueColor: color });
  if (setting.glyph) {
    const valueTop = top + (layout.showLabel ? layout.labelAdvance : 0);
    ctx.fillStyle = color;
    const shadow = needsHalo(ready.style) ? haloShadow(figure) : undefined;
    if (shadow) {
      ctx.shadowColor = shadow;
      ctx.shadowBlur = 0.2 * em;
    }
    drawGlyph(ctx, gradientGlyph(grade), box.x + padX, valueTop + (layout.valueSize * 1.1 - glyphSize) / 2, glyphSize);
    if (shadow) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
  }
}
