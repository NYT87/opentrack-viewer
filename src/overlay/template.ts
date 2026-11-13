import type { UnitSystem } from '../domain/units';
import {
  formatDistance,
  formatDistanceOnScale,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  formatTemperature,
  paceUnitLabel,
} from '../domain/units';
import {
  ZONE_FROM_MAX,
  ZONE_LIMITS,
  ZONE_NAME_MAX,
  ZONES_UNIT,
  cleanPersonal,
  effectivePersonal,
  zoneBounds,
  zoneIndex,
  withinZone,
} from './zones';
import { formatHeading } from './derivedSeries';
import { readPrivacyTrim, type PrivacyTrim } from './privacyTrim';
import { DEFAULT_DIAL, DIAL_LIMITS, activityRange, rangeFraction } from './dial';
import { DEFAULT_GRADIENT, GRADIENT_BAND_LIMITS, GRADIENT_FROM_LIMITS } from './gradient';
import { DEFAULT_COMPASS } from './compass';
import {
  DEFAULT_SPLITS,
  SPLITS_EVERY_METERS,
  SPLITS_LIST_LIMITS,
  SPLITS_NO_DISTANCE,
  splitsSourceOf,
  splitsUnavailableReason,
} from './splits';
import {
  OVERLAY_METRIC_KEYS,
  SMOOTHING_LIMITS,
  canSmooth,
  dataSourceId,
  smoothedValueAt,
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
  /** AV-1211. The activity's elevation along it, with a cursor at the moment shown. */
  | 'elevationProfile'
  | 'sensorChart'
  | 'label'
  | 'summary'
  | 'date'
  /** AV-1011. A card, a frame or a rule behind or in front of the figures. */
  | 'shape'
  /** AV-1018. The heart rate or power zone the activity is in, as a bar, an arc or a figure. */
  | 'zones'
  /** AV-1019. A figure on an arc of ticks with a needle or a marker. */
  | 'dial'
  /** AV-1019. A figure against time or distance, with a cursor at the moment shown. */
  | 'chart'
  /** AV-1019. The slope in percent, with an up or down glyph and a colour by steepness. */
  | 'gradient'
  /** AV-1019. The direction of travel, as a rose that turns or a needle on a fixed rose. */
  | 'compass'
  /** AV-1021. The split under way and the ones that finished: the file's laps, or every kilometre or mile. */
  | 'splits';

export const OVERLAY_COMPONENT_TYPES: readonly OverlayComponentType[] = [
  'text',
  'gauge',
  'routeInset',
  'progress',
  'elevationProfile',
  'sensorChart',
  'label',
  'summary',
  'date',
  'shape',
  'zones',
  'dial',
  'chart',
  'gradient',
  'compass',
  'splits',
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
  /** `distance` only: the distance so far over the whole activity's, "12.40 / 42.20 km" (TD-080). */
  ofTotal?: boolean;
}

/** The text size a text, a figure for the whole activity or a date can take, as a multiple of the base. */
export const TEXT_SCALE_LIMITS = { min: 0.1, max: 10 } as const;

/** The most room, in frame widths, a figure may leave between its label and its value. */
export const FIGURE_GAP_MAX = 0.2;

/**
 * AV-1015 (TD-083). How a live figure's two lines are set apart: a label over
 * a value. Every member is optional and an absent one is today's look, so a
 * layout made before it draws the same pixels.
 */
export interface OverlayFigureSetting {
  /** Absent: shown. Off, only the value (and a gauge's track) is drawn. */
  showLabel?: boolean;
  /** Multiplies the label's 0.55 em; absent is 1. */
  labelScale?: number;
  /** Multiplies the value's 1.1 em; absent is 1. */
  valueScale?: number;
  /** `#rrggbb`; absent is the style's text colour. The value always takes the text colour. */
  labelColor?: string;
  /** Space between the label and the value, in frame widths; absent is 0.2 of the label's size. */
  gap?: number;
  /** Both lines; absent is left. */
  align?: TextAlign;
  /** The halo under the type on a clear background; absent is black at 0.8, opacity 0 is none. */
  halo?: { color: string; opacity: number };
}

/** AV-1018. What zones are measured on. Other bounded figures (pace) can join this later. */
export type ZonesSource = 'heartRate' | 'power';
export const ZONES_SOURCES: readonly ZonesSource[] = ['heartRate', 'power'];

/** AV-1018. One zone: its name, its colour (`#rrggbb`) and its lower bound. */
export interface OverlayZone {
  name: string;
  color: string;
  from: number;
}

export type ZonesShape = 'horizontal' | 'vertical' | 'arc' | 'figure';
export const ZONES_SHAPES: readonly ZonesShape[] = ['horizontal', 'vertical', 'arc', 'figure'];

/** AV-1018. The reader's own figures, in bpm and W. In memory for the session; in a layout file only when asked for (TD-086). */
export interface PersonalFigures {
  maxHeartRate?: number;
  ftp?: number;
}

/**
 * AV-1018 (TD-086). A zones component's zones and how they are drawn. The
 * bounds are in percent of the reader's figure (`basis: 'percent'`: maximum
 * heart rate, or FTP) or absolute bpm and W. `personal` is present only when
 * the reader chose to put their figures in the layout file.
 */
export interface OverlayZonesSetting {
  source: ZonesSource;
  basis: 'percent' | 'value';
  /** 2 to 10, ascending by `from`; the first is the floor, and anything under it counts in it. */
  zones: OverlayZone[];
  shape: ZonesShape;
  show: { number: boolean; name: boolean; value: boolean; timeInZone: boolean };
  personal?: PersonalFigures;
}

/** AV-1019 (TD-087). A dial's arc, ticks, pointer and colours. Colours are `#rrggbb`. */
export interface OverlayDialSetting {
  /** The arc's opening in degrees, 180 to 300, centred at the top. */
  sweep: number;
  /** A major tick every this much of the range, in the source's stored unit; absent finds a step for the range. */
  majorStep?: number;
  /** Minor ticks between two major ones, 0 to 9. */
  minorTicks: number;
  pointer: 'needle' | 'marker';
  trackColor: string;
  fillColor: string;
  needleColor: string;
}

/** AV-1019. What a chart is measured along: seconds of the activity, or metres along it. */
export type ChartAxis = 'time' | 'distance';
export const CHART_AXES: readonly ChartAxis[] = ['time', 'distance'];

/** The most a chart's window reaches either side of now: a day of seconds, or a thousand kilometres. */
export const CHART_WINDOW_MAX = 1_000_000;

/** AV-1019 (TD-087). A chart's axis, window, colours and labels. Colours are `#rrggbb`. */
export interface OverlayChartSetting {
  axis: ChartAxis;
  /** Seconds or metres either side of now, with the cursor in the middle; absent is the whole activity. */
  window?: number;
  lineColor: string;
  fillColor: string;
  /** 0..1. */
  fillOpacity: number;
  /** The y range's ends and the x window, written on the chart. */
  labels: boolean;
}

export const DEFAULT_CHART: OverlayChartSetting = {
  axis: 'time',
  lineColor: '#ffffff',
  fillColor: '#ffffff',
  fillOpacity: 0.25,
  labels: true,
};

/** AV-1019 (TD-087). A band of the gradient indicator: its colour from this grade up, in percent. */
export interface OverlayGradientBand {
  from: number;
  color: string;
}

export interface OverlayGradientSetting {
  /** 2 to 10, ascending by `from`; the first is the floor, and anything under it counts in it. */
  bands: OverlayGradientBand[];
  glyph: boolean;
}

/** AV-1019 (TD-087). A compass's style, whether it labels the cardinal points, and its colours. */
export interface OverlayCompassSetting {
  /** `rose`: the rose turns so the heading is up. `needle`: a fixed north-up rose with a needle along the heading. */
  style: 'rose' | 'needle';
  labels: boolean;
  roseColor: string;
  needleColor: string;
}

/** AV-1021. Where a splits component's splits come from, and which clock times them. */
export type SplitsSource = 'laps' | 'distance';
export type SplitsTime = 'moving' | 'elapsed';
export type SplitsRate = 'pace' | 'speed' | 'none';

/**
 * AV-1021 (TD-090). A splits component's source, clock, what it shows and its colours.
 * Colours are `#rrggbb`.
 */
export interface OverlaySplitsSetting {
  /** `laps` falls back to the distance where the file has no usable laps. */
  source: SplitsSource;
  /** `distance` source only: metres in each split; absent is a kilometre or a mile, by the component's units. */
  every?: number;
  /** Moving time holds through a stop; elapsed time runs (TD-080). */
  time: SplitsTime;
  /** The last finished split, with how it compares with the one before it. */
  showLast: boolean;
  /** How many finished splits are listed, newest first, 0 to 10. */
  list: number;
  /** Absent: pace for a run, the average speed otherwise. */
  rate?: SplitsRate;
  /** The last split and the list when a split was faster, and slower, by pace. */
  fasterColor: string;
  slowerColor: string;
}

/**
 * AV-1019. The types that read one moment of the activity and mean nothing
 * without it: a picture that shows none (the map image) leaves them out.
 */
export const MOMENT_COMPONENT_TYPES: readonly OverlayComponentType[] = ['zones', 'dial', 'chart', 'gradient', 'compass', 'splits'];

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
/** AV-1207 added `climb`, the elevation gain, for the map video's summary card. */
export type SummaryStatKey = 'speed' | 'pace' | 'distance' | 'elapsed' | 'moving' | 'climb';
export const SUMMARY_STAT_KEYS: readonly SummaryStatKey[] = ['speed', 'pace', 'distance', 'elapsed', 'moving', 'climb'];

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
  /** Absent for `routeInset`, `progress` and `elevationProfile`, which read the sample's position and progress. */
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
  /** AV-1015. A live figure's label and value, styled apart. */
  figure?: OverlayFigureSetting;
  /**
   * AV-1016 (TD-084). A live figure or gauge shows the trailing mean of its
   * value over this many seconds, 0 to 30. Absent is off, as 0 is.
   */
  smoothing?: { windowSeconds: number };
  /** AV-1018. `zones`: the zones and how they are drawn. `source` is the zones' source. */
  zones?: OverlayZonesSetting;
  /** AV-1019. `dial`: the arc, the ticks, the pointer and the colours. The range is `range`. */
  dial?: OverlayDialSetting;
  /** AV-1019. `chart`: the axis, the window, the colours and the labels. */
  chart?: OverlayChartSetting;
  /** AV-1019. `gradient`: the colour bands and the glyph. The source is always the grade. */
  gradient?: OverlayGradientSetting;
  /** AV-1019. `compass`: the style, the labels and the colours. The source is always the heading. */
  compass?: OverlayCompassSetting;
  /** AV-1021. `splits`: the source, the clock, what is shown and the colours. No data source: it reads the activity's laps and distance. */
  splits?: OverlaySplitsSetting;
}

