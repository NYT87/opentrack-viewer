import { METERS_PER_MILE, type UnitSystem } from '../domain/units';
import type { OverlayDialSetting } from './template';
import { dataSourceId, type OverlayDataSource, type OverlayMetricKey, type OverlayTimeline } from './timeline';

/**
 * AV-1019 (TD-087). The dial gauge: the pure part. Its defaults and limits, the
 * range an activity gives it, where its needle points and where its ticks are.
 * Nothing here draws; the renderer, the editor, the layout parser and the
 * contract all call it, so they cannot disagree about a dial.
 *
 * AV-1020 (TD-089). What is stored stays in the stored units (m/s, s/km: the
 * range, the major step), so a layout opens the same in either system. What the
 * reader types, and the numbers beside the ticks, are in the units the dial's
 * figure is shown in: `toDialUnits` and `fromDialUnits` convert, and the ticks
 * and the range found from an activity are rounded in those units.
 */

/**
 * A stored value of a dial's metric, in the units it is shown in: speed in km/h or
 * mph, pace in seconds per kilometre or per mile; everything else, and a camera
 * stream, is as stored. Linear, so it converts a step and a span as it does a value.
 */
export function toDialUnits(metric: OverlayMetricKey | undefined, value: number, units: UnitSystem): number {
  if (metric === 'speed') return units === 'imperial' ? (value * 3600) / METERS_PER_MILE : (value * 3600) / 1000;
  if (metric === 'pace') return units === 'imperial' ? (value * METERS_PER_MILE) / 1000 : value;
  return value;
}

/** The stored value of one typed in the units the dial is shown in; the inverse of `toDialUnits`. */
export function fromDialUnits(metric: OverlayMetricKey | undefined, value: number, units: UnitSystem): number {
  if (metric === 'speed') return units === 'imperial' ? (value * METERS_PER_MILE) / 3600 : (value * 1000) / 3600;
  if (metric === 'pace') return units === 'imperial' ? (value * 1000) / METERS_PER_MILE : value;
  return value;
}

/** What a typed or stored number is in once converted, for a speed or a pace; `undefined` for the rest, whose unit is the stored one. */
export function dialUnitLabel(metric: OverlayMetricKey | undefined, units: UnitSystem): string | undefined {
  if (metric === 'speed') return units === 'imperial' ? 'mph' : 'km/h';
  if (metric === 'pace') return units === 'imperial' ? 'min/mi' : 'min/km';
  return undefined;
}

/** Floating-point noise from a conversion: 10.000000000000002 km/h is not a bound. */
const tidy = (value: number) => Math.round(value * 1e9) / 1e9;
/** The same for a stored value, kept finer so that converting it back is exact to the digit shown. */
const tidyStored = (value: number) => Math.round(value * 1e12) / 1e12;

/** Converts a stored value for a dial, tidied. */
export const storedToDial = (metric: OverlayMetricKey | undefined, value: number, units: UnitSystem) => tidy(toDialUnits(metric, value, units));
/** Converts a typed value to the stored unit, tidied. */
export const dialToStored = (metric: OverlayMetricKey | undefined, value: number, units: UnitSystem) => tidyStored(fromDialUnits(metric, value, units));


/** The sweep is the arc's opening angle, in degrees; the arc is centred at the top. */
export const DIAL_LIMITS = {
  sweep: { min: 180, max: 300 },
  minorTicks: { min: 0, max: 9 },
  /** The most major ticks a dial has: a smaller step than the range allows is raised to it, so a mistyped step cannot be a million lines a frame. */
  majorTicks: 50,
} as const;

export const DEFAULT_DIAL: OverlayDialSetting = {
  sweep: 240,
  minorTicks: 4,
  pointer: 'needle',
  trackColor: '#6b7280',
  fillColor: '#ff6a00',
  needleColor: '#ffffff',
};

/**
 * The angle of a value's place on the dial, in radians as the canvas takes them
 * (0 is east, clockwise): the arc starts at the top minus half the sweep and
 * runs `sweep` degrees clockwise, so it is centred at the top. The fraction is
 * pinned to 0..1, so a value beyond the range sits at its end.
 */
