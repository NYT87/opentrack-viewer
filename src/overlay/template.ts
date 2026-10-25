import type { UnitSystem } from '../domain/units';
import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  formatTemperature,
} from '../domain/units';
import {
  OVERLAY_METRIC_KEYS,
  dataSourceId,
  type OverlayDataSource,
  type OverlayMetricKey,
  type OverlaySample,
  type OverlayTimeline,
} from './timeline';

/**
 * AV-1003. The overlay template: which components are drawn, where, how they
 * look, and which data each reads. A template is plain data — no functions, no
 * DOM — so it serializes to JSON (TD-039) and the same template drives the
 * preview and every export.
 */

/**
 * Version 2 (AV-1010) adds the still image's components: free text, a figure
 * from the activity's summary, and its date. Version 1 templates read as
 * before; a version 1 reader refuses version 2 rather than half-reading it.
 */
export const OVERLAY_TEMPLATE_VERSION = 2;
const READABLE_TEMPLATE_VERSIONS: readonly number[] = [1, 2];

export type OverlayComponentType =
  | 'text'
  | 'gauge'
  | 'routeInset'
  | 'progress'
  | 'sensorChart'
  | 'label'
  | 'summary'
  | 'date'
  /** AV-1011. A card, a frame or a rule behind or in front of the figures. */
  | 'shape';

export const OVERLAY_COMPONENT_TYPES: readonly OverlayComponentType[] = [
  'text',
  'gauge',
  'routeInset',
  'progress',
  'sensorChart',
  'label',
  'summary',
  'date',
  'shape',
];

/** AV-1011. What a shape is. */
export type ShapeKind = 'roundedRect' | 'rect' | 'ellipse' | 'line';
export const SHAPE_KINDS: readonly ShapeKind[] = ['roundedRect', 'rect', 'ellipse', 'line'];

/**
 * AV-1011. How a shape is drawn. Colours are hex, transparencies 0..1, and
 * widths and radii shares of the frame's shorter side, so a shape scales with
 * the picture as everything else in a template does. A line runs from its
 * box's top-left corner to its bottom-right one, and has a border only.
 */
export interface OverlayShapeSetting {
  kind: ShapeKind;
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  /** `roundedRect` only. */
  radius: number;
}

/** AV-1011. How a data figure is labelled and written. */
export interface OverlayDisplaySetting {
  /** Replaces the figure's own name ("Speed"); empty keeps it. */
  label?: string;
  /** Decimal places for a plain number (speed, distance, elevation, power…); times and pace keep their own form. */
  decimals?: 0 | 1 | 2;
}

/**
 * AV-1010. Components that describe the whole activity rather than a moment of
 * it: drawn on the still image, and hidden in a video, where a frame shows a
 * moment.
 */
export const STILL_IMAGE_COMPONENT_TYPES: readonly OverlayComponentType[] = ['label', 'summary', 'date'];

/**
 * AV-1011. Whether a component is drawn the same on every frame, whatever the
 * telemetry says at that moment: a shape, or a text, figure or date for the
 * whole activity. These are drawn even where the activity does not reach.
 */
export function drawnWithoutTelemetry(component: OverlayComponent): boolean {
  return component.type === 'shape' || STILL_IMAGE_COMPONENT_TYPES.includes(component.type);
}

/** A figure from the activity's summary, for the still image. */
export type SummaryStatKey = 'speed' | 'pace' | 'distance' | 'elapsed' | 'moving';
export const SUMMARY_STAT_KEYS: readonly SummaryStatKey[] = ['speed', 'pace', 'distance', 'elapsed', 'moving'];

/** How a date is written: `2026-09-24`, `24 Sep 2026`, `24/09/2026`, `Thursday 24 September 2026`. */
export type DateFormatId = 'iso' | 'medium' | 'numeric' | 'long';
export const DATE_FORMAT_IDS: readonly DateFormatId[] = ['iso', 'medium', 'numeric', 'long'];

/** In the time zone the file says it was recorded in, or the reader's own. */
export type DateTimeZoneChoice = 'activity' | 'reader';