export interface OverlayTemplate {
  version: typeof OVERLAY_TEMPLATE_VERSION;
  name: string;
  style: OverlayStyle;
  components: OverlayComponent[];
  /**
   * AV-1022 (TD-091). The share of the route's distance hidden from each end, from everything
   * drawn of where the activity went. Absent when nothing is hidden: a layout without one opens with none.
   */
  privacyTrim?: PrivacyTrim;
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
  // AV-1019. A gradient indicator always reads the grade and a compass the heading, whatever the file says.
  const fixedSource: OverlayDataSource | undefined =
    componentType === 'gradient' ? { kind: 'metric', metric: 'grade' } : componentType === 'compass' ? { kind: 'metric', metric: 'heading' } : undefined;
  const needsSource =
    componentType !== 'routeInset' &&
    componentType !== 'gradient' &&
    componentType !== 'compass' &&
    componentType !== 'splits' &&
    componentType !== 'progress' &&
    componentType !== 'elevationProfile' &&
    componentType !== 'shape' &&
    !stillOnly;
  if (componentType === 'shape') {
    const kind = isRecord(value.shape) ? value.shape.kind : undefined;
    if (!SHAPE_KINDS.includes(kind as ShapeKind)) return `unknown shape "${String(kind)}"`;
  }
  let source = fixedSource ?? parseSource(value.source);
  // AV-1018. Zones read heart rate or power, and the zones' own source is the one that counts: they are measured on it.
  const zones = componentType === 'zones' && isRecord(value.zones) ? parseZonesSetting(value.zones) : undefined;
  if (componentType === 'zones') {
    if (zones) source = { kind: 'metric', metric: zones.source };
    else if (!(source?.kind === 'metric' && (source.metric === 'heartRate' || source.metric === 'power'))) {
      return 'missing or invalid data source';
    }
  }
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
  if ((needsSource || fixedSource) && source) component.source = source;
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
    if (value.display.ofTotal === true) display.ofTotal = true;
    if (display.label !== undefined || display.decimals !== undefined || display.ofTotal) component.display = display;
  }
  // AV-1018. Zones that cannot be read are dropped, and the component stays, drawn as nothing (TD-086): the editor offers the defaults.
  if (zones) component.zones = zones;
  // AV-1019. A dial, a chart, a gradient indicator and a compass carry their own settings, each read as it may be drawn and by its defaults where it cannot be.
  if (componentType === 'dial') component.dial = parseDialSetting(value.dial);
  if (componentType === 'chart') component.chart = parseChartSetting(value.chart);
  if (componentType === 'gradient') component.gradient = parseGradientSetting(value.gradient);
  if (componentType === 'compass') component.compass = parseCompassSetting(value.compass);
  if (componentType === 'splits') component.splits = parseSplitsSettings(value.splits);
  if (LABELLED_TYPES.includes(componentType) && isRecord(value.figure)) {
    const figure = parseFigure(value.figure);
    if (figure) component.figure = figure;
  }
  if (SMOOTHED_TYPES.includes(componentType) && isRecord(value.smoothing) && canSmooth(source)) {
    const seconds = value.smoothing.windowSeconds;
    if (isNumber(seconds) && seconds > 0) {
      component.smoothing = { windowSeconds: Math.min(SMOOTHING_LIMITS.max, seconds) };
    }
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
const HEX6 = /^#[0-9a-f]{6}$/i;

/** The types that style a label over a value (AV-1015), and the ones whose value may be smoothed (AV-1016). */
const LABELLED_TYPES: readonly OverlayComponentType[] = ['text', 'gauge', 'zones', 'dial', 'chart', 'gradient', 'compass', 'splits'];
const SMOOTHED_TYPES: readonly OverlayComponentType[] = ['text', 'gauge', 'zones', 'dial', 'gradient', 'compass'];

const hex6 = (value: unknown, fallback: string): string => (typeof value === 'string' && HEX6.test(value) ? value.toLowerCase() : fallback);

/**
 * AV-1019 (TD-087). A dial's settings as they may be drawn: the sweep and the
 * minor ticks kept inside their limits, a major step that is a positive number
 * or left to the range, the pointer and the colours by their defaults where they
 * do not read. Nothing here throws on any input.
 */
export function parseDialSetting(raw: unknown): OverlayDialSetting {
  const record = isRecord(raw) ? raw : {};
  const dial: OverlayDialSetting = {
    sweep: isNumber(record.sweep) ? Math.min(DIAL_LIMITS.sweep.max, Math.max(DIAL_LIMITS.sweep.min, record.sweep)) : DEFAULT_DIAL.sweep,
    minorTicks: isNumber(record.minorTicks)
      ? Math.min(DIAL_LIMITS.minorTicks.max, Math.max(DIAL_LIMITS.minorTicks.min, Math.round(record.minorTicks)))
      : DEFAULT_DIAL.minorTicks,
    pointer: record.pointer === 'marker' ? 'marker' : 'needle',
    trackColor: hex6(record.trackColor, DEFAULT_DIAL.trackColor),
    fillColor: hex6(record.fillColor, DEFAULT_DIAL.fillColor),
    needleColor: hex6(record.needleColor, DEFAULT_DIAL.needleColor),
  };
  if (isNumber(record.majorStep) && record.majorStep > 0) dial.majorStep = record.majorStep;
  return dial;
}

/** AV-1019 (TD-087). A chart's settings as they may be drawn; the window is a positive number up to a million or absent (the whole activity). */
export function parseChartSetting(raw: unknown): OverlayChartSetting {
  const record = isRecord(raw) ? raw : {};
  const chart: OverlayChartSetting = {
    axis: record.axis === 'distance' ? 'distance' : 'time',
    lineColor: hex6(record.lineColor, DEFAULT_CHART.lineColor),
    fillColor: hex6(record.fillColor, DEFAULT_CHART.fillColor),
    fillOpacity: isNumber(record.fillOpacity) ? clamp01(record.fillOpacity) : DEFAULT_CHART.fillOpacity,
    labels: record.labels === undefined ? DEFAULT_CHART.labels : record.labels === true,
  };
  if (isNumber(record.window) && record.window > 0) chart.window = Math.min(CHART_WINDOW_MAX, record.window);
  return chart;
}

/**
 * AV-1019 (TD-087). A gradient indicator's settings: the bands as they are when
 * there are two to ten, each with a start inside the scale and a `#rrggbb`
 * colour, and the starts rise; the default bands otherwise, as a set (a band
 * mended in a set of nine would be a scale nobody chose).
 */
export function parseGradientSetting(raw: unknown): OverlayGradientSetting {
  const record = isRecord(raw) ? raw : {};
  const glyph = record.glyph !== false;
  const entries = Array.isArray(record.bands) ? record.bands : [];
  const bands: OverlayGradientBand[] = [];
  let valid = entries.length >= GRADIENT_BAND_LIMITS.min && entries.length <= GRADIENT_BAND_LIMITS.max;
  for (const entry of valid ? entries : []) {
    if (!isRecord(entry) || !isNumber(entry.from) || typeof entry.color !== 'string' || !HEX6.test(entry.color)) {
      valid = false;
      break;
    }
    const from = Math.min(GRADIENT_FROM_LIMITS.max, Math.max(GRADIENT_FROM_LIMITS.min, entry.from));
    if (bands.length > 0 && !(from > bands[bands.length - 1]!.from)) {
      valid = false;
      break;
    }
    bands.push({ from, color: entry.color.toLowerCase() });
  }
  return { bands: valid ? bands : DEFAULT_GRADIENT.bands.map((band) => ({ ...band })), glyph };
}

/** AV-1019 (TD-087). A compass's settings, by their defaults where they do not read. */
export function parseCompassSetting(raw: unknown): OverlayCompassSetting {
  const record = isRecord(raw) ? raw : {};
  return {
    style: record.style === 'needle' ? 'needle' : 'rose',
    labels: record.labels !== false,
    roseColor: hex6(record.roseColor, DEFAULT_COMPASS.roseColor),
    needleColor: hex6(record.needleColor, DEFAULT_COMPASS.needleColor),
  };
}

/**
 * AV-1021 (TD-090). A splits component's settings as they may be drawn, by their
 * defaults where they do not read: the source and the clock one of their two, the
 * list a whole number from 0 to 10, a distance kept inside 0.1 km to 100 mi (in
 * metres) or absent, the rate one of three or absent, the colours `#rrggbb`.
 * Nothing here throws on any input.
 */
export function parseSplitsSettings(raw: unknown): OverlaySplitsSetting {
  const record = isRecord(raw) ? raw : {};
  const setting: OverlaySplitsSetting = {
    source: record.source === 'distance' ? 'distance' : 'laps',
    time: record.time === 'elapsed' ? 'elapsed' : 'moving',
    showLast: record.showLast === undefined ? DEFAULT_SPLITS.showLast : record.showLast === true,
    list: isNumber(record.list) ? Math.min(SPLITS_LIST_LIMITS.max, Math.max(SPLITS_LIST_LIMITS.min, Math.round(record.list))) : DEFAULT_SPLITS.list,
    fasterColor: hex6(record.fasterColor, DEFAULT_SPLITS.fasterColor),
    slowerColor: hex6(record.slowerColor, DEFAULT_SPLITS.slowerColor),
  };
  if (isNumber(record.every) && record.every > 0) setting.every = Math.min(SPLITS_EVERY_METERS.max, Math.max(SPLITS_EVERY_METERS.min, record.every));
  if (record.rate === 'pace' || record.rate === 'speed' || record.rate === 'none') setting.rate = record.rate;
  return setting;
}

/** AV-1015. A figure's settings, each kept only when it reads; `undefined` when none does. */
function parseFigure(raw: Record<string, unknown>): OverlayFigureSetting | undefined {
  const figure: OverlayFigureSetting = {};
  const scale = (value: unknown) =>
    isNumber(value) && value > 0 ? Math.min(TEXT_SCALE_LIMITS.max, Math.max(TEXT_SCALE_LIMITS.min, value)) : undefined;
  if (raw.showLabel === false) figure.showLabel = false;
  const labelScale = scale(raw.labelScale);
  if (labelScale !== undefined) figure.labelScale = labelScale;
  const valueScale = scale(raw.valueScale);
  if (valueScale !== undefined) figure.valueScale = valueScale;
  if (typeof raw.labelColor === 'string' && HEX6.test(raw.labelColor)) figure.labelColor = raw.labelColor.toLowerCase();
  if (isNumber(raw.gap) && raw.gap >= 0) figure.gap = Math.min(FIGURE_GAP_MAX, raw.gap);
  if (raw.align === 'left' || raw.align === 'center' || raw.align === 'right') figure.align = raw.align;
  if (isRecord(raw.halo) && typeof raw.halo.color === 'string' && HEX6.test(raw.halo.color) && isNumber(raw.halo.opacity)) {
    figure.halo = { color: raw.halo.color.toLowerCase(), opacity: clamp01(raw.halo.opacity) };
  }
  return Object.keys(figure).length > 0 ? figure : undefined;
}

// eslint-disable-next-line no-control-regex
const SAFE_NAME = /[\u0000-\u001F\u007F]/g;

/**
 * AV-1018 (TD-086). A zones setting as it may be drawn, or `undefined` when it
 * cannot be: not 2 to 10 zones, a bound that is not a number or does not rise,
 * or a source that is not heart rate or power. Names are one short line,
 * colours `#rrggbb`, bounds kept inside their limits, the shape and what is
 * shown by their defaults where unknown, and the personal figures inside
 * theirs. Nothing here throws on any input.
 */
export function parseZonesSetting(raw: Record<string, unknown>): OverlayZonesSetting | undefined {
  const source = raw.source;
  if (source !== 'heartRate' && source !== 'power') return undefined;
  const basis = raw.basis === 'value' ? 'value' : 'percent';
  if (!Array.isArray(raw.zones) || raw.zones.length < ZONE_LIMITS.min || raw.zones.length > ZONE_LIMITS.max) return undefined;
  const zones: OverlayZone[] = [];
  for (const entry of raw.zones) {
    if (!isRecord(entry) || !isNumber(entry.from)) return undefined;
    const from = Math.min(ZONE_FROM_MAX[basis], Math.max(0, entry.from));
    if (zones.length > 0 && !(from > zones[zones.length - 1]!.from)) return undefined;
    const name = typeof entry.name === 'string' ? entry.name.replace(SAFE_NAME, '').trim().slice(0, ZONE_NAME_MAX) : '';
    const color = typeof entry.color === 'string' && HEX6.test(entry.color) ? entry.color.toLowerCase() : '#ffffff';
    zones.push({ name, color, from });
  }
  const show = isRecord(raw.show) ? raw.show : {};
  const setting: OverlayZonesSetting = {
    source,
    basis,
    zones,
    shape: ZONES_SHAPES.includes(raw.shape as ZonesShape) ? (raw.shape as ZonesShape) : 'horizontal',
    show: {
      number: show.number !== false,
      name: show.name !== false,
      value: show.value !== false,
      timeInZone: show.timeInZone === true,
    },
  };
  if (isRecord(raw.personal)) {
    const personal = cleanPersonal(raw.personal);
    if (Object.keys(personal).length > 0) setting.personal = personal;
  }
  return setting;
}

/**
 * AV-1018 (TD-086). The components as a layout file may hold them: no zones
 * component carries the reader's figures unless `include` is given, and then
 * each carries the ones it is measured with (the session's, else what it
 * already held), so the file holds them only because the reader asked.
 * Everything else is returned as it is; nothing is mutated.
 */
export function componentsForLayoutFile(
  components: OverlayComponent[],
  options: { include: boolean; session?: PersonalFigures },
): OverlayComponent[] {
  return components.map((component) => {
    if (!component.zones) return component;
    const { personal: held, ...rest } = component.zones;
    const effective = effectivePersonal(options.session, { personal: held });
    const zones: OverlayZonesSetting = options.include && Object.keys(effective).length > 0 ? { ...rest, personal: effective } : rest;
    return { ...component, zones };
  });
}

/** AV-1018. The figures a set of components holds from a layout file, the first of each kind found; empty when none. */
export function personalHeldBy(components: OverlayComponent[]): PersonalFigures {
  const held: PersonalFigures = {};
  for (const component of components) {
    const personal = component.zones?.personal;
    if (personal?.maxHeartRate !== undefined) held.maxHeartRate ??= personal.maxHeartRate;
    if (personal?.ftp !== undefined) held.ftp ??= personal.ftp;
  }
  return held;
}

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

/** The `privacyTrim` of a parsed template: clamped, and absent when it hides nothing. */
const privacyTrimField = (raw: unknown): { privacyTrim?: PrivacyTrim } => {
  const privacyTrim = readPrivacyTrim(raw);
  return privacyTrim ? { privacyTrim } : {};
};

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
      ...privacyTrimField(raw.privacyTrim),
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
    if (component.visible && component.type === 'splits') {
      // AV-1021. Splits read no source: they need a clock, and laps or a distance to cut it by.
      const sources = timeline.splitSources;
      const reason = splitsUnavailableReason(timeline.unavailable !== undefined, sources) ?? (splitsSourceOf((component.splits ?? DEFAULT_SPLITS).source, sources) ? undefined : SPLITS_NO_DISTANCE);
      if (reason) warnings.push({ componentId: component.id, source: 'splits', message: `${reason} The splits are not shown.` });
      continue;
    }
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
  climb: 'Climb so far',
  heading: 'Heading',
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
      reason:
        | 'disabled'
        | 'no_data'
        | 'no_position'
        | 'still_image_only'
        /** AV-1018. Zones measured in percent of a figure the reader has not entered. */
        | 'needs_reference'
        /** AV-1018. A zones component whose zones could not be read. */
        | 'no_zones';
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
      /** AV-1019. A dial, a gradient indicator or a compass: the value shown, smoothed where it is set to be, in the stored unit. */
      value?: number;
      /** AV-1019. A dial: the range its fraction is of, the component's own or the activity's rounded to a step. */
      range?: { min: number; max: number };
      /** AV-1020. A dial: the unit system its ticks are numbered in (the component's own, else the reader's). */
      unitSystem?: UnitSystem;
      /** AV-1018. `zones`: where the value falls among the zones. */
      zones?: ResolvedZones;
      /** AV-1021. `splits`: the setting, where its splits come from here, and the units it is written in. */
      splits?: ResolvedSplits;
    };