export function dialAngle(sweepDegrees: number, fraction: number): number {
  const pinned = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const sweep = (sweepDegrees * Math.PI) / 180;
  return -Math.PI / 2 - sweep / 2 + sweep * pinned;
}

/** Where a value falls in a range, 0..1, pinned at its ends. */
export function rangeFraction(value: number, range: { min: number; max: number }): number {
  const span = range.max - range.min;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (value - range.min) / span));
}

const NICE = [1, 2, 5] as const;

/** The smallest of 1, 2 or 5 times a power of ten that is at least `value`. */
function niceCeil(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  for (const factor of NICE) if (factor * power >= value * (1 - 1e-12)) return factor * power;
  return 10 * power;
}

/** Most intervals a range is divided into when its step is found for it. */
const MAX_INTERVALS = 8;

/** The step (1, 2 or 5 times a power of ten) that divides a span into at most eight intervals. */
export function niceStep(span: number): number {
  return span > 0 && Number.isFinite(span) ? niceCeil(span / MAX_INTERVALS) : 1;
}

/** AV-1020. The steps of a pace dial, in seconds: ones a runner reads (every 30 s, every minute). */
const PACE_STEPS = [5, 10, 15, 20, 30, 60, 120, 300, 600] as const;

/** The step in seconds that divides a pace span into at most eight intervals. */
export function paceStep(span: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return 60;
  const wanted = span / MAX_INTERVALS;
  return PACE_STEPS.find((step) => step >= wanted * (1 - 1e-12)) ?? Math.ceil(wanted / 600) * 600;
}

/** The automatic step for a span in a metric's dial units. */
function autoStep(metric: OverlayMetricKey | undefined, span: number): number {
  return metric === 'pace' ? paceStep(span) : niceStep(span);
}

/** Metrics that cannot go below zero: their default range starts there at the lowest. */
const NON_NEGATIVE = new Set<string>([
  'metric:speed',
  'metric:pace',
  'metric:distance',
  'metric:heartRate',
  'metric:runningCadence',
  'metric:cyclingCadence',
  'metric:power',
  'metric:elapsed',
  'metric:moving',
  'metric:climb',
  'metric:heading',
]);

/**
 * The range an activity gives a figure: its lowest and highest value for the
 * source, rounded outward to a step of 1, 2 or 5 times a power of ten, the
 * lowest never under zero for a figure that cannot go there. `undefined` when
 * the activity has no value for the source. A flat figure gets one step of room
 * above it.
 *
 * AV-1020. Rounded in the units the dial is shown in (`units`, metric where not
 * said): a speed in whole steps of km/h or mph, a pace in seconds, and given back
 * in the stored units.
 */
export function activityRange(
  timeline: Pick<OverlayTimeline, 'rangeOf'>,
  source: OverlayDataSource,
  units: UnitSystem = 'metric',
): { min: number; max: number } | undefined {
  const seen = timeline.rangeOf?.(source);
  if (!seen) return undefined;
  const metric = source.kind === 'metric' ? source.metric : undefined;
  const shown = niceRange(
    toDialUnits(metric, seen.min, units),
    toDialUnits(metric, seen.max, units),
    NON_NEGATIVE.has(dataSourceId(source)),
    metric,
  );
  return { min: dialToStored(metric, shown.min, units), max: dialToStored(metric, shown.max, units) };
}

export function niceRange(low: number, high: number, nonNegative: boolean, metric?: OverlayMetricKey): { min: number; max: number } {
  const step = autoStep(metric, high - low);
  let min = Math.floor(low / step + 1e-9) * step;
  let max = Math.ceil(high / step - 1e-9) * step;
  if (nonNegative) min = Math.max(0, min);
  if (!(max > min)) max = min + step;
  // Floating-point noise from the multiplication: 0.30000000000000004 is not a bound.
  const clean = (value: number) => Math.round(value * 1e9) / 1e9;
  return { min: clean(min), max: clean(max) };
}