export type TextAlign = 'left' | 'center' | 'right';
export type FontWeight = 'normal' | 'bold';

/** How a still-image text, figure or date is set. */
export interface OverlayTextSetting {
  align: TextAlign;
  weight: FontWeight;
  /** A figure's caption ("Distance") over its value. */
  caption?: boolean;
}

/** The still image's route: its line and its markers, sized to the image. */
export interface OverlayRouteSetting {
  /** Stroke, as a fraction of the image's shorter side. */
  lineWidth: number;
  /** Margin inside the route's box, as a fraction of the image's shorter side. */
  padding: number;
  markers: boolean;
}

/** Longest free text kept, and most lines: a caption, not a document. */
export const LABEL_MAX_LENGTH = 200;
export const LABEL_MAX_LINES = 4;

/**
 * Free text as it may be drawn: control characters other than a line break
 * taken out, at most `LABEL_MAX_LINES` lines and `LABEL_MAX_LENGTH`
 * characters. It is only ever drawn as text (canvas `fillText`, React text),
 * never parsed as markup, so nothing else needs escaping.
 */
export function sanitizeLabel(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .split('\n')
    .slice(0, LABEL_MAX_LINES)
    .join('\n')
    .slice(0, LABEL_MAX_LENGTH);
}

/** Position and size as fractions of the frame, so one template fits any resolution. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `auto` follows the unit system the reader picked in Settings. */
export type OverlayUnitMode = 'auto' | UnitSystem;

/** Named style tokens; a renderer maps them to the app's theme, not raw CSS. */
export interface OverlayStyle {
  textColor: string;
  accentColor: string;
  /** 0..1 */
  backgroundOpacity: number;
  /** Multiplier on the component's base type size. */
  fontScale: number;
}

export const DEFAULT_OVERLAY_STYLE: OverlayStyle = {
  textColor: '#ffffff',
  accentColor: '#ff6a00',
  backgroundOpacity: 0.35,
  fontScale: 1,
};

/**
 * TD-059. Below this background the figures carry a thin dark halo of their
 * own: white type on a bright sky or snow is otherwise unreadable. The preview
 * and the export both draw it, from this one test.
 */
export const HALO_BELOW_OPACITY = 0.3;
export const needsHalo = (style: Pick<OverlayStyle, 'backgroundOpacity'>) =>
  style.backgroundOpacity < HALO_BELOW_OPACITY;

export interface OverlayComponent {
  id: string;
  type: OverlayComponentType;
  visible: boolean;
  rect: OverlayRect;
  unitMode: OverlayUnitMode;
  /** Merged over the template's style. */
  style: Partial<OverlayStyle>;
  /** Absent for `routeInset` and `progress`, which read the sample's position and progress. */
  source?: OverlayDataSource;
  /** Gauge bounds in the metric's stored unit. */
  range?: { min: number; max: number };
  /** Sensor chart window, in seconds of video time either side of now. */
  windowSeconds?: number;
  /** `label`: the text itself. */
  content?: string;
  /** `summary`: which figure. */
  summary?: { stat: SummaryStatKey };
  /** `date`: how it is written, and in which time zone. */
  date?: { format: DateFormatId; withTime: boolean; timeZone: DateTimeZoneChoice };
  /** `label`, `summary`, `date`: alignment, weight and caption. */
  text?: OverlayTextSetting;
  /** `routeInset` on the still image: line, padding and markers. */
  route?: OverlayRouteSetting;
  /** `shape`: what it is and how it is drawn. */
  shape?: OverlayShapeSetting;
  /** AV-1011. The shape this component is held by: moved with it, and kept inside the frame with it. */
  parentId?: string;
  /** AV-1011. A data figure's own label and number format. */
  display?: OverlayDisplaySetting;
}

