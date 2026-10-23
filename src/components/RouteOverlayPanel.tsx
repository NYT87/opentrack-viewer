import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatFileSize } from '../domain/units';
import { drawRouteImage, renderRouteImagePng } from '../overlay/export/drawRouteImage';
import {
  DEFAULT_ROUTE_IMAGE_OPTIONS,
  ROUTE_IMAGE_ASPECTS,
  ROUTE_IMAGE_LIMITS,
  RouteImageError,
  extractRoute,
  planRouteImage,
  routeImageFileName,
  scaleRouteImagePlan,
  type RouteImageOptions,
  type RouteImagePlan,
} from '../overlay/routeImage';

/** The long side of the preview, in pixels: it is the plan scaled down to this. */
const PREVIEW_LONG_SIDE = 640;

interface RouteOverlayPanelProps {
  activity: Activity;
  /** The activity is a focused section the reader handed over, not the whole recording. */
  focusedSection?: boolean;
  /** For tests: stand-ins for the encoder and the browser's download. */
  renderPng?: typeof renderRouteImagePng;
  save?: (blob: Blob, fileName: string) => void;
}

type Phase =
  | { status: 'idle' }
  | { status: 'rendering' }
  | { status: 'saved'; fileName: string; bytes: number }
  | { status: 'error'; message: string };

/**
 * AV-1009. The route of an activity as a transparent PNG, for placing over a
 * video or a design. It needs no video: the route is fitted into the size
 * asked for, the preview is the same drawing as the file at a smaller size, and
 * the file is made in this tab and handed to the browser's download. Nothing is
 * uploaded, and no map is drawn under the line.
 */
