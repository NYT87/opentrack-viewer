import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Activity } from '../domain/activity';
import { formatFileSize, type UnitSystem } from '../domain/units';
import { mapImageDetailChoices } from '../mapImage/details';
import { clampZoom, fitCamera, normalizeBearing } from '../mapImage/geometry';
import { planMapImage, stillOverlayClock } from '../mapImage/plan';
import { DEFAULT_MAP_IMAGE_SETTINGS, MAP_IMAGE_LIMITS, MAP_IMAGE_SIZE_PRESETS, mapImageSizeProblem, type MapImageCamera, type MapImageDetail, type MapImageSettings } from '../mapImage/settings';
import { MAP_VIDEO_LIMITS, type MapVideoColorBy } from '../mapVideo/project';
import { colorByChoices } from '../mapVideo/style';
import type { RenderWaiting } from '../mapVideo/export/renderMapVideo';
import { usePersonalStore } from '../state/personalStore';
import { canvasTemplate, type CanvasDraft } from '../overlay/customCanvas';
import { OverlayExportError } from '../overlay/export/errors';
import { measureText } from '../overlay/measureText';
import type { OverlayComponent } from '../overlay/template';
import { useInteractionStore } from '../state/interactionStore';
import { effectiveMapImageSettings, useMapImageStore } from '../state/mapImageStore';
import { CustomCanvas } from './CustomCanvas';
import { MapVideoBasemapChoice } from './MapVideoBasemapChoice';
import { useNumberDraft } from './useNumberDraft';

// MapLibre is loaded with the preview, only once there is an image to preview.
const MapImagePreview = lazy(() => import('./MapImagePreview'));

const FEET_PER_METER = 3.280839895;
/** How far one press of a button zooms, and turns. */
const ZOOM_STEP = 0.5;
const TURN_STEP = 15;

export interface MapImagePanelProps {
  activity: Activity;
  units: UnitSystem;
  /** For tests: the reader's time zone, which is otherwise the browser's. */
  readerTimeZone?: string;
  /** For tests: what makes the image, and what saves it. */
  render?: (typeof import('../mapImage/render'))['renderMapImage'];
  save?: (blob: Blob, fileName: string) => void;
}

type Phase =
  | { status: 'idle' }
  | { status: 'rendering'; waiting: RenderWaiting }
  | { status: 'done'; fileName: string; bytes: number; requests: number }
  | { status: 'error'; message: string };

