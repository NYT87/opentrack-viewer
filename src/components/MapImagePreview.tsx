import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { drawPanel } from '../mapImage/draw';
import { clampZoom, drawnAtZoom, normalizeBearing } from '../mapImage/geometry';
import { stillOverlayClock, type MapImagePlan } from '../mapImage/plan';
import type { MapImageCamera, MapImageSettings } from '../mapImage/settings';
import { drawAttribution } from '../mapVideo/figures';
import {
  ROUTE_ONLY_BACKGROUND,
  basemapStyleUrl,
  drawWholeRoute,
  installVideoLayers,
  isOwnSource,
  routeOnlyStyle,
  styleVideoMap,
  videoMapColors,
} from '../mapVideo/videoMap';
import { canvasTemplate } from '../overlay/customCanvas';
import { createOverlayRenderer } from '../overlay/export/drawOverlay';
import { usePersonalStore } from '../state/personalStore';

setWorkerUrl(maplibreWorkerUrl);

export interface MapImagePreviewProps {
  activity: Activity;
  plan: MapImagePlan;
  settings: MapImageSettings;
  units: UnitSystem;
  /** Where the reader has moved the map to, in the image's own pixels. */
  onCamera: (camera: MapImageCamera) => void;
  /** A picture of the map once it settles, for the free canvas's editor to place elements over. */
  onSnapshot?: (url: string) => void;
  readerTimeZone?: string;
}

/** Near enough that the map need not be moved to match. */
const sameCamera = (a: MapImageCamera, b: MapImageCamera) =>
  Math.abs(a.center[0] - b.center[0]) < 1e-7 &&
  Math.abs(a.center[1] - b.center[1]) < 1e-7 &&
  Math.abs(a.zoom - b.zoom) < 1e-4 &&
  Math.abs(normalizeBearing(a.bearing) - normalizeBearing(b.bearing)) < 1e-3;

/**
 * AV-1013. The map image as it will be saved, at the preview's size: a map
 * the reader moves, zooms and turns, but never tilts (it is always seen from
 * straight above), with the route drawn whole, and below it the panel, or
 * over it the free canvas's elements, drawn by the export's own code. The
 * credit is drawn in the frame as the export draws it.
 *
 * The map is laid out at the image's own pixels and scaled down to the
 * preview, its drawing buffer at the preview's resolution: so the camera is
 * the image's own, and the line, the ends and the map's labels are the same
 * share of the picture as in the file. MapLibre reads the pointer through
 * the scale.
 *
 * The map is made once; the page makes a new preview for another basemap.
 */
