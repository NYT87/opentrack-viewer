import {
  BASE_FONT_CQW,
  DEFAULT_OVERLAY_CONTROLS,
  TILE_WIDTH_EMS,
  buildOverlay,
  type OverlayPresetId,
} from './presets';
import { stillElementChoices, newStillComponent, freshComponentId, type StillImageContext } from './staticImage';
import {
  DEFAULT_OVERLAY_STYLE,
  DEFAULT_SHAPE,
  OVERLAY_TEMPLATE_VERSION,
  normalizeRect,
  type OverlayComponent,
  type OverlayRect,
  type OverlayTemplate,
  type ShapeKind,
} from './template';
import type { OverlayMetricKey, OverlayTimeline } from './timeline';

/**
 * AV-1011 (TD-062). The custom canvas: a video overlay laid out freely, with
 * or without a source video, at a resolution the reader chooses.
 *
 * The layout is an overlay template (AV-1003, version 2 since AV-1010), so it
 * is the same model the built-in templates, the still image and every exporter
 * use: rects in fractions of the frame, which is what keeps a layout
 * proportional when the resolution changes. Everything here is a pure
 * function of a list of components, so the editor's undo is a list of lists.
 */

// ---------------------------------------------------------------------------
// Resolution

export const CANVAS_PRESETS: readonly { id: string; label: string; width: number; height: number }[] = [
  { id: '1920x1080', label: 'Full HD landscape (1920 × 1080)', width: 1920, height: 1080 },
  { id: '1080x1920', label: 'Full HD portrait (1080 × 1920)', width: 1080, height: 1920 },
  { id: '1080x1080', label: 'Square (1080 × 1080)', width: 1080, height: 1080 },
  { id: '3840x2160', label: '4K landscape (3840 × 2160)', width: 3840, height: 2160 },
  { id: '1280x720', label: 'HD landscape (1280 × 720)', width: 1280, height: 720 },
];

/**
 * What a canvas can be: even sides (a video encoder will not take odd ones),
 * from 64 to 4096 pixels, and no more pixels than 4096 × 2160, the largest
 * frame the burned-in render and a browser's encoder can be counted on for.
 */
export const CANVAS_LIMITS = { minSide: 64, maxSide: 4096, maxPixels: 4096 * 2160 } as const;

export const CANVAS_LIMITS_TEXT = 'Each side 64 to 4096 pixels and even; at most 4096 × 2160 pixels in all.';

export function checkCanvasSize(width: number, height: number): string | undefined {
  const { minSide, maxSide, maxPixels } = CANVAS_LIMITS;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return 'Width and height must be whole numbers of pixels.';
  if (width < minSide || height < minSide || width > maxSide || height > maxSide) {
    return `Width and height must each be between ${minSide} and ${maxSide} pixels.`;
  }
  if (width % 2 !== 0 || height % 2 !== 0) return 'Width and height must be even numbers: a video encoder will not take odd ones.';
  if (width * height > maxPixels) return `That is more than ${maxPixels.toLocaleString('en')} pixels, the most a frame can have here.`;
  return undefined;
}

// ---------------------------------------------------------------------------
// What can be added

export type CanvasElementKey =
  | `metric:${OverlayMetricKey}`
  | 'gauge:speed'
  | 'gauge:heartRate'
  | 'route'
  | 'progress'
  | `still:${string}`
  | `shape:${ShapeKind}`;

export interface CanvasElementChoice {
  key: CanvasElementKey;
  label: string;
  group: 'Live figures' | 'Whole activity' | 'Shapes';
  available: boolean;
  reason?: string;
}

const LIVE_FIGURES: readonly { metric: OverlayMetricKey; label: string; missing: string }[] = [
  { metric: 'speed', label: 'Speed', missing: 'This activity has no speed: it needs positions or a recorded speed, and times.' },
  { metric: 'pace', label: 'Pace', missing: 'This activity has no pace: it needs a speed, and some movement.' },
  { metric: 'distance', label: 'Distance', missing: 'This activity has no distance: it has no positions or recorded distance.' },
  { metric: 'elapsed', label: 'Elapsed time', missing: 'This activity has no timestamps.' },
  { metric: 'moving', label: 'Moving time', missing: 'This activity has no moving time: it needs a distance and times.' },
  { metric: 'elevation', label: 'Elevation', missing: 'This activity has no elevation.' },
  { metric: 'heartRate', label: 'Heart rate', missing: 'This activity has no heart rate.' },
  { metric: 'power', label: 'Power', missing: 'This activity has no power.' },
  { metric: 'cyclingCadence', label: 'Cycling cadence', missing: 'This activity has no cycling cadence.' },
  { metric: 'runningCadence', label: 'Running cadence', missing: 'This activity has no running cadence.' },
];

