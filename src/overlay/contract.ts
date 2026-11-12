import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { BASE_FONT_CQW } from './presets';
import { projectProfile } from './elevationProfile';
import { projectRoute } from './routeProjection';
import { extractRoute } from './routeImage';
import { layoutStillText, stillFontPx, stillValue } from './staticImage';
import {
  DEFAULT_OVERLAY_STYLE,
  STILL_IMAGE_COMPONENT_TYPES,
  resolveOverlayComponent,
  type OverlayComponent,
  type OverlayFigureSetting,
  type OverlayStyle,
  type OverlayTemplate,
  type ResolvedOverlayComponent,
  type SummaryStatKey,
  type TextAlign,
  type FontWeight,
} from './template';
import {
  dataSourceId,
  SMOOTHING_LIMITS,
  smoothedValueAt,
  type OverlayDataSource,
  type OverlayMetricKey,
  type OverlaySample,
  type OverlayTimeline,
} from './timeline';

/**
 * AV-1017 (TD-085). The contract of an overlay component: what a component is
 * given, in which units, and what it draws with.
 *
 * Nothing here loads or runs a reader's code (TD-085 says why not yet). The
 * built-in components keep drawing as `export/drawOverlay.ts` draws them; this
 * module is the documented shape of the data they draw from, and `contractProps`
 * is the one place that builds it, from what the renderer already resolves. A
 * future loader would call the same function, so the documentation, the types
 * and the adapter cannot drift apart without a test noticing.
 *
 * Props are plain JSON: numbers, strings, booleans, arrays and plain objects,
 * with no function, no `Date`, no `undefined`. Data a component needs that the
 * activity does not have is an absent member, never a placeholder (no `0`,
 * `NaN`, `''` or `'--'` in its place); a component whose required data is
 * missing is not drawn at all, as the renderer does not draw it.
 */

// ---------------------------------------------------------------------------
// What a component draws with

/**
 * The part of a 2D canvas context a component may use. It is a subset on
 * purpose:
 * - there is no `canvas` member, so a component cannot reach the canvas, the page or its other
 *   components through it;
 * - there is no `getImageData`, `putImageData`, `createImageData` or `drawImage`: a component must
 *   not read the frame (it may hold the reader's video), and is given no image to draw;
 * - there is no `clearRect`, `setTransform`, `resetTransform` or `globalCompositeOperation`, which
 *   could undo the box the host clips to or paint over what other components drew.
 *
 * A real `CanvasRenderingContext2D` or `OffscreenCanvasRenderingContext2D` is
 * assignable to it.
 */
export type ContractContext2D = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'arcTo'
  | 'ellipse'
  | 'rect'
  | 'roundRect'
  | 'quadraticCurveTo'
  | 'bezierCurveTo'
  | 'fill'
  | 'stroke'
  | 'clip'
  | 'fillRect'
  | 'strokeRect'
  | 'fillText'
  | 'strokeText'
  | 'measureText'
  | 'setLineDash'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'shadowColor'
  | 'shadowBlur'
  | 'shadowOffsetX'
  | 'shadowOffsetY'
>;

/**
 * A component's draw function. The context is the frame's, in the frame's
 * pixels, origin at its top-left corner; the component draws inside
 * `props.box` only. For a figure, gauge or route the host fills the background
 * and clips to the box before the call; a whole-activity component gets neither.
 * Either way a component is held to the rule, not to the clip. It draws the same picture for the same
 * props, keeps no state between calls, and uses neither the network nor
 * storage.
 */
export type ComponentDraw<P extends ContractProps = ContractProps> = (
  ctx: ContractContext2D,
  props: P,
) => void;

// ---------------------------------------------------------------------------
// What every component is given

/** A rectangle in the frame's pixels, origin at the frame's top-left corner, y down. */
export interface ContractBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The look chosen for the component, as the template stores it. Colours are `#rrggbb`. */
export interface ContractStyle {
  /** The value's colour. */
  textColor: string;
  /** The gauge's fill, the route's marker, the cursor. */
  accentColor: string;
  /** 0..1. For a figure, gauge or route the host paints this behind the component; a component never paints its own box's background. A whole-activity component has no background. */
  backgroundOpacity: number;
  /** Multiplier on the base type size; already in `fontPx`. */
  fontScale: number;
}

