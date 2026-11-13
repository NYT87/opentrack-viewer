import type { Activity } from '../../domain/activity';
import { flatViewTiles } from '../../mapVideo/export/tileBudget';
import type { ExportMap, RenderWaiting } from '../../mapVideo/export/renderMapVideo';
import { createInsetModels, type InsetCamera, type InsetComponentModel } from '../insetCamera';
import { insetStyleUrl } from '../insetMapStyle';
import type { OverlayTemplate } from '../template';
import type { OverlayTimeline } from '../timeline';
import { OverlayExportError } from './errors';

/**
 * AV-1023 (TD-092). The page's side of the route insets' maps. The export's worker cannot hold a
 * map, so the page does, one off-screen MapLibre map for each inset that has a basemap, made by
 * the map video's own `openExportMap` (TD-064): sized to the inset's box in output pixels, its
 * every request sent through the export's own queue (each tile once, kept in memory for this
 * export), every tile waited for before a picture is taken, a failed tile asked for again and then
 * an error rather than a hole. The picture is the basemap only: the line, the marker, the border
 * and the credit are drawn over it by the renderer, from the same camera.
 *
 * Maps are opened when first asked for. Hidden stretches are never asked for: the camera holds at
 * the kept end (TD-091), so no tile of one is requested.
 */

export interface InsetMapSession {
  /** The picture of each inset in `ids` at this moment of the video: each a fresh `ImageBitmap` the caller owns. */
  bitmapsAt: (seconds: number, ids: string[]) => Promise<Record<string, ImageBitmap>>;
  /**
   * Visits the cameras of these video times once, loading every tile they need into the maps' memory, so a
   * recording in real time draws from tiles already in (the transparent WebM, TD-063).
   */
  warm: (times: Iterable<number>, onProgress?: (done: number, total: number) => void) => Promise<void>;
  /** Ends the maps. Safe to call twice. */
  close: () => void;
}

export interface InsetMapsInput {
  template: OverlayTemplate;
  activity: Activity | undefined;
  timeline: OverlayTimeline;
  width: number;
  height: number;
  maptilerKey: string;
  signal?: AbortSignal;
  onWaiting?: (waiting: RenderWaiting) => void;
  /** For tests: how a map is opened. */
  open?: typeof openExportMapLazily;
}

const cancelled = () => new OverlayExportError('cancelled', 'The export was stopped.');

/** The map video's own map, loaded when first needed so MapLibre is not in the page until an export wants it. */
async function openExportMapLazily(options: Parameters<typeof import('../../mapVideo/export/renderMapVideo').openExportMap>[0]): Promise<ExportMap> {
  const { openExportMap } = await import('../../mapVideo/export/renderMapVideo');
  return openExportMap(options);
}

const sameCamera = (a: InsetCamera, b: InsetCamera) => a.zoom === b.zoom && a.bearing === b.bearing && a.center[0] === b.center[0] && a.center[1] === b.center[1];