export default function MapImagePreview({ activity, plan, settings, units, onCamera, onSnapshot, readerTimeZone }: MapImagePreviewProps) {
  const personal = usePersonalStore((state) => state.personal);
  const frameRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string>();
  const [previewWidth, setPreviewWidth] = useState(0);
  /** The preview's pixels to the image's. */
  const scale = previewWidth > 0 ? previewWidth / plan.width : 0;
  const latest = useRef({ plan, onCamera, onSnapshot, layout: settings.layout, scale });
  useEffect(() => {
    latest.current = { plan, onCamera, onSnapshot, layout: settings.layout, scale };
  });
  /** Set while the page moves the map, so the move is not reported back as the reader's. */
  const moving = useRef(false);

  // Never MapTiler's (TD-079): no key is needed.
  const styleUrl = basemapStyleUrl(plan.video, '');
  useEffect(() => {
    const container = mapRef.current;
    if (!container) return;
    const background = getComputedStyle(container).getPropertyValue('--map-video-background').trim() || ROUTE_ONLY_BACKGROUND;
    const created = new MapLibreMap({
      container,
      style: styleUrl ?? routeOnlyStyle(background),
      attributionControl: false,
      pixelRatio: Math.max(0.05, latest.current.scale) * (window.devicePixelRatio || 1),
      // Always from straight above: turned, never tilted.
      maxPitch: 0,
      pitchWithRotate: false,
      fadeDuration: 0,
      // Kept after drawing, so a settled view can be pictured for the canvas's editor.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    created.touchPitch.disable();
    created.getCanvas?.()?.setAttribute('aria-label', 'The map. Drag to move it, scroll to zoom, right-drag to turn it; or use the buttons below.');
    map.current = created;
    created.on('load', () => {
      installVideoLayers(created, latest.current.plan.video);
      setReady(true);
    });
    // Only the reader's own moves: a resize or the page's own jump moves the map too, and is not a choice.
    created.on('moveend', (event) => {
      if (moving.current || !(event as { originalEvent?: unknown }).originalEvent) return;
      const center = created.getCenter();
      latest.current.onCamera({ center: [center.lng, center.lat], zoom: clampZoom(created.getZoom()), bearing: normalizeBearing(created.getBearing()) });
    });
    created.on('idle', () => {
      if (latest.current.layout !== 'canvas') return;
      try {
        const url = created.getCanvas?.()?.toDataURL('image/jpeg', 0.8);
        if (url) latest.current.onSnapshot?.(url);
      } catch {
        // A canvas the browser will not read: no picture behind the elements, no harm.
      }
    });
    created.on('error', (event) => {
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (isOwnSource(sourceId)) return;
      setMapError(event.error?.message ?? 'The online map could not be loaded.');
    });
    return () => {
      created.remove();
      map.current = null;
    };
    // The basemap is fixed for this component's life: see the doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The preview's width, which sets its zoom against the image's.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    setPreviewWidth(frame.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setPreviewWidth(frame.clientWidth));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // The map's size is the image's, less the panel; its buffer follows the preview's.
  const mapShare = plan.mapHeight / plan.height;
  useEffect(() => {
    const current = map.current;
    if (!current) return;
    if (scale > 0) current.setPixelRatio(scale * (window.devicePixelRatio || 1));
    current.resize();
  }, [scale, plan.width, plan.mapHeight]);

  // The route, as the export draws it, through the vertices worth drawing at this zoom.
  const zoomStep = Math.round(plan.camera.zoom);
  const line = useMemo(() => ({ route: plan.route, drawn: drawnAtZoom(plan.route, zoomStep) }), [plan.route, zoomStep]);
  const colors = useMemo(() => videoMapColors(activity, line, plan.video), [activity, line, plan.video]);
  useEffect(() => {
    const current = map.current;
    if (!current || !ready) return;
    styleVideoMap(current, activity, line, plan.video, colors);
    drawWholeRoute(current, line, colors);
  }, [activity, line, colors, plan.video, ready]);

  // The page's camera: moved only when it is not where the reader left it.
  useEffect(() => {
    const current = map.current;
    if (!current || !ready) return;
    const wanted = plan.camera;
    const center = current.getCenter();
    const shown = { center: [center.lng, center.lat] as [number, number], zoom: current.getZoom(), bearing: current.getBearing() };
    if (sameCamera(shown, wanted)) return;
    moving.current = true;
    current.jumpTo({ center: wanted.center, zoom: wanted.zoom, bearing: wanted.bearing, pitch: 0 });
    moving.current = false;
  }, [plan.camera, plan.width, plan.mapHeight, ready]);

  /** A canvas at its own pixels, scaled so the image's pixels can be drawn on it. */
  const prepare = useCallback((canvas: HTMLCanvasElement | null) => {
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, scale: width / latest.current.plan.width };
  }, []);

  // The panel, by the export's own code, scaled to the preview.
  useEffect(() => {
    const drawn = prepare(panelRef.current);
    if (!drawn || settings.layout !== 'panel') return;
    drawn.ctx.setTransform(drawn.scale, 0, 0, drawn.scale, 0, 0);
    drawPanel(drawn.ctx, { layout: plan.panel, background: settings.panel.background, accent: settings.route.color, profile: plan.profile }, 0, plan.width);
  }, [prepare, plan, settings.layout, settings.panel.background, settings.route.color, previewWidth]);

  // Over the map: the canvas's elements, then the credit, as the export lays them.
  const clock = useMemo(() => stillOverlayClock(plan.shown), [plan.shown]);
  useEffect(() => {
    const drawn = prepare(overRef.current);
    if (!drawn) return;
    const { ctx, scale } = drawn;
    if (settings.layout === 'canvas' && settings.overlay.length > 0) {
      const width = Math.round(plan.width * scale);
      const height = Math.round(plan.height * scale);
      const renderer = createOverlayRenderer({ template: canvasTemplate(settings.overlay), timeline: clock.timeline, activity: plan.shown, units, width, height, readerTimeZone, personal });
      renderer.drawFrame(ctx, clock.seconds, { clear: false });
    }
    if (plan.credit) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawAttribution(ctx, plan.credit, plan.width, plan.mapHeight);
    }
  }, [prepare, plan, settings.layout, settings.overlay, clock, units, readerTimeZone, personal, previewWidth]);

  return (
    <div className="map-image-preview">
      <div
        ref={frameRef}
        className="map-image-preview__frame"
        style={{ aspectRatio: `${plan.width} / ${plan.height}`, ['--frame-aspect' as string]: plan.width / plan.height }}
        data-testid="map-image-preview"
      >
        <div
          ref={mapRef}
          className="map-image-preview__map"
          style={{ width: `${plan.width}px`, height: `${plan.mapHeight}px`, transform: `scale(${scale})`, transformOrigin: '0 0' }}
        />
        {plan.panel.height > 0 && (
          <canvas ref={panelRef} className="map-image-preview__panel" style={{ height: `${(1 - mapShare) * 100}%` }} aria-hidden="true" />
        )}
        <canvas ref={overRef} className="map-image-preview__over" aria-hidden="true" />
      </div>
      {mapError && (
        <p className="export__error" role="alert">
          The map could not be loaded: {mapError}
        </p>
      )}
    </div>
  );
}