export interface OverlayTemplate {
  version: typeof OVERLAY_TEMPLATE_VERSION;
  name: string;
  style: OverlayStyle;
  components: OverlayComponent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** How far past the frame's edge a rect may read before it is refused: floating-point error, not a placement. */
const RECT_TOLERANCE = 1e-6;

/**
 * A rect kept inside the frame: sizes at most the whole frame, positions so
 * that position plus size is at most 1, all to six decimals. Measured boxes
 * (a text's) come out of division, and their sums can land a hair past 1;
 * this is applied when a layout is saved and when it is read, so a layout
 * always reopens with every element it was saved with (AV-1010).
 */
export function normalizeRect(rect: OverlayRect): OverlayRect {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const width = round(Math.min(1, Math.max(0, rect.width)));
  const height = round(Math.min(1, Math.max(0, rect.height)));
  return {
    x: round(Math.min(Math.max(0, rect.x), 1 - width)),
    y: round(Math.min(Math.max(0, rect.y), 1 - height)),
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Serialization

export function serializeOverlayTemplate(template: OverlayTemplate): string {
  return JSON.stringify(template, null, 2);
}

export type ParseOverlayTemplateResult =
  | { ok: true; template: OverlayTemplate; warnings: string[] }
  | { ok: false; error: string };

function parseSource(value: unknown): OverlayDataSource | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'metric' && OVERLAY_METRIC_KEYS.includes(value.metric as OverlayMetricKey)) {
    return { kind: 'metric', metric: value.metric as OverlayMetricKey };
  }
  if (value.kind === 'sensor' && typeof value.key === 'string' && value.key.length > 0) {
    return { kind: 'sensor', key: value.key };
  }
  return undefined;
}

function parseStyle(value: unknown): Partial<OverlayStyle> {
  if (!isRecord(value)) return {};
  const style: Partial<OverlayStyle> = {};
  if (typeof value.textColor === 'string') style.textColor = value.textColor;
  if (typeof value.accentColor === 'string') style.accentColor = value.accentColor;
  if (isNumber(value.backgroundOpacity)) style.backgroundOpacity = clamp01(value.backgroundOpacity);
  if (isNumber(value.fontScale) && value.fontScale > 0) style.fontScale = value.fontScale;
  return style;
}

function parseComponent(value: unknown): OverlayComponent | string {
  if (!isRecord(value)) return 'not an object';
  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) return 'missing id';
  const type = value.type;
  if (!OVERLAY_COMPONENT_TYPES.includes(type as OverlayComponentType)) {
    return `unknown component type "${String(type)}"`;
  }
  const rect = value.rect;
  if (
    !isRecord(rect) ||
    !isNumber(rect.x) ||
    !isNumber(rect.y) ||
    !isNumber(rect.width) ||
    !isNumber(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x < -RECT_TOLERANCE ||
    rect.y < -RECT_TOLERANCE ||
    rect.x + rect.width > 1 + RECT_TOLERANCE ||
    rect.y + rect.height > 1 + RECT_TOLERANCE
  ) {
    return 'invalid rect (must lie within the frame, as fractions of 0..1)';
  }
  const componentType = type as OverlayComponentType;
  const stillOnly = STILL_IMAGE_COMPONENT_TYPES.includes(componentType);
  const needsSource =
    componentType !== 'routeInset' && componentType !== 'progress' && componentType !== 'shape' && !stillOnly;
  if (componentType === 'shape') {
    const kind = isRecord(value.shape) ? value.shape.kind : undefined;
    if (!SHAPE_KINDS.includes(kind as ShapeKind)) return `unknown shape "${String(kind)}"`;
  }
  const source = parseSource(value.source);
  if (needsSource && !source) return 'missing or invalid data source';
  if (componentType === 'label' && typeof value.content !== 'string') return 'a text with no content';
  if (componentType === 'summary') {
    const stat = isRecord(value.summary) ? value.summary.stat : undefined;
    if (!SUMMARY_STAT_KEYS.includes(stat as SummaryStatKey)) return `unknown figure "${String(stat)}"`;
  }
  if (componentType === 'date') {
    const format = isRecord(value.date) ? value.date.format : undefined;
    if (!DATE_FORMAT_IDS.includes(format as DateFormatId)) return `unknown date format "${String(format)}"`;
  }

  const unitMode = value.unitMode;
  const component: OverlayComponent = {
    id,
    type: componentType,
    visible: value.visible !== false,
    rect: normalizeRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
    unitMode: unitMode === 'metric' || unitMode === 'imperial' ? unitMode : 'auto',
    style: parseStyle(value.style),
  };
  if (needsSource && source) component.source = source;
  if (
    isRecord(value.range) &&
    isNumber(value.range.min) &&
    isNumber(value.range.max) &&
    value.range.max > value.range.min
  ) {
    component.range = { min: value.range.min, max: value.range.max };
  }
  if (isNumber(value.windowSeconds) && value.windowSeconds > 0) {
    component.windowSeconds = value.windowSeconds;
  }
  if (componentType === 'label') component.content = sanitizeLabel(value.content as string);
  if (componentType === 'summary' && isRecord(value.summary)) {
    component.summary = { stat: value.summary.stat as SummaryStatKey };
  }
  if (componentType === 'date' && isRecord(value.date)) {
    component.date = {
      format: value.date.format as DateFormatId,
      withTime: value.date.withTime === true,
      timeZone: value.date.timeZone === 'activity' ? 'activity' : 'reader',
    };
  }
  if (stillOnly) {
    const text = isRecord(value.text) ? value.text : {};
    component.text = {
      align: text.align === 'center' || text.align === 'right' ? text.align : 'left',
      weight: text.weight === 'normal' ? 'normal' : 'bold',
      ...(componentType === 'summary' ? { caption: text.caption !== false } : {}),
    };
  }
  if (componentType === 'shape' && isRecord(value.shape)) component.shape = parseShape(value.shape);
  if (typeof value.parentId === 'string' && value.parentId.length > 0 && value.parentId !== id) {
    component.parentId = value.parentId;
  }
  if (isRecord(value.display)) {
    const display: OverlayDisplaySetting = {};
    if (typeof value.display.label === 'string') display.label = sanitizeLabel(value.display.label).split('\n')[0]!.slice(0, 40);
    if (value.display.decimals === 0 || value.display.decimals === 1 || value.display.decimals === 2) {
      display.decimals = value.display.decimals;
    }
    if (display.label !== undefined || display.decimals !== undefined) component.display = display;
  }
  if (componentType === 'routeInset' && isRecord(value.route)) {
    const route = value.route;
    if (isNumber(route.lineWidth) && route.lineWidth > 0 && isNumber(route.padding) && route.padding >= 0) {
      component.route = {
        lineWidth: Math.min(route.lineWidth, 0.5),
        padding: Math.min(route.padding, 0.4),
        markers: route.markers !== false,
      };
    }
  }
  return component;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The default shape: a dark rounded card, as a figure's tile is. */
export const DEFAULT_SHAPE: OverlayShapeSetting = {
  kind: 'roundedRect',
  fill: '#000000',
  fillOpacity: 0.35,
  stroke: '#ffffff',
  strokeOpacity: 0,
  strokeWidth: 0.004,
  radius: 0.02,
};

function parseShape(raw: Record<string, unknown>): OverlayShapeSetting {
  const share = (value: unknown, max: number, fallback: number) =>
    isNumber(value) && value >= 0 ? Math.min(value, max) : fallback;
  return {
    kind: raw.kind as ShapeKind,
    fill: typeof raw.fill === 'string' && HEX.test(raw.fill) ? raw.fill : DEFAULT_SHAPE.fill,
    fillOpacity: isNumber(raw.fillOpacity) ? clamp01(raw.fillOpacity) : DEFAULT_SHAPE.fillOpacity,
    stroke: typeof raw.stroke === 'string' && HEX.test(raw.stroke) ? raw.stroke : DEFAULT_SHAPE.stroke,
    strokeOpacity: isNumber(raw.strokeOpacity) ? clamp01(raw.strokeOpacity) : DEFAULT_SHAPE.strokeOpacity,
    strokeWidth: share(raw.strokeWidth, 0.1, DEFAULT_SHAPE.strokeWidth),
    radius: share(raw.radius, 0.5, DEFAULT_SHAPE.radius),
  };
}

/**
 * Reads a template back from JSON. A malformed file is an error; a single bad
 * component is dropped with a warning, so one stale entry does not cost the
 * reader the rest of their layout.
 */
export function parseOverlayTemplate(json: string): ParseOverlayTemplateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'The template is not valid JSON.' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'The template is not an object.' };
  if (!READABLE_TEMPLATE_VERSIONS.includes(raw.version as number)) {
    return { ok: false, error: `Unsupported template version ${String(raw.version)}.` };
  }
  if (!Array.isArray(raw.components)) {
    return { ok: false, error: 'The template has no components list.' };
  }

