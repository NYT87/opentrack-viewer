import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_TEMPLATE_VERSION,
  type OverlayComponent,
  type OverlayRect,
  type OverlayTemplate,
  type OverlayUnitMode,
} from './template';
import type { OverlayMetricKey, OverlayTimeline } from './timeline';

/**
 * AV-1005. The small set of templates the overlay page offers, and the
 * controls that adjust them.
 *
 * A preset is not a stored layout. It is a list of components switched on by
 * default and a rule for placing whichever are shown, so turning one off
 * closes the gap instead of leaving a hole, and a component the activity has
 * no data for is never placed at all. `buildOverlay` turns a preset plus the
 * reader's controls plus the timeline's data into an ordinary `OverlayTemplate`
 * (AV-1003) — what the preview draws, and what an export will.
 */

export type OverlayPresetId = 'compact-hud' | 'route-inset' | 'metric-strip';

export const OVERLAY_PRESETS: readonly {
  id: OverlayPresetId;
  name: string;
  description: string;
}[] = [
  {
    id: 'compact-hud',
    name: 'Compact HUD',
    description: 'A small stack of figures in one corner.',
  },
  {
    id: 'route-inset',
    name: 'Route inset',
    description: 'The route and a short row of figures.',
  },
  {
    id: 'metric-strip',
    name: 'Metric strip',
    description: 'One row of figures along an edge; the more are on, the smaller each is.',
  },
];

export type OverlayPosition = 'bottom' | 'top';

/** Everything the reader can change. Held in memory for the session. */
export interface OverlayControls {
  presetId: OverlayPresetId;
  /** Per component key; absent means the preset's default. */
  enabled: Record<string, boolean>;
  position: OverlayPosition;
  /** Multiplier on size and type. */
  scale: number;
  accentColor: string;
  /** 0..1 */
  backgroundOpacity: number;
  unitMode: OverlayUnitMode;
}

export const SCALE_RANGE = { min: 0.75, max: 1.5 } as const;
export const BACKGROUND_OPACITY_RANGE = { min: 0, max: 0.8 } as const;

export const DEFAULT_OVERLAY_CONTROLS: OverlayControls = {
  presetId: 'metric-strip',
  enabled: {},
  position: 'bottom',
  scale: 1,
  accentColor: DEFAULT_OVERLAY_STYLE.accentColor,
  backgroundOpacity: DEFAULT_OVERLAY_STYLE.backgroundOpacity,
  unitMode: 'auto',
};

type EntryKind = 'metric' | 'route' | 'progress' | 'sensor';

/** Something the reader can switch on or off. */
export interface OverlayCatalogEntry {
  /** Stable key, also the component id. */
  key: string;
  label: string;
  kind: EntryKind;
  metric?: OverlayMetricKey;
  sensorKey?: string;
}

const METRIC_ENTRIES: readonly (OverlayCatalogEntry & { metric: OverlayMetricKey })[] = [
  { key: 'speed', label: 'Speed', kind: 'metric', metric: 'speed' },
  { key: 'pace', label: 'Pace', kind: 'metric', metric: 'pace' },
  { key: 'distance', label: 'Distance', kind: 'metric', metric: 'distance' },
  { key: 'elapsed', label: 'Time', kind: 'metric', metric: 'elapsed' },
  { key: 'elevation', label: 'Elevation', kind: 'metric', metric: 'elevation' },
  { key: 'heartRate', label: 'Heart rate', kind: 'metric', metric: 'heartRate' },
  { key: 'runningCadence', label: 'Running cadence', kind: 'metric', metric: 'runningCadence' },
  { key: 'cyclingCadence', label: 'Cycling cadence', kind: 'metric', metric: 'cyclingCadence' },
  { key: 'power', label: 'Power', kind: 'metric', metric: 'power' },
];

const SENSOR_PREFIX = 'sensor:';

/** Every component the reader may switch, in the order they are placed. */
export function overlayCatalog(timeline: OverlayTimeline): OverlayCatalogEntry[] {
  const sensors: OverlayCatalogEntry[] = [...timeline.sensorLabels].map(([id, info]) => ({
    key: id,
    label: info.label,
    kind: 'sensor',
    sensorKey: id.slice(SENSOR_PREFIX.length),
  }));
  return [
    ...METRIC_ENTRIES,
    ...sensors,
    { key: 'route', label: 'Route inset', kind: 'route' },
    { key: 'progress', label: 'Progress bar', kind: 'progress' },
  ];
}

/** Whether the activity has what this component draws. */
export function isEntryAvailable(entry: OverlayCatalogEntry, timeline: OverlayTimeline): boolean {
  if (timeline.unavailable) return false;
  switch (entry.kind) {
    case 'route':
      return timeline.hasRoute;
    case 'progress':
      return true;
    case 'metric':
      return timeline.available.has(`metric:${entry.metric}`);
    case 'sensor':
      return timeline.available.has(entry.key);
  }
}

