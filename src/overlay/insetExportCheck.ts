import type { Activity } from '../domain/activity';
import { OPENFREEMAP_TILE_BUDGET, flatViewTiles } from '../mapVideo/export/tileBudget';
import { cappedMapIds, createInsetModels, type InsetCamera } from './insetCamera';
import { insetStyleUrl } from './insetMapStyle';
import { hasPrivacyTrim } from './privacyTrim';
import { insetProviderName, type InsetMapProvider } from './routeInset';
import { frameVideoTime } from './export/plan';
import type { OverlayTemplate } from './template';
import type { OverlayTimeline } from './timeline';

/**
 * AV-1023 (TD-092). What an export with a map in a route inset asks of its providers, worked out
 * before it starts from the cameras of every frame: which providers, how many tiles each, and
 * whether the export may go ahead. OpenFreeMap's terms allow at most 3,000 tiles to be taken at
 * a time (TD-064, TD-076), so more is refused with the reason; MapTiler's maps are for video, so
 * the PNG sequence refuses them (TD-079); and a MapTiler map needs the reader's key. Pure.
 */

export type InsetExportKind = 'png' | 'webm' | 'burned';

export interface InsetExportCheck {
  /** How many insets carry a map, and what each is drawn from. */
  /** Whether the template hides any of the route's ends. */
  trimmed: boolean;
  insets: { id: string; provider: Exclude<InsetMapProvider, 'none'>; tiles: number }[];
  /** The distinct tiles in all, each asked for once for each map. */
  tiles: number;
  /** Why the export may not go ahead, in words for the reader. */
  refusal?: string;
}

export interface InsetExportInput {
  template: OverlayTemplate;
  activity: Activity | undefined;
  timeline: OverlayTimeline;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Where in the video the first frame is drawn: the trim's start. */
  trimStartSeconds?: number;
  kind: InsetExportKind;
  maptilerKey: string;
}

const same = (a: InsetCamera, b: InsetCamera) => a.zoom === b.zoom && a.bearing === b.bearing && a.center[0] === b.center[0] && a.center[1] === b.center[1];

/** The distinct tiles one inset's map is moved through over the frames of an export, from its camera alone. */
export function countInsetTiles(momentAt: (seconds: number) => { camera: InsetCamera } | undefined, frame: { w: number; h: number; scale: number }, frames: { fps: number; frameCount: number; startSeconds: number }): number {
  const tiles = new Set<number>();
  let last: InsetCamera | undefined;
  for (let index = 0; index < frames.frameCount; index += 1) {
    const moment = momentAt(frames.startSeconds + frameVideoTime(index, frames.fps));
    if (!moment) continue;
    // A frame that does not move sees what the last one did.
    if (last && same(last, moment.camera)) continue;
    flatViewTiles(moment.camera, frame.w / frame.scale, frame.h / frame.scale, tiles);
    last = moment.camera;
  }
  return tiles.size;
}

/** `undefined` for an export with no map in it: nothing is asked of anyone. */
export function checkInsetExport(input: InsetExportInput): InsetExportCheck | undefined {
  const { template, kind } = input;
  const models = [...createInsetModels({ template, timeline: input.timeline, activity: input.activity, width: input.width, height: input.height }).values()].filter((model) => model.hasMap);
  const capped = cappedMapIds(template.components);
  const declared = template.components.filter((component) => component.visible && capped.has(component.id));
  if (declared.length === 0) return undefined;

  const insets = models.map((model) => ({
    id: model.component.id,
    provider: model.setting.map.provider as Exclude<InsetMapProvider, 'none'>,
    tiles: countInsetTiles(model.momentAt, { w: model.frame.w, h: model.frame.h, scale: model.scale }, { fps: input.fps, frameCount: input.frameCount, startSeconds: input.trimStartSeconds ?? 0 }),
  }));
  const tiles = insets.reduce((sum, inset) => sum + inset.tiles, 0);
  const result: InsetExportCheck = { insets, tiles, trimmed: hasPrivacyTrim(template.privacyTrim) };

  const maptiler = declared.filter((component) => component.routeInset!.map.provider === 'maptiler');
  if (maptiler.length > 0 && kind === 'png') {
    result.refusal =
      'A MapTiler map cannot go into the PNG sequence: MapTiler’s terms allow videos, not pictures of its map. Export the transparent video or the video with the overlay drawn in, or change the inset’s map to OpenFreeMap or none.';
  } else if (maptiler.some((component) => insetStyleUrl(component.routeInset!, input.maptilerKey) === undefined)) {
    result.refusal = 'A route inset has a MapTiler map and no key has been typed, so it would be exported without its map. Type your MapTiler key in the inset’s settings, or change its map.';
  } else {
    const openfreemap = insets.filter((inset) => inset.provider === 'openfreemap').reduce((sum, inset) => sum + inset.tiles, 0);
    if (openfreemap > OPENFREEMAP_TILE_BUDGET) {
      result.refusal = `This export would ask OpenFreeMap for ${openfreemap.toLocaleString('en')} tiles, and its terms allow ${OPENFREEMAP_TILE_BUDGET.toLocaleString('en')} to be taken at a time. Choose a lower zoom, the whole route, a shorter part of the video, or a smaller inset.`;
    }
  }
  return result;
}

/** One line for the panel: where the tiles come from and how many, said before the export starts. */
export function insetTilesText(check: InsetExportCheck): string {
  const providers = [...new Set(check.insets.map((inset) => insetProviderName(inset.provider)))];
  const where = providers.join(' and ');
  if (check.tiles === 0) return `The route inset’s map has no tiles to ask ${where || 'its provider'} for.`;
  const trim = check.trimmed ? 'The privacy trim keeps the start and end out of every request, as far as a view reaches: a tile is larger than the view.' : 'No privacy trim is set, so the start and end are asked for like any other part.';
  return `The route inset’s map asks ${where} for ${check.tiles.toLocaleString('en')} tile${check.tiles === 1 ? '' : 's'}, each once, before it writes anything. ${trim}`;
}

const recent: { input: InsetExportInput; result: InsetExportCheck | undefined }[] = [];

/**
 * `checkInsetExport`, remembered for its last few inputs (the PNG and the burned-in panels ask side by side, with different sizes
 * and rates): a panel asks on every render (a running export renders at each progress tick), and a long export's cameras are many.
 */
export function checkInsetExportCached(input: InsetExportInput): InsetExportCheck | undefined {
  const hit = recent.find(({ input: a }) =>
    a.template === input.template &&
    a.activity === input.activity &&
    a.timeline === input.timeline &&
    a.width === input.width &&
    a.height === input.height &&
    a.fps === input.fps &&
    a.frameCount === input.frameCount &&
    (a.trimStartSeconds ?? 0) === (input.trimStartSeconds ?? 0) &&
    a.kind === input.kind &&
    a.maptilerKey === input.maptilerKey,
  );
  if (hit) return hit.result;
  const result = checkInsetExport(input);
  recent.unshift({ input, result });
  recent.length = Math.min(recent.length, 6);
  return result;
}
