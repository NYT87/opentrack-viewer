import { FIGURE_FONT_FAMILY } from '../figureLayout';
import {
  createInsetProjection,
  lowerIndex,
  splitIndex,
  type InsetBox,
  type InsetComponentModel,
  type InsetMoment,
  type InsetRoute,
} from '../insetCamera';
import { insetMapCredit } from '../routeInset';
import type { ResolvedOverlayComponent } from '../template';
import type { OverlayContext2D } from './drawOverlay';

/**
 * AV-1023 (TD-092). The route inset drawn over a camera: the basemap's picture (when the page
 * has made one), the route's trail and what is ahead of it, the marker, the border, and the
 * provider's credit. The preview, the PNG sequence, the burned-in video and the WebM all draw
 * it here, from the camera `createInsetModels` gives, so the line lies on the map in each.
 *
 * Every point is projected (never a transformed context) so the picture can be read back. The
 * caller has clipped to `insetPath` and painted the background.
 */

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** What stands behind an inset: the page's picture of its map (export), or a live map under the canvas (preview). */
export interface InsetMapSource {
  /** One basemap picture per inset id, the size of the inset's frame. */
  bitmaps?: ReadonlyMap<string, CanvasImageSource>;
  /** The insets a live map is drawn under the canvas for (the preview's): their credit and the line's casing are drawn as if a picture were there. */
  live?: ReadonlySet<string>;
}

/** How near a point may be to the last one drawn before it is skipped: nothing finer than a pixel can be seen. */
const MIN_STEP_PX = 0.6;
const ALPHA_TRAIL = 0.85;
const ALPHA_DIMMED = 0.3;

/** The shape's outline as the path of the context: the box's rounded rectangle, or the circle a round inset is. */
export function insetPath(ctx: OverlayContext2D, model: InsetComponentModel, box: InsetBox, em: number): void {
  ctx.beginPath();
  if (model.setting.shape === 'round') {
    const { x, y, w } = model.frame;
    ctx.arc(x + w / 2, y + w / 2, w / 2, 0, Math.PI * 2);
  } else if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(box.x, box.y, box.w, box.h, 0.4 * em);
  } else {
    ctx.rect(box.x, box.y, box.w, box.h);
  }
}

/** Whether a map is behind the inset in this picture. */
export const insetMapShown = (model: InsetComponentModel, maps: InsetMapSource | undefined): boolean =>
  model.hasMap && (maps?.live?.has(model.component.id) === true || maps?.bitmaps?.has(model.component.id) === true);

export function drawInset(
  ctx: OverlayContext2D,
  model: InsetComponentModel,
  ready: Ready,
  em: number,
  moment: InsetMoment,
  maps: InsetMapSource | undefined,
): void {
  const { frame, setting, route } = model;
  const shown = insetMapShown(model, maps);
  const bitmap = maps?.bitmaps?.get(model.component.id);
  if (model.hasMap && bitmap) ctx.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h);

  const projection = createInsetProjection(moment.camera, frame.w, frame.h, model.scale);
  const toCanvas = (x: number, y: number): [number, number] => {
    const [px, py] = projection.toBox(x, y);
    return [frame.x + px, frame.y + py];
  };
  const side = Math.min(frame.w, frame.h);
  const color = setting.lineColor ?? ready.style.textColor;
  const width = Math.max(1, setting.lineWidth * side);

  // The route is cut at the moment: the trail behind it (all of it, or the last minutes), what is ahead.
  const last = route.count - 1;
  const markerAt = moment.marker ? toCanvas(...mercatorOf(moment.marker)) : undefined;
  let split = last;
  let trailFrom = 0;
  if (route.timed && moment.nowMs !== undefined) {
    split = splitIndex(route, moment.nowMs);
    if (setting.trail !== 'all') trailFrom = Math.min(lowerIndex(route, moment.nowMs - setting.trail * 60_000), Math.max(0, split));
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const stroke = (from: number, to: number, lead: { start?: [number, number]; end?: [number, number] }, alpha: number) => {
    // Nothing to stroke (a one-vertex trail at a held camera, a stretch wholly out of the picture): no call at all.
    if (!tracePath(ctx, route, from, to, toCanvas, frame, lead)) return;
    if (shown) {
      // A casing under the line, so it reads on any map.
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = width * 1.7;
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  if (setting.ahead !== 'hidden') {
    // Held with no marker, the vertex at the split is the camera's own and the route ahead starts from it, so no leg between is left undrawn.
    stroke(markerAt ? split + 1 : Math.max(0, split), last, { start: markerAt }, setting.ahead === 'dimmed' ? ALPHA_DIMMED : ALPHA_TRAIL);
  }
  stroke(trailFrom, split, { end: markerAt }, ALPHA_TRAIL);
  ctx.globalAlpha = 1;

  if (markerAt) {
    const radius = Math.max(2, 0.05 * side);
    ctx.fillStyle = ready.style.accentColor;
    ctx.beginPath();
    ctx.arc(markerAt[0], markerAt[1], radius, 0, Math.PI * 2);
    ctx.fill();
    if (shown) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, 0.012 * side);
      ctx.stroke();
    }
  }

  if (shown) drawCredit(ctx, model, setting.map.provider, em);
}