const PRESET_DEFAULTS: Record<OverlayPresetId, readonly string[]> = {
  'compact-hud': ['speed', 'distance', 'elapsed', 'heartRate'],
  'route-inset': ['route', 'speed', 'distance', 'elapsed'],
  'metric-strip': ['speed', 'distance', 'elapsed', 'elevation', 'heartRate', 'route', 'progress'],
};

/** The reader's choice if they made one, else the preset's default. */
export function isEntryEnabled(entry: OverlayCatalogEntry, controls: OverlayControls): boolean {
  return controls.enabled[entry.key] ?? PRESET_DEFAULTS[controls.presetId].includes(entry.key);
}

// ---------------------------------------------------------------------------
// Placement

const MARGIN = 0.02;
/** Between neighbouring tiles, in frame widths. */
const TILE_GAP = 0.004;
/** The smallest type, as a share of the base, a metric strip shrinks its figures to. */
export const MIN_STRIP_TYPE = 0.6;

/**
 * Type is sized in frame widths (`2.2cqw` at scale 1, see `OverlayLayer`), and
 * a tile needs this many ems of height for its label, value, gauge track and
 * padding. Tile height is a fraction of the frame's height, so whether text
 * fits depends on the aspect ratio — `fitScale` is where that is settled.
 */
export const BASE_FONT_CQW = 2.2;
export const TILE_HEIGHT_EMS = 3.2;
/**
 * And this many ems of width: the widest figure ("100.1 km/h") plus the tile's
 * padding, in the widest sans a reader's system is likely to fall back to.
 * The app names no font of its own, so the budget has to hold in DejaVu Sans
 * Bold — Ubuntu's default, with 0.70 em digits — where that figure measures
 * about 6.6 em; Helvetica, Liberation and Noto need under 5.5. A tile too
 * narrow does not clip: the value wraps onto a second line and overflows the
 * tile's height instead, which is how this was found, on a CI runner.
 */
export const TILE_WIDTH_EMS = 8.2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A figure tile's height, in frame heights, and width, in frame widths, at this size. */
const tileHeight = (scale: number, frameAspect: number) => clamp(0.075 * scale * frameAspect, 0.02, 0.2);
const tileWidth = (scale: number) => clamp(((BASE_FONT_CQW * TILE_WIDTH_EMS) / 100) * scale, 0.05, 0.3);
/** The metric strip's route: a square as tall as its tiles. */
const stripRouteWidth = (scale: number, frameAspect: number) => tileHeight(scale, frameAspect) / frameAspect;

/**
 * TD-059. How many figures the metric strip holds in one row at this size
 * before its type would go below MIN_STRIP_TYPE: past it, they wrap, and the
 * controls say so.
 */
export function metricStripCapacity(scale: number, frameAspect: number, route: boolean): number {
  const size = clamp(scale, SCALE_RANGE.min, SCALE_RANGE.max);
  const aspect = frameAspect > 0 ? frameAspect : 16 / 9;
  const room = route ? 1 - stripRouteWidth(size, aspect) - 3 * MARGIN : 1 - 2 * MARGIN;
  const full = tileWidth(size);
  const floor = Math.min(full, (full * MIN_STRIP_TYPE) / size);
  return Math.max(1, Math.floor((room + TILE_GAP) / (floor + TILE_GAP)));
}

interface PlaceOptions {
  position: OverlayPosition;
  scale: number;
  /** Frame width over height: a fraction of the height is not one of the width. */
  frameAspect: number;
}

/**
 * Rectangles are fractions of the frame, and type is sized in frame widths, so
 * a tile's *height* is its type size over the frame's height — which is why
 * the aspect ratio is an input. A portrait frame gets proportionally shorter
 * tiles in the same text.
 */
/** The largest type scale a tile of this height holds without clipping. */
function fitScale(height: number, scale: number, frameAspect: number): number {
  const heightCqw = (height * 100) / frameAspect;
  return Math.min(scale, heightCqw / (BASE_FONT_CQW * TILE_HEIGHT_EMS));
}

interface Placed {
  rect: OverlayRect;
  /** Set when the tile is too short for the template's type size. */
  fontScale?: number;
}