export function createInsetMaps(input: InsetMapsInput): InsetMapSession {
  const { template, activity, timeline, width, height, maptilerKey, signal } = input;
  const open = input.open ?? openExportMapLazily;
  const models = createInsetModels({ template, timeline, activity, width, height });
  interface Held {
    model: InsetComponentModel;
    map: Promise<ExportMap>;
    camera?: InsetCamera;
    /** Tiles the map has been moved to see, by the estimate's keys, and the last camera warmed at. */
    seen: Set<number>;
    warmedAt?: InsetCamera;
  }
  const held = new Map<string, Held>();
  let closed = false;

  const heldFor = (id: string, camera: InsetCamera): Held | undefined => {
    // Ended: no map is opened for a job that is over.
    if (closed) throw cancelled();
    const existing = held.get(id);
    if (existing) return existing;
    const model = models.get(id);
    if (!model || !model.hasMap) return undefined;
    const styleUrl = insetStyleUrl(model.setting, maptilerKey);
    if (!styleUrl) return undefined;
    // Laid out at the inset's size in reference pixels and drawn at the output's, so the picture is the output's size and the labels scale with it.
    const map = open({ width: model.frame.w / model.scale, height: model.frame.h / model.scale, pixelRatio: model.scale, camera, styleUrl, what: 'a frame', signal, onWaiting: input.onWaiting });
    // A map that fails to open is reported to whoever asks, not as an unhandled rejection of its own.
    map.catch(() => undefined);
    const created: Held = { model, map, seen: new Set() };
    held.set(id, created);
    return created;
  };

  const move = async (entry: Held, camera: InsetCamera) => {
    const exportMap = await entry.map;
    if (closed) throw cancelled();
    // A map not moved has nothing to wait for: `idle` would never come.
    if (!entry.camera || !sameCamera(entry.camera, camera)) {
      await exportMap.settle(() => exportMap.map.jumpTo({ center: camera.center, zoom: camera.zoom, bearing: camera.bearing, pitch: 0 }));
      entry.camera = camera;
    }
    return exportMap;
  };

  return {
    async bitmapsAt(seconds, ids) {
      const pictures: Record<string, ImageBitmap> = {};
      try {
        for (const id of ids) {
          if (signal?.aborted || closed) throw cancelled();
          const moment = models.get(id)?.momentAt(seconds);
          const entry = moment && heldFor(id, moment.camera);
          if (!entry || !moment) continue;
          const exportMap = await move(entry, moment.camera);
          pictures[id] = await createImageBitmap(exportMap.map.getCanvas());
        }
      } catch (error) {
        for (const bitmap of Object.values(pictures)) bitmap.close();
        throw error;
      }
      return pictures;
    },
    async warm(times, onProgress) {
      const list = [...times];
      let done = 0;
      for (const seconds of list) {
        if (signal?.aborted || closed) throw cancelled();
        for (const id of models.keys()) {
          const moment = models.get(id)?.momentAt(seconds);
          const entry = moment && heldFor(id, moment.camera);
          if (!entry || !moment) continue;
          // Visited when it shows a tile not yet seen, or has moved on well beyond where it was last visited: a view's tiles are not only the ones the count foresees.
          const tiles = flatViewTiles(moment.camera, entry.model.frame.w / entry.model.scale, entry.model.frame.h / entry.model.scale);
          let fresh = false;
          for (const tile of tiles) if (!entry.seen.has(tile)) fresh = true;
          const far = !entry.warmedAt || movedFar(entry.warmedAt, moment.camera, Math.min(entry.model.frame.w, entry.model.frame.h) / entry.model.scale);
          if (!fresh && !far) continue;
          await move(entry, moment.camera);
          for (const tile of tiles) entry.seen.add(tile);
          entry.warmedAt = moment.camera;
        }
        done += 1;
        onProgress?.(done, list.length);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of held.values()) void entry.map.then((exportMap) => exportMap.close(), () => undefined);
      held.clear();
    },
  };
}

/** Whether a camera is a sixth of the box, ten degrees or a twentieth of a zoom from another. */
function movedFar(from: InsetCamera, to: InsetCamera, boxRefPixels: number): boolean {
  const metersPerPixel = (40_075_016 * Math.cos((to.center[1] * Math.PI) / 180)) / (512 * 2 ** to.zoom);
  const dLat = (to.center[1] - from.center[1]) * 111_195;
  const dLon = (to.center[0] - from.center[0]) * 111_195 * Math.cos((to.center[1] * Math.PI) / 180);
  const pixels = Math.hypot(dLat, dLon) / Math.max(1e-6, metersPerPixel);
  const turn = Math.abs(((to.bearing - from.bearing + 540) % 360) - 180);
  return pixels > boxRefPixels / 6 || turn > 10 || Math.abs(to.zoom - from.zoom) > 0.05;
}