interface ContractBase {
  /** Where the component is, in the frame's pixels. */
  box: ContractBox;
  /** The frame's size in pixels. */
  frame: { width: number; height: number };
  /** The base type size in pixels for this component: 2.2 % of the frame's width times `style.fontScale` (smaller only for a whole-activity text that would not fit the frame). */
  fontPx: number;
  style: ContractStyle;
}

/** Props of a component that reads one moment of the activity. */
interface ContractMoment extends ContractBase {
  /** Seconds into the video (or into the canvas's own clock without one). Changes on every frame. */
  videoTimeSeconds: number;
  /** Seconds since the activity's first timed point, at this moment. */
  activityElapsedSeconds: number;
}

// ---------------------------------------------------------------------------
// Section: live figures

/** What a figure reads: a built-in metric, or a named stream of the camera. */
export type ContractSource = OverlayDataSource;

/** The unit a metric's `value` is in, whatever the reader's unit system: the stored unit. */
export const STORED_UNITS: Readonly<Record<OverlayMetricKey, string>> = {
  speed: 'm/s',
  /** 0 means standing still (TD-080), not an instant pace. */
  pace: 's/km',
  distance: 'm',
  elevation: 'm',
  heartRate: 'bpm',
  runningCadence: 'spm',
  cyclingCadence: 'rpm',
  power: 'W',
  temperature: '°C',
  grade: '%',
  elapsed: 's',
  moving: 's',
  climb: 'm',
};

/**
 * A live figure: speed, pace, distance, heart rate, power, cadence, elevation,
 * temperature, gradient, a time or one of the camera's streams. Props change
 * on every frame (the video's frame rate), and `value` changes at the
 * activity's own rate between its points.
 */
export interface FigureProps extends ContractMoment {
  section: 'figure';
  source: ContractSource;
  /**
   * The value in the STORED unit (`STORED_UNITS`), never the reader's: m/s,
   * s/km, m, bpm, spm, rpm, W, °C, %, s. It is the smoothed value when
   * `smoothingWindowSeconds` is present. A camera stream's value is in the
   * stream's own `unit`.
   */
  value: number;
  /** The unit of `value`. Absent for a camera stream that states none. */
  unit?: string;
  /** The unit system `text` is written in: the component's own choice, else the reader's. */
  unitSystem: UnitSystem;
  /** The figure's name as the reader sees it ("Speed", or their own wording). Not upper-cased: the built-ins draw it upper-cased. */
  label: string;
  /** `value` formatted for reading, in `unitSystem`, with the unit ("32.4 km/h", "4:30 /km"). Draw this, do not format `value` again. */
  text: string;
  /** The reader's styling of the label and the value; absent members are the built-in look. Absent when the reader set none. */
  figure?: OverlayFigureSetting;
  /** Seconds, above 0 and up to 30. Present only when `value` is a trailing mean over that window. */
  smoothingWindowSeconds?: number;
  /** Metres. Present only for a distance written "of the total": the whole activity's, `text` already says both. */
  totalDistanceMeters?: number;
}

// ---------------------------------------------------------------------------
// Section: gauges

/** A gauge: a figure with a range and the position of its value within it. */
export interface GaugeProps extends Omit<FigureProps, 'section'> {
  section: 'gauge';
  /** The bounds the reader set, in the STORED unit of `value`. `min` is below `max`. */
  range: { min: number; max: number };
  /** Where `value` falls in `range`, 0..1, clamped: 0 at or below `min`, 1 at or above `max`. */
  fraction: number;
}

// ---------------------------------------------------------------------------
// Section: along the route

/** A point in the component's own box, as fractions of its width and height (x right, y down). */
export type ContractPoint = [number, number];

/**
 * A route inset, a progress bar or an elevation profile. Which one is `part`;
 * the members each needs are present, the others absent. Everything geometric
 * is in 0..1 of the box, so it does not depend on the frame's size: a
 * component multiplies by `box.width` and `box.height`.
 */
