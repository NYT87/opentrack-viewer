import type { Activity, ActivitySport } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { createOverlayRenderer, type OverlayContext2D } from '../overlay/export/drawOverlay';
import { DEFAULT_OVERLAY_STYLE, DEFAULT_SHAPE, OVERLAY_TEMPLATE_VERSION, type OverlayComponent, type OverlayTemplate, type SummaryStatKey } from '../overlay/template';
import { buildOverlayTimeline, dataSourceId, type OverlaySample, type OverlayTimeline } from '../overlay/timeline';
import type { MapVideoModel } from './model';
import type { MapVideoSettings } from './project';
import { TERRAIN_FULL_CREDIT, terrainActive } from './style';

/**
 * AV-1207. Figures and graphics over the map video: the overlay components of
 * E10, laid out with the custom canvas editor (TD-062), bound to the map
 * video's timeline rather than to a source video's, and the summary card
 * shown through the outro. The preview and the export (AV-1209) draw them
 * with the same renderer, over the map frame.
 */

const SPEED = dataSourceId({ kind: 'metric', metric: 'speed' });
const PACE = dataSourceId({ kind: 'metric', metric: 'pace' });

/**
 * The activity as the figures may show it: the points the trimmed route
 * keeps, so a route inset or an elevation profile draws nothing the privacy
 * trim hides (TD-066). The summary's totals stay the whole activity's: a
 * total is a number, not a place.
 */
export function shownActivity(activity: Activity, model: MapVideoModel, settings: Pick<MapVideoSettings, 'privacyTrim'>): Activity {
  const { vertices } = model.route;
  const first = vertices[0]!;
  const last = vertices[vertices.length - 1]!;
  // A trimmed route starts on its cut; the point that vertex names lies just before it, in the trimmed stretch.
  const from = first.pointIndex + (settings.privacyTrim.startMeters > 0 ? 1 : 0);
  const kept = activity.points.filter((point) => point.index >= from && point.index <= last.pointIndex);
  if (kept.length === activity.points.length) return activity;
  return { ...activity, points: kept };
}

/**
 * The overlay timeline on the map video's clock. Video time `t` is read as
 * the activity at the marker's place: its recorded time there, interpolated
 * as the marker is. Through a shortened stop (TD-066) the figures hold the
 * stop's own values (standing still, the clock at the stop's start) rather
 * than racing through the minutes the beat skips. The intro shows the start
 * and the outro the end.
 */
export function mapVideoOverlayTimeline(activity: Activity, model: MapVideoModel): OverlayTimeline {
  // Anchored at the activity's first timed point, with no offset: video time is activity time.
  const base = buildOverlayTimeline(activity, { video: { durationSeconds: Number.MAX_SAFE_INTEGER } });
  const firstMs = activity.points.find((point) => point.time instanceof Date && Number.isFinite(point.time.getTime()))?.time?.getTime();
  const { timeline, route } = model;
  const length = timeline.lengthSeconds;

  const sampleAt = (videoSeconds: number): OverlaySample | undefined => {
    if (base.unavailable || firstMs === undefined) return undefined;
    const frame = model.at(Math.min(length, Math.max(0, videoSeconds)));
    const followSeconds = videoSeconds - timeline.introSeconds;
    const pause = frame.sample.paused
      ? timeline.pauses.find((stop) => followSeconds >= stop.startSeconds && followSeconds < stop.endSeconds)
      : undefined;
    const atMs = pause?.startTime ?? frame.position.time;
    if (atMs === undefined) return undefined;
    const sample = base.sampleAt((atMs - firstMs) / 1000);
    if (!sample) return undefined;
    const values = { ...sample.values };
    if (pause) {
      // Standing still: no speed, and no pace to speak of.
      values[SPEED] = 0;
      delete values[PACE];
    }
    return { ...sample, videoTimeSeconds: videoSeconds, values, progress: route.totalMeters > 0 ? frame.sample.distance / route.totalMeters : 0 };
  };

  return { ...base, durationSeconds: length, alignment: undefined, sampleAt };
}

/** Runners read pace, everyone else speed: the overview's own rule (TD-017). */
function summaryRate(sport: ActivitySport | undefined): SummaryStatKey {
  return sport === 'running' || sport === 'walking' || sport === 'hiking' ? 'pace' : 'speed';
}

/**
 * The summary card: a panel in the middle of the frame with the activity's
 * totals, from the still image's figures (TD-061): distance, moving time,
 * elevation gain and average speed or pace. A figure the activity lacks is
 * simply not drawn, as on the still image.
 */
