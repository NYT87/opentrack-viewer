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

export const OVERLAY_TEMPLATE_VERSION = 1;

export type OverlayComponentType =
  | 'text'
  | 'gauge'
  | 'routeInset'
  | 'progress'
  | 'sensorChart';

export const OVERLAY_COMPONENT_TYPES: readonly OverlayComponentType[] = [
  'text',
  'gauge',
  'routeInset',
  'progress',
  'sensorChart',
];

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
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > 1 ||
    rect.y + rect.height > 1
  ) {
    return 'invalid rect (must lie within the frame, as fractions of 0..1)';
  }
  const componentType = type as OverlayComponentType;
  const needsSource = componentType !== 'routeInset' && componentType !== 'progress';
  const source = parseSource(value.source);
  if (needsSource && !source) return 'missing or invalid data source';

  const unitMode = value.unitMode;
  const component: OverlayComponent = {
    id,
    type: componentType,
    visible: value.visible !== false,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
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
  return component;
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
  if (raw.version !== OVERLAY_TEMPLATE_VERSION) {
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
};

function describeSource(source: OverlayDataSource, timeline: OverlayTimeline): string {
  return source.kind === 'metric'
    ? METRIC_LABELS[source.metric]
    : (timeline.sensorLabels.get(dataSourceId(source))?.label ?? source.key);
}

/** What a renderer is told to draw for one component at one moment. */
export type ResolvedOverlayComponent =
  | { status: 'hidden'; reason: 'disabled' | 'no_data' | 'no_position'; componentId: string }
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

  const label = describeSource(source, timeline);
  let text: string;
  if (source.kind === 'metric') text = formatMetric(source.metric, value, unitSystem);
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