export interface RouteProps extends ContractMoment {
  section: 'route';
  part: 'route' | 'progress' | 'elevationProfile';
  /** 0..1 along the activity, by distance where it has one, else by time. Absent where the activity has no clock to measure by. */
  progress?: number;
  /**
   * `part: 'route'`. The route fitted into the box with its aspect kept and a margin, as runs of
   * unbroken positions (a pause or a lost fix ends one, so a line is never drawn across a gap).
   * Absent when no activity is given, or it has no route to fit. Changes never: the same in every frame.
   */
  route?: {
    segments: ContractPoint[][];
    /** Where the activity is at this moment, in the same space. Absent where it has no position. */
    position?: ContractPoint;
  };
  /**
   * `part: 'elevationProfile'`. Elevation along the activity: x is distance along (0..1), y is
   * height with the highest point near the top. Absent when the activity has no elevation along it.
   * A stretch with no elevation ends a run. The same in every frame except `cursor`.
   */
  profile?: {
    runs: ContractPoint[][];
    /** The line's point at `progress`. Absent in a gap. */
    cursor?: ContractPoint;
  };
}

// ---------------------------------------------------------------------------
// Section: the whole activity

/**
 * A text, a figure from the summary or the date: what describes the whole
 * activity. `box` is the box its words take (see `ContractContext.measureText`); the host paints no
 * background and applies no clip for it, so it is the same in every frame and carries no time. Drawn in a
 * video as on the still image.
 */
export interface WholeActivityProps extends ContractBase {
  section: 'wholeActivity';
  kind: 'text' | 'summary' | 'date';
  /** What to write, already formatted in the reader's units, or the reader's own words for `text`. May hold line breaks. */
  text: string;
  /** The small line over a summary figure ("Avg speed"), not upper-cased. Absent for a text or a date, or when the reader turned it off. */
  caption?: string;
  align: TextAlign;
  weight: FontWeight;
  /** `kind: 'summary'`. The figure in the STORED unit: m/s, s/km, m, s (elapsed and moving) and m (elevation gain). */
  summary?: {
    stat: SummaryStatKey;
    value: number;
    /** Speed and pace only: over moving time where the activity has one, else over elapsed time. */
    basis?: 'moving' | 'elapsed';
  };
  /** `kind: 'date'`. The activity's start as UTC ISO 8601 ("2026-09-24T08:00:00.000Z"). `text` is already in the zone the reader chose. */
  date?: { startTime: string; utcOffsetMinutes?: number };
  /** The activity's name where the file states one; absent otherwise. */
  activityName?: string;
}

// ---------------------------------------------------------------------------
// Section: zones (reserved)

/*
 * Zones (the bounds and the zone now, #20) are reserved: there is no props
 * type, no adapter and no section for them until #20 decides what a zone is,
 * so nothing here promises a shape that would then change. `docs/components/zones.md` says so.
 */

export type ContractProps = FigureProps | GaugeProps | RouteProps | WholeActivityProps;
export type ContractSection = ContractProps['section'];

// ---------------------------------------------------------------------------
// The adapter

type Ready = Extract<ResolvedOverlayComponent, { status: 'ready' }>;

/** What the adapter needs besides the resolved component. */
export interface ContractContext {
  /** The frame in pixels, the one the overlay is drawn at. */
  frame: { width: number; height: number };
  /** The reader's unit system (`auto` in a component follows it). */
  units: UnitSystem;
  /** The loaded activity: the route, the profile, the summary, the date and the name come from it. */
  activity?: Activity;
  /** IANA zone for a date set to the reader's own; the browser's by default. */
  readerTimeZone?: string;
  /**
   * Width in pixels of a text in a CSS font, as the canvas that draws it measures it. A whole-activity
   * component is drawn in the box its words take, so its `box` is only exact when this is given; without
   * it `box` is the component's stored rect, which the editor keeps at the measured size.
   */
  measureText?: (text: string, font: string) => number;
}

/** Which section a component is drawn as, or `undefined` for one that carries no data (a shape). */
export function contractSectionOf(component: OverlayComponent): ContractSection | undefined {
  switch (component.type) {
    case 'text':
    case 'sensorChart':
      return 'figure';
    case 'gauge':
      // Without a range the renderer draws a figure with no track, so it is a figure here.
      return component.range ? 'gauge' : 'figure';
    case 'routeInset':
    case 'progress':
    case 'elevationProfile':
      return 'route';
    case 'label':
    case 'summary':
    case 'date':
      return 'wholeActivity';
    case 'shape':
      return undefined;
  }
}

const boxOf = (component: OverlayComponent, frame: ContractContext['frame']): ContractBox => ({
  x: component.rect.x * frame.width,
  y: component.rect.y * frame.height,
  width: component.rect.width * frame.width,
  height: component.rect.height * frame.height,
});

