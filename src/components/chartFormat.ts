import type { ChartSeries, SeriesXAxis } from '../domain/series';
import {
  elevationUnitLabel,
  formatDistance,
  formatDistanceOnScale,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  formatTemperature,
  paceUnitLabel,
  speedUnitLabel,
  temperatureUnitLabel,
  toDisplayElevation,
  toDisplayPace,
  toDisplaySpeed,
  toDisplayTemperature,
  type UnitSystem,
} from '../domain/units';

/*
 * How a chart series and its x-axis read as text. Shared by the chart, which
 * labels its axes with them, and the readout above the charts (TD-056), which
 * names the values at the cursor: one place, so the two never disagree about
 * what "52 m" or "8:02 /km" means.
 */

/**
 * A series measuring temperature, whichever it is.
 *
 * Matched on the recorded unit rather than on a list of keys: `AV-905` added a
 * camera-temperature stream whose key is not `temperature`, and a reader who
 * has chosen imperial wants Fahrenheit from every temperature on the page, not
 * from the ones this function happened to have heard of.
 */
function isTemperature(series: ChartSeries): boolean {
  return series.unit === '°C';
}

/**
 * Y-axis presentation per series kind. Elevation, pace and temperature convert
 * into the user's unit system; everything else is plotted in the unit it was
 * recorded in.
 */
export function yUnitLabel(series: ChartSeries, units: UnitSystem): string {
  if (series.key === 'elevation') return elevationUnitLabel(units);
  if (series.key === 'pace') return paceUnitLabel(units);
  if (series.key === 'speed') return speedUnitLabel(units);
  if (isTemperature(series)) return temperatureUnitLabel(units);
  return series.unit;
}

export function toDisplayY(value: number, series: ChartSeries, units: UnitSystem): number {
  if (series.key === 'elevation') return toDisplayElevation(value, units);
  if (series.key === 'pace') return toDisplayPace(value, units);
  if (series.key === 'speed') return toDisplaySpeed(value, units);
  if (isTemperature(series)) return toDisplayTemperature(value, units);
  return value;
}

/** A series value with its unit, in the reader's unit system. */
export function formatSeriesValue(value: number, series: ChartSeries, units: UnitSystem): string {
  if (series.key === 'elevation') return formatElevation(value, units);
  if (series.key === 'pace') return formatPace(value, units);
  if (series.key === 'speed') return formatSpeed(value, units);
  if (isTemperature(series)) return formatTemperature(value, units);
  // AV-905: a sensor stream can be small — rotation rate lives between 0 and a
  // few rad/s — and rounding those to whole numbers would show a flat line of
  // zeros. Larger readings, like heart rate or power, stay whole.
  const rounded = Math.abs(value) < 10 ? value.toFixed(2) : String(Math.round(value));
  return `${rounded} ${series.unit}`;
}

/** Pace ticks read as M:SS; other kinds are plain numbers. */
export function formatTick(value: number, series: ChartSeries, units: UnitSystem, decimals: number): string {
  if (series.key === 'pace') {
    const total = Math.round(toDisplayPace(value, units));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  if (series.key === 'speed') return toDisplaySpeed(value, units).toFixed(decimals ? 1 : 0);
  return toDisplayY(value, series, units).toFixed(decimals);
}

/** How each x-axis names itself in the chart header. */
export const X_AXIS_LABEL: Record<SeriesXAxis, string> = {
  distance: 'Distance',
  time: 'Elapsed time',
  index: 'Point index (no distance or time available)',
};

/**
 * The caption over the cursor's position in the readout. "At", whatever the
 * axis: "Distance" there sat under a selected section's "Distance" and meant a
 * position rather than a length.
 */
export const X_AXIS_CAPTION: Record<SeriesXAxis, string> = {
  distance: 'At',
  time: 'At',
  index: 'At point',
};

/**
 * x values carry a different meaning per axis: meters, seconds, or an index.
 * Given the scale's largest value, a distance is written in that scale's unit,
 * so the two ends of an axis never disagree ("0.00 km … 1.20 km").
 */
export function formatXValue(value: number, axis: SeriesXAxis, units: UnitSystem, scaleMax?: number): string {
  if (axis === 'distance') {
    return scaleMax === undefined ? formatDistance(value, units) : formatDistanceOnScale(value, scaleMax, units);
  }
  if (axis === 'time') return formatDuration(value);
  return String(Math.round(value));
}
