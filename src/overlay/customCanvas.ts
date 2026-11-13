import {
  BASE_FONT_CQW,
  DEFAULT_OVERLAY_CONTROLS,
  TILE_WIDTH_EMS,
  buildOverlay,
  type OverlayPresetId,
} from './presets';
import { figureLayout } from './figureLayout';
import { stillElementChoices, newStillComponent, freshComponentId, type StillImageContext } from './staticImage';
import {
  DEFAULT_CHART,
  DEFAULT_OVERLAY_STYLE,
  DEFAULT_SHAPE,
  OVERLAY_TEMPLATE_VERSION,
  TEXT_SCALE_LIMITS,
  normalizeRect,
  resolveOverlayComponent,
  type OverlayComponent,
  type OverlayRect,
  type OverlayTemplate,
  type ShapeKind,
  type ZonesSource,
} from './template';
import { DEFAULT_ZONES_SMOOTHING_SECONDS, defaultZonesSetting } from './zones';
import { dataSourceId, type OverlayMetricKey, type OverlayTimeline } from './timeline';
import { DEFAULT_DIAL, activityRange } from './dial';
import { DEFAULT_GRADIENT } from './gradient';
import { DEFAULT_COMPASS } from './compass';
import { ELEVATION_MISSING, METRIC_MISSING, NO_ROUTE } from './missingData';
import { PREDEFINED_ENTRIES, predefinedAvailability, predefinedEntry, type StartLayoutId, componentsFromSportLayout } from './predefined';
import type { MeasureText } from './staticImage';
import type { UnitSystem } from '../domain/units';

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
  /** AV-1018. A zones component, with its source's default zones. */
  | 'zones:heartRate'
  | 'zones:power'
  /** AV-1019. A dial of a metric, with the activity's own range. */
  | `dial:${DialMetric}`
  /** AV-1019. A chart of a metric against time (against distance for the elevation). */
  | `chart:${ChartMetric}`
  | 'gradient'
  | 'compass'
  | 'route'
  | 'progress'
  | 'elevationProfile'
  | `still:${string}`
  | `shape:${ShapeKind}`
  /** AV-1016. An entry of the registry of predefined components, by its id. */
  | `predefined:${string}`;

/** AV-1019. The figures the Add list offers a dial and a chart of. A dial or a chart in a layout file may read any source. */
export const DIAL_METRICS = ['speed', 'pace', 'heartRate', 'power', 'cyclingCadence', 'runningCadence'] as const;
export const CHART_METRICS = ['speed', 'pace', 'heartRate', 'power', 'cyclingCadence', 'runningCadence', 'elevation', 'grade', 'temperature'] as const;
type DialMetric = (typeof DIAL_METRICS)[number];
type ChartMetric = (typeof CHART_METRICS)[number];
const FIGURE_NAMES: Record<OverlayMetricKey, string> = {
  speed: 'Speed',
  pace: 'Pace',
  distance: 'Distance',
  elapsed: 'Elapsed time',
  moving: 'Moving time',
  elevation: 'Elevation',
  heartRate: 'Heart rate',
  power: 'Power',
  cyclingCadence: 'Cycling cadence',
  runningCadence: 'Running cadence',
  temperature: 'Temperature',
  grade: 'Grade',
  climb: 'Climb so far',
  heading: 'Heading',
};

export interface CanvasElementChoice {
  key: CanvasElementKey;
  label: string;
  group: 'Live figures' | 'Along the route' | 'Whole activity' | 'Shapes' | 'Cycling' | 'Running' | 'Any sport';
  available: boolean;
  reason?: string;
}

export { ELEVATION_MISSING };

