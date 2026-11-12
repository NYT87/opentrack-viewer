import type { ComponentDraw, FigureProps } from '../../../src/overlay/contract';

/**
 * A live figure: the label small over the value large, left-aligned in its box.
 * It draws `props.text` as given (already formatted, in the reader's units) and
 * never formats `props.value` itself. AV-1017.
 */
export const draw: ComponentDraw<FigureProps> = (ctx, props) => {
  const { box, fontPx, style, label, text } = props;
  const pad = 0.5 * fontPx;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.globalAlpha = 0.75;
  ctx.fillStyle = style.textColor;
  ctx.font = `600 ${0.55 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(label.toUpperCase(), box.x + pad, box.y + pad);

  ctx.globalAlpha = 1;
  ctx.font = `700 ${1.1 * fontPx}px system-ui, sans-serif`;
  ctx.fillText(text, box.x + pad, box.y + pad + 0.8 * fontPx);
  ctx.restore();
};
