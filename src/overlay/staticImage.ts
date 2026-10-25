import type { Activity } from '../domain/activity';
import { formatDistance, formatDuration, formatPace, formatSpeed, type UnitSystem } from '../domain/units';
import { BASE_FONT_CQW } from './presets';
import {
  DEFAULT_ROUTE_IMAGE_OPTIONS,
  ROUTE_IMAGE_LIMITS,
  RouteImageError,
  checkImageSize,
  isHexColor,
  planRouteImage,
  type RouteGeometry,
  type RouteImagePlan,
} from './routeImage';
import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_TEMPLATE_VERSION,
  normalizeRect,
  STILL_IMAGE_COMPONENT_TYPES,
  parseOverlayTemplate,
  sanitizeLabel,
  type DateFormatId,
  type DateTimeZoneChoice,
  type OverlayComponent,
  type OverlayRect,
  type OverlayShapeSetting,
  type OverlayTemplate,
  type SummaryStatKey,
  type TextAlign,
} from './template';

/**
 * AV-1010 (TD-061). The still overlay image: the route, figures from the
 * activity's summary, its date and free text, each placed where the reader
 * puts it, on a transparent background of a chosen size.
 *
 * The layout is an overlay template (AV-1003), the model the video overlays
 * use, so a layout is plain data, saves as JSON and reads back (a layout file
 * wraps the template with the image's size). Every element is placed by a
 * rectangle in fractions of the frame, as every video component is: a route's
 * rectangle is the box it is fitted in; a text's is the box its words take at
 * the size chosen, measured, so moving it and keeping it in the frame are the
 * same arithmetic for every kind. Nothing here draws: `export/drawStaticImage`
 * does, from the plan.
 */

/** An image layout: its size in pixels and the template placed on it. */
export interface StaticImageLayout {
  width: number;
  height: number;
  template: OverlayTemplate;
}

export const ROUTE_COMPONENT_ID = 'route';