const SHAPE_CHOICES: readonly { kind: ShapeKind; label: string }[] = [
  { kind: 'roundedRect', label: 'Rounded rectangle' },
  { kind: 'rect', label: 'Rectangle' },
  { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'line', label: 'Line' },
];

/**
 * Every element the canvas offers, grouped, each with whether this activity
 * can supply it and, if not, why. Live figures change as the video plays (the
 * timeline, TD-041); whole-activity figures, the date and text are AV-1010's.
 */
export function canvasElementChoices(timeline: OverlayTimeline, still: StillImageContext): CanvasElementChoice[] {
  const has = (id: string) => !timeline.unavailable && timeline.available.has(id);
  const live: CanvasElementChoice[] = LIVE_FIGURES.map(({ metric, label, missing }) => ({
    key: `metric:${metric}`,
    label,
    group: 'Live figures',
    available: has(`metric:${metric}`),
    ...(has(`metric:${metric}`) ? {} : { reason: missing }),
  }));
  const gauges: CanvasElementChoice[] = [
    { key: 'gauge:speed', label: 'Speed gauge', group: 'Live figures', available: has('metric:speed'), ...(has('metric:speed') ? {} : { reason: LIVE_FIGURES[0]!.missing }) },
    { key: 'gauge:heartRate', label: 'Heart rate gauge', group: 'Live figures', available: has('metric:heartRate'), ...(has('metric:heartRate') ? {} : { reason: 'This activity has no heart rate.' }) },
    {
      key: 'route',
      label: 'Route with position',
      group: 'Live figures',
      available: !timeline.unavailable && timeline.hasRoute,
      ...(!timeline.unavailable && timeline.hasRoute ? {} : { reason: 'This activity has no positions, so there is no route.' }),
    },
    { key: 'progress', label: 'Progress bar', group: 'Live figures', available: !timeline.unavailable },
  ];
  const whole: CanvasElementChoice[] = stillElementChoices(still)
    .filter((choice) => choice.key !== 'route')
    .map((choice) => ({
      key: `still:${choice.key}` as CanvasElementKey,
      label: choice.key === 'label' ? 'Text' : choice.key === 'date' ? 'Date' : `${choice.label} (whole activity)`,
      group: 'Whole activity',
      available: choice.available,
      ...(choice.reason ? { reason: choice.reason } : {}),
    }));
  const shapes: CanvasElementChoice[] = SHAPE_CHOICES.map(({ kind, label }) => ({
    key: `shape:${kind}`,
    label,
    group: 'Shapes',
    available: true,
  }));
  return [...live, ...gauges, ...whole, ...shapes];
}

const HEART_RATE_RANGE = { min: 50, max: 200 };

/**
 * A new element, sized as a built-in template's tile is and put in the
 * top-left, a margin in: where a reader then moves it from.
 */
export function newCanvasComponent(
  template: OverlayTemplate,
  key: CanvasElementKey,
  size: { width: number; height: number },
  timeline: OverlayTimeline,
): OverlayComponent {
  const aspect = size.width / size.height;
  const tileW = Math.min(0.3, (BASE_FONT_CQW / 100) * TILE_WIDTH_EMS);
  const tileH = Math.min(0.2, 0.075 * aspect);
  const at = (width: number, height: number): OverlayRect => normalizeRect({ x: 0.04, y: 0.04, width, height });
  const base = { visible: true, unitMode: 'auto' as const, style: {} };

  if (key.startsWith('still:')) {
    const component = newStillComponent(template, key.slice('still:'.length) as never, size);
    return { ...component, style: { ...component.style, fontScale: 1.5 } };
  }
  if (key.startsWith('shape:')) {
    const kind = key.slice('shape:'.length) as ShapeKind;
    return {
      ...base,
      id: freshComponentId(template, 'shape'),
      type: 'shape',
      rect: kind === 'line' ? at(0.3, 0.01) : at(0.3, Math.min(0.9, 0.3 * aspect * 0.6)),
      shape: { ...DEFAULT_SHAPE, kind, ...(kind === 'line' ? { strokeOpacity: 1, fillOpacity: 0 } : {}) },
    };
  }
  if (key === 'route') {
    const side = Math.min(0.3, 0.3 / aspect);
    return { ...base, id: freshComponentId(template, 'route'), type: 'routeInset', rect: at(side, side * aspect) };
  }
  if (key === 'progress') {
    return { ...base, id: freshComponentId(template, 'progress'), type: 'progress', rect: at(0.5, Math.max(0.006, 0.012 * aspect)) };
  }
  if (key === 'gauge:speed' || key === 'gauge:heartRate') {
    const metric = key === 'gauge:speed' ? 'speed' : 'heartRate';
    const speedMax = speedRangeOf(timeline);
    return {
      ...base,
      id: freshComponentId(template, `${metric}-gauge`),
      type: 'gauge',
      rect: at(tileW, tileH),
      source: { kind: 'metric', metric },
      range: metric === 'heartRate' ? HEART_RATE_RANGE : { min: 0, max: speedMax },
    };
  }
  const metric = key.slice('metric:'.length) as OverlayMetricKey;
  return {
    ...base,
    id: freshComponentId(template, metric),
    type: 'text',
    rect: at(tileW, tileH),
    source: { kind: 'metric', metric },
  };
}