function NumberField({ label, value, range, step, unit, decimals = 0, onChange }: { label: string; value: number; range: readonly [number, number]; step: number; unit?: string; decimals?: number; onChange: (value: number) => void }) {
  const id = useId();
  const draft = useNumberDraft(value, decimals, onChange, range);
  return (
    <div className="map-video-settings__field">
      <label htmlFor={id}>{label}</label>
      <span className="map-video-settings__input">
        <input id={id} type="number" min={range[0]} max={range[1]} step={step} aria-describedby={unit ? `${id}-unit` : undefined} {...draft} />
        {unit && <span id={`${id}-unit`}>{unit}</span>}
      </span>
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="map-video-settings__group">
      <legend className="summary__label">{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * AV-1013. The activity as an image of its map, on the overlay page: the
 * route on a real basemap, seen from straight above, which the reader moves,
 * zooms and turns, with the activity's details in a panel below it or placed
 * freely over it with the custom canvas's editor. Made in this tab, every map
 * request through the export's queue; nothing is uploaded.
 */
export function MapImagePanel({ activity, units, readerTimeZone, render, save = downloadBlob }: MapImagePanelProps) {
  const personal = usePersonalStore((state) => state.personal);
  const ids = { layout: useId(), size: useId(), colorBy: useId(), routeColor: useId(), casingColor: useId(), background: useId(), heading: useId() };
  const stored = useMapImageStore((state) => state.settings);
  const basemapChosen = useMapImageStore((state) => state.basemapChosen);
  const view = useMapImageStore((state) => state.view);
  const update = useMapImageStore((state) => state.updateSettings);
  const setBasemap = useMapImageStore((state) => state.setBasemap);
  const setCamera = useMapImageStore((state) => state.setCamera);
  const basemapEnabled = useInteractionStore((state) => state.basemapEnabled);
  const sizeProblem = mapImageSizeProblem(stored.output);
  /** The last size that could be drawn: the preview keeps it while another is typed. */
  // Opened again with a size past the limits still typed, it starts from the default size.
  const [drawable, setDrawable] = useState(() => (sizeProblem ? DEFAULT_MAP_IMAGE_SETTINGS.output : stored.output));
  if (!sizeProblem && (drawable.width !== stored.output.width || drawable.height !== stored.output.height)) setDrawable(stored.output);
  // The camera at the width the preview draws, so a size still being typed never rescales it.
  const settings = useMemo(
    () => effectiveMapImageSettings({ settings: stored, basemapChosen, view }, activity, basemapEnabled, drawable.width),
    [stored, basemapChosen, view, activity, basemapEnabled, drawable.width],
  );
  const shownSettings = useMemo<MapImageSettings>(() => ({ ...settings, output: drawable }), [settings, drawable]);
  const planned = useMemo(
    () => planMapImage({ activity, settings: shownSettings, units, measure: measureText, readerTimeZone }),
    [activity, shownSettings, units, readerTimeZone],
  );
  const plan = planned.ok ? planned.plan : undefined;
  const details = useMemo(
    () => (plan ? mapImageDetailChoices({ activity, shown: plan.shown, units, readerTimeZone }) : []),
    [activity, plan, units, readerTimeZone],
  );
  const colorBy = useMemo(() => (plan ? colorByChoices(activity, plan.route) : undefined), [activity, plan]);

  const onCamera = useCallback((camera: MapImageCamera) => setCamera(activity, camera, drawable.width), [setCamera, activity, drawable.width]);
  const moveCamera = (patch: Partial<MapImageCamera>) => {
    if (plan) setCamera(activity, { ...plan.camera, ...patch }, plan.width);
  };

  // The free canvas's editor: its frame is the image, its clock the activity's end.
  const [backdrop, setBackdrop] = useState<string>();
  const clock = useMemo(() => (plan ? stillOverlayClock(plan.shown) : undefined), [plan]);
  // TD-088 (AV-1013). Each time the editor opens it starts from what the store holds now, not from what it held when the panel
  // opened: switching to the panel's layout and back keeps everything placed. The undo history starts again with the editor.
  const canvasOpen = settings.layout === 'canvas';
  const editorDraft = useMemo<CanvasDraft>(
    () => ({ width: String(drawable.width), height: String(drawable.height), frame: drawable, state: { components: useMapImageStore.getState().settings.overlay }, history: [] }),
    // Where the editor starts: when it opens. It keeps its own copy from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasOpen],
  );
  const reported = useRef<OverlayComponent[] | undefined>(undefined);
  const onComponentsChange = useCallback(
    (components: OverlayComponent[]) => {
      if (components === reported.current) return;
      reported.current = components;
      update({ overlay: canvasTemplate(components).components });
    },
    [update],
  );

  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const stop = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stop.current?.abort(), []);
  const blocked = Boolean(sizeProblem) || !plan || phase.status === 'rendering';
  const exportImage = async () => {
    if (blocked) return;
    const controller = new AbortController();
    stop.current = controller;
    setPhase({ status: 'rendering', waiting: undefined });
    try {
      const renderImage = render ?? (await import('../mapImage/render')).renderMapImage;
      const { blob, requests } = await renderImage(
        { activity, settings, units, readerTimeZone, personal },
        { signal: controller.signal, onWaiting: (waiting) => setPhase({ status: 'rendering', waiting }) },
      );
      const fileName = `map-image.${settings.format === 'jpeg' ? 'jpg' : 'png'}`;
      save(blob, fileName);
      setPhase({ status: 'done', fileName, bytes: blob.size, requests });
    } catch (error) {
      if (controller.signal.aborted) {
        setPhase({ status: 'idle' });
        return;
      }
      setPhase({ status: 'error', message: error instanceof OverlayExportError || error instanceof Error ? error.message : 'The image could not be made.' });
    } finally {
      if (stop.current === controller) stop.current = undefined;
    }
  };

  const imperial = units === 'imperial';
  const trimUnit = imperial ? 'ft' : 'm';
  const toShown = (meters: number) => (imperial ? meters * FEET_PER_METER : meters);
  const fromShown = (value: number) => (imperial ? value / FEET_PER_METER : value);
  const trimRange = [0, toShown(MAP_VIDEO_LIMITS.trimMeters[1])] as const;
  const presetChosen = MAP_IMAGE_SIZE_PRESETS.find((preset) => preset.width === settings.output.width && preset.height === settings.output.height);
  const styleKey = [settings.basemap.source, settings.basemap.style].join('|');
  const toggleDetail = (detail: MapImageDetail, on: boolean) =>
    update({ panel: { details: on ? [...stored.panel.details.filter((entry) => entry !== detail), detail] : stored.panel.details.filter((entry) => entry !== detail) } });
  const videoView = plan?.video;

  return (
    <section className="prose map-image" aria-label="Map image">
      <h3 className="prose__title">Map image</h3>
      <p>
        The activity on a map, seen from straight above, with its details below it or placed over it, as
        one image. It is made in this tab, and nothing of the activity is uploaded.
      </p>

      <div className="map-image__workspace">
        {/* Kept in view beside the controls on a wide screen: the picture, how it is framed, and saving it. */}
        <div className="map-image__stage">
          {plan && (
            <Suspense fallback={<p role="status">Loading the map…</p>}>
              {/* A new map for another basemap: MapLibre's setStyle stops its worker. */}
              <MapImagePreview
                key={styleKey}
                activity={activity}
                plan={plan}
                settings={shownSettings}
                units={units}
                onCamera={onCamera}
                onSnapshot={setBackdrop}
                readerTimeZone={readerTimeZone}
              />
            </Suspense>
          )}
          {plan && (
            <Group legend="The map’s view">
              <p className="map-video-settings__hint">
                Drag the map to move it, scroll or pinch to zoom, and right-drag or twist to turn it. {plan.fitted ? 'It is fitted to the route.' : ''}
              </p>
              <div className="video__actions" role="group" aria-label="Move the map">
                <button type="button" className="button" onClick={() => moveCamera({ zoom: clampZoom(plan.camera.zoom + ZOOM_STEP) })}>
                  Zoom in
                </button>
                <button type="button" className="button" onClick={() => moveCamera({ zoom: clampZoom(plan.camera.zoom - ZOOM_STEP) })}>
                  Zoom out
                </button>
                <button type="button" className="button" onClick={() => moveCamera({ bearing: normalizeBearing(plan.camera.bearing - TURN_STEP) })}>
                  Turn left
                </button>
                <button type="button" className="button" onClick={() => moveCamera({ bearing: normalizeBearing(plan.camera.bearing + TURN_STEP) })}>
                  Turn right
                </button>
                <button type="button" className="button" onClick={() => moveCamera({ bearing: 0 })} disabled={plan.camera.bearing === 0}>
                  North up
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setCamera(activity, fitCamera(plan.route, { width: plan.width, height: plan.mapHeight }, plan.camera.bearing), plan.width)}
                >
                  Fit to the route
                </button>
              </div>
              <NumberField label="Heading" unit="° from north" value={Math.round(plan.camera.bearing) % 360} range={[0, 359]} step={1} onChange={(bearing) => moveCamera({ bearing })} />
            </Group>
          )}
          <Group legend="Save">
            <label className="overlay-controls__choice">
              <input type="radio" name="map-image-format" checked={settings.format === 'png'} onChange={() => update({ format: 'png' })} />
              <span>PNG, sharp and larger</span>
            </label>
            <label className="overlay-controls__choice">
              <input type="radio" name="map-image-format" checked={settings.format === 'jpeg'} onChange={() => update({ format: 'jpeg' })} />
              <span>JPEG, smaller</span>
            </label>
            <p className="video__actions">
              <button type="button" className="button button--primary" onClick={() => void exportImage()} disabled={blocked}>
                Save the image
              </button>
              {phase.status === 'rendering' && (
                <button type="button" className="button" onClick={() => stop.current?.abort()}>
                  Stop
                </button>
              )}
            </p>
            <p role="status" className="map-video-settings__hint">
              {phase.status === 'rendering' &&
                (phase.waiting === 'hidden'
                  ? 'Waiting: the map is drawn only while this tab is in front.'
                  : phase.waiting === 'tiles'
                    ? 'Waiting for the map’s tiles…'
                    : `Drawing the image at ${settings.output.width} × ${settings.output.height}…`)}
              {phase.status === 'done' &&
                `Saved ${phase.fileName} (${formatFileSize(phase.bytes)}). ${phase.requests === 0 ? 'No map was asked for.' : `The map took ${phase.requests} requests.`}`}
            </p>
            {phase.status === 'error' && (
              <p className="export__error" role="alert">
                {phase.message}
              </p>
            )}
          </Group>
        </div>
        <div className="map-image__controls">
          <fieldset className="map-video-settings__group" aria-describedby={ids.layout}>
            <legend className="summary__label">Layout</legend>
            <label className="overlay-controls__choice">
              <input type="radio" name="map-image-layout" checked={settings.layout === 'panel'} onChange={() => update({ layout: 'panel' })} />
              <span>The map, with a panel of details below it</span>
            </label>
            <label className="overlay-controls__choice">
              <input type="radio" name="map-image-layout" checked={settings.layout === 'canvas'} onChange={() => update({ layout: 'canvas' })} />
              <span>The map filling the image, with figures, text and shapes placed over it</span>
            </label>
            <p id={ids.layout} className="map-video-settings__hint">
              Either way the map can be moved, zoomed and turned, but not tilted.
            </p>
          </fieldset>

          {/* Said before any map exists, so no tile is fetched before the reader has read this (TD-064). */}
          {videoView && (
            <MapVideoBasemapChoice
              settings={videoView}
              onSource={setBasemap}
              onChange={(patch) => {
                if (patch.basemap) update({ basemap: patch.basemap });
              }}
          maptilerKey=""
          onMaptilerKey={() => undefined}
              forImage
            />
          )}

          {!planned.ok && (
            <div className="panel panel--error" role="alert">
              <p className="panel__message">{planned.error}</p>
            </div>
          )}


          <Group legend="Size">
            <div className="map-video-settings__field">
              <label htmlFor={ids.size}>Size</label>
              <select
                id={ids.size}
                value={presetChosen?.id ?? 'custom'}
                onChange={(event) => {
                  const preset = MAP_IMAGE_SIZE_PRESETS.find((entry) => entry.id === event.target.value);
                  if (preset) update({ output: { width: preset.width, height: preset.height } });
                }}
              >
                {MAP_IMAGE_SIZE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom" disabled>
                  Your own size
                </option>
              </select>
            </div>
            <NumberField label="Width" unit="px" value={settings.output.width} range={[MAP_IMAGE_LIMITS.minSide, MAP_IMAGE_LIMITS.maxSide]} step={1} onChange={(width) => update({ output: { width } })} />
            <NumberField label="Height" unit="px" value={settings.output.height} range={[MAP_IMAGE_LIMITS.minSide, MAP_IMAGE_LIMITS.maxSide]} step={1} onChange={(height) => update({ output: { height } })} />
            {sizeProblem && (
              <p className="export__error" role="alert">
                {sizeProblem}
              </p>
            )}
          </Group>

          <Group legend="Route">
            <div className="map-video-settings__field">
              <label htmlFor={ids.colorBy}>Colour</label>
              <select id={ids.colorBy} value={settings.route.colorBy} onChange={(event) => update({ route: { colorBy: event.target.value as MapVideoColorBy } })}>
                {(colorBy ?? [{ value: 'none', label: 'One colour', available: true }]).map((choice) => (
                  <option key={choice.value} value={choice.value} disabled={!choice.available}>
                    {choice.available ? choice.label : `${choice.label} (not recorded)`}
                  </option>
                ))}
              </select>
            </div>
            {colorBy
              ?.filter((choice) => !choice.available)
              .map((choice) => (
                <p key={choice.value} className="map-video-settings__hint">
                  {choice.label}: {choice.reason}
                </p>
              ))}
            {settings.route.colorBy === 'none' && (
              <div className="map-video-settings__field">
                <label htmlFor={ids.routeColor}>Line colour</label>
                <input id={ids.routeColor} type="color" value={settings.route.color} onChange={(event) => update({ route: { color: event.target.value } })} />
              </div>
            )}
            <NumberField label="Line width" unit="px" value={settings.route.width} range={MAP_VIDEO_LIMITS.routeWidth} step={1} onChange={(width) => update({ route: { width } })} />
            <label className="overlay-controls__choice">
              <input type="checkbox" checked={settings.route.casing} onChange={(event) => update({ route: { casing: event.target.checked } })} />
              <span>A darker edge along the line</span>
            </label>
            {settings.route.casing && (
              <div className="map-video-settings__field">
                <label htmlFor={ids.casingColor}>Edge colour</label>
                <input id={ids.casingColor} type="color" value={settings.route.casingColor} onChange={(event) => update({ route: { casingColor: event.target.value } })} />
              </div>
            )}
            <label className="overlay-controls__choice">
              <input type="checkbox" checked={settings.endpoints.shown} onChange={(event) => update({ endpoints: { shown: event.target.checked } })} />
              <span>Start and finish markers, where the trimmed route begins and ends</span>
            </label>
          </Group>

          {settings.layout === 'panel' && (
            <Group legend="Details below the map">
              <div className="map-video-settings__field">
                <label htmlFor={ids.background}>Panel colour</label>
                <input id={ids.background} type="color" value={settings.panel.background} onChange={(event) => update({ panel: { background: event.target.value } })} />
              </div>
              {details.map((choice) => (
                <label key={choice.detail} className="overlay-controls__choice">
                  <input
                    type="checkbox"
                    checked={choice.available && settings.panel.details.includes(choice.detail)}
                    disabled={!choice.available}
                    onChange={(event) => toggleDetail(choice.detail, event.target.checked)}
                  />
                  <span>
                    {choice.label}
                    {!choice.available && <span className="map-video-settings__hint"> ({choice.reason})</span>}
                  </span>
                </label>
              ))}
              <p className="map-video-settings__hint">The panel is as tall as what it holds needs, and never more than half the image.</p>
            </Group>
          )}

          <Group legend="Privacy trim">
            <p className="map-video-settings__hint">
              Hides the start and the end of the route from the image (the line, the map’s framing and the
              profile), so it need not show where you live.
            </p>
            <NumberField label="Hide the first" unit={trimUnit} value={toShown(settings.privacyTrim.startMeters)} range={trimRange} step={imperial ? 50 : 10} onChange={(value) => update({ privacyTrim: { startMeters: fromShown(value) } })} />
            <NumberField label="Hide the last" unit={trimUnit} value={toShown(settings.privacyTrim.endMeters)} range={trimRange} step={imperial ? 50 : 10} onChange={(value) => update({ privacyTrim: { endMeters: fromShown(value) } })} />
          </Group>

          {settings.layout === 'canvas' && plan && clock && (
            <CustomCanvas
              activity={plan.shown}
              offsetSeconds={0}
              units={units}
              readerTimeZone={readerTimeZone}
              initialDraft={editorDraft}
              host={{
                title: 'Over the map',
                intro: 'Place shapes, text, figures for the whole activity, the date, the route and the elevation profile over the map.',
                frame: drawable,
                timeline: clock.timeline,
                seconds: clock.seconds,
                onSeek: () => undefined,
                backdrop,
                onComponentsChange,
                still: true,
              }}
            />
          )}

        </div>
      </div>
    </section>
  );
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