export function RouteOverlayPanel({
  activity,
  focusedSection = false,
  renderPng = renderRouteImagePng,
  save = downloadBlob,
}: RouteOverlayPanelProps) {
  const id = useId();
  const [width, setWidth] = useState(String(DEFAULT_ROUTE_IMAGE_OPTIONS.width));
  const [height, setHeight] = useState(String(DEFAULT_ROUTE_IMAGE_OPTIONS.height));
  const [paddingPercent, setPaddingPercent] = useState(
    String(DEFAULT_ROUTE_IMAGE_OPTIONS.paddingFraction * 100),
  );
  const [lineWidth, setLineWidth] = useState(String(DEFAULT_ROUTE_IMAGE_OPTIONS.lineWidth));
  const [color, setColor] = useState(DEFAULT_ROUTE_IMAGE_OPTIONS.color);
  const [markers, setMarkers] = useState(DEFAULT_ROUTE_IMAGE_OPTIONS.markers);
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });

  const extracted = useMemo(() => extractRoute(activity), [activity]);
  const planned = useMemo(
    () =>
      extracted.ok
        ? planRouteImage(
            extracted.route,
            readOptions({ width, height, paddingPercent, lineWidth, color, markers }),
          )
        : extracted,
    [extracted, width, height, paddingPercent, lineWidth, color, markers],
  );
  const plan = planned.ok ? planned.plan : undefined;
  const aspect = ROUTE_IMAGE_ASPECTS.find(
    (entry) => entry.width === parseNumber(width) && entry.height === parseNumber(height),
  );

  const handleSave = async () => {
    if (!plan) return;
    setPhase({ status: 'rendering' });
    try {
      const blob = await renderPng(plan);
      const fileName = routeImageFileName(plan);
      save(blob, fileName);
      setPhase({ status: 'saved', fileName, bytes: blob.size });
    } catch (error) {
      setPhase({
        status: 'error',
        message:
          error instanceof RouteImageError ? error.message : 'The image could not be made.',
      });
    }
  };

  return (
    <section className="prose overlay-controls" aria-label="Route image">
      <h3 className="prose__title">Route image</h3>
      <p>
        {focusedSection
          ? 'The focused section of the activity, as a route on a transparent background.'
          : 'The whole activity, as a route on a transparent background.'}{' '}
        No map is drawn under it.
      </p>

      <fieldset className="overlay-controls__group">
        <legend>Size</legend>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-aspect`}>Aspect ratio</label>
          <select
            id={`${id}-aspect`}
            className="select"
            value={aspect?.id ?? 'custom'}
            onChange={(event) => {
              const chosen = ROUTE_IMAGE_ASPECTS.find((entry) => entry.id === event.target.value);
              if (!chosen) return;
              setWidth(String(chosen.width));
              setHeight(String(chosen.height));
            }}
          >
            {ROUTE_IMAGE_ASPECTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            {!aspect && <option value="custom">Custom</option>}
          </select>
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-width`}>Width (px)</label>
          <input
            id={`${id}-width`}
            className="input"
            type="number"
            inputMode="numeric"
            min={ROUTE_IMAGE_LIMITS.minSide}
            max={ROUTE_IMAGE_LIMITS.maxSide}
            step={1}
            value={width}
            onChange={(event) => setWidth(event.target.value)}
          />
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-height`}>Height (px)</label>
          <input
            id={`${id}-height`}
            className="input"
            type="number"
            inputMode="numeric"
            min={ROUTE_IMAGE_LIMITS.minSide}
            max={ROUTE_IMAGE_LIMITS.maxSide}
            step={1}
            value={height}
            onChange={(event) => setHeight(event.target.value)}
          />
        </div>
      </fieldset>

      <fieldset className="overlay-controls__group">
        <legend>Line</legend>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-color`}>Route colour</label>
          <input
            id={`${id}-color`}
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_ROUTE_IMAGE_OPTIONS.color}
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-line`}>Route width (px)</label>
          <input
            id={`${id}-line`}
            className="input"
            type="number"
            inputMode="decimal"
            min={ROUTE_IMAGE_LIMITS.minLineWidth}
            max={ROUTE_IMAGE_LIMITS.maxLineWidth}
            step={1}
            value={lineWidth}
            onChange={(event) => setLineWidth(event.target.value)}
          />
        </div>
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-padding`}>Padding (% of the shorter side)</label>
          <input
            id={`${id}-padding`}
            className="input"
            type="number"
            inputMode="decimal"
            min={0}
            max={ROUTE_IMAGE_LIMITS.maxPaddingFraction * 100}
            step={1}
            value={paddingPercent}
            onChange={(event) => setPaddingPercent(event.target.value)}
          />
        </div>
        <label className="overlay-controls__choice">
          <input
            type="checkbox"
            checked={markers}
            onChange={(event) => setMarkers(event.target.checked)}
          />
          <span>Mark the start and the end</span>
        </label>
      </fieldset>

      {plan ? (
        <>
          <div className="overlay-controls__group route-image__stage">
            <RoutePreview plan={plan} />
          </div>
          {plan.notes.map((note) => (
            <p key={note} className="overlay-controls__hint">
              {note}
            </p>
          ))}
          <p className="overlay-controls__hint" data-testid="route-image-size">
            {plan.width} × {plan.height} px, PNG with a transparent background.
          </p>
        </>
      ) : (
        <p role="alert" className="export__error">
          {planned.ok ? '' : planned.error.message}
        </p>
      )}

      <p className="video__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!plan || phase.status === 'rendering'}
          onClick={() => void handleSave()}
        >
          {phase.status === 'rendering' ? 'Making the image…' : 'Download PNG'}
        </button>
      </p>
      {phase.status === 'saved' && (
        <p role="status" className="export__saved">
          Saved {phase.fileName} ({formatFileSize(phase.bytes)}).
        </p>
      )}
      {phase.status === 'error' && (
        <p role="alert" className="export__error">
          {phase.message}
        </p>
      )}
    </section>
  );
}

function RoutePreview({ plan }: { plan: RouteImagePlan }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const factor = Math.min(1, PREVIEW_LONG_SIDE / Math.max(plan.width, plan.height));
  const scaled = useMemo(() => scaleRouteImagePlan(plan, factor), [plan, factor]);

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) drawRouteImage(ctx, scaled);
  }, [scaled]);

  return (
    <canvas
      ref={ref}
      className="route-image__canvas"
      width={scaled.width}
      height={scaled.height}
      style={{ aspectRatio: `${plan.width} / ${plan.height}` }}
      role="img"
      aria-label={`Route preview, ${plan.width} by ${plan.height} pixels, transparent background`}
      data-testid="route-image-preview"
    />
  );
}

function readOptions(fields: {
  width: string;
  height: string;
  paddingPercent: string;
  lineWidth: string;
  color: string;
  markers: boolean;
}): RouteImageOptions {
  return {
    width: parseNumber(fields.width),
    height: parseNumber(fields.height),
    paddingFraction: parseNumber(fields.paddingPercent) / 100,
    color: fields.color,
    lineWidth: parseNumber(fields.lineWidth),
    markers: fields.markers,
  };
}

/** An empty or half-typed field is not a number: it is refused, not read as zero. */
function parseNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/** Hands the blob to the browser's download, then lets go of it (as the viewer's export does). */
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