/** The default route: the whole frame, padded and stroked as AV-1009's image is. */
export function defaultStaticLayout(width = DEFAULT_ROUTE_IMAGE_OPTIONS.width, height = DEFAULT_ROUTE_IMAGE_OPTIONS.height): StaticImageLayout {
  const shorter = Math.min(width, height);
  return {
    width,
    height,
    template: {
      version: OVERLAY_TEMPLATE_VERSION,
      name: 'Still image',
      style: { ...DEFAULT_OVERLAY_STYLE },
      components: [
        {
          id: ROUTE_COMPONENT_ID,
          type: 'routeInset',
          visible: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          unitMode: 'auto',
          style: { accentColor: DEFAULT_ROUTE_IMAGE_OPTIONS.color },
          route: {
            lineWidth: DEFAULT_ROUTE_IMAGE_OPTIONS.lineWidth / shorter,
            padding: DEFAULT_ROUTE_IMAGE_OPTIONS.paddingFraction,
            markers: DEFAULT_ROUTE_IMAGE_OPTIONS.markers,
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// What the activity says

export interface StillImageContext {
  activity: Activity;
  /** The route read from the activity (`extractRoute`), or why there is none. */
  route: { ok: true; route: RouteGeometry } | { ok: false; error: RouteImageError };
  units: UnitSystem;
  /** The reader's IANA time zone; the browser's own by default. */
  readerTimeZone?: string;
}

export type StaticValue =
  | { ok: true; caption: string; value: string }
  | { ok: false; reason: string };

const SUMMARY_CAPTIONS: Record<SummaryStatKey, string> = {
  speed: 'Avg speed',
  pace: 'Avg pace',
  distance: 'Distance',
  elapsed: 'Elapsed time',
  moving: 'Moving time',
};

/**
 * A figure from the activity's summary, in the reader's units, or why the
 * activity cannot supply it. Speed and pace are over moving time where there
 * is one (TD-058), and over elapsed time otherwise, and say which.
 */
export function summaryValue(stat: SummaryStatKey, activity: Activity, units: UnitSystem): StaticValue {
  const derived = activity.derived;
  const missing = (reason: string): StaticValue => ({ ok: false, reason });
  switch (stat) {
    case 'speed': {
      const moving = derived?.averageMovingSpeedMetersPerSecond;
      const value = moving ?? derived?.averageSpeedMetersPerSecond;
      if (value === undefined) return missing('This activity has no average speed: it needs both a distance and a time.');
      return { ok: true, caption: moving !== undefined ? 'Avg speed' : 'Avg speed (elapsed)', value: formatSpeed(value, units) };
    }
    case 'pace': {
      const moving = derived?.averageMovingPaceSecondsPerKm;
      const value = moving ?? derived?.averagePaceSecondsPerKm;
      if (value === undefined) return missing('This activity has no average pace: it needs both a distance and a time, and some movement.');
      return { ok: true, caption: moving !== undefined ? 'Avg pace' : 'Avg pace (elapsed)', value: formatPace(value, units) };
    }
    case 'distance':
      return derived?.distanceMeters === undefined
        ? missing('This activity has no distance: it has no GPS positions or recorded distance.')
        : { ok: true, caption: 'Distance', value: formatDistance(derived.distanceMeters, units) };
    case 'elapsed':
      return derived?.durationSeconds === undefined
        ? missing('This activity has no elapsed time: it has no timestamps.')
        : { ok: true, caption: 'Elapsed time', value: formatDuration(derived.durationSeconds) };
    case 'moving':
      return derived?.movingDurationSeconds === undefined
        ? missing('This activity has no moving time: it needs timestamps and a distance, and some movement.')
        : { ok: true, caption: 'Moving time', value: formatDuration(derived.movingDurationSeconds) };
  }
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Where a date is read: an offset the file states, or a named time zone. */
export type DateZone = { kind: 'offset'; minutes: number } | { kind: 'zone'; timeZone: string };

interface CivilTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The calendar date and clock time of an instant in a zone. */
function civil(date: Date, zone: DateZone): CivilTime {
  if (zone.kind === 'offset') {
    const shifted = new Date(date.getTime() + zone.minutes * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone.timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute') };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A date as one of the four formats, written the same in every browser: the
 * month and weekday names are this module's, not the locale's, so `24 Sep 2026`
 * does not become `24 Sept 2026` where a locale prefers it. A time is 24-hour.
 */
export function formatStillDate(date: Date, format: DateFormatId, withTime: boolean, zone: DateZone): string {
  const { year, month, day, hour, minute } = civil(date, zone);
  const time = `${pad(hour)}:${pad(minute)}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  switch (format) {
    case 'iso':
      return `${year}-${pad(month)}-${pad(day)}${withTime ? ` ${time}` : ''}`;
    case 'medium':
      return `${day} ${MONTHS_SHORT[month - 1]} ${year}${withTime ? `, ${time}` : ''}`;
    case 'numeric':
      return `${pad(day)}/${pad(month)}/${year}${withTime ? ` ${time}` : ''}`;
    case 'long':
      return `${weekday} ${day} ${MONTHS_LONG[month - 1]} ${year}${withTime ? `, ${time}` : ''}`;
  }
}

export const DATE_FORMAT_LABELS: Record<DateFormatId, string> = {
  iso: '2026-09-24',
  medium: '24 Sep 2026',
  numeric: '24/09/2026',
  long: 'Thursday 24 September 2026',
};

/** `UTC+09:00`, `UTC−03:30`, `UTC`. */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '−' : '+';
  const total = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function readerTimeZoneOf(context: Pick<StillImageContext, 'readerTimeZone'>): string {
  return context.readerTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** What each time-zone choice means for this activity, as the control states it, or why it cannot be had. */
export function dateZoneChoice(
  choice: DateTimeZoneChoice,
  context: Pick<StillImageContext, 'activity' | 'readerTimeZone'>,
): { ok: true; zone: DateZone; description: string } | { ok: false; reason: string } {
  if (choice === 'activity') {
    const minutes = context.activity.metadata.utcOffsetMinutes;
    return minutes === undefined
      ? {
          ok: false,
          reason: 'The file does not say which time zone it was recorded in, so the activity’s own time cannot be shown.',
        }
      : { ok: true, zone: { kind: 'offset', minutes }, description: `${formatUtcOffset(minutes)}, as the file states` };
  }
  const timeZone = readerTimeZoneOf(context);
  return { ok: true, zone: { kind: 'zone', timeZone }, description: `Your time zone, ${timeZone}` };
}

/** The activity's start date as the component asks for it, or why it cannot be shown. */
export function dateValue(component: OverlayComponent, context: StillImageContext): StaticValue {
  const start = context.activity.derived?.startTime;
  if (!(start instanceof Date)) return { ok: false, reason: 'This activity has no timestamps, so it has no date.' };
  const setting = component.date ?? { format: 'medium', withTime: false, timeZone: 'reader' };
  const zone = dateZoneChoice(setting.timeZone, context);
  if (!zone.ok) return { ok: false, reason: zone.reason };
  return { ok: true, caption: 'Date', value: formatStillDate(start, setting.format, setting.withTime, zone.zone) };
}

/** What a still-image text, figure or date reads as, or why it cannot be drawn. */
export function stillValue(component: OverlayComponent, context: StillImageContext): StaticValue {
  switch (component.type) {
    case 'label':
      return (component.content ?? '').trim() === ''
        ? { ok: false, reason: 'This text is empty.' }
        : { ok: true, caption: '', value: sanitizeLabel(component.content ?? '') };
    case 'summary':
      return component.summary
        ? summaryValue(component.summary.stat, context.activity, context.units)
        : { ok: false, reason: 'This figure names no statistic.' };
    case 'date':
      return dateValue(component, context);
    default:
      return { ok: false, reason: 'This component is drawn only on a video.' };
  }
}

/** Every element the reader can add, each with whether this activity can supply it and why not. */
export interface StillElementChoice {
  key: SummaryStatKey | 'date' | 'label' | 'route';
  label: string;
  available: boolean;
  reason?: string;
}

export function stillElementChoices(context: StillImageContext): StillElementChoice[] {
  const figures = (['distance', 'speed', 'pace', 'elapsed', 'moving'] as const).map((stat) => {
    const value = summaryValue(stat, context.activity, context.units);
    return { key: stat, label: SUMMARY_CAPTIONS[stat], available: value.ok, ...(value.ok ? {} : { reason: value.reason }) };
  });
  const hasDate = context.activity.derived?.startTime instanceof Date;
  return [
    { key: 'route', label: 'Route', available: context.route.ok, ...(context.route.ok ? {} : { reason: context.route.error.message }) },
    ...figures,
    hasDate
      ? { key: 'date', label: 'Date', available: true }
      : { key: 'date', label: 'Date', available: false, reason: 'This activity has no timestamps, so it has no date.' },
    { key: 'label', label: 'Text', available: true },
  ];
}

const SHAPE_LABELS: Record<OverlayShapeSetting['kind'], string> = {
  roundedRect: 'Rounded rectangle',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
};

/** How a component is named in the list of elements. */
export function describeStillComponent(component: OverlayComponent): string {
  switch (component.type) {
    case 'routeInset':
      return 'Route';
    case 'shape':
      return component.shape ? SHAPE_LABELS[component.shape.kind] : 'Shape';
    case 'summary':
      return component.summary ? SUMMARY_CAPTIONS[component.summary.stat] : 'Figure';
    case 'date':
      return 'Date';
    case 'label': {
      const first = (component.content ?? '').split('\n')[0]!.trim();
      return first ? `Text: ${first.length > 24 ? `${first.slice(0, 23)}…` : first}` : 'Text';
    }
    default:
      return component.type;
  }
}

// ---------------------------------------------------------------------------
// The plan: every element in pixels, inside the frame

/** Width, in pixels, of a text in a CSS font; a canvas's `measureText` in the browser. */
export type MeasureText = (text: string, font: string) => number;

/** The type the still image is drawn in: the system's, never a font fetched from anywhere. */
export const STILL_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlannedLine {
  text: string;
  /** A CSS font. */
  font: string;
  /** Pixels. */
  size: number;
  /** Where the line is anchored for its alignment, and its top. */
  x: number;
  y: number;
  /** A caption, drawn quieter than its value. */
  caption: boolean;
}

export type PlannedStillItem =
  | { kind: 'route'; id: string; box: Box; plan: RouteImagePlan }
  /** AV-1011. A shape, drawn as the video overlay draws it. */
  | { kind: 'shape'; id: string; box: Box; shape: OverlayShapeSetting }
  | {
      kind: 'text';
      id: string;
      box: Box;
      lines: PlannedLine[];
      color: string;
      align: TextAlign;
      /** The type was made smaller than chosen, to fit the frame. */
      shrunk: boolean;
    };

export interface StillImagePlan {
  width: number;
  height: number;
  items: PlannedStillItem[];
  /** Elements that are not drawn, and why: data the activity lacks, an empty text. */
  hidden: { id: string; label: string; reason: string }[];
  notes: string[];
}

export type PlanStillImageResult = { ok: true; plan: StillImagePlan } | { ok: false; error: RouteImageError };

const LINE_HEIGHT = 1.2;
const CAPTION_SIZE = 0.45;

/** A text's type size in pixels: the same base as a video figure's, in frame widths. */
export function stillFontPx(component: OverlayComponent, width: number): number {
  const scale = component.style.fontScale ?? DEFAULT_OVERLAY_STYLE.fontScale;
  return (BASE_FONT_CQW / 100) * width * scale;
}

/**
 * Lays the layout out in pixels. Every text is measured, made smaller only if
 * it is wider or taller than the frame itself, and kept inside the frame; the
 * route is fitted into its box as AV-1009 fits it into the whole image.
 * Elements whose data the activity lacks are not drawn, and are listed with
 * why. A size or a route style that cannot be drawn is an error; so is a
 * layout with nothing at all to draw.
 */
export function planStillImage(
  layout: StaticImageLayout,
  context: StillImageContext,
  measure: MeasureText,
): PlanStillImageResult {
  const { width, height } = layout;
  const sizeProblem = checkImageSize(width, height);
  if (sizeProblem) return { ok: false, error: sizeProblem };

  const items: PlannedStillItem[] = [];
  const hidden: StillImagePlan['hidden'] = [];
  const notes: string[] = [];
  let routeError: RouteImageError | undefined;

  for (const component of layout.template.components) {
    if (!component.visible) continue;
    const label = describeStillComponent(component);

    if (component.type === 'routeInset') {
      if (!context.route.ok) {
        routeError = context.route.error;
        hidden.push({ id: component.id, label, reason: context.route.error.message });
        continue;
      }
      const planned = planRouteItem(component, layout, context.route.route);
      if (!planned.ok) return planned;
      items.push(planned.item);
      notes.push(...planned.item.plan.notes);
      continue;
    }

    if (component.type === 'shape' && component.shape) {
      const r = normalizeRect(component.rect);
      items.push({
        kind: 'shape',
        id: component.id,
        box: { x: r.x * width, y: r.y * height, w: r.width * width, h: r.height * height },
        shape: component.shape,
      });
      continue;
    }
    if (!STILL_IMAGE_COMPONENT_TYPES.includes(component.type)) {
      hidden.push({ id: component.id, label, reason: 'It is drawn only on a video, where it has a moment to show.' });
      continue;
    }
    const value = stillValue(component, context);
    if (!value.ok) {
      hidden.push({ id: component.id, label, reason: value.reason });
      continue;
    }
    const color = component.style.textColor ?? DEFAULT_OVERLAY_STYLE.textColor;
    if (!isHexColor(color)) {
      return { ok: false, error: new RouteImageError('invalid_style', 'A text colour must be a hex colour such as #ffffff.') };
    }
    const item = layoutStillText(component, value, color, layout, measure);
    if (item.shrunk) notes.push(`${label} was set smaller than chosen, to fit inside the image.`);
    items.push(item);
  }

  if (items.length === 0) {
    return {
      ok: false,
      error:
        routeError && hidden.length === 1
          ? routeError
          : new RouteImageError('render_failed', 'There is nothing to draw: add the route, a figure, the date or a text.'),
    };
  }
  return { ok: true, plan: { width, height, items, hidden, notes } };
}

function planRouteItem(
  component: OverlayComponent,
  layout: StaticImageLayout,
  route: RouteGeometry,
): { ok: true; item: Extract<PlannedStillItem, { kind: 'route' }> } | { ok: false; error: RouteImageError } {
  const { width, height } = layout;
  const shorter = Math.min(width, height);
  // Edges, not sizes, are rounded, so a box that ends at the frame's edge ends there in pixels too.
  const left = Math.round(component.rect.x * width);
  const top = Math.round(component.rect.y * height);
  const right = Math.min(width, Math.round((component.rect.x + component.rect.width) * width));
  const bottom = Math.min(height, Math.round((component.rect.y + component.rect.height) * height));
  const boxW = right - left;
  const boxH = bottom - top;
  if (boxW < ROUTE_IMAGE_LIMITS.minSide || boxH < ROUTE_IMAGE_LIMITS.minSide) {
    return {
      ok: false,
      error: new RouteImageError(
        'no_room',
        `The route’s box is ${boxW} × ${boxH} pixels; it needs at least ${ROUTE_IMAGE_LIMITS.minSide} on each side. Make it larger, or the image larger.`,
      ),
    };
  }
  const setting = component.route ?? {
    lineWidth: DEFAULT_ROUTE_IMAGE_OPTIONS.lineWidth / shorter,
    padding: DEFAULT_ROUTE_IMAGE_OPTIONS.paddingFraction,
    markers: DEFAULT_ROUTE_IMAGE_OPTIONS.markers,
  };
  // The padding is a share of the image's shorter side, as the route image's
  // is; inside a smaller box it is the same number of pixels.
  const paddingFraction = (setting.padding * shorter) / Math.min(boxW, boxH);
  const planned = planRouteImage(route, {
    width: boxW,
    height: boxH,
    paddingFraction,
    color: component.style.accentColor ?? DEFAULT_ROUTE_IMAGE_OPTIONS.color,
    lineWidth: Math.round(setting.lineWidth * shorter * 100) / 100,
    markers: setting.markers,
  });
  if (!planned.ok) return { ok: false, error: planned.error };
  const x0 = left;
  const y0 = top;
  const move = ([x, y]: [number, number]): [number, number] => [x + x0, y + y0];
  const plan: RouteImagePlan = {
    ...planned.plan,
    width,
    height,
    runs: planned.plan.runs.map((run) => run.map(move)),
    dots: planned.plan.dots.map(move),
    ...(planned.plan.start ? { start: move(planned.plan.start) } : {}),
    ...(planned.plan.end ? { end: move(planned.plan.end) } : {}),
  };
  return { ok: true, item: { kind: 'route', id: component.id, box: { x: left, y: top, w: boxW, h: boxH }, plan } };
}

const fontOf = (weight: 'normal' | 'bold' | number, size: number) =>
  `${weight === 'bold' ? 700 : weight === 'normal' ? 400 : weight} ${Math.round(size * 100) / 100}px ${STILL_FONT_FAMILY}`;

/**
 * A still text, figure or date set in its box: measured, made smaller only if
 * it is larger than the frame, and kept inside it. The video overlay's
 * renderer sets these the same way (AV-1011), with the canvas's own measure.
 */
export function layoutStillText(
  component: OverlayComponent,
  value: Extract<StaticValue, { ok: true }>,
  color: string,
  layout: Pick<StaticImageLayout, 'width' | 'height'>,
  measure: MeasureText,
): Extract<PlannedStillItem, { kind: 'text' }> {
  const { width, height } = layout;
  const setting = component.text ?? { align: 'left' as const, weight: 'bold' as const };
  const caption = component.type === 'summary' && setting.caption !== false ? value.caption.toUpperCase() : undefined;
  const valueLines = value.value.split('\n');

  const lay = (size: number) => {
    const rows: { text: string; size: number; font: string; caption: boolean }[] = [];
    if (caption) rows.push({ text: caption, size: size * CAPTION_SIZE, font: fontOf(600, size * CAPTION_SIZE), caption: true });
    for (const text of valueLines) rows.push({ text, size, font: fontOf(setting.weight, size), caption: false });
    const w = Math.max(...rows.map((row) => measure(row.text, row.font)), 1);
    const h = rows.reduce((total, row) => total + row.size * LINE_HEIGHT, 0);
    return { rows, w, h };
  };

  const chosen = stillFontPx(component, width);
  let laid = lay(chosen);
  // Only a text larger than the frame itself is made smaller; anything that
  // fits is moved back inside instead, below.
  const fit = Math.min(1, width / laid.w, height / laid.h);
  const shrunk = fit < 1;
  if (shrunk) laid = lay(chosen * fit * 0.98);

  const x = clamp(component.rect.x * width, 0, width - laid.w);
  const y = clamp(component.rect.y * height, 0, height - laid.h);
  const anchor = setting.align === 'center' ? x + laid.w / 2 : setting.align === 'right' ? x + laid.w : x;
  let top = y;
  const lines: PlannedLine[] = laid.rows.map((row) => {
    const line = { text: row.text, font: row.font, size: row.size, x: anchor, y: top, caption: row.caption };
    top += row.size * LINE_HEIGHT;
    return line;
  });
  return {
    kind: 'text',
    id: component.id,
    box: { x, y, w: laid.w, h: laid.h },
    lines,
    color,
    align: setting.align,
    shrunk,
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));


// ---------------------------------------------------------------------------
// Placing: every move keeps the element inside the frame

/** An element's box as fractions of the frame, from the plan (a text's measured size) or its rect. */
export function placedRect(plan: StillImagePlan | undefined, component: OverlayComponent): OverlayRect {
  const item = plan?.items.find((entry) => entry.id === component.id);
  if (!item || !plan) return component.rect;
  return normalizeRect({
    x: item.box.x / plan.width,
    y: item.box.y / plan.height,
    width: item.box.w / plan.width,
    height: item.box.h / plan.height,
  });
}

/** The rect moved to a top-left corner, kept inside the frame. Rounded to 0.01 % so a value reads back as typed. */
export function moveRect(rect: OverlayRect, x: number, y: number): OverlayRect {
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    ...rect,
    x: round(clamp(x, 0, 1 - rect.width)),
    y: round(clamp(y, 0, 1 - rect.height)),
  };
}

export function nudgeRect(rect: OverlayRect, dx: number, dy: number): OverlayRect {
  return moveRect(rect, rect.x + dx, rect.y + dy);
}

export type SnapPosition =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export const SNAP_POSITIONS: readonly { id: SnapPosition; label: string }[] = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top', label: 'Top' },
  { id: 'top-right', label: 'Top right' },
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'bottom-right', label: 'Bottom right' },
];

/** The margin kept from an edge a rect is snapped to, as a fraction of the frame. */
export const SNAP_MARGIN = 0.04;

/** The rect moved to an edge, a corner or the centre, `SNAP_MARGIN` in from the edges it touches. */
export function snapRect(rect: OverlayRect, position: SnapPosition): OverlayRect {
  const horizontal = position.endsWith('left') ? 'start' : position.endsWith('right') ? 'end' : 'middle';
  const vertical = position.startsWith('top') ? 'start' : position.startsWith('bottom') ? 'end' : 'middle';
  const place = (side: 'start' | 'middle' | 'end', size: number) =>
    side === 'start' ? Math.min(SNAP_MARGIN, 1 - size) : side === 'end' ? Math.max(0, 1 - size - SNAP_MARGIN) : (1 - size) / 2;
  return moveRect(rect, place(horizontal, rect.width), place(vertical, rect.height));
}

/** The topmost element under a point of the image, in pixels; the one drawn last is on top. */
export function itemAt(plan: StillImagePlan, x: number, y: number): string | undefined {
  for (let i = plan.items.length - 1; i >= 0; i -= 1) {
    const { box, id } = plan.items[i]!;
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The layout file

export const LAYOUT_FILE_KIND = 'opentrack-overlay-layout';
export const LAYOUT_FILE_VERSION = 1;
/** Larger than any layout a person makes; a guard against reading a wrong file whole. */
export const LAYOUT_FILE_MAX_BYTES = 256 * 1024;

/**
 * The layout as a JSON file: its size, and the overlay template. It holds the
 * reader's layout and the words they typed, and nothing of the activity: no
 * place, no time, no figure.
 */
export function serializeStillLayout(layout: StaticImageLayout): string {
  return JSON.stringify(
    {
      kind: LAYOUT_FILE_KIND,
      version: LAYOUT_FILE_VERSION,
      image: { width: layout.width, height: layout.height },
      template: {
        ...layout.template,
        components: layout.template.components.map((component) => ({ ...component, rect: normalizeRect(component.rect) })),
      },
    },
    null,
    2,
  );
}

export type ParseStillLayoutResult =
  | { ok: true; layout: StaticImageLayout; warnings: string[] }
  | { ok: false; error: string };

/**
 * AV-1011. A layout file as it is, every component kept: what the custom
 * canvas opens. The still image filters it further (`parseStillLayout`).
 */
export function parseOverlayLayout(json: string): ParseStillLayoutResult {
  if (json.length > LAYOUT_FILE_MAX_BYTES) return { ok: false, error: 'This file is too large to be a layout.' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'This file is not valid JSON, so it is not a layout.' };
  }
  if (typeof raw !== 'object' || raw === null || (raw as { kind?: unknown }).kind !== LAYOUT_FILE_KIND) {
    return { ok: false, error: 'This file is not an OpenTrack overlay layout.' };
  }
  const file = raw as { version?: unknown; image?: { width?: unknown; height?: unknown }; template?: unknown };
  if (file.version !== LAYOUT_FILE_VERSION) {
    return { ok: false, error: `This layout is version ${String(file.version)}, which this app cannot read.` };
  }
  const width = Number(file.image?.width);
  const height = Number(file.image?.height);
  const sizeProblem = checkImageSize(width, height);
  if (sizeProblem) return { ok: false, error: `The layout’s image size cannot be used. ${sizeProblem.message}` };

  const parsed = parseOverlayTemplate(JSON.stringify(file.template ?? null));
  if (!parsed.ok) return { ok: false, error: `The layout’s template cannot be read. ${parsed.error}` };
  return { ok: true, layout: { width, height, template: parsed.template }, warnings: parsed.warnings };
}

/**
 * A layout file for the still image: a video's live components (a moving
 * figure, a gauge, a progress bar) are left out with a warning each, and so is
 * a second route; texts, figures, dates, shapes and the route are kept.
 */
export function parseStillLayout(json: string): ParseStillLayoutResult {
  const read = parseOverlayLayout(json);
  if (!read.ok) return read;
  const parsed = { template: read.layout.template };
  const { width, height } = read.layout;
  const warnings = [...read.warnings];
  const components: OverlayComponent[] = [];
  let routes = 0;
  for (const component of parsed.template.components) {
    if (component.type === 'routeInset') {
      routes += 1;
      if (routes > 1) {
        warnings.push('A second route was left out: the image has one route.');
        continue;
      }
      components.push({ ...component, id: ROUTE_COMPONENT_ID });
      continue;
    }
    if (!STILL_IMAGE_COMPONENT_TYPES.includes(component.type) && component.type !== 'shape') {
      warnings.push(`${describeStillComponent(component)} was left out: it is drawn only on a video.`);
      continue;
    }
    components.push(component);
  }
  // A component held by a shape that was left out is simply free.
  const kept = new Set(components.map((component) => component.id));
  for (const component of components) if (component.parentId && !kept.has(component.parentId)) delete component.parentId;
  return { ok: true, layout: { width, height, template: { ...parsed.template, components } }, warnings };
}

/** An id no component of the template has yet: `text-1`, `text-2`, … */
export function freshComponentId(template: OverlayTemplate, prefix: string): string {
  const taken = new Set(template.components.map((component) => component.id));
  for (let n = 1; ; n += 1) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

/** A new element of a kind, where a new one is put: the top-left, snapped in from the edges. */
export function newStillComponent(
  template: OverlayTemplate,
  key: StillElementChoice['key'],
  layout: Pick<StaticImageLayout, 'width' | 'height'>,
): OverlayComponent {
  const base = { visible: true, unitMode: 'auto' as const };
  const at = { x: SNAP_MARGIN, y: SNAP_MARGIN, width: 0.01, height: 0.01 };
  if (key === 'route') {
    return { ...defaultStaticLayout(layout.width, layout.height).template.components[0]!, ...base };
  }
  const textStyle = { textColor: DEFAULT_OVERLAY_STYLE.textColor, fontScale: 2 };
  if (key === 'label') {
    return {
      ...base,
      id: freshComponentId(template, 'text'),
      type: 'label',
      rect: at,
      style: textStyle,
      content: 'Text',
      text: { align: 'left', weight: 'bold' },
    };
  }
  if (key === 'date') {
    return {
      ...base,
      id: freshComponentId(template, 'date'),
      type: 'date',
      rect: at,
      style: { ...textStyle, fontScale: 1.5 },
      date: { format: 'medium', withTime: false, timeZone: 'reader' },
      text: { align: 'left', weight: 'bold' },
    };
  }
  return {
    ...base,
    id: freshComponentId(template, key),
    type: 'summary',
    rect: at,
    style: textStyle,
    summary: { stat: key },
    text: { align: 'left', weight: 'bold', caption: true },
  };
}