  const warnings: string[] = [];
  const components: OverlayComponent[] = [];
  const seen = new Set<string>();
  raw.components.forEach((entry, index) => {
    const parsed = parseComponent(entry);
    if (typeof parsed === 'string') {
      warnings.push(`Component ${index + 1} was skipped: ${parsed}.`);
    } else if (seen.has(parsed.id)) {
      warnings.push(`Component ${index + 1} was skipped: duplicate id "${parsed.id}".`);
    } else {
      seen.add(parsed.id);
      components.push(parsed);
    }
  });

  // A component held by a shape that is not there is simply free.
  const shapes = new Set(components.filter((entry) => entry.type === 'shape').map((entry) => entry.id));
  for (const entry of components) if (entry.parentId && !shapes.has(entry.parentId)) delete entry.parentId;

  return {
    ok: true,
    warnings,
    template: {
      version: OVERLAY_TEMPLATE_VERSION,
      name: typeof raw.name === 'string' && raw.name ? raw.name : 'Untitled template',
      style: { ...DEFAULT_OVERLAY_STYLE, ...parseStyle(raw.style) },
      components,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution against data

export interface OverlayTemplateWarning {
  componentId: string;
  /** The `dataSourceId` the component asked for. */
  source: string;
  message: string;
}

/**
 * Components whose data the timeline does not have anywhere. Shown to the
 * reader as warnings; the components themselves are hidden, never drawn empty.
 */
export function unavailableBindings(
  template: OverlayTemplate,
  timeline: OverlayTimeline,
): OverlayTemplateWarning[] {
  const warnings: OverlayTemplateWarning[] = [];
  for (const component of template.components) {
    if (!component.visible || !component.source) continue;
    const id = dataSourceId(component.source);
    if (!timeline.available.has(id)) {
      warnings.push({
        componentId: component.id,
        source: id,
        message: `${describeSource(component.source, timeline)} is not in this activity, so it is not shown.`,
      });
    }
  }
  return warnings;
}

const METRIC_LABELS: Record<OverlayMetricKey, string> = {
  speed: 'Speed',
  pace: 'Pace',
  distance: 'Distance',
  elevation: 'Elevation',
  heartRate: 'Heart rate',
  runningCadence: 'Running cadence',
  cyclingCadence: 'Cycling cadence',
  power: 'Power',
  temperature: 'Temperature',
  grade: 'Grade',
  elapsed: 'Time',
  moving: 'Moving time',
};

function describeSource(source: OverlayDataSource, timeline: OverlayTimeline): string {
  return source.kind === 'metric'
    ? METRIC_LABELS[source.metric]
    : (timeline.sensorLabels.get(dataSourceId(source))?.label ?? source.key);
}

/** What a renderer is told to draw for one component at one moment. */
export type ResolvedOverlayComponent =
  | {
      status: 'hidden';
      /** `still_image_only`: a text, figure or date, which a video frame does not show (AV-1010). */
      reason: 'disabled' | 'no_data' | 'no_position' | 'still_image_only';
      componentId: string;
    }
  | {
      status: 'ready';
      componentId: string;
      component: OverlayComponent;
      style: OverlayStyle;
      label?: string;
      /** Formatted for display in the component's unit mode. */
      text?: string;
      /** Gauge/progress position, 0..1. */
      fraction?: number;
    };

function effectiveUnits(component: OverlayComponent, units: UnitSystem): UnitSystem {
  return component.unitMode === 'auto' ? units : component.unitMode;
}

function formatMetric(metric: OverlayMetricKey, value: number, units: UnitSystem): string {
  switch (metric) {
    case 'speed':
      return formatSpeed(value, units);
    case 'pace':
      return formatPace(value, units);
    case 'distance':
      return formatDistance(value, units);
    case 'elevation':
      return formatElevation(value, units);
    case 'temperature':
      return formatTemperature(value, units);
    case 'elapsed':
    case 'moving':
      return formatDuration(value);
    case 'heartRate':
      return `${Math.round(value)} bpm`;
    case 'runningCadence':
      return `${Math.round(value)} spm`;
    case 'cyclingCadence':
      return `${Math.round(value)} rpm`;
    case 'power':
      return `${Math.round(value)} W`;
    case 'grade':
      return `${value.toFixed(1)} %`;
  }
}

/**
 * AV-1011. A metric with the decimal places the reader chose. Times and pace
 * are written as clocks, whatever the choice; a plain number takes it.
 */
export function formatMetricWith(metric: OverlayMetricKey, value: number, units: UnitSystem, decimals: 0 | 1 | 2): string {
  const imperial = units === 'imperial';
  const fixed = (n: number, unit: string) => `${n.toFixed(decimals)} ${unit}`;
  switch (metric) {
    case 'speed':
      return imperial ? fixed((value * 3600) / 1609.344, 'mph') : fixed((value * 3600) / 1000, 'km/h');
    case 'distance':
      return imperial ? fixed(value / 1609.344, 'mi') : fixed(value / 1000, 'km');
    case 'elevation':
      return imperial ? fixed(value * 3.28084, 'ft') : fixed(value, 'm');
    case 'temperature':
      return imperial ? fixed((value * 9) / 5 + 32, '°F') : fixed(value, '°C');
    case 'heartRate':
      return fixed(value, 'bpm');
    case 'runningCadence':
      return fixed(value, 'spm');
    case 'cyclingCadence':
      return fixed(value, 'rpm');
    case 'power':
      return fixed(value, 'W');
    case 'grade':
      return fixed(value, '%');
    case 'pace':
    case 'elapsed':
    case 'moving':
      return formatMetric(metric, value, units);
  }
}

/**
 * Resolves one component against one sample. Missing data yields `hidden`,
 * never a placeholder: a dash on a speedometer reads as a broken overlay.
 */
export function resolveOverlayComponent(
  template: OverlayTemplate,
  component: OverlayComponent,
  sample: OverlaySample | undefined,
  timeline: OverlayTimeline,
  units: UnitSystem,
): ResolvedOverlayComponent {
  const componentId = component.id;
  if (!component.visible) return { status: 'hidden', reason: 'disabled', componentId };
  if (STILL_IMAGE_COMPONENT_TYPES.includes(component.type)) {
    return { status: 'hidden', reason: 'still_image_only', componentId };
  }
  if (!sample) return { status: 'hidden', reason: 'no_data', componentId };

  const style: OverlayStyle = { ...template.style, ...component.style };
  const unitSystem = effectiveUnits(component, units);

  if (component.type === 'routeInset') {
    return sample.position
      ? { status: 'ready', componentId, component, style }
      : { status: 'hidden', reason: 'no_position', componentId };
  }
  if (component.type === 'progress') {
    return sample.progress === undefined
      ? { status: 'hidden', reason: 'no_data', componentId }
      : { status: 'ready', componentId, component, style, fraction: sample.progress };
  }

  const source = component.source;
  const value = source ? sample.values[dataSourceId(source)] : undefined;
  if (!source || value === undefined) return { status: 'hidden', reason: 'no_data', componentId };

  const label = component.display?.label?.trim() || describeSource(source, timeline);
  let text: string;
  if (source.kind === 'metric') {
    text =
      component.display?.decimals !== undefined
        ? formatMetricWith(source.metric, value, unitSystem, component.display.decimals)
        : formatMetric(source.metric, value, unitSystem);
  }
  else {
    const unit = timeline.sensorLabels.get(dataSourceId(source))?.unit;
    text = `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}`;
  }

  let fraction: number | undefined;
  if (component.type === 'gauge' && component.range) {
    const { min, max } = component.range;
    fraction = clamp01((value - min) / (max - min));
  }
  return { status: 'ready', componentId, component, style, label, text, fraction };
}