const LIVE_FIGURES: readonly { metric: OverlayMetricKey; label: string; missing: string }[] = (
  [
    ['speed', 'Speed'],
    ['pace', 'Pace'],
    ['distance', 'Distance'],
    ['elapsed', 'Elapsed time'],
    ['moving', 'Moving time'],
    ['elevation', 'Elevation'],
    // AV-1016. The elevation gained so far.
    ['climb', 'Climb so far'],
    // AV-1019. The direction of travel, as a figure; the compass draws it.
    ['heading', 'Heading'],
    ['heartRate', 'Heart rate'],
    ['power', 'Power'],
    ['cyclingCadence', 'Cycling cadence'],
    ['runningCadence', 'Running cadence'],
  ] as const
).map(([metric, label]) => ({ metric, label, missing: METRIC_MISSING[metric] }));

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
      ...(!timeline.unavailable && timeline.hasRoute ? {} : { reason: NO_ROUTE }),
    },
    // AV-1018. Zones, in the sport's own defaults; their reference is asked for in the editor.
    { key: 'zones:heartRate', label: 'Heart rate zones', group: 'Live figures', available: has('metric:heartRate'), ...(has('metric:heartRate') ? {} : { reason: METRIC_MISSING.heartRate }) },
    { key: 'zones:power', label: 'Power zones', group: 'Live figures', available: has('metric:power'), ...(has('metric:power') ? {} : { reason: METRIC_MISSING.power }) },
    // AV-1019. Dials, charts, the gradient indicator and the compass, each for what the activity has.
    ...DIAL_METRICS.map((metric): CanvasElementChoice => ({
      key: `dial:${metric}`,
      label: `${FIGURE_NAMES[metric]} dial`,
      group: 'Live figures',
      available: has(`metric:${metric}`),
      ...(has(`metric:${metric}`) ? {} : { reason: METRIC_MISSING[metric] }),
    })),
    ...CHART_METRICS.map((metric): CanvasElementChoice => ({
      key: `chart:${metric}`,
      label: `${FIGURE_NAMES[metric]} chart`,
      group: 'Live figures',
      available: has(`metric:${metric}`),
      ...(has(`metric:${metric}`) ? {} : { reason: METRIC_MISSING[metric] }),
    })),
    { key: 'gradient', label: 'Gradient indicator', group: 'Live figures', available: has('metric:grade'), ...(has('metric:grade') ? {} : { reason: METRIC_MISSING.grade }) },
    { key: 'compass', label: 'Compass', group: 'Live figures', available: has('metric:heading'), ...(has('metric:heading') ? {} : { reason: METRIC_MISSING.heading }) },
    { key: 'progress', label: 'Progress bar', group: 'Live figures', available: !timeline.unavailable },
    {
      key: 'elevationProfile',
      label: 'Elevation profile',
      group: 'Live figures',
      available: has('metric:elevation'),
      ...(has('metric:elevation') ? {} : { reason: ELEVATION_MISSING }),
    },
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
  // AV-1016. The registry's entries, by sport; the editor only reads this list, so a sport is added in the registry.
  const predefined: CanvasElementChoice[] = PREDEFINED_ENTRIES.map((entry) => {
    const available = predefinedAvailability(entry, timeline);
    return {
      key: `predefined:${entry.id}`,
      label: entry.name,
      group: SPORT_GROUPS[entry.sport],
      available,
      ...(available ? {} : { reason: entry.missing }),
    };
  });
  // A predefined entry named as a plain element is told apart by its sport, so every option reads differently.
  const others = new Set([...live, ...gauges, ...whole, ...shapes].map((choice) => choice.label));
  const names = predefined.map((choice) => choice.label);
  const told = predefined.map((choice, index) =>
    others.has(choice.label) || names.indexOf(choice.label) !== index || names.lastIndexOf(choice.label) !== index
      ? { ...choice, label: `${choice.label} (${choice.group})` }
      : choice,
  );
  return [...live, ...gauges, ...told, ...whole, ...shapes];
}

