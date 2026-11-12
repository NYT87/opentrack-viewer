import type { ComponentDraw, WholeActivityProps } from '../../../src/overlay/contract';

/**
 * A figure for the whole activity: its caption small over its text, set in the alignment and weight
 * the reader chose. It does not draw `activityName`: the name is not part of the box the words take,
 * so a component that shows it must make room for it. AV-1017.
 */
export const draw: ComponentDraw<WholeActivityProps> = (ctx, props) => {
  const { box, fontPx, style, text, caption, align, weight } = props;
  const x = align === 'center' ? box.x + box.width / 2 : align === 'right' ? box.x + box.width : box.x;
  let y = box.y;
  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  ctx.fillStyle = style.textColor;
  if (caption) {
    ctx.globalAlpha = 0.8;
    ctx.font = `600 ${0.45 * fontPx}px system-ui, sans-serif`;
    ctx.fillText(caption.toUpperCase(), x, y);
    y += 0.45 * fontPx * 1.2;
  }
  ctx.globalAlpha = 1;
  ctx.font = `${weight === 'bold' ? 700 : 400} ${fontPx}px system-ui, sans-serif`;
  for (const line of text.split('\n')) {
    ctx.fillText(line, x, y);
    y += fontPx * 1.2;
  }
  ctx.restore();
};
