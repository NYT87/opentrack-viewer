import { useEffect, useMemo, useRef, useState } from 'react';
import { download } from '../components/ExportPanel';
import { FileDropZone } from '../components/FileDropZone';
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
import { useOverlayStore } from '../state/overlayStore';

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
  const clear = useOverlayStore((state) => state.clear);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [options, setOptions] = useState<RouteImageOptions>(DEFAULT_ROUTE_IMAGE);
  const [exportError, setExportError] = useState<string | undefined>();
  const [intakeError, setIntakeError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();
  const [isReading, setIsReading] = useState(false);

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
