import { haloShadow, type FigureLayout } from '../figureLayout';
import { needsHalo, type ResolvedOverlayComponent } from '../template';
import type { OverlayContext2D } from './drawOverlay';

/**
 * AV-1019 (TD-087). A figure's two lines, a label over a value, drawn where a
 * component puts them: the dial's centre, the compass, the gradient's side. The
 * sizes, fonts, label colour, spacing and halo are the figure's own (AV-1015),
 * from the same `figureLayout` that `drawFigure` draws with, so these new
 * components are styled with the same controls.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

export interface LabelValueAt {
  /** The x the text is aligned to. */
  x: number;
  /** The top of the first line. */
  top: number;
  align: 'left' | 'center' | 'right';
  /** The widest a line is drawn; wider text is squeezed to it, never drawn beyond. */
  maxWidth: number;
  /** The value's colour; the style's text colour when absent. */
  valueColor?: string;
}

/** Draws the label (upper case, unless the figure hides it) and the value. */
export function drawLabelValue(ctx: OverlayContext2D, ready: Ready, layout: FigureLayout, em: number, at: LabelValueAt): void {
  const figure = ready.component.figure;
  const shadow = needsHalo(ready.style) ? haloShadow(figure) : undefined;
  let y = at.top;
  ctx.textBaseline = 'top';
  ctx.textAlign = at.align;
  if (shadow) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = 0.2 * em;
  }
  if (layout.showLabel && ready.label) {
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = figure?.labelColor ?? ready.style.textColor;
    ctx.font = layout.labelFont;
    ctx.fillText(ready.label.toUpperCase(), at.x, y, Math.max(1, at.maxWidth));
    ctx.globalAlpha = 1;
    y += layout.labelAdvance;
  }
  ctx.fillStyle = at.valueColor ?? ready.style.textColor;
  ctx.font = layout.valueFont;
  ctx.fillText(ready.text ?? '', at.x, y, Math.max(1, at.maxWidth));
  if (shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
}