export interface DialTick {
  /** 0..1 along the arc. */
  fraction: number;
  major: boolean;
  /** AV-1020. A major tick's value in the units the dial is shown in; the number written beside it. */
  value?: number;
}

/** What the ticks are worked out in: the dial's metric and the units its figure is shown in. Without it, the stored units. */
export interface DialDisplay {
  metric?: OverlayMetricKey;
  units: UnitSystem;
}

/**
 * The major step of a dial in the units it is shown in: the typed one (stored in
 * the stored unit, converted), or the one found for the range, raised so there are
 * at most `DIAL_LIMITS.majorTicks` of them.
 */
export function dialMajorStep(range: { min: number; max: number }, setting: Pick<OverlayDialSetting, 'majorStep'>, display?: DialDisplay): number {
  const metric = display?.metric;
  const units = display?.units ?? 'metric';
  const span = toDialUnits(metric, range.max, units) - toDialUnits(metric, range.min, units);
  const wanted = setting.majorStep !== undefined && setting.majorStep > 0 ? storedToDial(metric, setting.majorStep, units) : autoStep(metric, span);
  return Math.max(wanted, span / DIAL_LIMITS.majorTicks);
}

/**
 * The ticks of a dial: a major one every `majorStep` of the range from its
 * start (the step found for the range when it is not given), and `minorTicks`
 * between each pair, the last major at the range's end where the step divides
 * the range. The count is bounded, so a tiny step is raised and not drawn.
 *
 * AV-1020. The steps are found in the units the dial is shown in (`display`), and
 * a major tick carries its value there. The fractions are of the stored range, so
 * the units move the numbers and not the ticks' places on a range already stored.
 */
export function dialTicks(range: { min: number; max: number }, setting: Pick<OverlayDialSetting, 'majorStep' | 'minorTicks'>, display?: DialDisplay): DialTick[] {
  const metric = display?.metric;
  const units = display?.units ?? 'metric';
  const start = toDialUnits(metric, range.min, units);
  const span = toDialUnits(metric, range.max, units) - start;
  if (!(span > 0)) return [];
  const step = dialMajorStep(range, setting, display);
  const minor = Math.min(DIAL_LIMITS.minorTicks.max, Math.max(0, Math.round(setting.minorTicks)));
  const ticks: DialTick[] = [];
  // A tolerance wide enough for the noise a conversion leaves: 29.99999999 over 10 is three steps.
  const majors = Math.floor(span / step + 1e-6);
  for (let i = 0; i <= majors; i += 1) {
    ticks.push({ fraction: Math.min(1, (i * step) / span), major: true, value: tidy(start + i * step) });
    if (i === majors) break;
    for (let k = 1; k <= minor; k += 1) {
      const fraction = (i * step + (k * step) / (minor + 1)) / span;
      if (fraction < 1 - 1e-9) ticks.push({ fraction, major: false });
    }
  }
  // Where the step does not divide the range its last stretch has no ticks, and none is drawn past the end.
  return ticks.filter((tick) => tick.fraction <= 1 + 1e-9);
}

/**
 * The number written beside a major tick: a pace as m:ss, anything else with the
 * fewest decimals the step needs (none for a step of a whole number).
 */
export function dialTickLabel(metric: OverlayMetricKey | undefined, value: number, step: number): string {
  if (metric === 'pace') {
    const total = Math.max(0, Math.round(value));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  // A step of a whole number or more gives whole numbers, unless a tick is off the whole numbers
  // (a range stored in the other system's units): then one decimal, so a number is its tick's value.
  if (step >= 1) {
    const whole = Math.abs(value - Math.round(value)) < 0.05;
    return (whole ? Math.round(value) : Number(value.toFixed(1))).toString().replace(/^-0$/, '0');
  }
  let places = 0;
  while (places < 3 && Math.abs(step * 10 ** places - Math.round(step * 10 ** places)) > 1e-6) places += 1;
  return value.toFixed(places).replace(/^-0(\.0+)?$/, '0$1');
}
