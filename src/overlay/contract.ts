import type { Activity } from '../domain/activity';
import type { UnitSystem } from '../domain/units';
import { BASE_FONT_CQW } from './presets';
import { projectProfile } from './elevationProfile';
import type { ProjectedSeries } from './series';
import { chartLabels, chartMoment, chartSeriesOf, chartView } from './chart';
import { DEFAULT_DIAL, dialTicks } from './dial';
import { DEFAULT_GRADIENT, gradientBand, gradientGlyph } from './gradient';
import { DEFAULT_COMPASS } from './compass';
import { cardinalLetters, normalizeDegrees } from './derivedSeries';
import { projectRoute } from './routeProjection';
import { extractRoute } from './routeImage';
import { zoneTimesFor } from './zones';
import { layoutStillText, stillFontPx, stillValue } from './staticImage';
import {
  DEFAULT_CHART,
  DEFAULT_OVERLAY_STYLE,
  STILL_IMAGE_COMPONENT_TYPES,
  resolveOverlayComponent,
  type OverlayComponent,
  type OverlayFigureSetting,
  type OverlayStyle,
  type OverlayTemplate,
  type PersonalFigures,
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
  /** AV-1019. Degrees clockwise from north, 0 up to just under 360. */
  heading: '°',
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
// Section: zones

/**
 * AV-1018 (TD-086). Heart rate or power zones: which zone the activity is in
 * now, and the zones' bounds. Props change on every frame, and `zoneIndex`
 * only when the value crosses a bound. A set measured in percent of a figure
 * the reader has not entered is not drawn, so it is not given: the props
 * always carry the bounds in absolute units.
 */
export interface ZoneProps extends ContractMoment {
  section: 'zones';
  /** What the zones are measured on. */
  source: 'heartRate' | 'power';
  /** The value in the STORED unit (`unit`): bpm or W. It is the smoothed value when `smoothingWindowSeconds` is present. */
  value: number;
  /** `'bpm'` for heart rate, `'W'` for power. */
  unit: 'bpm' | 'W';
  /** The figure's name as the reader sees it ("Heart rate", or their own wording). */
  label: string;
  /** `value` formatted for reading, with the unit ("152 bpm"). */
  text: string;
  /** 0-based position of the zone the value is in: the last whose lower bound is at or under the value, and 0 for a value under every bound. */
  zoneIndex: number;
  /** Where `value` falls in its zone, 0..1: 0 at the zone's lower bound, 1 at the next one's. The last zone is as wide as the one before it. */
  fractionInZone: number;
  /** The zones, lowest first: 2 to 10. `lowerBound` is in `unit`, ascending: always absolute, whatever the reader measured them in. */
  zones: { name: string; color: string; lowerBound: number }[];
  /** How the reader asked for it to be drawn. The built-ins draw each as the documentation says; a component may draw its own. */
  shape: 'horizontal' | 'vertical' | 'arc' | 'figure';
  /** What the reader asked to be shown. */
  show: { number: boolean; name: boolean; value: boolean; timeInZone: boolean };
  /** Seconds spent moving in each zone so far, one per zone, from the unsmoothed values, counted as moving time is. Present only when `show.timeInZone` and the activity can say. */
  timeInZoneSeconds?: number[];
  /** Seconds, above 0 and up to 30. Present only when `value` is a trailing mean over that window. */
  smoothingWindowSeconds?: number;
  /** The reader's styling of the label and the value; absent members are the built-in look. Absent when the reader set none. */
  figure?: OverlayFigureSetting;
}

// ---------------------------------------------------------------------------
// Section: dials, charts, the gradient indicator and the compass

/**
 * AV-1019 (TD-087). A dial: a gauge on an arc. It has everything a gauge has
 * (the value, `range`, `fraction`) and the arc, the ticks and the pointer.
 */
export interface DialProps extends Omit<GaugeProps, 'section'> {
  section: 'dial';
  /** The arc's opening, 180 to 300 degrees, centred at the top. */
  sweepDegrees: number;
  /**
   * Where the pointer points, in degrees clockwise from straight up: -sweepDegrees / 2 at the range's start,
   * 0 at its middle, +sweepDegrees / 2 at its end, so a value beyond the range is at an end. A component turns
   * it into a canvas angle with `(angleDegrees - 90) * Math.PI / 180`.
   */
  angleDegrees: number;
  /** The ticks, worked out for the range: `fraction` 0..1 along the arc, ascending, and whether it is a major one. */
  ticks: { fraction: number; major: boolean }[];
  pointer: 'needle' | 'marker';
  /** `#rrggbb`. */
  trackColor: string;
  fillColor: string;
  needleColor: string;
}

/**
 * AV-1019 (TD-087). A chart: a figure against time or distance, whole or through
 * a window, with a cursor. The geometry is in 0..1 of the box, as a profile's is.
 * Missing data is a gap in a run, and no cursor value.
 */
export interface ChartProps extends ContractMoment {
  section: 'chart';
  source: ContractSource;
  /** The figure's name as the reader sees it. */
  label: string;
  /** What the x axis is: seconds of the activity, or metres along it. */
  axis: 'time' | 'distance';
  /** Seconds or metres either side of now, with the cursor in the middle. Absent: the whole activity, and the cursor moves along it. */
  window?: number;
  /** `#rrggbb`. */
  lineColor: string;
  fillColor: string;
  /** 0..1: how much of its colour the fill under the line has. */
  fillOpacity: number;
  /** Whether the reader asked for the axis labels; `labels` below holds what they say. */
  showLabels: boolean;
  /** The runs of the line, in 0..1 of the box, y down, the highest value near the top. A gap in the data ends a run. For a window, only the window, with x 0..1 across it. */
  runs: ContractPoint[][];
  /** The cursor: `x` in 0..1 of the box (its share of the activity, or 0.5 in a window), and `y`, the figure's value on the line, absent where it has none. */
  cursor: { x: number; y?: number };
  /** The figure now in the STORED unit, absent where the activity has no value at this moment. */
  value?: number;
  /** The unit of `value` and of `yRange`; absent for a camera stream that states none. */
  unit?: string;
  /** The lowest and highest value drawn, in the stored unit; absent when a window has no data. */
  yRange?: { low: number; high: number };
  /** The axis labels, already written in the reader's units; present only when `showLabels`. `yLow` and `yHigh` are absent with `yRange`. */
  labels?: { yHigh?: string; yLow?: string; xStart: string; xEnd: string };
  /** The reader's styling of the labels; absent members are the built-in look. Absent when the reader set none. */
  figure?: OverlayFigureSetting;
}

/**
 * AV-1019 (TD-087). The gradient indicator: the grade, written, with a glyph and
 * a colour by steepness. The band and the glyph are already worked out.
 */
export interface GradientProps extends ContractMoment {
  section: 'gradient';
  /** The grade in percent: positive uphill. The trailing mean when `smoothingWindowSeconds` is present. */
  value: number;
  label: string;
  /** `value` formatted for reading ("6.5 %"). Draw this. */
  text: string;
  /** The bands, lowest first, 2 to 10: each starts at `from` percent, with `color` `#rrggbb`. */
  bands: { from: number; color: string }[];
  /** 0-based: the last band whose `from` is at or under `value`, and 0 for a value under every band. */
  bandIndex: number;
  /** The colour of the band `value` is in, `#rrggbb`. */
  color: string;
  /** Which glyph: `up` from 1 % up, `down` from 1 % down, `flat` between. Absent when the reader turned the glyph off. */
  glyph?: 'up' | 'down' | 'flat';
  /** Seconds, above 0 and up to 30. Present only when `value` is a trailing mean over that window. */
  smoothingWindowSeconds?: number;
  figure?: OverlayFigureSetting;
}

/**
 * AV-1019 (TD-087). The compass: the direction of travel. The angles of the rose
 * and the needle are already worked out, so the heading wraps correctly at 0 and 360.
 */
export interface HeadingProps extends ContractMoment {
  section: 'compass';
  /** The heading in degrees, 0 (north) up to just under 360, 90 east. The circular mean when `smoothingWindowSeconds` is present. */
  value: number;
  label: string;
  /** `value` formatted for reading ("123° SE"). Draw this. */
  text: string;
  /** The 8-point letter for `value`: `N`, `NE`, `E`, `SE`, `S`, `SW`, `W` or `NW`. */
  cardinal: string;
  /** `rose`: the rose turns so the heading is up, under a fixed marker. `needle`: a fixed north-up rose with a needle along the heading. */
  compassStyle: 'rose' | 'needle';
  /** Whether the reader asked for the cardinal points to be labelled. */
  showLabels: boolean;
  /** `#rrggbb`. */
  roseColor: string;
  needleColor: string;
  /** Where north is drawn on the rose, in degrees clockwise from straight up: 360 - `value` (mod 360) for `rose`, 0 for `needle`. The other points follow 90 degrees apart. */
  northAngleDegrees: number;
  /** Where the needle (or, for `rose`, the marker) points, in degrees clockwise from straight up: `value` for `needle`, 0 for `rose`. */
  needleAngleDegrees: number;
  /** Seconds, above 0 and up to 30. Present only when `value` is a circular mean over that window. */
  smoothingWindowSeconds?: number;
  figure?: OverlayFigureSetting;
}

export type ContractProps = FigureProps | GaugeProps | RouteProps | WholeActivityProps | ZoneProps | DialProps | ChartProps | GradientProps | HeadingProps;
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
  /** AV-1018. The reader's own maximum heart rate and FTP, which a zones component in percent is measured against. */
  personal?: PersonalFigures;
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
    case 'zones':
      return 'zones';
    case 'dial':
      return 'dial';
    case 'chart':
      return 'chart';
    case 'gradient':
      return 'gradient';
    case 'compass':
      return 'compass';
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
): FigureProps | GaugeProps | RouteProps | ZoneProps | DialProps | ChartProps | GradientProps | HeadingProps {
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

  if (component.type === 'zones' && ready.zones) {
    const { setting, bounds, index, within, value } = ready.zones;
    const windowSeconds = component.smoothing?.windowSeconds;
    const props: ZoneProps = {
      section: 'zones',
      ...base,
      source: setting.source,
      value,
      unit: ready.zones.unit,
      label: ready.label as string,
      text: ready.text as string,
      zoneIndex: index,
      fractionInZone: within,
      zones: setting.zones.map((zone, i) => ({ name: zone.name, color: zone.color, lowerBound: bounds[i]! })),
      shape: setting.shape,
      show: { ...setting.show },
    };
    const times = setting.show.timeInZone && component.source ? zoneTimesFor(timeline, component.source, bounds) : undefined;
    if (times) props.timeInZoneSeconds = times.at(sample.activityElapsedSeconds);
    if (component.figure) props.figure = structuredClone(component.figure);
    if (windowSeconds && smoothedValueAt(timeline, component.source as OverlayDataSource, sample.videoTimeSeconds, windowSeconds) !== undefined) {
      props.smoothingWindowSeconds = Math.min(windowSeconds, SMOOTHING_LIMITS.max);
    }
    return props;
  }

  if (component.type === 'chart') return chartProps(ready, sample, timeline, context, base);
  if (component.type === 'dial' || component.type === 'gradient' || component.type === 'compass') return momentProps(ready, timeline, context, base, sample);

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

type MomentBase = Omit<ContractMoment, never>;

/** The series a chart draws, from the points the renderer was given; `undefined` when the activity has none for the source. */
function chartSeries(component: OverlayComponent, activity: Activity | undefined): ProjectedSeries | undefined {
  const source = component.source;
  return activity && source ? chartSeriesOf(activity, source, (component.chart ?? DEFAULT_CHART).axis) : undefined;
}

/** AV-1019. A chart's props: the line, the cursor, the range and the labels, as the renderer draws them. */
function chartProps(ready: Ready, sample: OverlaySample, timeline: OverlayTimeline, context: ContractContext, base: MomentBase): ChartProps {
  const { component } = ready;
  const source = component.source as OverlayDataSource;
  const setting = component.chart ?? DEFAULT_CHART;
  const series = chartSeries(component, context.activity);
  const view = series ? chartView(series, setting, chartMoment(series, source, sample, timeline)) : undefined;
  const id = dataSourceId(source);
  const unit = source.kind === 'metric' ? STORED_UNITS[source.metric] : timeline.sensorLabels.get(id)?.unit;
  const value = sample.values[id];
  const props: ChartProps = {
    section: 'chart',
    ...base,
    source: source.kind === 'metric' ? { kind: 'metric', metric: source.metric } : { kind: 'sensor', key: source.key },
    label: ready.label as string,
    axis: setting.axis,
    lineColor: setting.lineColor,
    fillColor: setting.fillColor,
    fillOpacity: setting.fillOpacity,
    showLabels: setting.labels,
    runs: view ? view.runs.map((run) => run.map(([x, y]) => [x, y] as ContractPoint)) : [],
    cursor: { x: view?.cursorX ?? 0 },
  };
  if (setting.window !== undefined) props.window = setting.window;
  if (view?.cursorY !== undefined) props.cursor.y = view.cursorY;
  if (value !== undefined) props.value = value;
  if (unit !== undefined) props.unit = unit;
  if (view?.low !== undefined && view.high !== undefined) props.yRange = { low: view.low, high: view.high };
  if (setting.labels && series && view) {
    const units = component.unitMode === 'auto' ? context.units : component.unitMode;
    const written = chartLabels(view, series, setting, source, units, timeline, component.display?.decimals);
    props.labels = {
      ...(written.high !== undefined ? { yHigh: written.high } : {}),
      ...(written.low !== undefined ? { yLow: written.low } : {}),
      xStart: written.start,
      xEnd: written.end,
    };
  }
  if (component.figure) props.figure = structuredClone(component.figure);
  return props;
}

/** AV-1019. A dial's, a gradient indicator's or a compass' props: the value as a figure has it, and what each draws it with. */
function momentProps(ready: Ready, timeline: OverlayTimeline, context: ContractContext, base: MomentBase, sample: OverlaySample): DialProps | GradientProps | HeadingProps {
  const { component } = ready;
  const source = component.source as OverlayDataSource;
  const value = ready.value as number;
  const windowSeconds = component.smoothing?.windowSeconds;
  const smoothed = windowSeconds && smoothedValueAt(timeline, source, sample.videoTimeSeconds, windowSeconds) !== undefined;
  const common = {
    ...base,
    value,
    label: ready.label as string,
    text: ready.text as string,
    ...(smoothed ? { smoothingWindowSeconds: Math.min(windowSeconds as number, SMOOTHING_LIMITS.max) } : {}),
    ...(component.figure ? { figure: structuredClone(component.figure) } : {}),
  };
  if (component.type === 'gradient') {
    const setting = component.gradient ?? DEFAULT_GRADIENT;
    const bandIndex = gradientBand(value, setting.bands);
    return {
      section: 'gradient',
      ...common,
      bands: setting.bands.map((band) => ({ from: band.from, color: band.color })),
      bandIndex,
      color: setting.bands[bandIndex]!.color,
      ...(setting.glyph ? { glyph: gradientGlyph(value) } : {}),
    };
  }
  if (component.type === 'compass') {
    const setting = component.compass ?? DEFAULT_COMPASS;
    return {
      section: 'compass',
      ...common,
      value: normalizeDegrees(value),
      cardinal: cardinalLetters(value),
      compassStyle: setting.style,
      showLabels: setting.labels,
      roseColor: setting.roseColor,
      needleColor: setting.needleColor,
      northAngleDegrees: setting.style === 'rose' ? normalizeDegrees(-value) : 0,
      needleAngleDegrees: setting.style === 'needle' ? normalizeDegrees(value) : 0,
    };
  }
  const setting = component.dial ?? DEFAULT_DIAL;
  const range = ready.range as { min: number; max: number };
  const fraction = ready.fraction as number;
  const unit = source.kind === 'metric' ? STORED_UNITS[source.metric] : timeline.sensorLabels.get(dataSourceId(source))?.unit;
  return {
    section: 'dial',
    ...common,
    source: source.kind === 'metric' ? { kind: 'metric', metric: source.metric } : { kind: 'sensor', key: source.key },
    ...(unit !== undefined ? { unit } : {}),
    unitSystem: component.unitMode === 'auto' ? context.units : component.unitMode,
    range: { min: range.min, max: range.max },
    fraction,
    sweepDegrees: setting.sweep,
    angleDegrees: (fraction - 0.5) * setting.sweep,
    ticks: dialTicks(range, setting).map((tick) => ({ fraction: tick.fraction, major: tick.major })),
    pointer: setting.pointer,
    trackColor: setting.trackColor,
    fillColor: setting.fillColor,
    needleColor: setting.needleColor,
  };
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
  const ready = resolveOverlayComponent(template, component, sample, timeline, context.units, context.personal);
  if (ready.status !== 'ready') return undefined;
  // A chart the renderer draws nothing for (no activity to draw it from, or no place on its axis) has no props either.
  if (component.type === 'chart') {
    const series = chartSeries(component, context.activity);
    if (!series || !component.source || chartMoment(series, component.source, sample, timeline).centre === undefined) return undefined;
  }
  return contractProps(ready, sample, timeline, context);
}