/** A speed gauge's top: the fastest the activity went, rounded up, or 15 m/s (54 km/h). */
function speedRangeOf(timeline: OverlayTimeline): number {
  let max = 0;
  const span = timeline.alignment?.activitySpanSeconds ?? timeline.durationSeconds;
  for (let i = 0; i <= 200; i += 1) {
    const sample = timeline.sampleAt((span * i) / 200);
    const speed = sample?.values['metric:speed'];
    if (typeof speed === 'number' && speed > max) max = speed;
  }
  return max > 0 ? Math.ceil(max / 5) * 5 : 15;
}

// ---------------------------------------------------------------------------
// Placing: every change keeps every element inside the frame

/** The smallest an element may be made, as a share of the frame. */
export const MIN_SHARE = 0.01;

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

function membersOf(components: OverlayComponent[], id: string): OverlayComponent[] {
  return components.filter((component) => component.id === id || component.parentId === id);
}

/**
 * Moves an element so its rect's top-left is at (x, y), with every component
 * a shape holds moved by as much: the group as one, kept inside the frame as
 * one, so a card never leaves its figures behind or pushes them off the edge.
 */
export function moveComponent(components: OverlayComponent[], id: string, x: number, y: number): OverlayComponent[] {
  const target = components.find((component) => component.id === id);
  if (!target) return components;
  const group = target.type === 'shape' ? membersOf(components, id) : [target];
  const left = Math.min(...group.map((component) => component.rect.x));
  const top = Math.min(...group.map((component) => component.rect.y));
  const right = Math.max(...group.map((component) => component.rect.x + component.rect.width));
  const bottom = Math.max(...group.map((component) => component.rect.y + component.rect.height));
  const dx = clamp(x - target.rect.x, -left, 1 - right);
  const dy = clamp(y - target.rect.y, -top, 1 - bottom);
  const moving = new Set(group.map((component) => component.id));
  return components.map((component) =>
    moving.has(component.id)
      ? { ...component, rect: normalizeRect({ ...component.rect, x: round(component.rect.x + dx), y: round(component.rect.y + dy) }) }
      : component,
  );
}

export function nudgeComponent(components: OverlayComponent[], id: string, dx: number, dy: number): OverlayComponent[] {
  const target = components.find((component) => component.id === id);
  return target ? moveComponent(components, id, target.rect.x + dx, target.rect.y + dy) : components;
}

/** Resizes an element from its top-left corner, between `MIN_SHARE` and what is left of the frame. */
export function resizeComponent(components: OverlayComponent[], id: string, width: number, height: number): OverlayComponent[] {
  return components.map((component) =>
    component.id === id
      ? {
          ...component,
          rect: normalizeRect({
            ...component.rect,
            width: round(clamp(width, MIN_SHARE, 1 - component.rect.x)),
            height: round(clamp(height, MIN_SHARE, 1 - component.rect.y)),
          }),
        }
      : component,
  );
}

/** The text size a text, a figure for the whole activity or a date can take, as a multiple of the base. */
export const TEXT_SCALE_LIMITS = { min: 0.1, max: 10 } as const;

/**
 * Resizes a text, a figure for the whole activity or a date: its box is the
 * size its words take, so resizing it scales the words, from the scale it had
 * at `from` (the element as the resize began).
 */
