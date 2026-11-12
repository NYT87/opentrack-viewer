import { newCanvasComponent, canvasTemplate, type CanvasElementKey } from './customCanvas';
import { METRIC_MISSING, NO_ROUTE, ELEVATION_MISSING } from './missingData';
import { OVERLAY_PRESETS, type OverlayPresetId } from './presets';
import { SMOOTHING_LIMITS, canSmooth, type OverlayTimeline } from './timeline';
import { normalizeRect, type OverlayComponent, type OverlayTemplate } from './template';

/**
 * AV-1016 (TD-084). The registry of predefined components: ready-made figures,
 * gauges and profiles for a sport, each a name, a sport, the data it needs and
 * a builder that makes ordinary components with a default look, size and
 * smoothing. Once added a component is like any other (saved in the layout,
 * edited with the usual controls, drawn by the one renderer), so the registry
 * is plain data: a sport is added by adding entries here, and the editor, which
 * only reads `PREDEFINED_ENTRIES`, does not change.
 *
 * Dials, charts, the gradient glyph, the compass, zones, splits and
 * average-so-far figures wait for their own drawing pieces (#20, #21, #22,
 * #39) and have no entry until those land.
 */

export type PredefinedSport = 'cycling' | 'running' | 'any';

export interface PredefinedEntry {
  /** Stable, `sport.name`: what the add list and a test refer to. */
  id: string;
  name: string;
  sport: PredefinedSport;
  /** Data source ids the activity must have: `metric:power`, `route`. Empty needs nothing. */
  needs: string[];
  /** Why the entry is offered disabled, in the Add list's own wording. */
  missing: string;
  /** Ordinary components, the first of which is the one selected after adding. */
  build: (
    template: OverlayTemplate,
    size: { width: number; height: number },
    timeline: OverlayTimeline,
  ) => OverlayComponent[];
}

/** Whether this activity can supply an entry's data. */
export function predefinedAvailability(entry: PredefinedEntry, timeline: OverlayTimeline): boolean {
  if (timeline.unavailable) return false;
  return entry.needs.every((need) => (need === 'route' ? timeline.hasRoute : timeline.available.has(need)));
}

export function predefinedEntry(id: string): PredefinedEntry | undefined {
  return PREDEFINED_ENTRIES.find((entry) => entry.id === id);
}

type Build = PredefinedEntry['build'];

/** An ordinary figure or gauge, with smoothing and display settings put on it. */
function figure(
  key: CanvasElementKey,
  extra: { smoothing?: number; label?: string; decimals?: 0 | 1 | 2; ofTotal?: boolean } = {},
): Build {
  return (template, size, timeline) => {
    const component = newCanvasComponent(template, key, size, timeline);
    const seconds = Math.min(SMOOTHING_LIMITS.max, extra.smoothing ?? 0);
    if (seconds > 0 && canSmooth(component.source)) component.smoothing = { windowSeconds: seconds };
    const display: NonNullable<OverlayComponent['display']> = {};
    if (extra.label) display.label = extra.label;
    if (extra.decimals !== undefined) display.decimals = extra.decimals;
    if (extra.ofTotal) display.ofTotal = true;
    if (Object.keys(display).length > 0) component.display = display;
    if (extra.ofTotal) {
      // "12.40 / 42.20 km" is about twice as wide as a plain figure.
      component.rect = normalizeRect({ ...component.rect, width: Math.min(0.5, component.rect.width * 1.7) });
    }
    return [component];
  };
}

const plain =
  (key: CanvasElementKey): Build =>
  (template, size, timeline) => [newCanvasComponent(template, key, size, timeline)];

