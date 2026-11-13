import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
// See ActivityMap: once bundled, MapLibre cannot find its worker on its own.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Activity } from '../domain/activity';
import { createInsetModels, type InsetCamera, type InsetComponentModel } from '../overlay/insetCamera';
import { insetStyleUrl } from '../overlay/insetMapStyle';
import { BASE_FONT_FRACTION } from '../overlay/export/drawOverlay';
import type { OverlayTemplate } from '../overlay/template';
import type { OverlayTimeline } from '../overlay/timeline';

setWorkerUrl(maplibreWorkerUrl);

/**
 * AV-1023 (TD-092). The preview's live maps: one MapLibre map for each route inset that has a
 * basemap, in the inset's box and under the canvas, moved to the camera the renderer draws the
 * line with (`createInsetModels`) at every moment, without waiting for tiles. The export draws
 * every frame with all its tiles; this is a guide, and the page says so.
 *
 * A map is laid out at the inset's size in reference pixels (the frame's shorter side at 1080),
 * then scaled to the preview's own size, so the same ground is in view at any size, as in the export.
 */
export interface InsetMapLayerProps {
  template: OverlayTemplate;
  timeline: OverlayTimeline;
  activity: Activity | undefined;
  /** The preview's canvas size, in pixels: the size the renderer is given. */
  width: number;
  height: number;
  /** The moment shown, in the canvas's own time. */
  seconds: number;
  maptilerKey: string;
}

export default function InsetMapLayer({ template, timeline, activity, width, height, seconds, maptilerKey }: InsetMapLayerProps) {
  const models = useMemo(() => [...createInsetModels({ template, timeline, activity, width, height }).values()].filter((model) => model.hasMap), [template, timeline, activity, width, height]);
  return (
    <div className="inset-map-layer" aria-hidden="true" data-testid="inset-map-layer">
      {models.map((model) => {
        const styleUrl = insetStyleUrl(model.setting, maptilerKey);
        return styleUrl ? <InsetMap key={`${model.component.id}|${styleUrl}`} model={model} styleUrl={styleUrl} camera={model.momentAt(seconds)?.camera} width={width} height={height} radius={0.4 * BASE_FONT_FRACTION * width * (template.components.find((c) => c.id === model.component.id)?.style.fontScale ?? template.style.fontScale)} /> : null;
      })}
    </div>
  );
}

function InsetMap({ model, styleUrl, camera, width, height, radius }: { model: InsetComponentModel; styleUrl: string; camera: InsetCamera | undefined; width: number; height: number; radius: number }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [factor, setFactor] = useState(1);
  const { frame, scale } = model;
  // The map is as large as the inset is in reference pixels.
  const refWidth = frame.w / scale;
  const refHeight = frame.h / scale;
  // What a map made now starts from, read when it is made; an edit to the template does not make a new map.
  const latest = useRef({ camera, fit: model.fit });
  useLayoutEffect(() => {
    latest.current = { camera, fit: model.fit };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let map: MapLibreMap;
    try {
      const start = latest.current.camera ?? latest.current.fit;
      map = new MapLibreMap({
        container: element,
        style: styleUrl,
        center: start.center,
        zoom: start.zoom,
        bearing: start.bearing,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        // Where the camera goes, the ground follows: no terrain here.
        centerClampedToGround: false,
      });
    } catch {
      // No WebGL: the line is drawn alone, as it is where there is no map.
      return;
    }
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // One map for a style: the template changing moves it, it does not make another.
  }, [styleUrl]);

  useEffect(() => {
    if (camera) mapRef.current?.jumpTo({ center: camera.center, zoom: camera.zoom, bearing: camera.bearing });
  }, [camera?.center[0], camera?.center[1], camera?.zoom, camera?.bearing]); // eslint-disable-line react-hooks/exhaustive-deps

  // The preview's size on the page is not its canvas size: the map is scaled with it.
  useEffect(() => {
    const element = wrapper.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    const measure = () => {
      if (element.clientWidth > 0) setFactor(element.clientWidth / refWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [refWidth]);

  return (
    <div
      ref={wrapper}
      className="inset-map"
      data-component={model.component.id}
      data-provider={model.setting.map.provider}
      style={{
        left: `${(frame.x / width) * 100}%`,
        top: `${(frame.y / height) * 100}%`,
        width: `${(frame.w / width) * 100}%`,
        height: `${(frame.h / height) * 100}%`,
        // As the canvas clips the inset: a circle, or the rounded corners of its box.
        borderRadius: model.setting.shape === 'round' ? '50%' : `${(radius / frame.w) * 100}% / ${(radius / frame.h) * 100}%`,
        // Not shown where the moment has no camera (outside the activity): the inset is not drawn there either.
        visibility: camera ? 'visible' : 'hidden',
      }}
    >
      <div ref={container} className="inset-map__map" style={{ width: refWidth, height: refHeight, transform: `scale(${factor})` }} />
    </div>
  );
}