/** The border, drawn last and over everything, on the shape's own edge. */
export function drawInsetBorder(ctx: OverlayContext2D, model: InsetComponentModel, box: InsetBox, em: number, frameSide: number): void {
  const { border } = model.setting;
  if (!(border.width > 0)) return;
  insetPath(ctx, model, box, em);
  ctx.strokeStyle = border.color;
  // Half of a stroke falls outside the clip: twice the width leaves the width inside.
  ctx.lineWidth = Math.max(1, border.width * frameSide) * 2;
  ctx.stroke();
}

const RAD = Math.PI / 180;
const mercatorOf = (place: { lat: number; lon: number }): [number, number] => {
  const sin = Math.sin(Math.max(-85.0511287798, Math.min(85.0511287798, place.lat)) * RAD);
  return [(place.lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
};

/**
 * The route from vertex `from` to `to` as a path, with an optional point before and after. A run
 * (an unbroken stretch of valid fixes) is one line; the gap between two is not drawn across. A
 * stretch of line wholly outside the picture on one side is not built, and a point under a pixel
 * from the last one drawn is skipped, so the cost of a frame is what is seen, not the recording.
 * Whether anything was built.
 */
function tracePath(
  ctx: OverlayContext2D,
  route: InsetRoute,
  from: number,
  to: number,
  toCanvas: (x: number, y: number) => [number, number],
  frame: InsetBox,
  lead: { start?: [number, number]; end?: [number, number] },
): boolean {
  ctx.beginPath();
  let drawn = false;
  const margin = 4;
  const left = frame.x - margin;
  const right = frame.x + frame.w + margin;
  const top = frame.y - margin;
  const bottom = frame.y + frame.h + margin;
  const code = (x: number, y: number) => (x < left ? 1 : x > right ? 2 : 0) | (y < top ? 4 : y > bottom ? 8 : 0);

  let prevX = 0;
  let prevY = 0;
  let prevOut = 0;
  let hasPrev = false;
  let penDown = false;
  let currentRun = -1;
  const visit = (x: number, y: number, run: number, force: boolean) => {
    if (run !== currentRun) {
      currentRun = run;
      hasPrev = false;
      penDown = false;
    }
    const out = code(x, y);
    if (hasPrev) {
      if (!force && out === 0 && prevOut === 0 && Math.hypot(x - prevX, y - prevY) < MIN_STEP_PX) return;
      if (prevOut & out) {
        // Both beyond the same edge: this stretch cannot be seen.
        penDown = false;
      } else {
        if (!penDown) {
          ctx.moveTo(prevX, prevY);
          penDown = true;
        }
        ctx.lineTo(x, y);
        drawn = true;
      }
    }
    prevX = x;
    prevY = y;
    prevOut = out;
    hasPrev = true;
  };

  if (lead.start) visit(lead.start[0], lead.start[1], route.run[Math.max(0, from)] ?? 0, true);
  for (let i = Math.max(0, from); i <= to && i < route.count; i += 1) {
    const [x, y] = toCanvas(route.x[i]!, route.y[i]!);
    visit(x, y, route.run[i]!, i === to);
  }
  if (lead.end && to >= 0) visit(lead.end[0], lead.end[1], route.run[Math.min(to, route.count - 1)] ?? 0, true);
  return drawn;
}

/** The provider's credit, small, along the bottom edge of the inset, on a soft plate. */
function drawCredit(ctx: OverlayContext2D, model: InsetComponentModel, provider: Parameters<typeof insetMapCredit>[0], em: number): void {
  const text = insetMapCredit(provider);
  if (!text) return;
  const { frame } = model;
  // A round inset's bottom edge is a chord: the credit sits a little up it, centred, as wide as the circle there.
  const round = model.setting.shape === 'round';
  const lift = round ? 0.08 * frame.w : 0;
  const available = Math.max(1, round ? 0.54 * frame.w : frame.w - 4);
  let size = Math.max(6, Math.min(0.4 * em, frame.w * 0.05));
  ctx.font = `${size}px ${FIGURE_FONT_FAMILY}`;
  const measured = ctx.measureText(text).width;
  // Squeezed to fit rather than cut: a credit is shown whole.
  if (measured > available - 6) {
    size = Math.max(3, (size * (available - 6)) / measured);
    ctx.font = `${size}px ${FIGURE_FONT_FAMILY}`;
  }
  const w = Math.min(available, ctx.measureText(text).width + 6);
  const h = size * 1.4;
  const x = round ? frame.x + (frame.w - w) / 2 : frame.x + frame.w - 2 - w;
  const y = frame.y + frame.h - h - lift;
  ctx.fillStyle = 'rgb(255 255 255 / 0.75)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#222222';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 3, y + h / 2);
}