export function summaryCardTemplate(sport: ActivitySport | undefined, frame: { width: number; height: number }): OverlayTemplate {
  const portrait = frame.height > frame.width;
  const card = portrait ? { x: 0.1, y: 0.3, width: 0.8, height: 0.4 } : { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const cell = (column: number, row: number) => ({
    x: card.x + card.width * (0.1 + column * 0.45),
    y: card.y + card.height * (0.14 + row * 0.38),
    width: 0.01,
    height: 0.01,
  });
  const figure = (stat: SummaryStatKey, column: number, row: number): OverlayComponent => ({
    id: `summary-${stat}`,
    type: 'summary',
    visible: true,
    unitMode: 'auto',
    rect: cell(column, row),
    style: { textColor: '#ffffff', fontScale: portrait ? 2.2 : 1.6 },
    summary: { stat },
    text: { align: 'left', weight: 'bold', caption: true },
  });
  return {
    version: OVERLAY_TEMPLATE_VERSION,
    name: 'Summary card',
    style: { ...DEFAULT_OVERLAY_STYLE },
    components: [
      {
        id: 'summary-card',
        type: 'shape',
        visible: true,
        unitMode: 'auto',
        rect: card,
        style: {},
        shape: { ...DEFAULT_SHAPE, kind: 'roundedRect', fill: '#111820', fillOpacity: 0.82, strokeOpacity: 0 },
      },
      figure('distance', 0, 0),
      figure('moving', 1, 0),
      figure('climb', 0, 1),
      figure(summaryRate(sport), 1, 1),
    ],
  };
}

export interface MapVideoFigures {
  /** The timeline the figures read, for the editor to offer what it can show. */
  timeline: OverlayTimeline;
  /** The activity the figures draw from: the trimmed stretch, with the whole activity's totals. */
  activity: Activity;
  /** Draws the figures, and the summary card in the outro, over what is on `ctx` already. */
  drawFrame: (ctx: OverlayContext2D, seconds: number) => void;
}

export interface MapVideoFiguresInput {
  activity: Activity;
  model: MapVideoModel;
  settings: MapVideoSettings;
  units: UnitSystem;
  /** The canvas drawn on: the video's size for the export, the preview's for the preview. */
  width: number;
  height: number;
  readerTimeZone?: string;
  /** AV-1208. The photos' pixels, decoded in the page: drawn as pixels, so nothing of their EXIF goes with them. */
  photoImages?: ReadonlyMap<string, PhotoImage>;
}

/** A photo as drawn: its decoded pixels and their size. */
export interface PhotoImage {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** How long a photo takes to come in and to go, at most a quarter of its showing. */
const PHOTO_TRANSITION_SECONDS = 0.4;

/**
 * A photo over the map while the marker waits for it: fitted within three
 * quarters of the frame, in the middle, with a white edge, coming in and
 * going out by fading and growing a little.
 */
export function drawPhoto(ctx: OverlayContext2D, photo: PhotoImage, shown: { elapsed: number; duration: number }, width: number, height: number): void {
  const fade = Math.min(PHOTO_TRANSITION_SECONDS, shown.duration / 4);
  const t = Math.min(1, shown.elapsed / fade, (shown.duration - shown.elapsed) / fade);
  const eased = t * t * (3 - 2 * t);
  const fit = Math.min((width * 0.75) / photo.width, (height * 0.75) / photo.height) * (0.92 + 0.08 * eased);
  const w = photo.width * fit;
  const h = photo.height * fit;
  const x = (width - w) / 2;
  const y = (height - h) / 2;
  const edge = Math.max(2, Math.min(width, height) * 0.012);
  ctx.save();
  ctx.globalAlpha = eased;
  ctx.shadowColor = 'rgb(0 0 0 / 0.5)';
  ctx.shadowBlur = edge * 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - edge, y - edge, w + 2 * edge, h + 2 * edge);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.drawImage(photo.image, x, y, w, h);
  ctx.restore();
}

/** The figures of a map video, ready to draw at any moment. */
export function createMapVideoFigures(input: MapVideoFiguresInput): MapVideoFigures {
  const { activity, model, settings, units, width, height, readerTimeZone, photoImages } = input;
  const timeline = mapVideoOverlayTimeline(activity, model);
  const shown = shownActivity(activity, model, settings);
  const overlay = settings.overlay && settings.overlay.components.length > 0
    ? createOverlayRenderer({ template: settings.overlay, timeline, activity: shown, units, width, height, readerTimeZone })
    : undefined;
  const card = settings.summaryCard.enabled
    ? createOverlayRenderer({ template: summaryCardTemplate(activity.metadata.sport, { width, height }), timeline, activity: shown, units, width, height, readerTimeZone })
    : undefined;
  const credit = card && terrainActive(settings) ? TERRAIN_FULL_CREDIT : undefined;

  return {
    timeline,
    activity: shown,
    drawFrame: (ctx, seconds) => {
      overlay?.drawFrame(ctx, seconds, { clear: false });
      const photo = model.timeline.at(seconds).photo;
      const image = photo && photoImages?.get(photo.id);
      if (photo && image) drawPhoto(ctx, image, photo, width, height);
      if (!card || model.timeline.at(seconds).phase !== 'outro') return;
      card.drawFrame(ctx, seconds, { clear: false });
      if (credit) drawCredit(ctx, credit, settings.output.height > settings.output.width, width, height);
    },
  };
}

/** The terrain's full credit (TD-064), in small type along the card's foot, wrapped to its width. */
function drawCredit(ctx: OverlayContext2D, text: string, portrait: boolean, width: number, height: number): void {
  const card = portrait ? { x: 0.1, y: 0.3, width: 0.8, height: 0.4 } : { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const size = Math.max(8, width * 0.0085);
  const left = (card.x + card.width * 0.05) * width;
  const maxWidth = card.width * 0.9 * width;
  ctx.save();
  ctx.font = `${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.fillStyle = 'rgb(255 255 255 / 0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const bottom = (card.y + card.height * 0.96) * height;
  lines.forEach((entry, i) => ctx.fillText(entry, left, bottom - (lines.length - 1 - i) * size * 1.25));
  ctx.restore();
}
