import type { MeasureText } from './staticImage';
import type { OverlayFigureSetting, TextAlign } from './template';

/**
 * AV-1015 (TD-083). Where a live figure's two lines go inside its box, in one
 * pure place: the renderer draws from it and the editor measures from it, so a
 * box grown to fit is grown to what is drawn. Today's proportions are the
 * defaults (label 0.55 em, value 1.1 em, the label's line 1.2 times its size,
 * the value's 1.1, an inset of 0.6 em), so a figure with no settings is laid
 * out as it always was.
 */

export const FIGURE_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** How far the content sits from the box's top at least, in ems. */
export const FIGURE_MIN_TOP_EMS = 0.3;

export interface FigureLayoutInput {
  /** Type size in pixels at scale 1 for this figure: the base size times its font scale. */
  em: number;
  /** The frame's width in pixels, the unit the spacing is stored in. */
  frameWidth: number;
  /** The label as written; it is drawn in upper case. */
  label: string | undefined;
  value: string;
  figure: OverlayFigureSetting | undefined;
  /** A gauge's track is drawn under the value. */
  track: boolean;
  /** Only the editor measures; drawing needs no widths. */
  measure?: MeasureText;
}

export interface FigureLayout {
  showLabel: boolean;
  align: TextAlign;
  labelSize: number;
  valueSize: number;
  labelFont: string;
  valueFont: string;
  padX: number;
  /** Height of the gauge's track, and the space above it; both 0 without one. */
  track: number;
  trackGap: number;
  /** From the label's top to the value's top. */
  labelAdvance: number;
  /** From the first line's top to the end of the track, or the value. */
  contentHeight: number;
  /** The width the lines need, with the inset either side; 0 when nothing was measured. */
  neededWidth: number;
  /** The height the content needs, with the least top and the same below. */
  neededHeight: number;
}

export function figureLayout(input: FigureLayoutInput): FigureLayout {
  const { em, figure } = input;
  const showLabel = figure?.showLabel !== false;
  const labelSize = 0.55 * em * (figure?.labelScale ?? 1);
  const valueSize = 1.1 * em * (figure?.valueScale ?? 1);
  const track = input.track ? 0.25 * em : 0;
  const trackGap = input.track ? 0.2 * em : 0;
  const labelAdvance =
    figure?.gap === undefined ? labelSize * 1.2 : labelSize + figure.gap * input.frameWidth;
  const contentHeight = showLabel
    ? labelAdvance + valueSize * 1.1 + trackGap + track
    : valueSize * 1.1 + trackGap + track;
  const padX = 0.6 * em;
  const labelFont = `${labelSize}px ${FIGURE_FONT_FAMILY}`;
  const valueFont = `bold ${valueSize}px ${FIGURE_FONT_FAMILY}`;
  const { measure } = input;
  const widest = measure
    ? Math.max(showLabel ? measure((input.label ?? '').toUpperCase(), labelFont) : 0, measure(input.value, valueFont))
    : 0;
  return {
    showLabel,
    align: figure?.align ?? 'left',
    labelSize,
    valueSize,
    labelFont,
    valueFont,
    padX,
    track,
    trackGap,
    labelAdvance,
    contentHeight,
    neededWidth: 2 * padX + widest,
    neededHeight: contentHeight + 2 * FIGURE_MIN_TOP_EMS * em,
  };
}

/** The halo's `shadowColor`, or `undefined` for none: today's black at 0.8 unless the figure says otherwise. */
export function haloShadow(figure: OverlayFigureSetting | undefined): string | undefined {
  const halo = figure?.halo;
  if (!halo) return 'rgb(0 0 0 / 0.8)';
  if (halo.opacity <= 0) return undefined;
  const channel = (from: number) => parseInt(halo.color.slice(from, from + 2), 16);
  return `rgb(${channel(1)} ${channel(3)} ${channel(5)} / ${halo.opacity})`;
}
