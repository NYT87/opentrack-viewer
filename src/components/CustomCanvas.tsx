import { LAYOUT_FILE_MAX_BYTES } from '../overlay/staticImage';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Activity } from '../domain/activity';
import { formatDuration, type UnitSystem } from '../domain/units';
import {
  CANVAS_LIMITS,
  CANVAS_LIMITS_TEXT,
  CANVAS_PRESETS,
  canvasElementChoices,
  canvasTemplate,
  checkCanvasSize,
  componentsFromStart,
  duplicateComponent,
  growFigureToFit,
  moveComponent,
  moveLayer,
  newCanvasComponents,
  nudgeComponent,
  pushHistory,
  removeComponent,
  resizeComponent,
  scaleText,
  TEXT_SCALE_LIMITS,
  setHolder,
  type CanvasElementChoice,
  type CanvasElementKey,
  ELEVATION_MISSING,
  EMPTY_CANVAS_DRAFT,
  type CanvasDraft,
  type CanvasState,
  type LayerMove,
} from '../overlay/customCanvas';
import { figureLayout } from '../overlay/figureLayout';
import { BASE_FONT_FRACTION, createOverlayRenderer } from '../overlay/export/drawOverlay';
import { measureText } from '../overlay/measureText';
import { DEFAULT_OVERLAY_CONTROLS } from '../overlay/presets';
import { START_LAYOUTS, type StartLayoutId } from '../overlay/predefined';
import { extractRoute } from '../overlay/routeImage';
import {
  SNAP_POSITIONS,
  describeStillComponent,
  layoutStillText,
  parseOverlayLayout,
  serializeStillLayout,
  snapRect,
  stillValue,
  type Box,
  type StillImageContext,
} from '../overlay/staticImage';
import {
  DEFAULT_OVERLAY_STYLE,
  DEFAULT_SHAPE,
  FIGURE_GAP_MAX,
  MOMENT_COMPONENT_TYPES,
  SHAPE_KINDS,
  STILL_IMAGE_COMPONENT_TYPES,
  SUMMARY_STAT_KEYS,
  ZONES_SHAPES,
  componentsForLayoutFile,
  needsHalo,
  normalizeRect,
  personalHeldBy,
  sanitizeLabel,
  type OverlayComponent,
  type OverlayFigureSetting,
  type OverlayShapeSetting,
  type OverlayUnitMode,
  type PersonalFigures,
  type ShapeKind,
  type SummaryStatKey,
  type TextAlign,
  type ZonesShape,
  type ZonesSource,
} from '../overlay/template';
import { SMOOTHING_LIMITS, buildOverlayTimeline, canSmooth, type OverlayTimeline } from '../overlay/timeline';
import type { VideoTrim } from '../overlay/trim';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';
import { GITHUB_URL } from './SiteFooter';
import { BurnedInExportPanel } from './BurnedInExportPanel';
import { OverlayExportPanel } from './OverlayExportPanel';
import { DateSettings, PercentField } from './RouteOverlayPanel';
import { usePersonalStore } from '../state/personalStore';
import {
  PERSONAL_LIMITS,
  REFERENCE_KEY,
  REFERENCE_LABEL,
  ZONES_UNIT,
  ZONE_FROM_MAX,
  ZONE_LIMITS,
  ZONE_NAME_MAX,
  activityHighest,
  addZone,
  changeBasis,
  cleanFigure,
  defaultZonesSetting,
  effectivePersonal,
  removeLastZone,
  setZone,
  DEFAULT_ZONES_SMOOTHING_SECONDS,
} from '../overlay/zones';
import { ElementRows } from './ElementRows';
import { ColorField } from './ColorField';
import { ChartEditor, CompassEditor, DialEditor, GradientEditor } from './MomentEditors';

/** The long side of the preview, in pixels: the overlay is drawn at this size by the export's renderer. */
const PREVIEW_LONG_SIDE = 720;
const NUDGE = 0.01;
const NUDGE_FAR = 0.1;
/** How near the selected element's corner a press resizes rather than moves, in preview pixels. */
const HANDLE = 12;

interface CustomCanvasProps {
  activity: Activity;
  /** The source video, when there is one; without it, the canvas is the whole output. */
  video?: OverlayVideo;
  media?: OverlayMedia;
  offsetSeconds: number;
  /** TD-081. The part of the video exported, as set in Sync. */
  trim?: VideoTrim;
  units: UnitSystem;
  /** Where the video is lined up: the template workspace's Sync. */
  onOpenSync?: () => void;
  /**
   * The video's size and length once it has loaded. The template preview
   * reports them otherwise; on the canvas it is not there, so the canvas does.
   */
  onMediaInfo?: (media: OverlayMedia) => void;
  /** For tests: the reader's time zone, which is otherwise the browser's. */
  readerTimeZone?: string;
  /**
   * Told whether a finished export is waiting, so Start over can ask first:
   * the PNG sequence and the burned-in video apart, as the page counts them.
   */
  onFinishedChange?: (kind: 'png' | 'video', finished: boolean) => void;
  /** Where the editor starts: the page's draft, kept for the session. */
  initialDraft?: CanvasDraft;
  /** Every change to the draft, for the page to keep. */
  onDraftChange?: (draft: CanvasDraft) => void;
  /**
   * AV-1207. The editor placing figures for another page, the map video's:
   * that page sets the frame, the timeline and the time, and shows a picture
   * of its map behind the elements. Its own resolution and exports are not
   * offered, since the host has its own.
   */
  host?: CustomCanvasHost;
}

export interface CustomCanvasHost {
  title: string;
  intro: string;
  frame: { width: number; height: number };
  timeline: OverlayTimeline;
  /** The host's moment, which the editor's preview shows and its scrubber moves. */
  seconds: number;
  onSeek: (seconds: number) => void;
  /** A picture of what lies under the elements: the map at this moment. */
  backdrop?: string;
  /** Every change to the layout, for the host to draw and keep. */
  onComponentsChange: (components: OverlayComponent[]) => void;
  /**
   * AV-1013. A still picture, the map image's: there is no time to move
   * through, so no scrubber, and no figure that only means something as it
   * plays (a live speed, a gauge, the progress). The route and the profile
   * are offered, shown at the finish.
   */
  still?: boolean;
}

const SHAPE_LABELS: Record<ShapeKind, string> = {
  roundedRect: 'Rounded rectangle',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
};

/**
 * AV-1011 (TD-062). The custom canvas: a video overlay laid out freely, at a
 * resolution the reader chooses, over a source video or on its own.
 *
 * The preview is drawn by the exporters' own renderer (`createOverlayRenderer`)
 * at the preview's size, so what is seen is what is written: the same
 * components, the same type sizing, the same shapes. Every element is placed
 * by pressing and dragging on the preview, or by the fields, nudges, snaps and
 * arrow keys; a corner handle resizes. Every change, the selection included,
 * can be taken back. The layout is a template in fractions of the frame, so it
 * keeps its proportions when the resolution changes, saves as the same JSON
 * the still image uses, and is what the exporters are given.
 */