/** AV-1021. A splits component here: its setting, and the source it really reads (the laps' fall back to the distance). */
export interface ResolvedSplits {
  setting: OverlaySplitsSetting;
  source: SplitsSource;
  unitSystem: UnitSystem;
}

/**
 * AV-1018. A zones component at one moment: the value (smoothed where it is
 * set to be), its zone and the zones' bounds, in bpm or W.
 */
export interface ResolvedZones {
  setting: OverlayZonesSetting;
  value: number;
  unit: 'bpm' | 'W';
  /** 0-based. */
  index: number;
  /** Lower bounds in the value's own unit, one per zone, ascending. */
  bounds: number[];
  /** Where in its zone the value is, 0..1. */
  within: number;
}

/** The unit system a component is shown in: its own choice, else the reader's. */
export function effectiveUnits(component: OverlayComponent, units: UnitSystem): UnitSystem {
  return component.unitMode === 'auto' ? units : component.unitMode;
}

function formatMetric(metric: OverlayMetricKey, value: number, units: UnitSystem): string {
  switch (metric) {
    case 'speed':
      return formatSpeed(value, units);
    case 'pace':
      // Standing still (TD-080).
      return value > 0 ? formatPace(value, units) : `0:00 ${paceUnitLabel(units)}`;
    case 'distance':
      return formatDistance(value, units);
    case 'elevation':
    case 'climb':
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
    case 'heading':
      return formatHeading(value);
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
    case 'climb':
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
    case 'heading':
      // Times and pace are clocks, and a heading is degrees and a letter (AV-1019), whatever the decimals.
      return formatMetric(metric, value, units);
  }
}