export const PREDEFINED_ENTRIES: readonly PredefinedEntry[] = [
  // Cycling
  { id: 'cycling.speed', name: 'Speed', sport: 'cycling', needs: ['metric:speed'], missing: METRIC_MISSING.speed, build: figure('metric:speed', { smoothing: 2 }) },
  { id: 'cycling.speed-gauge', name: 'Speed gauge', sport: 'cycling', needs: ['metric:speed'], missing: METRIC_MISSING.speed, build: figure('gauge:speed', { smoothing: 2 }) },
  { id: 'cycling.power', name: 'Power', sport: 'cycling', needs: ['metric:power'], missing: METRIC_MISSING.power, build: plain('metric:power') },
  { id: 'cycling.power-3s', name: 'Power, 3 s average', sport: 'cycling', needs: ['metric:power'], missing: METRIC_MISSING.power, build: figure('metric:power', { smoothing: 3, label: 'Power 3s' }) },
  { id: 'cycling.cadence', name: 'Cadence', sport: 'cycling', needs: ['metric:cyclingCadence'], missing: METRIC_MISSING.cyclingCadence, build: figure('metric:cyclingCadence', { smoothing: 3, label: 'Cadence' }) },
  { id: 'cycling.gradient', name: 'Gradient', sport: 'cycling', needs: ['metric:grade'], missing: METRIC_MISSING.grade, build: figure('metric:grade', { smoothing: 5, decimals: 0 }) },
  { id: 'cycling.climb', name: 'Climb so far', sport: 'cycling', needs: ['metric:climb'], missing: METRIC_MISSING.climb, build: plain('metric:climb') },
  { id: 'cycling.elevation-profile', name: 'Elevation profile', sport: 'cycling', needs: ['metric:elevation'], missing: ELEVATION_MISSING, build: plain('elevationProfile') },
  // Running
  { id: 'running.pace', name: 'Pace', sport: 'running', needs: ['metric:pace'], missing: METRIC_MISSING.pace, build: figure('metric:pace', { smoothing: 5 }) },
  { id: 'running.heart-rate', name: 'Heart rate', sport: 'running', needs: ['metric:heartRate'], missing: METRIC_MISSING.heartRate, build: plain('metric:heartRate') },
  { id: 'running.cadence', name: 'Running cadence', sport: 'running', needs: ['metric:runningCadence'], missing: METRIC_MISSING.runningCadence, build: figure('metric:runningCadence', { smoothing: 3 }) },
  { id: 'running.distance-total', name: 'Distance of the total', sport: 'running', needs: ['metric:distance'], missing: METRIC_MISSING.distance, build: figure('metric:distance', { ofTotal: true }) },
  // Any sport
  { id: 'any.elevation-profile', name: 'Elevation profile', sport: 'any', needs: ['metric:elevation'], missing: ELEVATION_MISSING, build: plain('elevationProfile') },
  { id: 'any.progress', name: 'Progress bar', sport: 'any', needs: [], missing: '', build: plain('progress') },
  { id: 'any.route', name: 'Route inset', sport: 'any', needs: ['route'], missing: NO_ROUTE, build: plain('route') },
];

// ---------------------------------------------------------------------------
// Starting layouts

/** What the canvas's Start from can lay out: a built-in template, or a sport. */
export type StartLayoutId = OverlayPresetId | 'cycling' | 'running';

export const START_LAYOUTS: readonly { id: StartLayoutId; name: string }[] = [
  ...OVERLAY_PRESETS.map(({ id, name }) => ({ id, name })),
  { id: 'cycling', name: 'Cycling' },
  { id: 'running', name: 'Running' },
];

/** Which entries make a sport's layout, in reading order; the first of a pair that the activity can supply is taken. */
const SPORT_LAYOUTS: Record<'cycling' | 'running', { figures: string[][]; profile: string }> = {
  cycling: {
    figures: [['cycling.speed'], ['cycling.power-3s'], ['cycling.cadence'], ['cycling.gradient', 'cycling.climb']],
    profile: 'cycling.elevation-profile',
  },
  running: {
    figures: [['running.pace'], ['running.heart-rate'], ['running.cadence'], ['running.distance-total']],
    profile: 'any.elevation-profile',
  },
};

