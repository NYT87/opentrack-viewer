import type { OverlayDialSetting } from './template';
import { dataSourceId, type OverlayDataSource, type OverlayTimeline } from './timeline';

/**
 * AV-1019 (TD-087). The dial gauge: the pure part. Its defaults and limits, the
 * range an activity gives it, where its needle points and where its ticks are.
 * Nothing here draws; the renderer, the editor, the layout parser and the
 * contract all call it, so they cannot disagree about a dial.
 */

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
 */
export function activityRange(
  timeline: Pick<OverlayTimeline, 'rangeOf'>,
  source: OverlayDataSource,
): { min: number; max: number } | undefined {
  const seen = timeline.rangeOf?.(source);
  if (!seen) return undefined;
  return niceRange(seen.min, seen.max, NON_NEGATIVE.has(dataSourceId(source)));
}

export function niceRange(low: number, high: number, nonNegative: boolean): { min: number; max: number } {
  const step = niceStep(high - low);
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
}

/**
 * The ticks of a dial: a major one every `majorStep` of the range from its
 * start (the step found for the range when it is not given), and `minorTicks`
 * between each pair, the last major at the range's end where the step divides
 * the range. The count is bounded, so a tiny step is raised and not drawn.
 */
export function dialTicks(range: { min: number; max: number }, setting: Pick<OverlayDialSetting, 'majorStep' | 'minorTicks'>): DialTick[] {
  const span = range.max - range.min;
  if (!(span > 0)) return [];
  const wanted = setting.majorStep !== undefined && setting.majorStep > 0 ? setting.majorStep : niceStep(span);
  const step = Math.max(wanted, span / DIAL_LIMITS.majorTicks);
  const minor = Math.min(DIAL_LIMITS.minorTicks.max, Math.max(0, Math.round(setting.minorTicks)));
  const ticks: DialTick[] = [];
  const majors = Math.floor(span / step + 1e-9);
  for (let i = 0; i <= majors; i += 1) {
    ticks.push({ fraction: (i * step) / span, major: true });
    if (i === majors) break;
    for (let k = 1; k <= minor; k += 1) {
      const fraction = (i * step + (k * step) / (minor + 1)) / span;
      if (fraction < 1 - 1e-9) ticks.push({ fraction, major: false });
    }
  }
  // Where the step does not divide the range its last stretch has no ticks, and none is drawn past the end.
  return ticks.filter((tick) => tick.fraction <= 1 + 1e-9);
}
