import { useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../components/ExportPanel';
import { FileDropZone } from '../components/FileDropZone';
import { OverlayFrameExport, type VideoInfo } from '../components/OverlayFrameExport';
import { OverlayTemplateEditor } from '../components/OverlayTemplateEditor';
import { OverlayVideoPreview } from '../components/OverlayVideoPreview';
import { toActivityError } from '../domain/errors';
import { projectRoute } from '../domain/routeProjection';
import {
  DEFAULT_ROUTE_IMAGE,
  ROUTE_IMAGE_PRESETS,
  canvasToPng,
  renderRouteToCanvas,
  routeImageBaseName,
  validateRouteImageOptions,
  type RouteImageOptions,
} from '../overlays/routeImage';
import { parseActivityFile } from '../parsers';
import { createOverlayRenderer } from '../overlays/renderOverlay';
import { BUILT_IN_TEMPLATES, availabilityOf, staticAvailability } from '../overlays/template';
import { buildTimeline } from '../overlays/timeline';
import type { UnitSystem } from '../domain/units';
import { useInteractionStore } from '../state/interactionStore';
import { CUSTOM_TEMPLATE_ID, currentTemplate, useOverlayTemplateStore } from '../state/overlayTemplateStore';
import { useOverlayStore } from '../state/overlayStore';

/** The containers a camera or phone writes that a browser may play. */
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v'];

/**
 * AV-1002 / AV-1009. Makes overlays from an activity.
 *
 * Today that is one thing: the route, alone, as a transparent PNG to lay over a
 * video in an editor. The page is the home for the telemetry-video overlays
 * that follow (AV-1003 onward), which is why it is its own route and not part
 * of the viewer.
 *
 * Everything is drawn in this tab. The image is a canvas encoded to a `Blob`
 * and saved by the browser; no coordinates, pixels or files are sent anywhere.
 */
export function OverlayPage() {
  const activity = useOverlayStore((state) => state.activity);
  const isSection = useOverlayStore((state) => state.isSection);
  const setActivity = useOverlayStore((state) => state.setActivity);
  const video = useOverlayStore((state) => state.video);
  const setVideo = useOverlayStore((state) => state.setVideo);
  const clear = useOverlayStore((state) => state.clear);
  const defaultUnits = useInteractionStore((state) => state.unitSystem);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [options, setOptions] = useState<RouteImageOptions>(DEFAULT_ROUTE_IMAGE);
  const [exportError, setExportError] = useState<string | undefined>();
  const [intakeError, setIntakeError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  const [isReading, setIsReading] = useState(false);
  // AV-1005. The template lives in a session store so edits survive moving
  // between pages and switching templates, and nothing else.
  const selectedId = useOverlayTemplateStore((state) => state.selectedId);
  const savedTemplates = useOverlayTemplateStore((state) => state.saved);
  const chosenUnits = useOverlayTemplateStore((state) => state.units);
  const selectTemplate = useOverlayTemplateStore((state) => state.select);
  const saveTemplate = useOverlayTemplateStore((state) => state.save);
  const changeUnits = useOverlayTemplateStore((state) => state.setUnits);
  const importTemplate = useOverlayTemplateStore((state) => state.importTemplate);
  const resetTemplate = useOverlayTemplateStore((state) => state.reset);
  const units: UnitSystem = chosenUnits ?? defaultUnits;
  const template = useMemo(
    () => currentTemplate({ selectedId, saved: savedTemplates }, units),
    [selectedId, savedTemplates, units],
  );
  const [offsetSeconds, setOffsetSeconds] = useState(0);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | undefined>();

  // AV-1004. The clock the video is lined up against, and what it can supply.
  const timelineResult = useMemo(() => (activity ? buildTimeline(activity) : undefined), [activity]);
  const overlayRenderer = useMemo(() => {
    if (!activity || !timelineResult) return undefined;
    return createOverlayRenderer({
      activity,
      template,
      ...(timelineResult.ok
        ? { timeline: timelineResult.timeline, availability: availabilityOf(timelineResult.timeline) }
        : { availability: staticAvailability(activity.streams.hasLocation) }),
    });
  }, [activity, timelineResult, template]);

  const sensorChoices = useMemo(
    () =>
      timelineResult?.ok
        ? (activity?.sensorStreams ?? [])
            .filter((stream) => timelineResult.timeline.availableSensors.has(stream.key))
            .map((stream) => ({ key: stream.key, label: stream.label }))
        : [],
    [activity, timelineResult],
  );

  /**
   * What is wrong with the current settings or route, if anything. Worked out
   * during render rather than discovered by drawing, so the message and the
   * disabled Save button can never disagree with what is on screen.
   */
  const problem = useMemo(() => {
    if (!activity) return undefined;
    try {
      validateRouteImageOptions(options);
      projectRoute(activity.points, options);
      return undefined;
    } catch (error) {
      return toActivityError(error, 'file_read_failed').message;
    }
  }, [activity, options]);

  // Redraw the preview whenever what it shows changes. The preview *is* the
  // export canvas, so what is seen is what is saved. A drawing failure that
  // validation did not foresee (no canvas support) is reported on export.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activity || problem) return;
    try {
      renderRouteToCanvas(canvas, activity, options);
    } catch {
      /* reported by handleExport */
    }
  }, [activity, options, problem]);

  const handleVideo = (file: File) => {
    setOffsetSeconds(0);
    setVideoInfo(undefined);
    setVideo(file);
  };

  const handleFile = async (file: File) => {
    setIsReading(true);
    setIntakeError(undefined);
    try {
      const { activity: parsed } = await parseActivityFile(file);
      // The viewer is happy to open an indoor workout; there is nothing here to
      // draw from one, and saying so now beats an empty preview.
      if (!parsed.streams.hasLocation) {
        setIntakeError('That file has no GPS coordinates, so there is no route to draw.');
        return;
      }
      setActivity(parsed);
    } catch (error) {
      const failure = toActivityError(error, 'unsupported_format');
      setIntakeError(`${failure.message} ${failure.hint}`);
    } finally {
      setIsReading(false);
    }
  };

  const handleExport = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !activity || problem) return;
    try {
      renderRouteToCanvas(canvas, activity, options);
      const blob = await canvasToPng(canvas);
      const fileName = `${routeImageBaseName(activity)}.png`;
      download(blob, fileName);
      setSaved(fileName);
      setExportError(undefined);
    } catch (error) {
      setSaved(undefined);
      setExportError(toActivityError(error, 'file_read_failed').message);
    }
  };

  const setNumber = (key: 'width' | 'height' | 'padding' | 'lineWidth') => (value: string) =>
    setOptions((current) => ({ ...current, [key]: value === '' ? NaN : Number(value) }));

  const presetId =
    ROUTE_IMAGE_PRESETS.find((p) => p.width === options.width && p.height === options.height)?.id ?? 'custom';

  return (
    <main className="page">
      <div className="page__inner">
        <header className="page__header">
          <h2 className="page__title">Overlays</h2>
          <p className="page__intro">
            Draw a route as a transparent image to lay over a video in your editor. It is made in
            this tab from a file on your device — nothing is uploaded.
          </p>
        </header>

        {!activity && (
          <section className="prose" aria-label="Choose a route">
            <h3 className="prose__title">Choose a route</h3>
            <p>
              Open a GPX, FIT or TCX file here, or open one in the file viewer and choose{' '}
              <em>Create route overlay</em>.
            </p>
            {intakeError && (
              <p role="alert" className="route-tools__notice">
                {intakeError}
              </p>
            )}
            <FileDropZone onFile={(file) => void handleFile(file)} disabled={isReading} />
          </section>
        )}

        {activity && (
          <>
            <section className="box route-tools" aria-label="Overlay settings">
              <p className="route-tools__help">
                {activity.metadata.name ?? activity.source.fileName ?? 'Route'}
                {isSection ? ' — selected section only' : ''}
              </p>

              <div className="route-tools__row">
                <label className="export__label">
                  Size{' '}
                  <select
                    className="select"
                    value={presetId}
                    onChange={(event) => {
                      const preset = ROUTE_IMAGE_PRESETS.find((p) => p.id === event.target.value);
                      if (preset) {
                        setOptions((o) => ({ ...o, width: preset.width, height: preset.height }));
                      }
                    }}
                  >
                    {ROUTE_IMAGE_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom" disabled>
                      Custom
                    </option>
                  </select>
                </label>
                <label className="export__label">
                  Width{' '}
                  <input
                    className="input"
                    type="number"
                    value={Number.isNaN(options.width) ? '' : options.width}
                    onChange={(event) => setNumber('width')(event.target.value)}
                  />
                </label>
                <label className="export__label">
                  Height{' '}
                  <input
                    className="input"
                    type="number"
                    value={Number.isNaN(options.height) ? '' : options.height}
                    onChange={(event) => setNumber('height')(event.target.value)}
                  />
                </label>
                <label className="export__label">
                  Padding{' '}
                  <input
                    className="input"
                    type="number"
                    value={Number.isNaN(options.padding) ? '' : options.padding}
                    onChange={(event) => setNumber('padding')(event.target.value)}
                  />
                </label>
              </div>

              <div className="route-tools__row">
                <label className="export__label">
                  Route colour{' '}
                  <input
                    type="color"
                    value={options.color}
                    onChange={(event) => setOptions((o) => ({ ...o, color: event.target.value }))}
                  />
                </label>
                <label className="export__label">
                  Route width{' '}
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={Number.isNaN(options.lineWidth) ? '' : options.lineWidth}
                    onChange={(event) => setNumber('lineWidth')(event.target.value)}
                  />
                </label>
                <label className="export__label">
                  <input
                    type="checkbox"
                    checked={options.showMarkers}
                    onChange={(event) =>
                      setOptions((o) => ({ ...o, showMarkers: event.target.checked }))
                    }
                  />{' '}
                  Mark the start and end
                </label>
              </div>

              {(problem ?? exportError) && (
                <p role="alert" className="route-tools__notice">
                  {problem ?? exportError}
                </p>
              )}
            </section>

            <section className="box overlay-preview" aria-label="Preview">
              <canvas
                ref={canvasRef}
                className="overlay-preview__canvas"
                data-testid="overlay-canvas"
                aria-label="Route overlay preview"
              />
            </section>

            <section className="box route-tools" aria-label="Video overlay">
              <h3 className="prose__title">Preview on a video</h3>
              {timelineResult && !timelineResult.ok && (
                <p role="note">{timelineResult.reason}</p>
              )}
              {timelineResult?.ok && overlayRenderer && (
                <>
                  <div className="route-tools__row">
                    <label className="export__label">
                      Template{' '}
                      <select
                        className="select"
                        value={selectedId}
                        onChange={(event) => selectTemplate(event.target.value, units)}
                      >
                        {BUILT_IN_TEMPLATES.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                        {savedTemplates[CUSTOM_TEMPLATE_ID] && (
                          <option value={CUSTOM_TEMPLATE_ID}>
                            {savedTemplates[CUSTOM_TEMPLATE_ID].name} (loaded)
                          </option>
                        )}
                      </select>
                    </label>
                    <label className="export__label">
                      Units{' '}
                      <select
                        className="select"
                        value={units}
                        onChange={(event) => changeUnits(event.target.value as UnitSystem, template)}
                      >
                        <option value="metric">Metric</option>
                        <option value="imperial">Imperial</option>
                      </select>
                    </label>
                  </div>

                  {overlayRenderer.resolved.hidden.length > 0 && (
                    <ul className="export__warnings" aria-label="Hidden components">
                      {overlayRenderer.resolved.hidden.map(({ component, reason }) => (
                        <li key={component.id}>{reason}</li>
                      ))}
                    </ul>
                  )}

                  <OverlayTemplateEditor
                    template={template}
                    availability={
                      timelineResult.ok ? availabilityOf(timelineResult.timeline) : staticAvailability(false)
                    }
                    hidden={overlayRenderer.resolved.hidden}
                    sensors={sensorChoices}
                    onChange={saveTemplate}
                    onImport={importTemplate}
                    onReset={resetTemplate}
                  />

                  {!video && (
                    <>
                      <p>Choose the video these figures belong to. It stays on this device.</p>
                      <FileDropZone
                        acceptedExtensions={VIDEO_EXTENSIONS}
                        onFile={handleVideo}
                      />
                    </>
                  )}
                  {video && (
                    <>
                      <OverlayVideoPreview
                        file={video}
                        renderer={overlayRenderer}
                        offsetSeconds={offsetSeconds}
                        onOffsetChange={setOffsetSeconds}
                        onMetadata={setVideoInfo}
                      />
                      <p>
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            setVideoInfo(undefined);
                            setVideo(undefined);
                          }}
                        >
                          Choose another video
                        </button>
                      </p>
                    </>
                  )}
                </>
              )}
            </section>

            {timelineResult?.ok && overlayRenderer && video && videoInfo && (
              <OverlayFrameExport
                renderer={overlayRenderer}
                offsetSeconds={offsetSeconds}
                video={videoInfo}
              />
            )}

            <section className="box route-tools" aria-label="Save overlay">
              <p className="export__hint">
                Saved as a PNG with a transparent background: only the route is drawn, with no map
                behind it.
              </p>
              <div className="route-tools__row">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void handleExport()}
                  disabled={Boolean(problem)}
                >
                  Save as PNG
                </button>
                <button type="button" className="button" onClick={clear}>
                  Choose another route
                </button>
              </div>
              {saved && (
                <p role="status" className="export__saved">
                  Saved <strong>{saved}</strong>.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