/** The space around the layout, and between its figures, as shares of the frame's width. */
const MARGIN = 0.04;
const GAP = 0.01;

/**
 * AV-1016 (TD-084). A sport's starting layout, built from the registry's
 * entries and laid out for the frame's shape. Landscape (or square): the
 * figures in rows along the bottom-left, as many to a row as fit beside the
 * elevation profile, which takes the bottom-right. Portrait: the profile
 * across the bottom and the figures in rows above it, a lower third. Entries
 * the activity cannot supply are left out and the rest close up. Everything is
 * inside the frame and nothing overlaps.
 */
export function componentsFromSportLayout(
  sport: 'cycling' | 'running',
  timeline: OverlayTimeline,
  size: { width: number; height: number },
): OverlayComponent[] {
  const layout = SPORT_LAYOUTS[sport];
  const aspect = size.width / size.height;
  const landscape = aspect >= 1;
  const supplied = (id: string) => {
    const entry = predefinedEntry(id);
    return entry && predefinedAvailability(entry, timeline) ? entry : undefined;
  };
  // Built one by one against what is already built, so each gets its own id.
  const built: OverlayComponent[] = [];
  const make = (entry: PredefinedEntry) => {
    const [component] = entry.build(canvasTemplate(built), size, timeline);
    if (component) built.push(component);
    return component;
  };
  const figures: OverlayComponent[] = [];
  for (const choices of layout.figures) {
    const entry = choices.map(supplied).find(Boolean);
    const component = entry && make(entry);
    if (component) figures.push(component);
  }
  const profileEntry = supplied(layout.profile);
  const profile = profileEntry && make(profileEntry);

  // The profile's box: beside the figures in landscape, across the foot in portrait.
  if (profile) {
    const width = landscape ? profile.rect.width : 1 - 2 * MARGIN;
    const height = (width * aspect) / 4;
    profile.rect = normalizeRect({ x: 1 - MARGIN - width, y: 1 - Math.min(MARGIN * aspect, 0.1) - height, width, height });
  }

  // Rows of figures: as few as fit the room, filled evenly.
  const room = landscape ? 1 - 2 * MARGIN - (profile ? profile.rect.width + MARGIN : 0) : 1 - 2 * MARGIN;
  const widthOf = (items: OverlayComponent[]) =>
    items.reduce((total, item) => total + item.rect.width, 0) + GAP * Math.max(0, items.length - 1);
  const rowsAt = (perRow: number) => {
    const rows: OverlayComponent[][] = [];
    for (let i = 0; i < figures.length; i += perRow) rows.push(figures.slice(i, i + perRow));
    return rows;
  };
  let rows: OverlayComponent[][] = [];
  for (let perRow = figures.length; perRow >= 1; perRow -= 1) {
    rows = rowsAt(perRow);
    if (rows.every((row) => widthOf(row) <= room + 1e-9)) {
      // The fewest rows that fit; then the most even split into that many.
      const even = rowsAt(Math.ceil(figures.length / rows.length));
      if (even.every((row) => widthOf(row) <= room + 1e-9)) rows = even;
      break;
    }
  }
  const rowHeight = figures.reduce((tallest, item) => Math.max(tallest, item.rect.height), 0);
  // The margin and gap are the same in pixels on every side, but never more than a tenth of the frame's height, so a very wide frame still has a bottom.
  const marginY = Math.min(MARGIN * aspect, 0.1);
  const gapY = Math.min(GAP * aspect, 0.02);
  const blockHeight = rows.length * rowHeight + Math.max(0, rows.length - 1) * gapY;
  const floor = profile && !landscape ? profile.rect.y - gapY : 1 - marginY;
  const top = floor - blockHeight;
  rows.forEach((row, r) => {
    let x = MARGIN;
    for (const item of row) {
      item.rect = normalizeRect({ ...item.rect, x, y: top + r * (rowHeight + gapY), height: rowHeight });
      x += item.rect.width + GAP;
    }
  });
  return built;
}
