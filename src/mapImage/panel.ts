import { STILL_FONT_FAMILY, type MeasureText } from '../overlay/staticImage';

/**
 * AV-1013. The map image's panel of details, laid out: its height follows
 * from what it holds and the image's size, so it is never a fixed box with
 * room to spare or text crowded into it. Pure; `drawMapImage` draws what is
 * planned here.
 *
 * Type is sized from the image's area, so a link preview and a 4K poster set
 * the same details at the same share of the picture. The figures sit in a
 * grid of as many even columns as their widest fits, balanced so the last row
 * is not one figure alone. A panel that would take more than `MAX_PANEL_SHARE`
 * of the image is set smaller until it does not, so the map stays the picture.
 */

export interface PanelFigure {
  caption: string;
  value: string;
}

export interface PanelContent {
  title?: string;
  date?: string;
  figures: PanelFigure[];
  profile: boolean;
}

export type PanelTextRole = 'title' | 'date' | 'caption' | 'value';

export type PanelItem =
  | { kind: 'text'; role: PanelTextRole; text: string; x: number; y: number; size: number; font: string; maxWidth: number }
  | { kind: 'profile'; x: number; y: number; w: number; h: number };

export interface PanelLayout {
  /** In image pixels; 0 when there is nothing to show, and the map has the whole image. */
  height: number;
  /** The type's scale: 1 at 1080 × 1350, where the sizes below are set. */
  scale: number;
  /** Positions from the panel's top left, text by its top. */
  items: PanelItem[];
}

/** The most of the image the panel takes. */
export const MAX_PANEL_SHARE = 0.5;
/** The smallest the type is set, against the image's own scale, before the panel is allowed past its share. */
const MIN_SHRINK = 0.35;

const SIZES = { pad: 48, title: 46, date: 26, caption: 22, value: 50, rowGap: 26, colGap: 40, sectionGap: 26, profile: 150 };

const font = (size: number, bold: boolean) => `${bold ? '700 ' : ''}${size}px ${STILL_FONT_FAMILY}`;

/** `text`, cut with an ellipsis where it is wider than `maxWidth`. */
export function fitText(text: string, fontSpec: string, maxWidth: number, measure: MeasureText): string {
  if (measure(text, fontSpec) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(`${text.slice(0, mid).trimEnd()}…`, fontSpec) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

function layoutAt(content: PanelContent, width: number, scale: number, measure: MeasureText): PanelLayout {
  const s = Object.fromEntries(Object.entries(SIZES).map(([key, value]) => [key, value * scale])) as typeof SIZES;
  const inner = Math.max(1, width - 2 * s.pad);
  const items: PanelItem[] = [];
  let y = s.pad;
  let any = false;
  const gap = () => {
    if (any) y += s.sectionGap;
    any = true;
  };

  if (content.title) {
    const f = font(s.title, true);
    items.push({ kind: 'text', role: 'title', text: fitText(content.title, f, inner, measure), x: s.pad, y, size: s.title, font: f, maxWidth: inner });
    y += s.title * 1.2;
    any = true;
  }
  if (content.date) {
    const f = font(s.date, false);
    if (content.title) y += s.date * 0.2;
    items.push({ kind: 'text', role: 'date', text: fitText(content.date, f, inner, measure), x: s.pad, y, size: s.date, font: f, maxWidth: inner });
    y += s.date * 1.25;
    any = true;
  }

  const figures = content.figures;
  if (figures.length > 0) {
    gap();
    const captionFont = font(s.caption, false);
    const valueFont = font(s.value, true);
    const widest = Math.max(...figures.map((figure) => Math.max(measure(figure.caption, captionFont), measure(figure.value, valueFont))));
    let columns = Math.max(1, Math.min(figures.length, Math.floor((inner + s.colGap) / (widest + s.colGap))));
    const rows = Math.ceil(figures.length / columns);
    // As few columns as the same rows need: 5 figures in 4 columns are 3 and 2, not 4 and 1.
    columns = Math.ceil(figures.length / rows);
    const columnWidth = (inner - (columns - 1) * s.colGap) / columns;
    const cell = s.caption * 1.35 + s.value * 1.15;
    figures.forEach((figure, i) => {
      const x = s.pad + (i % columns) * (columnWidth + s.colGap);
      const top = y + Math.floor(i / columns) * (cell + s.rowGap);
      items.push({ kind: 'text', role: 'caption', text: fitText(figure.caption, captionFont, columnWidth, measure), x, y: top, size: s.caption, font: captionFont, maxWidth: columnWidth });
      items.push({ kind: 'text', role: 'value', text: figure.value, x, y: top + s.caption * 1.35, size: s.value, font: valueFont, maxWidth: columnWidth });
    });
    y += rows * cell + (rows - 1) * s.rowGap;
  }

  if (content.profile) {
    gap();
    items.push({ kind: 'profile', x: s.pad, y, w: inner, h: s.profile });
    y += s.profile;
  }

  return any ? { height: Math.ceil(y + s.pad), scale, items } : { height: 0, scale, items: [] };
}

/** The panel for `content` across an image `size`. */
export function planPanel(content: PanelContent, size: { width: number; height: number }, measure: MeasureText): PanelLayout {
  const base = Math.sqrt(size.width * size.height) / Math.sqrt(1080 * 1350);
  const limit = size.height * MAX_PANEL_SHARE;
  let scale = base;
  let layout = layoutAt(content, size.width, scale, measure);
  // Smaller until it fits its share; a few steps, since more columns fit as the type shrinks.
  for (let step = 0; layout.height > limit && step < 12 && scale > base * MIN_SHRINK; step += 1) {
    scale = Math.max(base * MIN_SHRINK, scale * Math.min(0.95, limit / layout.height));
    layout = layoutAt(content, size.width, scale, measure);
  }
  return layout;
}