const styleOf = (style: OverlayStyle): ContractStyle => ({
  textColor: style.textColor,
  accentColor: style.accentColor,
  backgroundOpacity: style.backgroundOpacity,
  fontScale: style.fontScale,
});

/** The renderer's em for a live component: `BASE_FONT_CQW` percent of the frame's width, scaled. */
const fontPxOf = (frame: ContractContext['frame'], style: OverlayStyle) =>
  (BASE_FONT_CQW / 100) * frame.width * style.fontScale;

/**
 * The props of a live component, from what the renderer has already resolved
 * for it (`resolveOverlayComponent` said `ready`) at this sample. Pure, and
 * nothing in it is shared: every call returns fresh plain data.
 *
 * It is the figure's, gauge's or route's section by the component's type. A
 * whole-activity component is `wholeActivityProps`' (the renderer resolves
 * those as hidden in a video, and draws them from the still image's values).
 */
export function contractProps(
  ready: Ready,
  sample: OverlaySample,
  timeline: OverlayTimeline,
  context: ContractContext,
): FigureProps | GaugeProps | RouteProps {
  const { component, style } = ready;
  const { frame } = context;
  const base = {
    box: boxOf(component, frame),
    frame: { width: frame.width, height: frame.height },
    fontPx: fontPxOf(frame, style),
    style: styleOf(style),
    videoTimeSeconds: sample.videoTimeSeconds,
    activityElapsedSeconds: sample.activityElapsedSeconds,
  };

  if (component.type === 'routeInset' || component.type === 'progress' || component.type === 'elevationProfile') {
    const props: RouteProps = {
      section: 'route',
      part: component.type === 'routeInset' ? 'route' : component.type,
      ...base,
    };
    // A profile and a progress bar read `ready.fraction`; a route inset reads the sample's progress where it has one.
    const progress = ready.fraction ?? sample.progress;
    if (progress !== undefined) props.progress = progress;
    const box = base.box;
    if (component.type === 'routeInset' && context.activity) {
      const route = projectRoute(context.activity, box.width / box.height);
      if (route) {
        props.route = { segments: route.segments.map((segment) => segment.map(([x, y]) => [x, y])) };
        if (sample.position) props.route.position = [...route.project(sample.position)];
      }
    }
    if (component.type === 'elevationProfile' && context.activity) {
      const profile = projectProfile(context.activity);
      if (profile) {
        props.profile = { runs: profile.runs.map((run) => run.map(([x, y]) => [x, y])) };
        const cursor = profile.at(progress ?? 0);
        if (cursor) props.profile.cursor = [cursor[0], cursor[1]];
      }
    }
    return props;
  }

  // A figure or a gauge: the value is read as `resolveOverlayComponent` reads it.
  const source = component.source as OverlayDataSource;
  const id = dataSourceId(source);
  const raw = sample.values[id] as number;
  const windowSeconds = component.smoothing?.windowSeconds;
  const smoothed = windowSeconds
    ? smoothedValueAt(timeline, source, sample.videoTimeSeconds, windowSeconds)
    : undefined;
  const shown = smoothed ?? raw;
  const unit = source.kind === 'metric' ? STORED_UNITS[source.metric] : timeline.sensorLabels.get(id)?.unit;
  const props: FigureProps = {
    section: 'figure',
    ...base,
    source: source.kind === 'metric' ? { kind: 'metric', metric: source.metric } : { kind: 'sensor', key: source.key },
    value: shown,
    unitSystem: component.unitMode === 'auto' ? context.units : component.unitMode,
    label: ready.label as string,
    text: ready.text as string,
  };
  if (unit !== undefined) props.unit = unit;
  if (component.figure) props.figure = structuredClone(component.figure);
  if (windowSeconds && smoothed !== undefined) {
    props.smoothingWindowSeconds = Math.min(windowSeconds, SMOOTHING_LIMITS.max);
  }
  const total = timeline.distanceTotalMeters;
  if (source.kind === 'metric' && source.metric === 'distance' && component.display?.ofTotal && total !== undefined) {
    props.totalDistanceMeters = total;
  }
  if (component.type === 'gauge' && component.range && ready.fraction !== undefined) {
    return { ...props, section: 'gauge', range: { min: component.range.min, max: component.range.max }, fraction: ready.fraction };
  }
  return props;
}

