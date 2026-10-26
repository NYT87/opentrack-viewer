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
  componentsFromPreset,
  duplicateComponent,
  moveComponent,
  moveLayer,
  newCanvasComponent,
  nudgeComponent,
  pushHistory,
  removeComponent,
  resizeComponent,
  scaleText,
  TEXT_SCALE_LIMITS,
  setHolder,
  type CanvasElementChoice,
  type CanvasElementKey,
  EMPTY_CANVAS_DRAFT,
  type CanvasDraft,
  type CanvasState,
  type LayerMove,
} from '../overlay/customCanvas';
import { createOverlayRenderer } from '../overlay/export/drawOverlay';
import { measureText } from '../overlay/measureText';
import { DEFAULT_OVERLAY_CONTROLS, OVERLAY_PRESETS, type OverlayPresetId } from '../overlay/presets';
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
  SHAPE_KINDS,
  STILL_IMAGE_COMPONENT_TYPES,
  SUMMARY_STAT_KEYS,
  normalizeRect,
  sanitizeLabel,
  type OverlayComponent,
  type OverlayShapeSetting,
  type OverlayUnitMode,
  type ShapeKind,
  type SummaryStatKey,
  type TextAlign,
} from '../overlay/template';
import { buildOverlayTimeline } from '../overlay/timeline';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';
import { BurnedInExportPanel } from './BurnedInExportPanel';
import { OverlayExportPanel } from './OverlayExportPanel';
import { DateSettings, PercentField } from './RouteOverlayPanel';

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
  units,
  onOpenSync,
  onMediaInfo,
  readerTimeZone,
  onFinishedChange,
  initialDraft = EMPTY_CANVAS_DRAFT,
  onDraftChange,
}: CustomCanvasProps) {
  const id = useId();
  const [width, setWidth] = useState(initialDraft.width);
  const [height, setHeight] = useState(initialDraft.height);
  const [state, setState] = useState<CanvasState>(initialDraft.state);
  const [history, setHistory] = useState<CanvasState[]>(initialDraft.history);
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; message: string; warnings?: string[] }>();
  const [preset, setPreset] = useState<OverlayPresetId>('compact-hud');
  const loadInput = useRef<HTMLInputElement>(null);
  const { components, selectedId } = state;

  const w = Number(width);
  const h = Number(height);
  const sizeProblem = checkCanvasSize(w, h);
  const size = sizeProblem ? undefined : { width: w, height: h };
  /** The last size that could be used: the preview keeps it while a new one is being typed. */
  const reportPng = useCallback((finished: boolean) => onFinishedChange?.('png', finished), [onFinishedChange]);
  const reportVideo = useCallback((finished: boolean) => onFinishedChange?.('video', finished), [onFinishedChange]);
  const [frame, setFrame] = useState(initialDraft.frame);
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
  const durationSeconds = video ? (video.timing?.durationSeconds ?? media?.durationSeconds ?? 0) : activitySpan;
  const timeline = useMemo(
    () =>
      buildOverlayTimeline(activity, {
        video: { durationSeconds, start: video?.timing?.start },
        offsetSeconds: video ? offsetSeconds : 0,
      }),
    [activity, durationSeconds, video, offsetSeconds],
  );
  const stillContext = useMemo<StillImageContext>(
    () => ({ activity, route: extractRoute(activity), units, readerTimeZone }),
    [activity, units, readerTimeZone],
  );
  const choices = useMemo(() => canvasElementChoices(timeline, stillContext), [timeline, stillContext]);
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
    const component = newCanvasComponent(template, key, frame, timeline);
    change([...components, component], component.id);
  };

  const saveLayout = () => {
    if (!size) return;
    const json = serializeStillLayout({ ...size, template });
    downloadBlob(new Blob([json], { type: 'application/json' }), 'overlay-layout.json');
    setNotice({ kind: 'status', message: 'Saved overlay-layout.json: the layout and its texts, and nothing of the activity.' });
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
    commit({ components: parsed.layout.template.components, selectedId: undefined });
    const warnings = [...parsed.warnings];
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
    <section className="prose custom-canvas" aria-label="Custom canvas">
      <h3 className="prose__title">Custom canvas</h3>
      <p>
        {video
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
        stillContext={stillContext}
        selectedId={selectedId}
        onSelect={select}
        onChange={(next, ...selected) => change(next, ...selected)}
        onDragStart={() => setHistory((current) => pushHistory(current, state))}
        onDragMove={(next) => setState({ components: measured(next, stillContext, frame), selectedId })}
        onUndo={undo}
      />
      {sizeProblem && (
        <p role="alert" className="export__error">
          {sizeProblem}
        </p>
      )}
      {video && (
        <p className="overlay-controls__hint">
          The video is lined up as it is set in Sync, on the template workspace.{' '}
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

        <fieldset className="overlay-controls__group">
          <legend>Elements</legend>
          {components.length > 0 ? (
            <ul className="still-image__elements" aria-label="Elements on the canvas">
              {components.map((component) => (
                <li key={component.id}>
                  <button
                    type="button"
                    className="button"
                    aria-pressed={component.id === selectedId}
                    onClick={() => select(component.id === selectedId ? undefined : component.id)}
                  >
                    {describeCanvasComponent(component)}
                  </button>
                </li>
              ))}
            </ul>
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
            <select id={`${id}-start`} className="select" value={preset} onChange={(event) => setPreset(event.target.value as OverlayPresetId)}>
              {OVERLAY_PRESETS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button"
              onClick={() => change(componentsFromPreset(preset, timeline, frame), undefined)}
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
            onChange={(next, ...selected) => change(next, ...selected)}
          />
        )}
      </div>

      <div className="still-image__layout" role="group" aria-label="Layout file">
        <p className="overlay-controls__hint">
          A layout keeps the resolution, every element and how it is set. It opens here and in the
          still image, and holds nothing of the activity.
        </p>
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

      {size && components.length > 0 && (
        <div className="custom-canvas__exports">
          <OverlayExportPanel
            video={video}
            activity={activity}
            controls={DEFAULT_OVERLAY_CONTROLS}
            template={template}
            size={size}
            offsetSeconds={offsetSeconds}
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
      const base = { speed: 'Speed', pace: 'Pace', distance: 'Distance', elapsed: 'Elapsed time', moving: 'Moving time', elevation: 'Elevation', heartRate: 'Heart rate', power: 'Power', cyclingCadence: 'Cycling cadence', runningCadence: 'Running cadence', temperature: 'Temperature', grade: 'Grade' }[source.metric];
      return component.type === 'gauge' ? `${base} gauge` : base;
    }
    return source?.kind === 'sensor' ? source.key : 'Figure';
  }
  if (component.type === 'routeInset') return 'Route with position';
  if (component.type === 'progress') return 'Progress bar';
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

function AddElement({ choices, onAdd }: { choices: CanvasElementChoice[]; onAdd: (key: CanvasElementKey) => void }) {
  const id = useId();
  const firstAvailable = choices.find((choice) => choice.available)?.key;
  const [wanted, setWanted] = useState<CanvasElementKey | undefined>();
  const chosen = choices.find((choice) => choice.key === wanted && choice.available)?.key ?? firstAvailable;
  const groups = ['Live figures', 'Whole activity', 'Shapes'] as const;
  return (
    <div className="overlay-controls__field">
      <label htmlFor={`${id}-add`}>Add</label>
      <select id={`${id}-add`} className="select" value={chosen ?? ''} onChange={(event) => setWanted(event.target.value as CanvasElementKey)}>
        {groups.map((group) => (
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
  stillContext,
  selectedId,
  onSelect,
  onChange,
  onDragStart,
  onDragMove,
  onUndo,
  onMediaInfo,
}: {
  onMediaInfo?: (media: OverlayMedia) => void;
  activity: Activity;
  video?: OverlayVideo;
  frame: { width: number; height: number };
  durationSeconds: number;
  template: ReturnType<typeof canvasTemplate>;
  timeline: ReturnType<typeof buildOverlayTimeline>;
  units: UnitSystem;
  readerTimeZone?: string;
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
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const drag = useRef<
    | { mode: 'move' | 'resize'; id: string; startX: number; startY: number; start: OverlayComponent[]; moved: boolean }
    | undefined
  >(undefined);

  const factor = PREVIEW_LONG_SIDE / Math.max(frame.width, frame.height);
  const pw = Math.max(1, Math.round(frame.width * factor));
  const ph = Math.max(1, Math.round(frame.height * factor));
  const renderer = useMemo(
    () => createOverlayRenderer({ template, timeline, activity, units, width: pw, height: ph, readerTimeZone }),
    [template, timeline, activity, units, pw, ph, readerTimeZone],
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
      <div className="overlay-preview__controls">
        <button type="button" className="button" onClick={togglePlay} disabled={!(durationSeconds > 0)}>
          {playing ? 'Pause' : 'Play'}
        </button>
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
    </div>
  );
}

function ComponentEditor({
  component,
  components,
  frame,
  stillContext,
  onChange,
}: {
  component: OverlayComponent;
  components: OverlayComponent[];
  frame: { width: number; height: number };
  stillContext: StillImageContext;
  onChange: (components: OverlayComponent[], ...selected: [string | undefined] | []) => void;
}) {
  const id = useId();
  const percent = (value: number) => String(Math.round(value * 10_000) / 100);
  const name = describeCanvasComponent(component);
  const shorter = Math.min(frame.width, frame.height);
  const update = (patch: (current: OverlayComponent) => OverlayComponent) =>
    onChange(components.map((entry) => (entry.id === component.id ? patch(entry) : entry)));
  const holders = components.filter((entry) => entry.type === 'shape' && entry.id !== component.id);
  const isData = component.type === 'text' || component.type === 'gauge';
  const isStill = STILL_IMAGE_COMPONENT_TYPES.includes(component.type);
  const shape: OverlayShapeSetting | undefined = component.type === 'shape' ? (component.shape ?? DEFAULT_SHAPE) : undefined;
  const setShape = (patch: Partial<OverlayShapeSetting>) => update((current) => ({ ...current, shape: { ...(current.shape ?? DEFAULT_SHAPE), ...patch } }));
  const style = { ...DEFAULT_OVERLAY_STYLE, ...component.style };
  const numeric = component.source?.kind === 'metric' && !['pace', 'elapsed', 'moving'].includes(component.source.metric);

  return (
    <fieldset className="overlay-controls__group still-image__editor" aria-label={`Selected: ${name}`}>
      <legend>Selected: {name}</legend>

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

      {isData && (
        <>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-label`}>Label</label>
            <input
              id={`${id}-label`}
              className="input"
              type="text"
              placeholder={describeCanvasComponent({ ...component, display: undefined }).replace(/ gauge$/, '')}
              value={component.display?.label ?? ''}
              onChange={(event) => {
                const label = sanitizeLabel(event.target.value).split('\n')[0]!.slice(0, 40);
                update((current) => ({ ...current, display: { ...current.display, label } }));
              }}
            />
          </div>
          <div className="overlay-controls__field">
            <label htmlFor={`${id}-units`}>Units</label>
            <select id={`${id}-units`} className="select" value={component.unitMode} onChange={(event) => update((current) => ({ ...current, unitMode: event.target.value as OverlayUnitMode }))}>
              <option value="auto">Follow Settings</option>
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>
          </div>
          {numeric && (
            <div className="overlay-controls__field">
              <label htmlFor={`${id}-decimals`}>Decimal places</label>
              <select
                id={`${id}-decimals`}
                className="select"
                value={component.display?.decimals ?? 'default'}
                onChange={(event) =>
                  update((current) => {
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

      {(isData || isStill || component.type === 'routeInset' || component.type === 'progress') && (
        <>
          <ColorField id={`${id}-text`} label={component.type === 'routeInset' ? 'Line colour' : 'Text colour'} value={style.textColor} onChange={(textColor) => update((current) => ({ ...current, style: { ...current.style, textColor } }))} />
          {!isStill && (
            <>
              <ColorField id={`${id}-accent`} label="Accent colour" value={style.accentColor} onChange={(accentColor) => update((current) => ({ ...current, style: { ...current.style, accentColor } }))} />
              <PercentField id={`${id}-bg`} label="Background (%)" value={percent(style.backgroundOpacity)} onCommit={(value) => update((current) => ({ ...current, style: { ...current.style, backgroundOpacity: Math.min(1, Math.max(0, value / 100)) } }))} />
            </>
          )}
          {(isData || isStill) && (
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

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={(event) => onChange(event.target.value)} />
    </div>
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
