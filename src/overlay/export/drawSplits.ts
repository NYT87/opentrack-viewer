import { FIGURE_FONT_FAMILY, haloShadow } from '../figureLayout';
import { splitsMetrics, type SplitRow, type SplitVerdict, type SplitsView } from '../splits';
import { needsHalo, type ResolvedOverlayComponent } from '../template';
import type { Box, OverlayContext2D } from './drawOverlay';

/**
 * AV-1021 (TD-090). Draws a splits component in its box: the split under way,
 * its number over the time so far; then, where the reader asked, the last
 * finished split with how it compares with the one before it, and a list of
 * the last few, newest first, each a number, a time and a pace or speed. A split
 * that was faster or slower is in the colour for it, and is also said in words
 * ("faster") on the last split's label, so the colour is never all there is.
 *
 * The one drawing: the preview, the PNG sequence, the WebM, the burned-in video
 * and the map video all call it through `createOverlayRenderer`. The caller has
 * clipped to the box and painted its background. Type uses the figures' own
 * fonts, sizes and halo (AV-1015); the lines are left aligned, with a rate at the
 * right of each, as a dial's and a chart's text sits where its picture puts it.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

const VERDICT_WORDS: Record<SplitVerdict, string> = { faster: 'faster', slower: 'slower', same: '' };

export function drawSplits(ctx: OverlayContext2D, box: Box, ready: Ready, em: number, frameWidth: number, view: SplitsView | undefined): void {
  const resolved = ready.splits;
  if (!resolved || !view) return;
  const { setting } = resolved;
  const figure = ready.component.figure;

  const { pad, labelSize, valueSize, lastSize, rowSize, labelAdvance, showLabel } = splitsMetrics(em, frameWidth, figure);
  const rateSize = (size: number) => Math.max(size * 0.5, 0.4 * em);
  const labelFont = `${labelSize}px ${FIGURE_FONT_FAMILY}`;
  const font = (size: number, bold = false) => `${bold ? 'bold ' : ''}${size}px ${FIGURE_FONT_FAMILY}`;
  const left = box.x + pad;
  const right = box.x + box.w - pad;
  const inner = Math.max(1, right - left);
  const labelColor = figure?.labelColor ?? ready.style.textColor;
  const shadow = needsHalo(ready.style) ? haloShadow(figure) : undefined;
  const colorOf = (verdict: SplitVerdict | undefined) =>
    verdict === 'faster' ? setting.fasterColor : verdict === 'slower' ? setting.slowerColor : ready.style.textColor;

  const text = (value: string, x: number, y: number, fontCss: string, color: string, alpha: number, align: 'left' | 'right', maxWidth: number) => {
    ctx.font = fontCss;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.textAlign = align;
    ctx.fillText(value, x, y, Math.max(1, maxWidth));
  };

  ctx.textBaseline = 'top';
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = 0.2 * em;
  }
  let y = box.y + 0.5 * em;

  /** A label over a line with a time at its left and a rate at its right, the rate under the time's width. */
  const block = (label: string, row: SplitRow, size: number, color: string) => {
    if (showLabel) {
      text(label.toUpperCase(), left, y, labelFont, labelColor, 0.75, 'left', inner);
      y += labelAdvance;
    }
    ctx.font = font(size, true);
    const timeWidth = (typeof ctx.measureText === 'function' ? ctx.measureText(row.text)?.width : undefined) ?? row.text.length * size * 0.55;
    text(row.text, left, y, font(size, true), color, 1, 'left', inner);
    if (row.rateText) {
      const rateFont = font(rateSize(size));
      const room = inner - timeWidth - 0.5 * em;
      if (room > 1) text(row.rateText, right, y + (size - rateSize(size)) * 0.8, rateFont, color, 0.9, 'right', room);
    }
    y += size * 1.1;
  };

  block(`${ready.label ?? 'Split'} ${view.current.number}`, view.current, valueSize, ready.style.textColor);
  if (view.last) {
    y += 0.3 * em;
    const word = view.last.verdict ? VERDICT_WORDS[view.last.verdict] : '';
    block(`${ready.label ?? 'Split'} ${view.last.number}${word ? ` · ${word}` : ''}`, view.last, lastSize, colorOf(view.last.verdict));
  }
  if (view.list.length > 0) {
    y += 0.3 * em;
    const numberWidth = 0.22 * inner;
    for (const row of view.list) {
      if (y + rowSize > box.y + box.h) break;
      const color = colorOf(row.verdict);
      text(String(row.number), left, y, font(rowSize), labelColor, 0.75, 'left', numberWidth);
      text(row.text, left + numberWidth, y, font(rowSize, true), color, 1, 'left', inner - numberWidth);
      if (row.rateText) text(row.rateText, right, y, font(rowSize), color, 0.9, 'right', inner * 0.5);
      y += rowSize * 1.35;
    }
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  if (shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
}