/**
 * The props of a text, a figure for the whole activity or a date, from the
 * values the still image draws (`stillValue`), or `undefined` when the
 * activity cannot supply it or the text is empty: such a component is not
 * drawn, in a video or on a still.
 */
export function wholeActivityProps(
  component: OverlayComponent,
  context: ContractContext,
): WholeActivityProps | undefined {
  if (!component.visible || !STILL_IMAGE_COMPONENT_TYPES.includes(component.type)) return undefined;
  const { activity, frame } = context;
  if (!activity) return undefined;
  const value = stillValue(component, {
    activity,
    route: extractRoute(activity),
    units: context.units,
    readerTimeZone: context.readerTimeZone,
  });
  if (!value.ok) return undefined;

  // The renderer takes a still text's colour from the component, not the template (AV-1011).
  const style: OverlayStyle = { ...DEFAULT_OVERLAY_STYLE, ...component.style };
  const setting = component.text ?? { align: 'left' as const, weight: 'bold' as const };
  // The renderer sets these in the box their words take, shrunk only if larger than the frame.
  const laid = context.measureText ? layoutStillText(component, value, style.textColor, frame, context.measureText) : undefined;
  const props: WholeActivityProps = {
    section: 'wholeActivity',
    kind: component.type === 'label' ? 'text' : component.type === 'summary' ? 'summary' : 'date',
    box: laid ? { x: laid.box.x, y: laid.box.y, width: laid.box.w, height: laid.box.h } : boxOf(component, frame),
    frame: { width: frame.width, height: frame.height },
    fontPx: laid?.lines.find((line) => !line.caption)?.size ?? stillFontPx(component, frame.width),
    style: styleOf(style),
    text: value.value,
    align: setting.align,
    weight: setting.weight,
  };
  if (component.type === 'summary' && setting.caption !== false) props.caption = value.caption;
  if (component.type === 'summary' && component.summary) {
    const summary = summaryFigure(component.summary.stat, activity);
    if (summary) props.summary = summary;
  }
  const start = activity.derived?.startTime;
  if (component.type === 'date' && start instanceof Date) {
    props.date = { startTime: start.toISOString() };
    const offset = activity.metadata.utcOffsetMinutes;
    if (offset !== undefined) props.date.utcOffsetMinutes = offset;
  }
  const name = activity.metadata.name?.trim();
  if (name) props.activityName = name;
  return props;
}

/** The summary's figure in its stored unit, on the basis `summaryValue` writes it on. */
function summaryFigure(stat: SummaryStatKey, activity: Activity): WholeActivityProps['summary'] | undefined {
  const derived = activity.derived;
  if (!derived) return undefined;
  const make = (value: number | undefined, basis?: 'moving' | 'elapsed') =>
    value === undefined ? undefined : { stat, value, ...(basis ? { basis } : {}) };
  switch (stat) {
    case 'speed':
      return derived.averageMovingSpeedMetersPerSecond !== undefined
        ? make(derived.averageMovingSpeedMetersPerSecond, 'moving')
        : make(derived.averageSpeedMetersPerSecond, 'elapsed');
    case 'pace':
      return derived.averageMovingPaceSecondsPerKm !== undefined
        ? make(derived.averageMovingPaceSecondsPerKm, 'moving')
        : make(derived.averagePaceSecondsPerKm, 'elapsed');
    case 'distance':
      return make(derived.distanceMeters);
    case 'elapsed':
      return make(derived.durationSeconds);
    case 'moving':
      return make(derived.movingDurationSeconds);
    case 'climb':
      return make(derived.elevationGainMeters);
  }
}

/**
 * The props the renderer's resolution of one component at one moment implies,
 * or `undefined` where it draws nothing (hidden, no data, a shape). The
 * convenience that ties `resolveOverlayComponent`, `contractProps` and
 * `wholeActivityProps` together, as a loader would use them.
 */
export function contractPropsFor(
  template: OverlayTemplate,
  component: OverlayComponent,
  sample: OverlaySample | undefined,
  timeline: OverlayTimeline,
  context: ContractContext,
): ContractProps | undefined {
  const section = contractSectionOf(component);
  if (section === undefined) return undefined;
  if (section === 'wholeActivity') return wholeActivityProps(component, context);
  if (!sample) return undefined;
  const ready = resolveOverlayComponent(template, component, sample, timeline, context.units);
  return ready.status === 'ready' ? contractProps(ready, sample, timeline, context) : undefined;
}