const SPORT_GROUPS = { cycling: 'Cycling', running: 'Running', any: 'Any sport' } as const;

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
  units: UnitSystem = 'metric',
): OverlayComponent {
  if (key.startsWith('predefined:')) {
    const entry = predefinedEntry(key.slice('predefined:'.length));
    const built = entry?.build(template, size, timeline, units)[0];
    if (!built) throw new Error(`No predefined component "${key}".`);
    return built;
  }
  const aspect = size.width / size.height;
  const tileW = Math.min(0.3, (BASE_FONT_CQW / 100) * TILE_WIDTH_EMS);
  const tileH = Math.min(0.2, 0.075 * aspect);
  const at = (width: number, height: number): OverlayRect => normalizeRect({ x: 0.04, y: 0.04, width, height });
  const base = { visible: true, unitMode: 'auto' as const, style: {} };

  if (key.startsWith('still:')) {
    const component = newStillComponent(template, key.slice('still:'.length) as never, size);
    return { ...component, style: { ...component.style, fontScale: 1.5 } };
  }
  if (key === 'zones:heartRate' || key === 'zones:power') {
    return newZonesComponent(template, key === 'zones:heartRate' ? 'heartRate' : 'power', size);
  }
  if (key.startsWith('dial:')) return newDialComponent(template, key.slice('dial:'.length) as OverlayMetricKey, size, timeline, units);
  if (key.startsWith('chart:')) return newChartComponent(template, key.slice('chart:'.length) as OverlayMetricKey, size, timeline);
  if (key === 'gradient') return newGradientComponent(template, size);
  if (key === 'compass') return newCompassComponent(template, size);
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
  if (key === 'elevationProfile') {
    // A strip, four times as wide as it is tall on the frame, whatever the frame's shape.
    const width = Math.min(0.4, 0.4 / aspect);
    return { ...base, id: freshComponentId(template, 'elevation-profile'), type: 'elevationProfile', rect: at(width, (width * aspect) / 4) };
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

/**
 * AV-1018 (TD-086). A zones component for a source: its default zones as a
 * horizontal bar with the zone and the value above it, power smoothed over 3 s.
 * It starts a wide strip in the top-left, sized for the header and the bar.
 */
export function newZonesComponent(
  template: OverlayTemplate,
  source: ZonesSource,
  size: { width: number; height: number },
): OverlayComponent {
  const aspect = size.width / size.height;
  const component: OverlayComponent = {
    id: freshComponentId(template, `${source === 'heartRate' ? 'heart-rate' : 'power'}-zones`),
    type: 'zones',
    visible: true,
    unitMode: 'auto',
    style: {},
    rect: normalizeRect({ x: 0.04, y: 0.04, width: 0.34, height: Math.min(0.5, 0.09 * aspect) }),
    source: { kind: 'metric', metric: source },
    zones: defaultZonesSetting(source),
  };
  const seconds = DEFAULT_ZONES_SMOOTHING_SECONDS[source];
  if (seconds > 0) component.smoothing = { windowSeconds: seconds };
  return component;
}

/**
 * AV-1019 (TD-087). A dial of a metric: a square in the top-left, with the
 * range of the activity's own values rounded to a step, falling back to the
 * speed gauge's rule for speed (or a heart rate's usual 50 to 200) where the
 * activity gives none, and the default arc, ticks and colours.
 */
export function newDialComponent(
  template: OverlayTemplate,
  metric: OverlayMetricKey,
  size: { width: number; height: number },
  timeline: OverlayTimeline,
  units: UnitSystem = 'metric',
): OverlayComponent {
  const aspect = size.width / size.height;
  const side = Math.min(0.3, 0.3 / aspect);
  const source = { kind: 'metric' as const, metric };
  return {
    id: freshComponentId(template, `${metric}-dial`),
    type: 'dial',
    visible: true,
    unitMode: 'auto',
    style: {},
    rect: normalizeRect({ x: 0.04, y: 0.04, width: side, height: side * aspect }),
    source,
    range: activityRange(timeline, source, units) ?? (metric === 'heartRate' ? HEART_RATE_RANGE : { min: 0, max: metric === 'speed' ? speedRangeOf(timeline) : 100 }),
    dial: { ...DEFAULT_DIAL },
  };
}

/**
 * AV-1019 (TD-087). A chart of a metric against time, or against distance for
 * elevation where the activity has one (the profile's own axis): a strip in the
 * top-left over the whole activity, with axis labels on.
 */
export function newChartComponent(
  template: OverlayTemplate,
  metric: OverlayMetricKey,
  size: { width: number; height: number },
  timeline: OverlayTimeline,
): OverlayComponent {
  const aspect = size.width / size.height;
  const width = Math.min(0.4, 0.4 / aspect);
  return {
    id: freshComponentId(template, `${metric}-chart`),
    type: 'chart',
    visible: true,
    unitMode: 'auto',
    style: {},
    rect: normalizeRect({ x: 0.04, y: 0.04, width, height: (width * aspect) / 3 }),
    source: { kind: 'metric', metric },
    chart: { ...DEFAULT_CHART, axis: metric === 'elevation' && timeline.available.has('metric:distance') ? 'distance' : 'time' },
  };
}

/** AV-1019 (TD-087). The gradient indicator: a tile with the default bands and a glyph, the grade smoothed over 5 s (it is noisy from GPS). */
export function newGradientComponent(template: OverlayTemplate, size: { width: number; height: number }): OverlayComponent {
  const aspect = size.width / size.height;
  const tileW = Math.min(0.3, (BASE_FONT_CQW / 100) * TILE_WIDTH_EMS * 1.3);
  return {
    id: freshComponentId(template, 'gradient'),
    type: 'gradient',
    visible: true,
    unitMode: 'auto',
    style: {},
    rect: normalizeRect({ x: 0.04, y: 0.04, width: tileW, height: Math.min(0.2, 0.075 * aspect) }),
    source: { kind: 'metric', metric: 'grade' },
    gradient: { bands: DEFAULT_GRADIENT.bands.map((band) => ({ ...band })), glyph: true },
    smoothing: { windowSeconds: GRADIENT_SMOOTHING_SECONDS },
  };
}

/** AV-1019 (TD-087). The compass: a rose that turns, labelled, the heading smoothed over 3 s (it is noisy from GPS). */
export function newCompassComponent(template: OverlayTemplate, size: { width: number; height: number }): OverlayComponent {
  const aspect = size.width / size.height;
  const side = Math.min(0.22, 0.22 / aspect);
  return {
    id: freshComponentId(template, 'compass'),
    type: 'compass',
    visible: true,
    unitMode: 'auto',
    style: {},
    rect: normalizeRect({ x: 0.04, y: 0.04, width: side, height: side * aspect }),
    source: { kind: 'metric', metric: 'heading' },
    compass: { ...DEFAULT_COMPASS },
    smoothing: { windowSeconds: COMPASS_SMOOTHING_SECONDS },
  };
}

/** AV-1019. How long the grade and the heading are averaged over to start with. */
export const GRADIENT_SMOOTHING_SECONDS = 5;
export const COMPASS_SMOOTHING_SECONDS = 3;

/**
 * AV-1016. What adding an element puts on the canvas: one component, or the
 * several a predefined entry builds. The first is the one to select.
 */
export function newCanvasComponents(
  template: OverlayTemplate,
  key: CanvasElementKey,
  size: { width: number; height: number },
  timeline: OverlayTimeline,
  units: UnitSystem = 'metric',
): OverlayComponent[] {
  if (key.startsWith('predefined:')) {
    const built = predefinedEntry(key.slice('predefined:'.length))?.build(template, size, timeline, units) ?? [];
    if (built.length > 0) return built;
  }
  return [newCanvasComponent(template, key, size, timeline, units)];
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

export { TEXT_SCALE_LIMITS };

/**
 * AV-1015 (TD-083). The widest a metric can reasonably read, in its stored
 * unit, for sizing a figure's box: a text that fits these fits what the
 * activity shows. Pace is seconds per kilometre.
 */
const WIDEST_VALUE: Record<OverlayMetricKey, number> = {
  speed: 20,
  pace: 900,
  distance: 99_999,
  elevation: 3000,
  heartRate: 199,
  runningCadence: 199,
  cyclingCadence: 199,
  power: 999,
  temperature: 40,
  grade: -20,
  elapsed: 35_999,
  moving: 35_999,
  climb: 9999,
  heading: 359,
};

/**
 * Grows a live figure's box to hold its label and value as `drawFigure` lays
 * them out (`figureLayout`), right and down and no further than the frame's
 * edges. It never moves the box and never shrinks it; text that still does
 * not fit is cut at the box when drawn. Other elements are untouched, as a
 * plain resize leaves them (TD-083).
 *
 * AV-1020 (TD-089). A figure held by a shape takes the shape with it: the shape
 * grows right and down by as much as the figure did, keeping the gap the figure
 * had from the shape's right and bottom edges, and never past the frame. The
 * shape never moves or shrinks and its other members are untouched. A figure
 * whose box does not start inside the shape's leaves the shape alone.
 */
export function growFigureToFit(
  components: OverlayComponent[],
  id: string,
  frame: { width: number; height: number },
  context: { timeline: OverlayTimeline; units: UnitSystem; measure: MeasureText },
): OverlayComponent[] {
  const found = components.find((component) => component.id === id);
  if (!found || (found.type !== 'text' && found.type !== 'gauge') || !found.source) return components;
  // AV-1016. The widest value is laid out as it is, not averaged with the activity's own.
  const target: OverlayComponent = { ...found };
  delete target.smoothing;
  const source = found.source;
  const { timeline } = context;
  const sourceId = dataSourceId(source);
  const wide =
    source.kind === 'metric'
      ? source.metric === 'distance' && target.display?.ofTotal && timeline.distanceTotalMeters !== undefined
        ? timeline.distanceTotalMeters
        : source.metric === 'elapsed' || source.metric === 'moving'
          ? Math.max(WIDEST_VALUE[source.metric], timeline.alignment?.videoEndInActivity ?? timeline.durationSeconds)
          : source.metric === 'distance'
            ? Math.max(WIDEST_VALUE.distance, timeline.distanceTotalMeters ?? 0)
            : WIDEST_VALUE[source.metric]
      : (timeline.sensorLabels.get(sourceId)?.max ?? 999);
  const resolved = resolveOverlayComponent(
    canvasTemplate(components),
    target,
    { videoTimeSeconds: 0, activityElapsedSeconds: 0, values: { [sourceId]: wide } },
    timeline,
    context.units,
  );
  if (resolved.status !== 'ready') return components;
  const layout = figureLayout({
    em: (BASE_FONT_CQW / 100) * frame.width * resolved.style.fontScale,
    frameWidth: frame.width,
    label: resolved.label,
    value: resolved.text ?? '',
    figure: target.figure,
    track: resolved.fraction !== undefined,
    measure: context.measure,
  });
  const { rect } = found;
  const grown = (needed: number, now: number, room: number) =>
    needed > now + 1e-9 ? round(clamp(needed, now, room)) : now;
  const width = grown(layout.neededWidth / frame.width, rect.width, 1 - rect.x);
  const height = grown(layout.neededHeight / frame.height, rect.height, 1 - rect.y);
  if (width === rect.width && height === rect.height) return components;
  const holder = found.parentId ? components.find((component) => component.id === found.parentId) : undefined;
  const holds = holder?.type === 'shape' && rect.x >= holder.rect.x - 1e-9 && rect.y >= holder.rect.y - 1e-9;
  // The shape's edge moves out by as much as the figure's did, plus the gap it had, to the frame at most.
  const hold = (edge: number, start: number, figureOld: number, figureNew: number) => {
    const end = start + edge;
    const gap = Math.max(0, end - figureOld);
    return figureNew + gap > end + 1e-9 ? round(clamp(figureNew + gap, end, 1)) - start : edge;
  };
  return components.map((component) => {
    if (component.id === id) return { ...component, rect: normalizeRect({ ...rect, width, height }) };
    if (holds && component.id === holder.id) {
      const { x, y } = component.rect;
      const wider = hold(component.rect.width, x, rect.x + rect.width, rect.x + width);
      const taller = hold(component.rect.height, y, rect.y + rect.height, rect.y + height);
      if (wider === component.rect.width && taller === component.rect.height) return component;
      return { ...component, rect: normalizeRect({ ...component.rect, width: wider, height: taller }) };
    }
    return component;
  });
}

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

/** AV-1016. What Start from lays out: a built-in template, or a sport's own layout of predefined components. */
export function componentsFromStart(
  id: StartLayoutId,
  timeline: OverlayTimeline,
  size: { width: number; height: number },
  units: UnitSystem = 'metric',
): OverlayComponent[] {
  return id === 'cycling' || id === 'running'
    ? componentsFromSportLayout(id, timeline, size, units)
    : componentsFromPreset(id, timeline, size);
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
