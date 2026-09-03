import type { SeriesXAxis } from './series';
import { METERS_PER_MILE, formatDistance, formatDuration, type UnitSystem } from './units';

export interface AxisTick {
  value: number;
  label: string;
}

/** AV-514: distance ticks land on whole kilometres, or whole miles in imperial. */
export function distanceTickStep(units: UnitSystem): number {
  return units === 'imperial' ? METERS_PER_MILE : 1000;
}

/** AV-514: time ticks land on five-minute boundaries. */
export const TIME_TICK_STEP_SECONDS = 300;

/**
 * A readable step for the point-index fallback axis, which has no natural
 * unit: the smallest of 1/2/5 × 10^n that keeps the tick count sensible.
 */
function niceStep(range: number, target: number): number {
  if (range <= 0) return 1;
  const rough = range / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const multiple of [1, 2, 5, 10]) {
    const step = multiple * magnitude;
    if (step >= rough) return step;
  }
  return magnitude * 10;
}

/**
 * AV-514. Ticks are generated at fixed real-world intervals — every 1 km, every
 * 5 minutes — rather than by dividing the range into N parts, so a label always
 * means the same thing regardless of how long the activity is.
 *
 * Generation is independent of the available width; thinning for a narrow
 * viewport happens separately in `thinTicks`.
 */
export function buildXTicks(
  min: number,
  max: number,
  axis: SeriesXAxis,
  units: UnitSystem = 'metric',
): AxisTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];

  const step =
    axis === 'distance'
      ? distanceTickStep(units)
      : axis === 'time'
        ? TIME_TICK_STEP_SECONDS
        : niceStep(max - min, 6);

  const label = (value: number) => {
    if (axis === 'distance') return formatDistance(value, units);
    if (axis === 'time') return formatDuration(value);
    return String(Math.round(value));
  };

  const ticks: AxisTick[] = [];
  // Strictly inside the range: the ends are the endpoint labels' job, and a tick
  // sitting exactly on one would just print the same value twice.
  const first = Math.floor(min / step) * step + step;
  // A guard rather than a limit: an activity cannot legitimately need this many.
  for (let value = first, guard = 0; value < max && guard < 5000; value += step, guard += 1) {
    ticks.push({ value, label: label(value) });
  }
  return ticks;
}

export interface ThinnedTicks {
  /** Every generated tick; all of them get a mark on the axis. */
  ticks: AxisTick[];
  /** The subset whose labels fit without colliding. */
  labelled: AxisTick[];
}

/**
 * AV-514. Keeps every tick mark but drops labels that will not fit, taking
 * every Nth so the surviving labels stay evenly spaced. Generation is never
 * changed — only what gets written next to the marks.
 */
export function thinTicks(
  ticks: AxisTick[],
  min: number,
  max: number,
  availableWidth: number,
  minLabelSpacing: number,
): ThinnedTicks {
  if (ticks.length === 0 || availableWidth <= 0 || max <= min) {
    return { ticks, labelled: [] };
  }

  const pixelsPerUnit = availableWidth / (max - min);
  const spacing = ticks.length > 1 ? (ticks[1]!.value - ticks[0]!.value) * pixelsPerUnit : Infinity;
  const every = spacing >= minLabelSpacing ? 1 : Math.ceil(minLabelSpacing / Math.max(spacing, 1));

  return { ticks, labelled: ticks.filter((_, index) => index % every === 0) };
}

/**
 * Whether an endpoint label can be shown without colliding with the nearest
 * interval label. AV-514 keeps endpoints visible where they do not conflict.
 */
export function endpointFits(
  endpoint: number,
  labelled: AxisTick[],
  min: number,
  max: number,
  availableWidth: number,
  minLabelSpacing: number,
): boolean {
  if (labelled.length === 0 || max <= min || availableWidth <= 0) return true;
  const pixelsPerUnit = availableWidth / (max - min);
  return labelled.every(
    (tick) => Math.abs(tick.value - endpoint) * pixelsPerUnit >= minLabelSpacing,
  );
}