export function scaleText(components: OverlayComponent[], id: string, from: OverlayComponent, factor: number): OverlayComponent[] {
  const base = from.style.fontScale ?? DEFAULT_OVERLAY_STYLE.fontScale;
  const fontScale = round(clamp(base * (Number.isFinite(factor) ? factor : 1), TEXT_SCALE_LIMITS.min, TEXT_SCALE_LIMITS.max));
  return components.map((component) => (component.id === id ? { ...component, style: { ...component.style, fontScale } } : component));
}

export type LayerMove = 'front' | 'forward' | 'backward' | 'back';

/** Changes where an element is drawn among the others: the last drawn is in front. */
export function moveLayer(components: OverlayComponent[], id: string, move: LayerMove): OverlayComponent[] {
  const index = components.findIndex((component) => component.id === id);
  if (index < 0) return components;
  const next = [...components];
  const [item] = next.splice(index, 1);
  const to = move === 'front' ? next.length : move === 'back' ? 0 : move === 'forward' ? Math.min(next.length, index + 1) : Math.max(0, index - 1);
  next.splice(to, 0, item!);
  return next;
}

/** A copy of an element, just below and right of it, inside the frame, drawn in front. Held by the same shape. */
export function duplicateComponent(components: OverlayComponent[], id: string): { components: OverlayComponent[]; id?: string } {
  const source = components.find((component) => component.id === id);
  if (!source) return { components };
  const prefix = source.id.replace(/-\d+$/, '') || source.type;
  const copyId = freshComponentId({ version: OVERLAY_TEMPLATE_VERSION, name: '', style: DEFAULT_OVERLAY_STYLE, components }, prefix);
  const copy: OverlayComponent = structuredClone(source);
  copy.id = copyId;
  const placed = { ...copy, rect: normalizeRect({ ...copy.rect, x: copy.rect.x + 0.02, y: copy.rect.y + 0.02 }) };
  return { components: [...components, placed], id: copyId };
}

/** Removes an element; what it held is let go, not removed with it. */
export function removeComponent(components: OverlayComponent[], id: string): OverlayComponent[] {
  return components
    .filter((component) => component.id !== id)
    .map((component) => {
      if (component.parentId !== id) return component;
      const free = { ...component };
      delete free.parentId;
      return free;
    });
}

/** Puts an element in a shape's hold, or lets it go. Only a shape holds, and not itself. */
export function setHolder(components: OverlayComponent[], id: string, holderId: string | undefined): OverlayComponent[] {
  const holder = holderId ? components.find((component) => component.id === holderId) : undefined;
  if (holderId && (!holder || holder.type !== 'shape' || holderId === id)) return components;
  return components.map((component) => {
    if (component.id !== id) return component;
    const next = { ...component };
    if (holderId) next.parentId = holderId;
    else delete next.parentId;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Undo

/** What the editor can take back: the layout and what was selected in it. */
export interface CanvasState {
  components: OverlayComponent[];
  selectedId?: string;
}

/**
 * Everything the editor holds, kept by the page for the session so a visit to
 * Sync, another mode or Start over does not lose the layout or its undo.
 */
export interface CanvasDraft {
  /** As typed, so a size being typed is not lost either. */
  width: string;
  height: string;
  /** The last size that could be used. */
  frame: { width: number; height: number };
  state: CanvasState;
  history: CanvasState[];
}

export const EMPTY_CANVAS_DRAFT: CanvasDraft = {
  width: '1920',
  height: '1080',
  frame: { width: 1920, height: 1080 },
  state: { components: [] },
  history: [],
};

export const UNDO_DEPTH = 100;

/** The history with `state` added, the oldest let go past `UNDO_DEPTH`; an unchanged state adds nothing. */
export function pushHistory(history: CanvasState[], state: CanvasState): CanvasState[] {
  const last = history[history.length - 1];
  if (last && last.components === state.components && last.selectedId === state.selectedId) return history;
  return [...history, state].slice(-UNDO_DEPTH);
}

// ---------------------------------------------------------------------------
// Starting points

/** A built-in template's layout, at this canvas's shape: a starting point to move from. */
export function componentsFromPreset(
  presetId: OverlayPresetId,
  timeline: OverlayTimeline,
  size: { width: number; height: number },
): OverlayComponent[] {
  return buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS, presetId }, timeline, size.width / size.height).template.components;
}

/** A template of these components, ready for an exporter or a layout file. */
export function canvasTemplate(components: OverlayComponent[]): OverlayTemplate {
  return {
    version: OVERLAY_TEMPLATE_VERSION,
    name: 'Custom canvas',
    style: { ...DEFAULT_OVERLAY_STYLE },
    components: components.map((component) => ({ ...component, rect: normalizeRect(component.rect) })),
  };
}
