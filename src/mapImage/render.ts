import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { openExportMap, type RenderWaiting } from '../mapVideo/export/renderMapVideo';
import { basemapStyleUrl, drawWholeRoute, installVideoLayers, styleVideoMap, videoMapColors } from '../mapVideo/videoMap';
import { canvasTemplate } from '../overlay/customCanvas';
import { createOverlayRenderer, type OverlayContext2D } from '../overlay/export/drawOverlay';
import { OverlayExportError } from '../overlay/export/errors';
import { measureText } from '../overlay/measureText';
import type { PersonalFigures } from '../overlay/template';
import { drawMapImage } from './draw';
import { drawnAtZoom } from './geometry';
import { planMapImage, stillOverlayClock } from './plan';
import type { MapImageSettings } from './settings';

/**
 * AV-1013. A map image, drawn once at its own size: the map video's offscreen
 * map (TD-072) at the map's size, every request through its queue, four at a
 * time and each tile once (TD-076), waited on until every tile is in, a failed
 * one asked for again and then the export stopped rather than save a picture
 * with a hole (TD-064). The panel or the canvas's elements and the credit are
 * drawn over it, and the whole is encoded here, in the tab. Nothing is sent.
 */

export interface MapImageRenderInput {
  activity: Activity;
  settings: MapImageSettings;
  units: UnitSystem;
  readerTimeZone?: string;
  /** AV-1018. The reader's own figures for a zones component, from the session. */
  personal?: PersonalFigures;
}

export interface MapImageRenderResult {
  blob: Blob;
  /** Map requests made: tiles, and the style's own files. */
  requests: number;
}

/** JPEG's quality: high enough that a map's lines and labels do not ring. */
const JPEG_QUALITY = 0.92;

export async function renderMapImage(
  input: MapImageRenderInput,
  options: { signal?: AbortSignal; onWaiting?: (waiting: RenderWaiting) => void } = {},
): Promise<MapImageRenderResult> {
  const { activity, settings, units, readerTimeZone, personal } = input;
  const planned = planMapImage({ activity, settings, units, measure: measureText, readerTimeZone });
  if (!planned.ok) throw new OverlayExportError('render_failed', planned.error);
  const { plan } = planned;
  const { width, height, mapHeight, camera } = plan;

  const exportMap = await openExportMap({ width, height: mapHeight, styleUrl: basemapStyleUrl(plan.video, ''), what: 'the image', ...options });
  try {
    const { map } = exportMap;
    installVideoLayers(map, plan.video);
    const line = { route: plan.route, drawn: drawnAtZoom(plan.route, camera.zoom) };
    const colors = videoMapColors(activity, line, plan.video);
    styleVideoMap(map, activity, line, plan.video, colors);
    await exportMap.settle(() => {
      // Always from straight above.
      map.jumpTo({ center: camera.center, zoom: camera.zoom, bearing: camera.bearing, pitch: 0 });
      drawWholeRoute(map, line, colors);
    });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new OverlayExportError('unsupported_browser', 'This browser cannot draw the image.');
    const overlay =
      settings.layout === 'canvas' && settings.overlay.length > 0
        ? (() => {
            const clock = stillOverlayClock(plan.shown);
            const renderer = createOverlayRenderer({ template: canvasTemplate(settings.overlay), timeline: clock.timeline, activity: plan.shown, units, width, height, readerTimeZone, personal });
            return (target: OverlayContext2D) => renderer.drawFrame(target, clock.seconds, { clear: false });
          })()
        : undefined;
    drawMapImage(ctx, map.getCanvas(), {
      width,
      height,
      mapHeight,
      ...(settings.layout === 'panel' ? { panel: { layout: plan.panel, background: settings.panel.background, accent: settings.route.color, profile: plan.profile } } : {}),
      ...(overlay ? { drawOverlay: overlay } : {}),
      credit: plan.credit,
    });
    const type = settings.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((made) => (made ? resolve(made) : reject(new OverlayExportError('render_failed', 'The image could not be encoded.'))), type, JPEG_QUALITY),
    );
    return { blob, requests: exportMap.requests() };
  } finally {
    exportMap.close();
  }
}