/**
 * TD-080. The distance so far over the whole, "12.40 / 42.20 km": both in the
 * unit the whole is written in, so the two read against each other.
 */
export function distanceOfTotal(meters: number, totalMeters: number, units: UnitSystem, decimals?: 0 | 1 | 2): string {
  if (decimals !== undefined) {
    const [done] = formatMetricWith('distance', meters, units, decimals).split(' ');
    return `${done} / ${formatMetricWith('distance', totalMeters, units, decimals)}`;
  }
  const [done] = formatDistanceOnScale(meters, totalMeters, units).split(' ');
  return `${done} / ${formatDistanceOnScale(totalMeters, totalMeters, units)}`;
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
  /** AV-1018. The reader's own figures for this session: the zones' reference. Never read from anywhere else. */
  personal?: PersonalFigures,
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
  if (component.type === 'elevationProfile') {
    return sample.progress === undefined || !timeline.available.has('metric:elevation')
      ? { status: 'hidden', reason: 'no_data', componentId }
      : { status: 'ready', componentId, component, style, fraction: sample.progress };
  }
  if (component.type === 'chart') {
    // AV-1019. A chart is drawn from the source's whole series and the sample's place on it; only a source with no values, or a distance axis with no distance, leaves it nothing to draw.
    const chartSource = component.source;
    const axis = (component.chart ?? DEFAULT_CHART).axis;
    if (!chartSource || !timeline.available.has(dataSourceId(chartSource)) || (axis === 'distance' && !timeline.available.has('metric:distance'))) {
      return { status: 'hidden', reason: 'no_data', componentId };
    }
    return {
      status: 'ready',
      componentId,
      component,
      style,
      label: component.display?.label?.trim() || describeSource(chartSource, timeline),
      fraction: sample.progress,
    };
  }
  if (component.type === 'splits') {
    // AV-1021. Splits read the activity's laps and distance, not a source of the sample; with neither there is nothing to count.
    const setting = component.splits ?? DEFAULT_SPLITS;
    const splitsSource = splitsSourceOf(setting.source, timeline.splitSources);
    if (!splitsSource) return { status: 'hidden', reason: 'no_data', componentId };
    return { status: 'ready', componentId, component, style, label: component.display?.label?.trim() || 'Split', splits: { setting, source: splitsSource, unitSystem } };
  }
  if (component.type === 'progress') {
    return sample.progress === undefined
      ? { status: 'hidden', reason: 'no_data', componentId }
      : { status: 'ready', componentId, component, style, fraction: sample.progress };
  }

  const source = component.source;
  const value = source ? sample.values[dataSourceId(source)] : undefined;
  if (!source || value === undefined) return { status: 'hidden', reason: 'no_data', componentId };

  // AV-1016. What a smoothed figure shows is the trailing mean up to this moment; hiding stays by the moment's own value.
  const windowSeconds = component.smoothing?.windowSeconds;
  const shown = (windowSeconds ? smoothedValueAt(timeline, source, sample.videoTimeSeconds, windowSeconds) : undefined) ?? value;
  const label = component.display?.label?.trim() || describeSource(source, timeline);
  if (component.type === 'zones') {
    // AV-1018. A set that cannot be read, or that needs a figure the reader has not given, draws nothing.
    const setting = component.zones;
    if (!setting || source.kind !== 'metric' || source.metric !== setting.source) return { status: 'hidden', reason: 'no_zones', componentId };
    const bounds = zoneBounds(setting, effectivePersonal(personal, setting));
    if (!bounds) return { status: 'hidden', reason: 'needs_reference', componentId };
    const index = zoneIndex(shown, bounds);
    return {
      status: 'ready',
      componentId,
      component,
      style,
      label,
      text: formatMetric(source.metric, shown, unitSystem),
      zones: { setting, value: shown, unit: ZONES_UNIT[setting.source], index, bounds, within: withinZone(shown, index, bounds) },
    };
  }
  const total = timeline.distanceTotalMeters;
  const text =
    source.kind === 'metric' && source.metric === 'distance' && component.display?.ofTotal && total !== undefined
      ? distanceOfTotal(shown, total, unitSystem, component.display.decimals)
      : formatSourceValue(source, shown, unitSystem, timeline, component.display?.decimals);

  let fraction: number | undefined;
  if (component.type === 'gauge' && component.range) {
    const { min, max } = component.range;
    fraction = clamp01((shown - min) / (max - min));
  }
  if (component.type === 'dial') {
    // AV-1019. The range the reader set, or the activity's own rounded to a step; a value beyond it pins at its end.
    const range = component.range ?? activityRange(timeline, source, unitSystem);
    if (!range) return { status: 'hidden', reason: 'no_data', componentId };
    return { status: 'ready', componentId, component, style, label, text, fraction: rangeFraction(shown, range), value: shown, range, unitSystem };
  }
  if (component.type === 'gradient' || component.type === 'compass') {
    return { status: 'ready', componentId, component, style, label, text, value: shown };
  }
  return { status: 'ready', componentId, component, style, label, text, fraction };
}

/**
 * A value as a figure writes it, in the unit system and with the decimals chosen:
 * a metric by its own rule, a camera stream in its own unit. AV-1019 shares it with
 * the chart's labels, so an axis reads as the figure does.
 */
export function formatSourceValue(
  source: OverlayDataSource,
  value: number,
  units: UnitSystem,
  timeline: Pick<OverlayTimeline, 'sensorLabels'>,
  decimals?: 0 | 1 | 2,
): string {
  if (source.kind === 'metric') {
    return decimals !== undefined ? formatMetricWith(source.metric, value, units, decimals) : formatMetric(source.metric, value, units);
  }
  const unit = timeline.sensorLabels.get(dataSourceId(source))?.unit;
  return `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ''}`;
}