function placeEntries(
  presetId: OverlayPresetId,
  tiles: OverlayCatalogEntry[],
  route: boolean,
  progress: boolean,
  { position, scale, frameAspect }: PlaceOptions,
): Map<string, Placed> {
  const rects = new Map<string, Placed>();
  const tileH = tileHeight(scale, frameAspect);
  // Width in frame widths, from the em budget: type is sized in frame widths too.
  const tileW = tileWidth(scale);
  const progressH = clamp(0.012 * frameAspect, 0.006, 0.02);
  const toY = (distanceFromEdge: number, height: number) =>
    position === 'bottom' ? 1 - distanceFromEdge - height : distanceFromEdge;
  const place = (key: string, x: number, edge: number, w: number, h: number) => {
    const width = clamp(w, 0.01, 1);
    const height = clamp(h, 0.005, 1);
    rects.set(key, {
      rect: {
        x: clamp(x, 0, 1 - width),
        y: clamp(toY(edge, height), 0, 1 - height),
        width,
        height,
      },
    });
  };
  /** A figure: placed, and given the type size its height can hold. */
  const placeTile = (key: string, x: number, edgeOffset: number, w: number, h: number) => {
    place(key, x, edgeOffset, w, h);
    const placed = rects.get(key);
    if (!placed) return;
    const fit = fitScale(placed.rect.height, scale, frameAspect);
    if (fit < scale) placed.fontScale = fit;
  };
  const square = (width: number) => ({ w: width, h: Math.min(width * frameAspect, 0.5) });

  // The progress bar sits on the outermost edge, so everything else clears it.
  let edge = MARGIN;
  if (progress) {
    place('progress', MARGIN, edge, 1 - 2 * MARGIN, progressH);
    edge += progressH + MARGIN / 2;
  }

  const avail = 1 - edge - MARGIN;

  /**
   * Tiles keep the width a value needs ("100.0 km/h" at this type size) and
   * wrap onto further rows rather than squeezing into one — a squeezed tile
   * clips its text. Only if the rows would not fit the frame's height do they
   * get shorter, which is the last resort rather than the first. Tiles stand a
   * hair apart, so rounded corners never meet in a notch of video.
   */
  const flowRows = (x0: number, room: number) => {
    const perRow = Math.max(1, Math.floor((room + TILE_GAP) / (tileW + TILE_GAP)));
    const rows = Math.max(1, Math.ceil(tiles.length / perRow));
    const gapH = TILE_GAP * frameAspect;
    const height = Math.min(tileH, (avail - gapH * (rows - 1)) / rows);
    tiles.forEach((tile, index) =>
      placeTile(
        tile.key,
        x0 + (index % perRow) * (tileW + TILE_GAP),
        edge + Math.floor(index / perRow) * (height + gapH),
        tileW,
        height,
      ),
    );
  };

  /**
   * TD-059. A strip stays one row while its type can: its tiles share the
   * edge, the type smaller to fit a narrower tile, down to a floor
   * (MIN_STRIP_TYPE of the base). Past that floor a smaller figure is not a
   * figure any more, so the tiles keep the floor's width and wrap, and the
   * controls say the strip is full (`metricStripCapacity`).
   */
  const stripRow = (x0: number, room: number) => {
    const count = Math.max(1, tiles.length);
    const floorW = (tileW * MIN_STRIP_TYPE) / scale;
    const shared = (room - TILE_GAP * (count - 1)) / count;
    const width = Math.min(tileW, Math.max(shared, Math.min(floorW, tileW)));
    const perRow = Math.max(1, Math.floor((room + TILE_GAP) / (width + TILE_GAP)));
    const gapH = TILE_GAP * frameAspect;
    tiles.forEach((tile, index) => {
      placeTile(
        tile.key,
        x0 + (index % perRow) * (width + TILE_GAP),
        edge + Math.floor(index / perRow) * (tileH + gapH),
        width,
        tileH,
      );
      const placed = rects.get(tile.key);
      if (placed && width < tileW) placed.fontScale = Math.min(placed.fontScale ?? scale, (scale * width) / tileW);
    });
  };

  if (presetId === 'metric-strip') {
    // The route takes the far end of the strip's edge, so rows never run under
    // it: a square as tall as a tile, docked beside the figures, not a third of
    // the strip's width.
    const box = square(stripRouteWidth(scale, frameAspect));
    stripRow(MARGIN, route ? 1 - box.w - 3 * MARGIN : 1 - 2 * MARGIN);
    if (route) place('route', 1 - MARGIN - box.w, edge, box.w, box.h);
  } else if (presetId === 'compact-hud') {
    // A column as tall as the frame allows, then another beside it: a long
    // list must not run off the edge and be squeezed onto the same row.
    const box = square(0.18 * scale);
    const columnW = clamp(0.2 * scale, 0.1, 0.4);
    const room = route ? 1 - box.w - 3 * MARGIN : 1 - 2 * MARGIN;
    const maxColumns = Math.max(1, Math.floor(room / columnW));
    const perColumn = Math.max(
      Math.floor((avail + TILE_GAP * frameAspect) / (tileH + TILE_GAP * frameAspect)),
      Math.ceil(tiles.length / maxColumns),
      1,
    );
    const gapH = TILE_GAP * frameAspect;
    const height = Math.min(tileH, (avail - gapH * (perColumn - 1)) / perColumn);
    tiles.forEach((tile, index) =>
      placeTile(
        tile.key,
        MARGIN + Math.floor(index / perColumn) * (columnW + TILE_GAP),
        edge + (index % perColumn) * (height + gapH),
        columnW,
        height,
      ),
    );
    if (route) place('route', 1 - MARGIN - box.w, edge, box.w, box.h);
  } else {
    const box = square(0.3 * scale);
    if (route) place('route', 1 - MARGIN - box.w, edge, box.w, box.h);
    flowRows(MARGIN, route ? 1 - box.w - 3 * MARGIN : 1 - 2 * MARGIN);
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Building

export interface OverlayUnsupported {
  key: string;
  label: string;
  message: string;
}

export interface BuiltOverlay {
  template: OverlayTemplate;
  /** Components the reader has on that this activity cannot supply. */
  unsupported: OverlayUnsupported[];
}

const HEART_RATE_RANGE = { min: 50, max: 200 };

function componentFor(
  entry: OverlayCatalogEntry,
  rect: OverlayRect,
  timeline: OverlayTimeline,
  unitMode: OverlayUnitMode,
): OverlayComponent {
  const base = { id: entry.key, visible: true, rect, unitMode, style: {} };
  switch (entry.kind) {
    case 'route':
      return { ...base, type: 'routeInset' };
    case 'progress':
      return { ...base, type: 'progress' };
    case 'sensor': {
      const info = timeline.sensorLabels.get(entry.key);
      // A flat stream still needs a span, or the gauge would divide by zero.
      const min = info?.min ?? 0;
      const max = info && info.max > info.min ? info.max : min + 1;
      return {
        ...base,
        type: 'gauge',
        source: { kind: 'sensor', key: entry.sensorKey ?? '' },
        range: { min, max },
      };
    }
    case 'metric': {
      const metric = entry.metric as OverlayMetricKey;
      return {
        ...base,
        type: metric === 'heartRate' ? 'gauge' : 'text',
        source: { kind: 'metric', metric },
        ...(metric === 'heartRate' ? { range: HEART_RATE_RANGE } : {}),
      };
    }
  }
}

/**
 * The template for these controls over this activity. Components that are on
 * and supported are placed; components that are on but unsupported are left
 * out and reported, so the reader is told rather than shown a gap or a dash.
 */
export function buildOverlay(
  controls: OverlayControls,
  timeline: OverlayTimeline,
  frameAspect = 16 / 9,
): BuiltOverlay {
  const unsupported: OverlayUnsupported[] = [];
  const shown: OverlayCatalogEntry[] = [];
  for (const entry of overlayCatalog(timeline)) {
    if (!isEntryEnabled(entry, controls)) continue;
    if (isEntryAvailable(entry, timeline)) shown.push(entry);
    else if (!timeline.unavailable) {
      unsupported.push({
        key: entry.key,
        label: entry.label,
        message: `${entry.label} is not in this activity, so it is not shown.`,
      });
    }
  }

  const tiles = shown.filter((entry) => entry.kind === 'metric' || entry.kind === 'sensor');
  const rects = placeEntries(
    controls.presetId,
    tiles,
    shown.some((entry) => entry.kind === 'route'),
    shown.some((entry) => entry.kind === 'progress'),
    {
      position: controls.position,
      scale: clamp(controls.scale, SCALE_RANGE.min, SCALE_RANGE.max),
      frameAspect: frameAspect > 0 ? frameAspect : 16 / 9,
    },
  );

  const components: OverlayComponent[] = [];
  for (const entry of shown) {
    const placed = rects.get(entry.key);
    if (!placed) continue;
    const component = componentFor(entry, placed.rect, timeline, controls.unitMode);
    if (placed.fontScale !== undefined) component.style = { fontScale: placed.fontScale };
    components.push(component);
  }

  const preset = OVERLAY_PRESETS.find((candidate) => candidate.id === controls.presetId);
  return {
    unsupported,
    template: {
      version: OVERLAY_TEMPLATE_VERSION,
      name: preset?.name ?? 'Overlay',
      style: {
        ...DEFAULT_OVERLAY_STYLE,
        accentColor: controls.accentColor,
        backgroundOpacity: clamp(
          controls.backgroundOpacity,
          BACKGROUND_OPACITY_RANGE.min,
          BACKGROUND_OPACITY_RANGE.max,
        ),
        fontScale: clamp(controls.scale, SCALE_RANGE.min, SCALE_RANGE.max),
      },
      components,
    },
  };
}