export function CustomCanvas({
  activity,
  video,
  media,
  offsetSeconds,
  trim,
  units,
  onOpenSync,
  onMediaInfo,
  readerTimeZone,
  onFinishedChange,
  initialDraft = EMPTY_CANVAS_DRAFT,
  onDraftChange,
  host,
}: CustomCanvasProps) {
  const id = useId();
  const [width, setWidth] = useState(initialDraft.width);
  const [height, setHeight] = useState(initialDraft.height);
  const [state, setState] = useState<CanvasState>(initialDraft.state);
  const [history, setHistory] = useState<CanvasState[]>(initialDraft.history);
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; message: string; warnings?: string[] }>();
  const [preset, setPreset] = useState<StartLayoutId>('compact-hud');
  const loadInput = useRef<HTMLInputElement>(null);
  const { components, selectedId } = state;
  // AV-1018 (TD-086). The reader's own figures are in a layout file only if this is ticked: it starts, and stays, unticked.
  const personal = usePersonalStore((store) => store.personal);
  const adoptPersonal = usePersonalStore((store) => store.adopt);
  const [includePersonal, setIncludePersonal] = useState(false);
  const hasZones = components.some((component) => component.type === 'zones');
  const heldFigures = useMemo(() => personalHeldBy(components), [components]);
  const offerHeld =
    (heldFigures.maxHeartRate !== undefined && heldFigures.maxHeartRate !== personal.maxHeartRate) ||
    (heldFigures.ftp !== undefined && heldFigures.ftp !== personal.ftp);

  const w = Number(width);
  const h = Number(height);
  const sizeProblem = checkCanvasSize(w, h);
  const size = sizeProblem ? undefined : { width: w, height: h };
  /** The last size that could be used: the preview keeps it while a new one is being typed. */
  const reportPng = useCallback((finished: boolean) => onFinishedChange?.('png', finished), [onFinishedChange]);
  const reportVideo = useCallback((finished: boolean) => onFinishedChange?.('video', finished), [onFinishedChange]);
  const [ownFrame, setFrame] = useState(initialDraft.frame);
  // A host sets the frame: its video's size.
  const frame = host?.frame ?? ownFrame;
  useEffect(() => {
    onDraftChange?.({ width, height, frame, state, history });
  }, [onDraftChange, width, height, frame, state, history]);
  const setSize = (nextWidth: string, nextHeight: string) => {
    setWidth(nextWidth);
    setHeight(nextHeight);
    const [a, b] = [Number(nextWidth), Number(nextHeight)];
    if (!checkCanvasSize(a, b)) setFrame({ width: a, height: b });
  };

  // Without a video the timeline runs across the activity's own span, from its first timed point.
  const activitySpan = useMemo(
    () => buildOverlayTimeline(activity, { video: { durationSeconds: 0 } }).alignment?.activitySpanSeconds ?? 0,
    [activity],
  );
  const durationSeconds = host ? host.timeline.durationSeconds : video ? (video.timing?.durationSeconds ?? media?.durationSeconds ?? 0) : activitySpan;
  const ownTimeline = useMemo(
    () =>
      buildOverlayTimeline(activity, {
        video: { durationSeconds, start: video?.timing?.start },
        offsetSeconds: video ? offsetSeconds : 0,
      }),
    [activity, durationSeconds, video, offsetSeconds],
  );
  const timeline = host?.timeline ?? ownTimeline;
  const reportComponents = host?.onComponentsChange;
  useEffect(() => {
    reportComponents?.(components);
  }, [components, reportComponents]);
  const stillContext = useMemo<StillImageContext>(
    () => ({ activity, route: extractRoute(activity), units, readerTimeZone }),
    [activity, units, readerTimeZone],
  );
  const still = host?.still === true;
  const choices = useMemo(
    () =>
      still
        ? canvasElementChoices(timeline, stillContext)
            .filter((choice) => !choice.key.startsWith('metric:') && !choice.key.startsWith('gauge:') && !choice.key.startsWith('predefined:') && !choice.key.startsWith('zones:') && !choice.key.startsWith('dial:') && !choice.key.startsWith('chart:') && choice.key !== 'gradient' && choice.key !== 'compass' && choice.key !== 'progress')
            .map((choice) => (choice.group === 'Live figures' ? { ...choice, group: 'Along the route' as const } : choice))
        : canvasElementChoices(timeline, stillContext),
    [timeline, stillContext, still],
  );
  const template = useMemo(() => canvasTemplate(components), [components]);

  /** Changes the layout, keeping what it was for Undo. */
  const commit = useCallback(
    (next: CanvasState) => {
      setHistory((current) => pushHistory(current, state));
      setState({ ...next, components: measured(next.components, stillContext, frame) });
    },
    [state, stillContext, frame],
  );
  /** A new layout, and with it the selection: given, or the current one kept. One commit, so one Undo. */
  const change = (next: OverlayComponent[], ...selected: [string | undefined] | []) =>
    commit({ components: next, selectedId: selected.length > 0 ? selected[0] : selectedId });
  const select = (next: string | undefined) => {
    if (next !== selectedId) commit({ components, selectedId: next });
  };
  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setState(previous);
  };

  const add = (key: CanvasElementKey) => {
    // AV-1016. A predefined entry may build several; the first is the one selected.
    const added = newCanvasComponents(template, key, frame, timeline);
    change([...components, ...added], added[0]?.id);
  };

  const saveLayout = () => {
    if (!size) return;
    // AV-1018. Each zones component carries the figures only when asked; otherwise none is written, even one the layout held.
    const filed = { ...template, components: componentsForLayoutFile(template.components, { include: includePersonal, session: personal }) };
    const json = serializeStillLayout({ ...size, template: filed });
    downloadBlob(new Blob([json], { type: 'application/json' }), 'overlay-layout.json');
    const written = includePersonal && personalHeldBy(filed.components);
    const withFigures = written && (written.maxHeartRate !== undefined || written.ftp !== undefined);
    setNotice({
      kind: 'status',
      message: `Saved overlay-layout.json: the layout and its texts, and nothing of the activity.${
        hasZones ? (withFigures ? ' It holds the maximum heart rate and FTP you asked to include (the layout’s own where this tab has none).' : ' Your maximum heart rate and FTP are not in it.') : ''
      }`,
    });
  };

  const loadLayout = async (file: File) => {
    if (file.size > LAYOUT_FILE_MAX_BYTES) {
      setNotice({ kind: 'alert', message: `${file.name} is too large to be a layout.` });
      return;
    }
    const parsed = parseOverlayLayout(await file.text());
    if (!parsed.ok) {
      setNotice({ kind: 'alert', message: `${file.name} was not opened. ${parsed.error}` });
      return;
    }
    const fitted = fitCanvasSize(parsed.layout.width, parsed.layout.height);
    setSize(String(fitted.width), String(fitted.height));
    // A still (the map image) shows no moment, so what only means something at one (zones, dials, charts, the gradient indicator and the compass: AV-1018, AV-1019) is left out of it, as the still image leaves out a video's figures.
    const opened = host?.still
      ? parsed.layout.template.components.filter((component) => !MOMENT_COMPONENT_TYPES.includes(component.type))
      : parsed.layout.template.components;
    commit({ components: opened, selectedId: undefined });
    const warnings = [...parsed.warnings];
    if (opened.length !== parsed.layout.template.components.length) warnings.push('Zones, dials, charts, gradient indicators and compasses were left out: this picture shows no moment of the activity.');
    if (fitted.width !== parsed.layout.width || fitted.height !== parsed.layout.height) {
      warnings.push(
        `The layout was made at ${parsed.layout.width} × ${parsed.layout.height}; the canvas is ${fitted.width} × ${fitted.height}, the nearest size it can be. The layout keeps its proportions.`,
      );
    }
    setNotice({ kind: 'status', message: `Opened the layout in ${file.name}.`, warnings });
  };

  const selected = components.find((component) => component.id === selectedId);
  const unavailable = choices.filter((choice) => !choice.available);
  // The video's own size, to even sides, so the burned-in render takes the canvas as it is.
  const even = (value: number) => Math.round(value / 2) * 2;
  const videoSize = media && { width: even(media.width), height: even(media.height) };
  const presets = [
    ...(videoSize && checkCanvasSize(videoSize.width, videoSize.height) === undefined
      ? [{ id: 'video', label: `Same as the video (${videoSize.width} × ${videoSize.height})`, ...videoSize }]
      : []),
    ...CANVAS_PRESETS,
  ];
  const presetChosen = presets.find((entry) => entry.width === w && entry.height === h);

  return (
    <section className="prose custom-canvas" aria-label={host?.title ?? 'Custom canvas'}>
      <h3 className="prose__title">{host?.title ?? 'Custom canvas'}</h3>
      <p>
        {host ? host.intro : video
          ? 'Lay the overlay out yourself, over this video: place live figures, figures for the whole activity, the date, text and shapes anywhere on it.'
          : 'Lay a video overlay out yourself, with no video: the canvas is the whole picture, and the figures play across the activity.'}{' '}
        It is drawn and exported in this tab; nothing is uploaded.
      </p>

      <CanvasPreview
        onMediaInfo={onMediaInfo}
        activity={activity}
        video={video}
        frame={frame}
        durationSeconds={durationSeconds}
        template={template}
        timeline={timeline}
        units={units}
        readerTimeZone={readerTimeZone}
        personal={personal}
        stillContext={stillContext}
        selectedId={selectedId}
        onSelect={select}
        onChange={(next, ...selected) => change(next, ...selected)}
        onDragStart={() => setHistory((current) => pushHistory(current, state))}
        onDragMove={(next) => setState({ components: measured(next, stillContext, frame), selectedId })}
        onUndo={undo}
        clock={host ? { seconds: host.seconds, onSeek: host.onSeek, still } : undefined}
        backdrop={host?.backdrop}
      />
      {sizeProblem && (
        <p role="alert" className="export__error">
          {sizeProblem}
        </p>
      )}
      {video && (
        <p className="overlay-controls__hint">
          The video is lined up, and cut, as it is set in Sync, on the template workspace.{' '}
          {onOpenSync && (
            <button type="button" className="button" onClick={onOpenSync}>
              Change where the video starts
            </button>
          )}
        </p>
      )}

      <p className="video__actions">
        <button type="button" className="button" onClick={undo} disabled={history.length === 0}>
          Undo
        </button>
      </p>

      <div className="custom-canvas__panels">
        {!host && (
        <fieldset className="overlay-controls__group">
          <legend>Resolution</legend>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-preset`}>Size</label>
            <select
              id={`${id}-preset`}
              className="select"
              value={presetChosen?.id ?? 'custom'}
              onChange={(event) => {
                const chosen = presets.find((entry) => entry.id === event.target.value);
                if (!chosen) return;
                setSize(String(chosen.width), String(chosen.height));
              }}
            >
              {presets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
              {!presetChosen && <option value="custom">Custom</option>}
            </select>
          </div>
          <NumberInput id={`${id}-w`} label="Width (px)" value={width} onChange={(value) => setSize(value, height)} />
          <NumberInput id={`${id}-h`} label="Height (px)" value={height} onChange={(value) => setSize(width, value)} />
          <p className="overlay-controls__hint">{CANVAS_LIMITS_TEXT} The layout keeps its proportions at any size.</p>
        </fieldset>
        )}

        <fieldset className="overlay-controls__group">
          <legend>Elements</legend>
          {components.length > 0 ? (
            <ElementRows
              label="Elements on the canvas"
              rows={components.map((component) => ({ id: component.id, name: describeCanvasComponent(component) }))}
              selectedId={selectedId}
              onSelect={select}
              onRemove={(removed) =>
                change(removeComponent(components, removed), removed === selectedId ? undefined : selectedId)
              }
            />
          ) : (
            <p className="overlay-controls__hint">The canvas is empty. Add an element, or start from a template.</p>
          )}
          <AddElement choices={choices} onAdd={add} />
          {unavailable.length > 0 && (
            <ul className="still-image__unavailable" aria-label="Not in this activity">
              {unavailable.map((choice) => (
                <li key={choice.key} className="overlay-controls__hint">
                  {choice.label}: {choice.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-start`}>Start from</label>
            <select id={`${id}-start`} className="select" value={preset} onChange={(event) => setPreset(event.target.value as StartLayoutId)}>
              {START_LAYOUTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button"
              onClick={() => change(componentsFromStart(preset, timeline, frame), undefined)}
            >
              Use this layout
            </button>
          </div>
        </fieldset>

        {selected && (
          <ComponentEditor
            key={selected.id}
            component={selected}
            components={components}
            frame={frame}
            stillContext={stillContext}
            timeline={timeline}
            units={units}
            onChange={(next, ...selected) => change(next, ...selected)}
          />
        )}
      </div>

      <div className="still-image__layout" role="group" aria-label="Layout file">
        <p className="overlay-controls__hint">
          A layout keeps the resolution, every element and how it is set. It opens here and in the
          still image, and holds nothing of the activity.
        </p>
        {hasZones && (
          <label className="overlay-controls__choice">
            <input type="checkbox" checked={includePersonal} onChange={(event) => setIncludePersonal(event.target.checked)} />
            <span>Include my maximum heart rate and FTP</span>
          </label>
        )}
        {hasZones && (
          <p className="overlay-controls__hint">
            Your maximum heart rate and FTP stay in this tab. They go into the layout file only if you tick this, for
            example to share a layout.
          </p>
        )}
        {offerHeld && (
          <div className="video__actions" role="group" aria-label="Figures in this layout">
            <span>
              This layout holds{' '}
              {[
                heldFigures.maxHeartRate !== undefined ? `a maximum heart rate of ${heldFigures.maxHeartRate} bpm` : undefined,
                heldFigures.ftp !== undefined ? `an FTP of ${heldFigures.ftp} W` : undefined,
              ]
                .filter(Boolean)
                .join(' and ')}
              .
            </span>
            <button type="button" className="button" onClick={() => adoptPersonal(heldFigures)}>
              Use the figures in this layout
            </button>
          </div>
        )}
        <p className="video__actions">
          <button type="button" className="button" onClick={saveLayout} disabled={!size}>
            Save layout
          </button>
          <button type="button" className="button" onClick={() => loadInput.current?.click()}>
            Open a layout
          </button>
          <input
            ref={loadInput}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="canvas-layout-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void loadLayout(file);
            }}
          />
        </p>
        {notice && (
          <div role={notice.kind} aria-label="Layout file result">
            <p>{notice.message}</p>
            {notice.warnings && notice.warnings.length > 0 && (
              <ul>
                {notice.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {!host && size && components.length > 0 && (
        <div className="custom-canvas__exports">
          <OverlayExportPanel
            video={video}
            activity={activity}
            controls={DEFAULT_OVERLAY_CONTROLS}
            template={template}
            size={size}
            offsetSeconds={offsetSeconds}
            trim={trim}
            units={units}
            media={media}
            onFinishedChange={reportPng}
          />
          {video ? (
            <BurnedInExportPanel
              video={video}
              activity={activity}
              controls={DEFAULT_OVERLAY_CONTROLS}
              template={template}
              size={size}
              offsetSeconds={offsetSeconds}
              trim={trim}
              units={units}
              media={media}
              onFinishedChange={reportVideo}
            />
          ) : (
            <p className="overlay-controls__hint">
              A video with the overlay burned in needs a source video: add one above.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** The nearest size a canvas can be: even sides, within the limits, the same shape. */
export function fitCanvasSize(width: number, height: number): { width: number; height: number } {
  const { minSide, maxSide, maxPixels } = CANVAS_LIMITS;
  let scale = Math.min(1, maxSide / width, maxSide / height, Math.sqrt(maxPixels / (width * height)));
  scale = Math.max(scale, minSide / Math.min(width, height));
  const even = (value: number) => Math.max(minSide, Math.min(maxSide, Math.round((value * scale) / 2) * 2));
  return { width: even(width), height: even(height) };
}

export function describeCanvasComponent(component: OverlayComponent): string {
  if (component.type === 'shape') return component.shape ? SHAPE_LABELS[component.shape.kind] : 'Shape';
  if (component.type === 'text' || component.type === 'gauge') {
    const source = component.source;
    const name = component.display?.label?.trim();
    if (name) return name;
    if (source?.kind === 'metric') {
      const base = { speed: 'Speed', pace: 'Pace', distance: 'Distance', elapsed: 'Elapsed time', moving: 'Moving time', elevation: 'Elevation', heartRate: 'Heart rate', power: 'Power', cyclingCadence: 'Cycling cadence', runningCadence: 'Running cadence', temperature: 'Temperature', grade: 'Grade', climb: 'Climb so far', heading: 'Heading' }[source.metric];
      return component.type === 'gauge' ? `${base} gauge` : base;
    }
    return source?.kind === 'sensor' ? source.key : 'Figure';
  }
  if (component.type === 'zones') {
    const name = component.display?.label?.trim();
    const power = component.zones ? component.zones.source === 'power' : component.source?.kind === 'metric' && component.source.metric === 'power';
    return name || (power ? 'Power zones' : 'Heart rate zones');
  }
  // AV-1019. A dial and a chart are named for their figure, as a gauge is; a gradient indicator and a compass by what they are.
  if (component.type === 'dial' || component.type === 'chart') {
    const name = component.display?.label?.trim();
    if (name) return name;
    const source = component.source;
    const base = source?.kind === 'metric' ? { speed: 'Speed', pace: 'Pace', distance: 'Distance', elapsed: 'Elapsed time', moving: 'Moving time', elevation: 'Elevation', heartRate: 'Heart rate', power: 'Power', cyclingCadence: 'Cycling cadence', runningCadence: 'Running cadence', temperature: 'Temperature', grade: 'Grade', climb: 'Climb so far', heading: 'Heading' }[source.metric] : source?.kind === 'sensor' ? source.key : 'Figure';
    return `${base} ${component.type}`;
  }
  if (component.type === 'gradient') return component.display?.label?.trim() || 'Gradient indicator';
  if (component.type === 'compass') return component.display?.label?.trim() || 'Compass';
  if (component.type === 'routeInset') return 'Route with position';
  if (component.type === 'progress') return 'Progress bar';
  if (component.type === 'elevationProfile') return 'Elevation profile';
  return describeStillComponent(component);
}

function NumberInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type="number" inputMode="numeric" step={2} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

/** AV-1017. The README of the component contract, in the repository. */
export const COMPONENT_DOCS_URL = `${GITHUB_URL}/blob/main/docs/components/README.md`;

function AddElement({ choices, onAdd }: { choices: CanvasElementChoice[]; onAdd: (key: CanvasElementKey) => void }) {
  const id = useId();
  const firstAvailable = choices.find((choice) => choice.available)?.key;
  const [wanted, setWanted] = useState<CanvasElementKey | undefined>();
  const chosen = choices.find((choice) => choice.key === wanted && choice.available)?.key ?? firstAvailable;
  const groups = ['Live figures', 'Cycling', 'Running', 'Any sport', 'Whole activity', 'Shapes'] as const;
  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-add`}>Add</label>
        <select id={`${id}-add`} className="select" value={chosen ?? ''} onChange={(event) => setWanted(event.target.value as CanvasElementKey)}>
          {groups.filter((group) => choices.some((choice) => choice.group === group)).map((group) => (
            <optgroup key={group} label={group}>
              {choices
                .filter((choice) => choice.group === group)
                .map((choice) => (
                  <option key={choice.key} value={choice.key} disabled={!choice.available}>
                    {choice.label}
                    {choice.available ? '' : ' (not in this activity)'}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <button type="button" className="button" disabled={!chosen} onClick={() => chosen && onAdd(chosen)}>
          Add to the canvas
        </button>
      </div>
      <p className="overlay-controls__hint">
        {/* AV-1017 (TD-085). Where the documented component contract lives; a component of your own is not loaded yet. */}
        <a className="link" href={COMPONENT_DOCS_URL} target="_blank" rel="noopener noreferrer">
          Write your own component (documentation)
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      </p>
    </>
  );
}

/**
 * The layout with each text, whole-activity figure and date given the size
 * its words take, measured as the renderer measures them. A new text's rect
 * is only where it starts; with its real size in it, a snap to the right
 * leaves the same margin a card has, and a saved layout says how large it is.
 */
function measured(components: OverlayComponent[], stillContext: StillImageContext, frame: { width: number; height: number }) {
  let changed = false;
  const next = components.map((component) => {
    if (!STILL_IMAGE_COMPONENT_TYPES.includes(component.type)) return component;
    const value = stillValue(component, stillContext);
    if (!value.ok) return component;
    const color = component.style.textColor ?? DEFAULT_OVERLAY_STYLE.textColor;
    const { box } = layoutStillText(component, value, color, frame, measureText);
    const rect = normalizeRect({ x: box.x / frame.width, y: box.y / frame.height, width: box.w / frame.width, height: box.h / frame.height });
    const same = (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(rect[key] - component.rect[key]) < 1e-6);
    if (same) return component;
    changed = true;
    return { ...component, rect };
  });
  return changed ? next : components;
}

/**
 * Where each element is drawn, in the preview's pixels: its rect, or for a
 * text, a figure for the whole activity or the date, the box its words take
 * (measured as the renderer measures them).
 */
function boxesOf(
  components: OverlayComponent[],
  stillContext: StillImageContext,
  width: number,
  height: number,
): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const component of components) {
    if (STILL_IMAGE_COMPONENT_TYPES.includes(component.type)) {
      const value = stillValue(component, stillContext);
      if (value.ok) {
        const color = component.style.textColor ?? DEFAULT_OVERLAY_STYLE.textColor;
        boxes.set(component.id, layoutStillText(component, value, color, { width, height }, measureText).box);
        continue;
      }
    }
    const r = component.rect;
    boxes.set(component.id, { x: r.x * width, y: r.y * height, w: r.width * width, h: r.height * height });
  }
  return boxes;
}

function CanvasPreview({
  activity,
  video,
  frame,
  durationSeconds,
  template,
  timeline,
  units,
  readerTimeZone,
  personal,
  stillContext,
  selectedId,
  onSelect,
  onChange,
  onDragStart,
  onDragMove,
  onUndo,
  onMediaInfo,
  clock,
  backdrop,
}: {
  /** The host's time, shown and moved here instead of a clock of the preview's own (AV-1207). */
  clock?: { seconds: number; onSeek: (seconds: number) => void; still?: boolean };
  backdrop?: string;
  onMediaInfo?: (media: OverlayMedia) => void;
  activity: Activity;
  video?: OverlayVideo;
  frame: { width: number; height: number };
  durationSeconds: number;
  template: ReturnType<typeof canvasTemplate>;
  timeline: ReturnType<typeof buildOverlayTimeline>;
  units: UnitSystem;
  readerTimeZone?: string;
  /** AV-1018. The reader's own figures for a zones component, drawn with and kept nowhere. */
  personal: PersonalFigures;
  stillContext: StillImageContext;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onChange: (components: OverlayComponent[], ...selected: [string | undefined] | []) => void;
  onDragStart: () => void;
  onDragMove: (components: OverlayComponent[]) => void;
  onUndo: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const element = useRef<HTMLVideoElement>(null);
  const [ownTime, setTime] = useState(0);
  const time = clock ? clock.seconds : ownTime;
  const [playing, setPlaying] = useState(false);
  const drag = useRef<
    | { mode: 'move' | 'resize'; id: string; startX: number; startY: number; start: OverlayComponent[]; moved: boolean }
    | undefined
  >(undefined);

  const factor = PREVIEW_LONG_SIDE / Math.max(frame.width, frame.height);
  const pw = Math.max(1, Math.round(frame.width * factor));
  const ph = Math.max(1, Math.round(frame.height * factor));
  const renderer = useMemo(
    () => createOverlayRenderer({ template, timeline, activity, units, width: pw, height: ph, readerTimeZone, personal }),
    [template, timeline, activity, units, pw, ph, readerTimeZone, personal],
  );
  const boxes = useMemo(() => boxesOf(template.components, stillContext, pw, ph), [template, stillContext, pw, ph]);

  // The latest listener, so a new one never reloads the video.
  const mediaInfo = useRef(onMediaInfo);
  useEffect(() => {
    mediaInfo.current = onMediaInfo;
  }, [onMediaInfo]);

  // The video is the clock when there is one; without it, the preview keeps its own.
  useEffect(() => {
    const media = element.current;
    if (!video || !media || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(video.file);
    const report = () => {
      if (media.videoWidth > 0 && media.videoHeight > 0 && Number.isFinite(media.duration)) {
        mediaInfo.current?.({ width: media.videoWidth, height: media.videoHeight, durationSeconds: media.duration });
      }
    };
    media.addEventListener('loadedmetadata', report);
    media.addEventListener('durationchange', report);
    media.src = url;
    return () => {
      media.removeEventListener('loadedmetadata', report);
      media.removeEventListener('durationchange', report);
      media.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  }, [video]);

  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const media = element.current;
      if (video && media) setTime(media.currentTime);
      else {
        const next = (now - last) / 1000;
        setTime((current) => {
          const advanced = current + next;
          if (advanced >= durationSeconds) {
            setPlaying(false);
            return durationSeconds;
          }
          return advanced;
        });
      }
      last = now;
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, video, durationSeconds]);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    renderer.drawFrame(ctx, time);
    const box = selectedId ? boxes.get(selectedId) : undefined;
    if (box) {
      // The outline and the corner handle are the preview's own; never in the export.
      ctx.save();
      ctx.setLineDash?.([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#3b82f6';
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash?.([]);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(box.x + box.w - HANDLE / 2, box.y + box.h - HANDLE / 2, HANDLE, HANDLE);
      ctx.restore();
    }
  }, [renderer, time, boxes, selectedId]);

  const togglePlay = () => {
    const media = element.current;
    if (video && media) {
      if (media.paused) void media.play().then(() => setPlaying(true), () => setPlaying(false));
      else {
        media.pause();
        setPlaying(false);
      }
      return;
    }
    if (!playing && time >= durationSeconds) setTime(0);
    setPlaying(!playing);
  };
  const seek = (seconds: number) => {
    const clamped = Math.min(Math.max(0, seconds), durationSeconds);
    if (clock) {
      clock.onSeek(clamped);
      return;
    }
    if (video && element.current) element.current.currentTime = clamped;
    setTime(clamped);
  };

  const toFrame = (event: React.PointerEvent) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / (bounds.width || 1)) * pw,
      y: ((event.clientY - bounds.top) / (bounds.height || 1)) * ph,
    };
  };
  const hit = (x: number, y: number) => {
    for (let i = template.components.length - 1; i >= 0; i -= 1) {
      const component = template.components[i]!;
      const box = boxes.get(component.id);
      if (box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return component.id;
    }
    return undefined;
  };

  return (
    <div className="custom-canvas__stage">
      <div
        className="custom-canvas__frame"
        style={{ aspectRatio: `${frame.width} / ${frame.height}`, ['--canvas-aspect' as string]: frame.width / frame.height }}
        tabIndex={0}
        role="group"
        aria-label={`Canvas preview, ${frame.width} by ${frame.height} pixels. Press an element to select it and drag to move it; drag its corner to resize it, which for a text sets its size. The arrow keys move the selected element, with Shift further; Delete removes it; Control or Command with Z undoes.`}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            onUndo();
            return;
          }
          if (!selectedId) return;
          const step = event.shiftKey ? NUDGE_FAR : NUDGE;
          const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          const move = moves[event.key];
          if (move) {
            event.preventDefault();
            onChange(nudgeComponent(template.components, selectedId, move[0], move[1]));
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            onChange(removeComponent(template.components, selectedId), undefined);
          } else if (event.key === 'Escape') {
            onSelect(undefined);
          }
        }}
      >
        {video && <video ref={element} className="custom-canvas__video" playsInline preload="metadata" muted data-testid="canvas-video" />}
        {backdrop && <img className="custom-canvas__video" src={backdrop} alt="" data-testid="canvas-backdrop" />}
        <canvas
          ref={canvas}
          className="custom-canvas__canvas"
          width={pw}
          height={ph}
          data-testid="canvas-preview"
          aria-hidden="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const at = toFrame(event);
            const selectedBox = selectedId ? boxes.get(selectedId) : undefined;
            const onHandle =
              selectedBox &&
              Math.abs(at.x - (selectedBox.x + selectedBox.w)) <= HANDLE &&
              Math.abs(at.y - (selectedBox.y + selectedBox.h)) <= HANDLE;
            const id = onHandle ? selectedId! : hit(at.x, at.y);
            if (!id) {
              onSelect(undefined);
              return;
            }
            if (id !== selectedId) onSelect(id);
            drag.current = { mode: onHandle ? 'resize' : 'move', id, startX: at.x, startY: at.y, start: template.components, moved: false };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const press = drag.current;
            if (!press) return;
            const at = toFrame(event);
            const dx = (at.x - press.startX) / pw;
            const dy = (at.y - press.startY) / ph;
            if (!press.moved) {
              if (Math.hypot(at.x - press.startX, at.y - press.startY) < 3) return;
              press.moved = true;
              onDragStart();
            }
            const target = press.start.find((component) => component.id === press.id)!;
            if (press.mode === 'move') {
              onDragMove(moveComponent(press.start, press.id, target.rect.x + dx, target.rect.y + dy));
            } else if (STILL_IMAGE_COMPONENT_TYPES.includes(target.type)) {
              // A text is as large as its words: the corner scales them, by how far it moved on average.
              const factor = ((target.rect.width + dx) / target.rect.width + (target.rect.height + dy) / target.rect.height) / 2;
              onDragMove(scaleText(press.start, press.id, target, factor));
            } else {
              onDragMove(resizeComponent(press.start, press.id, target.rect.width + dx, target.rect.height + dy));
            }
          }}
          onPointerUp={() => {
            drag.current = undefined;
          }}
          onPointerCancel={() => {
            drag.current = undefined;
          }}
        />
      </div>
      {!clock?.still && (
      <div className="overlay-preview__controls">
        {!clock && (
          <button type="button" className="button" onClick={togglePlay} disabled={!(durationSeconds > 0)}>
            {playing ? 'Pause' : 'Play'}
          </button>
        )}
        <input
          type="range"
          className="overlay-preview__scrub"
          aria-label="Canvas time"
          min={0}
          max={durationSeconds || 0}
          step={0.1}
          value={Math.min(time, durationSeconds || 0)}
          disabled={!(durationSeconds > 0)}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="overlay-preview__time" role="timer" aria-label="Canvas time shown">
          {formatDuration(time)} / {formatDuration(durationSeconds)}
        </span>
      </div>
      )}
    </div>
  );
}

function ComponentEditor({
  component,
  components,
  frame,
  stillContext,
  timeline,
  units,
  onChange,
}: {
  component: OverlayComponent;
  components: OverlayComponent[];
  frame: { width: number; height: number };
  stillContext: StillImageContext;
  timeline: OverlayTimeline;
  units: UnitSystem;
  onChange: (components: OverlayComponent[], ...selected: [string | undefined] | []) => void;
}) {
  const id = useId();
  const percent = (value: number) => String(Math.round(value * 10_000) / 100);
  const name = describeCanvasComponent(component);
  const shorter = Math.min(frame.width, frame.height);
  const update = (patch: (current: OverlayComponent) => OverlayComponent) =>
    onChange(components.map((entry) => (entry.id === component.id ? patch(entry) : entry)));
  /** AV-1015. A change to what a figure's lines say or how big they are: the box grows to hold them. */
  const updateFigure = (patch: (current: OverlayComponent) => OverlayComponent) =>
    onChange(
      growFigureToFit(
        components.map((entry) => (entry.id === component.id ? patch(entry) : entry)),
        component.id,
        frame,
        { timeline, units, measure: measureText },
      ),
    );
  /** Merges into the figure's settings, dropping what is unset and the whole of it when nothing is. */
  const withFigure = (current: OverlayComponent, patch: { [K in keyof OverlayFigureSetting]: OverlayFigureSetting[K] | undefined }) => {
    const figure: Record<string, unknown> = { ...current.figure, ...patch };
    for (const key of Object.keys(figure)) if (figure[key] === undefined) delete figure[key];
    const next = { ...current };
    if (Object.keys(figure).length > 0) next.figure = figure as OverlayFigureSetting;
    else delete next.figure;
    return next;
  };
  const setFigure = (patch: { [K in keyof OverlayFigureSetting]: OverlayFigureSetting[K] | undefined }, grow = true) =>
    (grow ? updateFigure : update)((current) => withFigure(current, patch));
  const holders = components.filter((entry) => entry.type === 'shape' && entry.id !== component.id);
  const isData = component.type === 'text' || component.type === 'gauge';
  // AV-1018. Zones are laid out and styled as a figure is: label colour, sizes, spacing, alignment and halo.
  const isZones = component.type === 'zones';
  // AV-1019. A dial, a chart, a gradient indicator and a compass are laid out and styled as a figure is, each with settings of its own.
  const isMoment = component.type === 'dial' || component.type === 'chart' || component.type === 'gradient' || component.type === 'compass';
  const isFigureLike = isData || isZones || isMoment;
  // The text of a dial, a chart and a compass sits where the picture puts it; only a gradient indicator's follows the alignment.
  const honoursAlign = !(component.type === 'dial' || component.type === 'chart' || component.type === 'compass');
  const isStill = STILL_IMAGE_COMPONENT_TYPES.includes(component.type);
  const isLine = component.type === 'routeInset' || component.type === 'elevationProfile';
  const shape: OverlayShapeSetting | undefined = component.type === 'shape' ? (component.shape ?? DEFAULT_SHAPE) : undefined;
  const setShape = (patch: Partial<OverlayShapeSetting>) => update((current) => ({ ...current, shape: { ...(current.shape ?? DEFAULT_SHAPE), ...patch } }));
  const style = { ...DEFAULT_OVERLAY_STYLE, ...component.style };
  const figure = component.figure;
  const fontScale = style.fontScale;
  // The sizes are shown as the figure's own text size times its line's scale, so a layout saved at 150 % reads 150 % for both.
  const lineScale = (scale: number | undefined) => String(Math.round(fontScale * (scale ?? 1) * 100));
  const lineSetting = (value: number): number | undefined => {
    const scale = Math.min(TEXT_SCALE_LIMITS.max, Math.max(TEXT_SCALE_LIMITS.min, value / 100 / fontScale));
    return Math.abs(scale - 1) < 1e-9 ? undefined : scale;
  };
  const spacing = isFigureLike
    ? (() => {
        const laid = figureLayout({
          em: BASE_FONT_FRACTION * frame.width * fontScale,
          frameWidth: frame.width,
          label: undefined,
          value: '',
          figure,
          track: false,
        });
        return (laid.labelAdvance - laid.labelSize) / frame.width;
      })()
    : 0;
  const numeric = component.source?.kind === 'metric' && !['pace', 'elapsed', 'moving', 'heading'].includes(component.source.metric);

  const smoothingField = canSmooth(component.source) && (
    <PercentField
      id={`${id}-smoothing`}
      label="Smoothing (s)"
      hint="0 turns it off"
      value={String(component.smoothing?.windowSeconds ?? 0)}
      min={SMOOTHING_LIMITS.min}
      max={SMOOTHING_LIMITS.max}
      step={0.5}
      onCommit={(value) =>
        update((current) => {
          const next = { ...current };
          const seconds = Math.min(SMOOTHING_LIMITS.max, Math.max(0, Math.round(value * 100) / 100));
          if (seconds > 0) next.smoothing = { windowSeconds: seconds };
          else delete next.smoothing;
          return next;
        })
      }
    />
  );

  return (
    <fieldset className="overlay-controls__group still-image__editor" aria-label={`Selected: ${name}`}>
      <legend>Selected: {name}</legend>
      {component.type === 'elevationProfile' && !stillContext.activity.streams.hasElevation && (
        <p className="overlay-controls__note" role="status">
          {ELEVATION_MISSING} The profile stays empty until an activity with elevation is opened.
        </p>
      )}

      <div className="still-image__position">
        <PercentField id={`${id}-x`} label="From the left (%)" value={percent(component.rect.x)} onCommit={(value) => onChange(moveComponent(components, component.id, value / 100, component.rect.y))} />
        <PercentField id={`${id}-y`} label="From the top (%)" value={percent(component.rect.y)} onCommit={(value) => onChange(moveComponent(components, component.id, component.rect.x, value / 100))} />
        {!isStill && (
          <>
            <PercentField id={`${id}-w`} label="Width (%)" value={percent(component.rect.width)} onCommit={(value) => onChange(resizeComponent(components, component.id, value / 100, component.rect.height))} />
            <PercentField id={`${id}-h`} label="Height (%)" value={percent(component.rect.height)} onCommit={(value) => onChange(resizeComponent(components, component.id, component.rect.width, value / 100))} />
          </>
        )}
      </div>
      <div className="still-image__nudges" role="group" aria-label="Move by 1% of the canvas">
        <button type="button" className="button" aria-label="Move left" onClick={() => onChange(nudgeComponent(components, component.id, -NUDGE, 0))}>←</button>
        <button type="button" className="button" aria-label="Move up" onClick={() => onChange(nudgeComponent(components, component.id, 0, -NUDGE))}>↑</button>
        <button type="button" className="button" aria-label="Move down" onClick={() => onChange(nudgeComponent(components, component.id, 0, NUDGE))}>↓</button>
        <button type="button" className="button" aria-label="Move right" onClick={() => onChange(nudgeComponent(components, component.id, NUDGE, 0))}>→</button>
      </div>
      <div className="still-image__snaps" role="group" aria-label="Snap to an edge or a corner">
        {SNAP_POSITIONS.map((position) => (
          <button
            key={position.id}
            type="button"
            className="button"
            aria-label={`Snap to ${position.label.toLowerCase()}`}
            title={position.label}
            onClick={() => {
              const target = snapRect(normalizeRect(component.rect), position.id);
              onChange(moveComponent(components, component.id, target.x, target.y));
            }}
          >
            <span aria-hidden="true" className={`still-image__snap still-image__snap--${position.id}`} />
          </button>
        ))}
      </div>
      <div className="video__actions" role="group" aria-label="Layer order">
        {(
          [
            ['front', 'To the front'],
            ['forward', 'Forward'],
            ['backward', 'Backward'],
            ['back', 'To the back'],
          ] as [LayerMove, string][]
        ).map(([move, label]) => (
          <button key={move} type="button" className="button" onClick={() => onChange(moveLayer(components, component.id, move))}>
            {label}
          </button>
        ))}
      </div>

      {component.type !== 'shape' && holders.length > 0 && (
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-holder`}>Held by</label>
          <select
            id={`${id}-holder`}
            className="select"
            value={component.parentId ?? ''}
            onChange={(event) => onChange(setHolder(components, component.id, event.target.value || undefined))}
          >
            <option value="">Nothing: moves on its own</option>
            {holders.map((holder) => (
              <option key={holder.id} value={holder.id}>
                {describeCanvasComponent(holder)} ({holder.id})
              </option>
            ))}
          </select>
        </div>
      )}

      {shape && (
        <>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-kind`}>Shape</label>
            <select id={`${id}-kind`} className="select" value={shape.kind} onChange={(event) => setShape({ kind: event.target.value as ShapeKind })}>
              {SHAPE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {SHAPE_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>
          {shape.kind !== 'line' && (
            <>
              <ColorField id={`${id}-fill`} label="Fill colour" value={shape.fill} onChange={(fill) => setShape({ fill })} />
              <PercentField id={`${id}-fill-opacity`} label="Fill opacity (%)" value={percent(shape.fillOpacity)} onCommit={(value) => setShape({ fillOpacity: Math.min(1, Math.max(0, value / 100)) })} />
            </>
          )}
          <ColorField id={`${id}-stroke`} label={shape.kind === 'line' ? 'Line colour' : 'Border colour'} value={shape.stroke} onChange={(stroke) => setShape({ stroke })} />
          <PercentField id={`${id}-stroke-opacity`} label={shape.kind === 'line' ? 'Line opacity (%)' : 'Border opacity (%)'} value={percent(shape.strokeOpacity)} onCommit={(value) => setShape({ strokeOpacity: Math.min(1, Math.max(0, value / 100)) })} />
          <PercentField id={`${id}-stroke-width`} label={shape.kind === 'line' ? 'Line width (px)' : 'Border width (px)'} value={String(Math.round(shape.strokeWidth * shorter * 10) / 10)} max={500} onCommit={(value) => setShape({ strokeWidth: Math.min(0.1, Math.max(0, value / shorter)) })} />
          {shape.kind === 'roundedRect' && (
            <PercentField id={`${id}-radius`} label="Corner radius (px)" value={String(Math.round(shape.radius * shorter))} max={2000} onCommit={(value) => setShape({ radius: Math.min(0.5, Math.max(0, value / shorter)) })} />
          )}
        </>
      )}

      {(isData || isMoment) && (
        <>
          {component.type !== 'chart' && (
          <label className="overlay-controls__choice">
            <input type="checkbox" checked={figure?.showLabel !== false} onChange={(event) => setFigure({ showLabel: event.target.checked ? undefined : false })} />
            <span>Show the label</span>
          </label>
          )}
          {component.type !== 'chart' && (
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-label`}>Label</label>
            <input
              id={`${id}-label`}
              className="input"
              type="text"
              placeholder={component.type === 'gradient' ? 'Grade' : component.type === 'compass' ? 'Heading' : describeCanvasComponent({ ...component, display: undefined }).replace(/ (gauge|dial|chart)$/, '')}
              value={component.display?.label ?? ''}
              onChange={(event) => {
                const label = sanitizeLabel(event.target.value).split('\n')[0]!.slice(0, 40);
                updateFigure((current) => ({ ...current, display: { ...current.display, label } }));
              }}
            />
          </div>
          )}
          {component.type !== 'gradient' && component.type !== 'compass' && (
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-units`}>Units</label>
            <select id={`${id}-units`} className="select" value={component.unitMode} onChange={(event) => updateFigure((current) => ({ ...current, unitMode: event.target.value as OverlayUnitMode }))}>
              <option value="auto">Follow Settings</option>
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>
          </div>
          )}
          {component.source?.kind === 'metric' && component.source.metric === 'distance' && (
            <div className="overlay-controls__field">
              <label htmlFor={`${id}-of-total`}>Show</label>
              <select
                id={`${id}-of-total`}
                className="select"
                value={component.display?.ofTotal ? 'total' : 'so-far'}
                onChange={(event) =>
                  updateFigure((current) => {
                    const display = { ...current.display };
                    if (event.target.value === 'total') display.ofTotal = true;
                    else delete display.ofTotal;
                    return { ...current, display };
                  })
                }
              >
                <option value="so-far">The distance so far</option>
                <option value="total">The distance so far, of the total</option>
              </select>
            </div>
          )}
          {isData && smoothingField}
          {numeric && component.type !== 'compass' && (
            <div className="overlay-controls__field">
              <label htmlFor={`${id}-decimals`}>Decimal places</label>
              <select
                id={`${id}-decimals`}
                className="select"
                value={component.display?.decimals ?? 'default'}
                onChange={(event) =>
                  updateFigure((current) => {
                    const display = { ...current.display };
                    if (event.target.value === 'default') delete display.decimals;
                    else display.decimals = Number(event.target.value) as 0 | 1 | 2;
                    return { ...current, display };
                  })
                }
              >
                <option value="default">As the app writes it</option>
                <option value="0">0</option>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </div>
          )}
        </>
      )}

      {isZones && (
        <ZonesEditor
          id={id}
          component={component}
          activity={stillContext.activity}
          smoothingField={smoothingField}
          onChange={(patch) => update(patch)}
        />
      )}

      {component.type === 'dial' && <DialEditor id={id} component={component} timeline={timeline} smoothingField={smoothingField} onChange={(patch) => update(patch)} />}
      {component.type === 'chart' && <ChartEditor id={id} component={component} timeline={timeline} onChange={(patch) => update(patch)} />}
      {component.type === 'gradient' && <GradientEditor id={id} component={component} smoothingField={smoothingField} onChange={(patch) => update(patch)} />}
      {component.type === 'compass' && <CompassEditor id={id} component={component} smoothingField={smoothingField} onChange={(patch) => update(patch)} />}

      {component.type === 'label' && (
        <div className="overlay-controls__field still-image__text">
          <label htmlFor={`${id}-content`}>Text</label>
          <textarea id={`${id}-content`} className="input" rows={2} value={component.content ?? ''} onChange={(event) => { const content = sanitizeLabel(event.target.value); update((current) => ({ ...current, content })); }} />
        </div>
      )}
      {component.type === 'summary' && (
        <div className="overlay-controls__field">
          <label htmlFor={`${id}-stat`}>Figure</label>
          <select id={`${id}-stat`} className="select" value={component.summary?.stat} onChange={(event) => update((current) => ({ ...current, summary: { stat: event.target.value as SummaryStatKey } }))}>
            {SUMMARY_STAT_KEYS.map((stat) => (
              <option key={stat} value={stat}>
                {describeStillComponent({ ...component, summary: { stat } })}
              </option>
            ))}
          </select>
        </div>
      )}
      {component.type === 'date' && <DateSettings id={id} component={component} context={stillContext} onChange={(change) => update(change)} />}

      {(isFigureLike || isStill || isLine || component.type === 'progress') && (
        <>
          <ColorField id={`${id}-text`} label={isLine ? 'Line colour' : isFigureLike && component.type !== 'chart' && component.type !== 'gradient' ? 'Value colour' : 'Text colour'} value={style.textColor} onChange={(textColor) => update((current) => ({ ...current, style: { ...current.style, textColor } }))} />
          {isFigureLike && <ColorField id={`${id}-label-colour`} label="Label colour" value={figure?.labelColor ?? style.textColor} onChange={(labelColor) => setFigure({ labelColor }, false)} />}
          {!isStill && (
            <>
              <ColorField id={`${id}-accent`} label="Accent colour" value={style.accentColor} onChange={(accentColor) => update((current) => ({ ...current, style: { ...current.style, accentColor } }))} />
              <PercentField id={`${id}-bg`} label="Background (%)" value={percent(style.backgroundOpacity)} onCommit={(value) => update((current) => ({ ...current, style: { ...current.style, backgroundOpacity: Math.min(1, Math.max(0, value / 100)) } }))} />
            </>
          )}
          {isFigureLike && (
            <>
              <PercentField id={`${id}-label-size`} label="Label size (%)" value={lineScale(figure?.labelScale)} max={fontScale * TEXT_SCALE_LIMITS.max * 100} onCommit={(value) => setFigure({ labelScale: lineSetting(value) })} />
              {component.type !== 'chart' && (
                <>
                  <PercentField id={`${id}-value-size`} label="Value size (%)" value={lineScale(figure?.valueScale)} max={fontScale * TEXT_SCALE_LIMITS.max * 100} onCommit={(value) => setFigure({ valueScale: lineSetting(value) })} />
                  <PercentField id={`${id}-spacing`} label="Spacing (% of width)" value={String(Math.round(spacing * 1000) / 10)} max={FIGURE_GAP_MAX * 100} step={0.1} onCommit={(value) => setFigure({ gap: Math.min(FIGURE_GAP_MAX, Math.max(0, value / 100)) })} />
                </>
              )}
              {honoursAlign && (
              <div className="overlay-controls__field">
                <label htmlFor={`${id}-figure-align`}>Alignment</label>
                <select id={`${id}-figure-align`} className="select" value={figure?.align ?? 'left'} onChange={(event) => setFigure({ align: event.target.value === 'left' ? undefined : (event.target.value as TextAlign) }, false)}>
                  <option value="left">Left</option>
                  <option value="center">Centre</option>
                  <option value="right">Right</option>
                </select>
              </div>
              )}
              <ColorField id={`${id}-halo-colour`} label="Halo colour" value={figure?.halo?.color ?? '#000000'} onChange={(color) => setFigure({ halo: { color, opacity: figure?.halo?.opacity ?? 0.8 } }, false)} />
              <PercentField id={`${id}-halo-opacity`} label="Halo (%)" value={percent(figure?.halo?.opacity ?? 0.8)} onCommit={(value) => setFigure({ halo: { color: figure?.halo?.color ?? '#000000', opacity: Math.min(1, Math.max(0, value / 100)) } }, false)} />
              {!needsHalo(style) && <p className="overlay-controls__hint">The halo is drawn under the text when the background is under 30 %.</p>}
            </>
          )}
          {isStill && (
            <PercentField id={`${id}-size`} label="Text size (%)" value={String(Math.round(style.fontScale * 100))} max={1000} onCommit={(value) => update((current) => ({ ...current, style: { ...current.style, fontScale: Math.min(TEXT_SCALE_LIMITS.max, Math.max(TEXT_SCALE_LIMITS.min, value / 100)) } }))} />
          )}
          {isStill && (
            <>
              <div className="overlay-controls__field">
                <label htmlFor={`${id}-align`}>Alignment</label>
                <select id={`${id}-align`} className="select" value={component.text?.align ?? 'left'} onChange={(event) => update((current) => ({ ...current, text: { weight: 'bold', ...current.text, align: event.target.value as TextAlign } }))}>
                  <option value="left">Left</option>
                  <option value="center">Centre</option>
                  <option value="right">Right</option>
                </select>
              </div>
              <label className="overlay-controls__choice">
                <input type="checkbox" checked={(component.text?.weight ?? 'bold') === 'bold'} onChange={(event) => update((current) => ({ ...current, text: { align: 'left', ...current.text, weight: event.target.checked ? 'bold' : 'normal' } }))} />
                <span>Bold</span>
              </label>
            </>
          )}
        </>
      )}

      <p className="video__actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            const copy = duplicateComponent(components, component.id);
            onChange(copy.components, copy.id);
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="button"
          onClick={() => onChange(removeComponent(components, component.id), undefined)}
        >
          Delete
        </button>
      </p>
    </fieldset>
  );
}

const ZONES_SOURCE_LABELS: Record<ZonesSource, string> = { heartRate: 'Heart rate', power: 'Power' };
const ZONES_SHAPE_LABELS: Record<ZonesShape, string> = {
  horizontal: 'Horizontal bar',
  vertical: 'Vertical bar',
  arc: 'Segmented arc',
  figure: 'A single coloured figure',
};

/**
 * AV-1018 (TD-086). The zones' own settings: the source, what the bounds are
 * measured in and the figure they are measured against, each zone's name,
 * colour and bound, the shape, and what is shown. The reader's figure lives in
 * the session (`usePersonalStore`) and nowhere else; a zones component that
 * needs it and has none is not drawn, and says so here.
 */
function ZonesEditor({
  id,
  component,
  activity,
  smoothingField,
  onChange,
}: {
  id: string;
  component: OverlayComponent;
  activity: Activity;
  smoothingField: React.ReactNode;
  onChange: (patch: (current: OverlayComponent) => OverlayComponent) => void;
}) {
  const session = usePersonalStore((store) => store.personal);
  const setFigure = usePersonalStore((store) => store.setFigure);
  const setting = component.zones;
  const highestSource = setting?.source;
  const activityHighestOf = useMemo(() => (highestSource ? activityHighest(activity, highestSource) : undefined), [activity, highestSource]);
  const withZones = (change: (current: NonNullable<OverlayComponent['zones']>) => NonNullable<OverlayComponent['zones']>) =>
    onChange((current) => (current.zones ? { ...current, zones: change(current.zones) } : current));

  if (!setting) {
    return (
      <div className="overlay-controls__field">
        <p className="overlay-controls__note" role="status">
          These zones could not be read, so nothing is drawn.
        </p>
        <button
          type="button"
          className="button"
          onClick={() =>
            onChange((current) => {
              const source: ZonesSource = current.source?.kind === 'metric' && current.source.metric === 'power' ? 'power' : 'heartRate';
              return { ...current, source: { kind: 'metric', metric: source }, zones: defaultZonesSetting(source) };
            })
          }
        >
          Use the default zones
        </button>
      </div>
    );
  }

  const { source } = setting;
  const unit = ZONES_UNIT[source];
  const key = REFERENCE_KEY[source];
  const reference = effectivePersonal(session, setting)[key];
  const highest = activityHighestOf;
  // Offered only as it is: a highest outside what the field takes is not shown as another number.
  const highestShown = highest !== undefined && cleanFigure(key, highest) === highest ? highest : undefined;
  const limits = PERSONAL_LIMITS[key];
  const bound = setting.basis === 'percent' ? '%' : unit;
  const needs = setting.basis === 'percent' && reference === undefined;

  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-zones-source`}>Zones of</label>
        <select
          id={`${id}-zones-source`}
          className="select"
          value={source}
          onChange={(event) => {
            const next = event.target.value as ZonesSource;
            if (next === source) return;
            // The other source's own zones, and its own usual smoothing.
            onChange((current) => {
              const changed: OverlayComponent = { ...current, source: { kind: 'metric', metric: next }, zones: { ...defaultZonesSetting(next), shape: setting.shape, show: setting.show } };
              if (DEFAULT_ZONES_SMOOTHING_SECONDS[next] > 0) changed.smoothing = { windowSeconds: DEFAULT_ZONES_SMOOTHING_SECONDS[next] };
              else delete changed.smoothing;
              delete changed.display;
              return changed;
            });
          }}
        >
          {(['heartRate', 'power'] as const).map((value) => (
            <option key={value} value={value}>
              {ZONES_SOURCE_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-zones-basis`}>Bounds are</label>
        <select
          id={`${id}-zones-basis`}
          className="select"
          value={setting.basis}
          onChange={(event) => withZones((current) => changeBasis(current, event.target.value as 'percent' | 'value', session))}
        >
          <option value="percent">A percentage of my {REFERENCE_LABEL[source]}</option>
          <option value="value">Absolute values ({unit})</option>
        </select>
      </div>
      {setting.basis === 'percent' && (
        <>
          {needs && (
            <p className="overlay-controls__note" role="status">
              Enter your {REFERENCE_LABEL[source]} to draw these zones. They are not drawn until you do, and it stays in this tab.
            </p>
          )}
          <PercentField
            id={`${id}-zones-reference`}
            label={`My ${REFERENCE_LABEL[source]} (${unit})`}
            hint={`${limits.min} to ${limits.max}. Kept in this tab for the session only; it is not saved.${
              session[key] === undefined && reference !== undefined ? ' This one is from the layout you opened, and is not yet yours.' : ''
            }`}
            value={reference === undefined ? '' : String(reference)}
            min={limits.min}
            max={limits.max}
            onCommit={(value) => setFigure(key, value)}
          />
          <p className="video__actions">
            {highestShown !== undefined && (
              <button type="button" className="button" onClick={() => setFigure(key, highestShown)}>
                Use this activity’s highest: {highestShown} {unit}
              </button>
            )}
            {session[key] !== undefined && (
              <button type="button" className="button" onClick={() => setFigure(key, undefined)}>
                Forget my {REFERENCE_LABEL[source]}
              </button>
            )}
          </p>
        </>
      )}

      <div role="group" aria-label="Zones" className="zones-editor">
        {setting.zones.map((zone, i) => (
          <div key={i} role="group" aria-label={`Zone ${i + 1}`} className="overlay-controls__field">
            <label htmlFor={`${id}-zone-${i}-name`}>Zone {i + 1} name</label>
            <input
              id={`${id}-zone-${i}-name`}
              className="input"
              type="text"
              maxLength={ZONE_NAME_MAX}
              value={zone.name}
              onChange={(event) => {
                const name = sanitizeLabel(event.target.value).split('\n')[0]!.slice(0, ZONE_NAME_MAX);
                withZones((current) => setZone(current, i, { name }));
              }}
            />
            <ColorField id={`${id}-zone-${i}-color`} label={`Zone ${i + 1} colour`} value={zone.color} onChange={(color) => withZones((current) => setZone(current, i, { color }))} />
            <PercentField
              id={`${id}-zone-${i}-from`}
              label={`Zone ${i + 1} starts at (${bound})`}
              value={String(zone.from)}
              min={0}
              max={ZONE_FROM_MAX[setting.basis]}
              onCommit={(value) => withZones((current) => setZone(current, i, { from: Math.round(value * 10) / 10 }))}
            />
          </div>
        ))}
      </div>
      <p className="video__actions">
        <button type="button" className="button" disabled={addZone(setting) === setting} onClick={() => withZones(addZone)}>
          Add a zone
        </button>
        <button type="button" className="button" disabled={setting.zones.length <= ZONE_LIMITS.min} onClick={() => withZones(removeLastZone)}>
          Remove the last zone
        </button>
        <button type="button" className="button" onClick={() => withZones((current) => ({ ...defaultZonesSetting(current.source), shape: current.shape, show: current.show, ...(current.personal ? { personal: current.personal } : {}) }))}>
          Reset the zones
        </button>
      </p>
      <p className="overlay-controls__hint">
        {ZONE_LIMITS.min} to {ZONE_LIMITS.max} zones. A value under the first zone’s start counts in the first zone, and one over the last zone’s start in the last.
      </p>

      <div className="overlay-controls__field">
        <label htmlFor={`${id}-zones-shape`}>Shape</label>
        <select
          id={`${id}-zones-shape`}
          className="select"
          value={setting.shape}
          onChange={(event) => withZones((current) => ({ ...current, shape: event.target.value as ZonesShape }))}
        >
          {ZONES_SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {ZONES_SHAPE_LABELS[shape]}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="overlay-controls__group">
        <legend>Show</legend>
        {(
          [
            ['number', 'The zone’s number'],
            ['name', 'The zone’s name'],
            ['value', `The value (${unit})`],
            ['timeInZone', 'The time in each zone so far'],
          ] as const
        ).map(([part, text]) => (
          <label key={part} className="overlay-controls__choice">
            <input
              type="checkbox"
              checked={setting.show[part]}
              onChange={(event) => withZones((current) => ({ ...current, show: { ...current.show, [part]: event.target.checked } }))}
            />
            <span>{text}</span>
          </label>
        ))}
      </fieldset>
      {smoothingField}
    </>
  );
}

function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
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
