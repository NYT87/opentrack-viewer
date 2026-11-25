import type { ComponentDraw, SplitRowProps, SplitsProps } from '../../../src/overlay/contract';

/**
 * Splits as lines of text: the split under way (its number and the time so far, with the pace or
 * speed at the right), then the last finished split in the colour of how it went, then the list,
 * newest first. A split that went faster or slower is in the reader's colour for it, and the last
 * split's label says so in words as well, so the colour is never all there is. AV-1021.
 */
export const draw: ComponentDraw<SplitsProps> = (ctx, props) => {
  const { box, fontPx, style, current, last, list, fasterColor, slowerColor } = props;
  const pad = 0.6 * fontPx;
  const left = box.x + pad;
  const right = box.x + box.width - pad;
  const width = Math.max(1, right - left);
  const colorOf = (row: SplitRowProps) => (row.verdict === 'faster' ? fasterColor : row.verdict === 'slower' ? slowerColor : style.textColor);

  ctx.save();
  ctx.textBaseline = 'top';
  let y = box.y + 0.5 * fontPx;

  /** A small label over a line: the time at the left, the rate (when there is one) at the right. */
  const line = (label: string, row: SplitRowProps, size: number) => {
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = style.textColor;
    ctx.font = `${0.55 * fontPx}px system-ui, sans-serif`;
    ctx.fillText(label.toUpperCase(), left, y, width);
    y += 0.66 * fontPx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = colorOf(row);
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.fillText(row.text, left, y, width);
    if (row.rateText) {
      ctx.textAlign = 'right';
      ctx.font = `${0.5 * size}px system-ui, sans-serif`;
      ctx.fillText(row.rateText, right, y + 0.5 * size, width / 2);
    }
    y += 1.1 * size;
  };

  line(`Split ${current.number}`, current, 1.1 * fontPx);
  if (last) {
    y += 0.3 * fontPx;
    line(`Split ${last.number}${last.verdict && last.verdict !== 'same' ? ` · ${last.verdict}` : ''}`, last, 0.9 * fontPx);
  }
  ctx.textAlign = 'left';
  ctx.font = `${0.6 * fontPx}px system-ui, sans-serif`;
  for (const row of list) {
    y += 0.3 * fontPx;
    if (y + 0.6 * fontPx > box.y + box.height) break;
    ctx.fillStyle = colorOf(row);
    ctx.fillText(`${row.number}  ${row.text}${row.rateText ? `  ${row.rateText}` : ''}`, left, y, width);
    y += 0.7 * fontPx;
  }
  ctx.restore();
};
