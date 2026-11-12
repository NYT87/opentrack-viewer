import type { ComponentDraw, GradientProps } from '../../../src/overlay/contract';

/**
 * The gradient indicator: the grade written in the colour of its band, with a glyph
 * drawn as a path (a triangle up or down, or a bar), never as a font character. AV-1019.
 */
export const draw: ComponentDraw<GradientProps> = (ctx, props) => {
  const { box, fontPx, color, text, glyph } = props;
  const pad = 0.5 * fontPx;
  const size = 0.9 * fontPx;
  const x = box.x + pad;
  const y = box.y + (box.height - size) / 2;

  ctx.save();
  ctx.fillStyle = color;
  if (glyph) {
    ctx.beginPath();
    if (glyph === 'up') {
      ctx.moveTo(x + size / 2, y);
      ctx.lineTo(x + size, y + size);
      ctx.lineTo(x, y + size);
    } else if (glyph === 'down') {
      ctx.moveTo(x, y);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x + size / 2, y + size);
    } else {
      ctx.rect(x, y + 0.38 * size, size, 0.24 * size);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  const left = glyph ? x + size + 0.35 * fontPx : x;
  ctx.fillText(text, left, box.y + box.height / 2, Math.max(1, box.x + box.width - pad - left));
  ctx.restore();
};
