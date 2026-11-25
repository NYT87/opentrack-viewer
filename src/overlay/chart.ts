import { formatDistance, formatDuration, type UnitSystem } from '../domain/units';
import type { Activity } from '../domain/activity';
import { projectSeries, type ProjectedSeries, type SeriesPoint } from './series';
import { formatSourceValue, type OverlayChartSetting } from './template';
import { dataSourceId, pointValuesOf, type OverlayDataSource, type OverlaySample, type OverlayTimeline } from './timeline';

/**
 * AV-1019 (TD-087). A chart at one moment: the pure part. Where the moment is
 * on the series' axis, which part of the series is drawn (the whole, or a
 * window with the cursor in the middle), where the cursor and its dot are, and
 * what the axis labels say. The renderer draws from it and the contract gives
 * it as props, so the two cannot disagree.
 */

const seriesCache = new WeakMap<Activity, Map<string, ProjectedSeries | null>>();

/**
 * The series a chart draws, from the points of `activity`, made once per activity, source and axis and kept
 * (the editor makes a new renderer on every edit; the series does not change with them). `undefined` when
 * the activity has none for the source.
 */
export function chartSeriesOf(activity: Activity, source: OverlayDataSource, axis: 'time' | 'distance'): ProjectedSeries | undefined {
  let byKey = seriesCache.get(activity);
  if (!byKey) seriesCache.set(activity, (byKey = new Map()));
  const key = `${dataSourceId(source)}|${axis}`;
  let series = byKey.get(key);
  if (series === undefined) {
    const values = pointValuesOf(activity, source);
    series = (values && projectSeries(activity, (index) => values[index], axis, { breakAtPauses: true })) || null;
    byKey.set(key, series);
  }
  return series ?? undefined;
}

/** Where a chart's cursor is, in the series' own along-units, and what the figure reads there. */
export interface ChartMoment {
  /** The along-value at now, in seconds or metres; absent where the sample has no place on this axis. */
  centre?: number;
  /** The figure's value now, absent in a gap. */
  value?: number;
}

/**
 * The moment a sample is on a series' axis: the activity's own clock for time,
 * and for distance the timeline's progress along the whole (TD-041), as the
 * elevation profile's cursor is, so the two stay together on the map video too.
 */
export function chartMoment(
  series: Pick<ProjectedSeries, 'axis' | 'first' | 'last'>,
  source: OverlayDataSource,
  sample: OverlaySample,
  timeline: Pick<OverlayTimeline, 'activityStartMs'>,
): ChartMoment {
  const value = sample.values[dataSourceId(source)];
  let centre: number | undefined;
  if (series.axis === 'time') {
    if (timeline.activityStartMs !== undefined) centre = timeline.activityStartMs / 1000 + sample.activityElapsedSeconds;
  } else if (sample.progress !== undefined) {
    centre = series.first + sample.progress * (series.last - series.first);
  }
  return { centre, value };
}

export interface ChartView {
  /** The runs to draw, in the chart's own 0..1 box, y down. */
  runs: SeriesPoint[][];
  /** The cursor's x in the box: its share of the whole activity, or 0.5 in a window. */
  cursorX: number;
  /** The cursor's dot, 0..1 down, absent where the figure has no value or the window has no data. */
  cursorY?: number;
  /** The lowest and highest value drawn, absent when a window has none. */
  low?: number;
  high?: number;
  /** Where a value is on the y axis drawn, 0..1 down; absent when nothing is drawn. */
  y?: (value: number) => number;
}

/** What is drawn at a moment, or `undefined` when the moment has no place on the axis. */
export function chartView(series: ProjectedSeries, setting: OverlayChartSetting, moment: ChartMoment): ChartView | undefined {
  if (moment.centre === undefined) return undefined;
  if (setting.window === undefined) {
    const cursorX = Math.min(1, Math.max(0, (moment.centre - series.first) / (series.last - series.first)));
    return {
      runs: series.runs,
      cursorX,
      ...(moment.value !== undefined ? { cursorY: series.y(moment.value) } : {}),
      low: series.low,
      high: series.high,
      y: series.y,
    };
  }
  const window = series.window(moment.centre, setting.window);
  if (!window) return { runs: [], cursorX: 0.5 };
  return {
    runs: window.runs,
    cursorX: 0.5,
    ...(moment.value !== undefined ? { cursorY: window.y(moment.value) } : {}),
    low: window.low,
    high: window.high,
    y: window.y,
  };
}

export interface ChartLabels {
  /** The y range's ends, written as the figure is; absent when nothing is drawn. */
  high?: string;
  low?: string;
  /** The x window's ends: "−0:30" and "+0:30", or from the activity's start to its length. */
  start: string;
  end: string;
}

export function chartLabels(
  view: Pick<ChartView, 'low' | 'high'>,
  series: Pick<ProjectedSeries, 'first' | 'last'>,
  setting: OverlayChartSetting,
  source: OverlayDataSource,
  units: UnitSystem,
  timeline: Pick<OverlayTimeline, 'sensorLabels'>,
  decimals?: 0 | 1 | 2,
): ChartLabels {
  const along = setting.axis === 'distance' ? (meters: number) => formatDistance(meters, units) : formatDuration;
  const x =
    setting.window !== undefined
      ? { start: `−${along(setting.window)}`, end: `+${along(setting.window)}` }
      : { start: along(0), end: along(series.last - series.first) };
  return {
    ...(view.high !== undefined ? { high: formatSourceValue(source, view.high, units, timeline, decimals) } : {}),
    ...(view.low !== undefined ? { low: formatSourceValue(source, view.low, units, timeline, decimals) } : {}),
    ...x,
  };
}
