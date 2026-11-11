import { drawAttribution } from '../mapVideo/figures';
import type { ProjectedProfile } from '../overlay/elevationProfile';
import type { OverlayContext2D } from '../overlay/export/drawOverlay';
import type { PanelLayout } from './panel';

/**
 * AV-1013. A map image put together: the map's picture at the top, the panel
 * of details below it, or the free canvas's elements over the map, and the
 * map's credit, which no setting takes away (TD-068). The export draws it at
 * the image's size; the preview draws the panel with the same code, scaled.
 */

/** Text that reads on `background`: near white on a dark panel, near black on a light one. */
export function panelTextColor(background: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(background)?.[1];
  if (!hex) return '#ffffff';
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Where black and white contrast equally with the background.
  return luminance > 0.179 ? '#14181d' : '#ffffff';
}

export interface PanelDrawing {
  layout: PanelLayout;
  background: string;
  /** The profile's line: the route's colour. */
  accent: string;
  profile?: ProjectedProfile;
}

/** The panel, its top left at `top` on an image `width` across. */
export function drawPanel(ctx: OverlayContext2D, panel: PanelDrawing, top: number, width: number): void {
  const { layout, background, accent, profile } = panel;
  if (layout.height <= 0) return;
  const text = panelTextColor(background);
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, top, width, layout.height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const item of layout.items) {
    if (item.kind === 'text') {
      ctx.font = item.font;
      ctx.fillStyle = text;
      ctx.globalAlpha = item.role === 'caption' || item.role === 'date' ? 0.72 : 1;
      ctx.fillText(item.text, item.x, top + item.y, item.maxWidth);
      ctx.globalAlpha = 1;
    } else if (profile) {
      drawProfile(ctx, profile, { x: item.x, y: top + item.y, w: item.w, h: item.h }, accent, layout.scale);
    }
  }
  ctx.restore();
}

function drawProfile(ctx: OverlayContext2D, profile: ProjectedProfile, box: { x: number; y: number; w: number; h: number }, accent: string, scale: number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const run of profile.runs) {
    if (run.length < 2) continue;
    ctx.beginPath();
    run.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(box.x + x * box.w, box.y + y * box.h) : ctx.lineTo(box.x + x * box.w, box.y + y * box.h)));
    // The fill closes down to the box's foot, under the line.
    ctx.lineTo(box.x + run[run.length - 1]![0] * box.w, box.y + box.h);
    ctx.lineTo(box.x + run[0]![0] * box.w, box.y + box.h);
    ctx.closePath();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    run.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(box.x + x * box.w, box.y + y * box.h) : ctx.lineTo(box.x + x * box.w, box.y + y * box.h)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1.5, 3 * scale);
    ctx.stroke();
  }
  ctx.restore();
}

export interface MapImageDrawing {
  width: number;
  height: number;
  /** The map's height: the whole image, or what the panel leaves. */
  mapHeight: number;
  panel?: PanelDrawing;
  /** The free canvas's elements, drawn over the map. */
  drawOverlay?: (ctx: OverlayContext2D) => void;
  credit?: string;
}

/** The whole image, the map's picture (`map`) drawn first at the top. */
export function drawMapImage(ctx: OverlayContext2D, map: CanvasImageSource, drawing: MapImageDrawing): void {
  const { width, height, mapHeight, panel, drawOverlay, credit } = drawing;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(map, 0, 0, width, mapHeight);
  if (panel) drawPanel(ctx, panel, mapHeight, width);
  drawOverlay?.(ctx);
  // Last, at the map's foot: nothing is drawn over the credit.
  if (credit) drawAttribution(ctx, credit, width, mapHeight);
}
