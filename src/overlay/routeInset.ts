/**
 * AV-1023 (TD-092). The route inset's own settings: the view (the whole kept route, or a
 * zoom that follows the position), north up or heading up, the shape and border, the trail
 * and the route ahead, the line, and, off by default, a basemap. Types, defaults and the
 * parse; the camera is `insetCamera.ts`, the drawing `export/drawInset.ts`.
 *
 * A component with no setting is today's inset exactly (`isPlainInset`): the setting is saved
 * only once the reader touches it, so a layout from before opens as a whole-route, line-only
 * inset and its goldens do not change.
 */

export type RouteInsetView = 'whole' | 'follow';
export type RouteInsetOrientation = 'north' | 'heading';
export type RouteInsetShape = 'square' | 'round';
export type RouteInsetAhead = 'shown' | 'dimmed' | 'hidden';
export type InsetMapProvider = 'none' | 'openfreemap' | 'maptiler';

/** OpenFreeMap's styles and MapTiler's, as the map video offers them (a test holds these equal to its lists). */
export const INSET_OPENFREEMAP_STYLES = ['liberty', 'positron', 'bright', 'dark'] as const;
export const INSET_MAPTILER_STYLES = ['satellite', 'hybrid', 'outdoor-v2', 'streets-v2'] as const;

export interface OverlayRouteInsetSetting {
  view: RouteInsetView;
  /** 10 to 18: what a follow view is drawn at, in the map's own zoom, at a 1080-pixel frame. */
  zoom: number;
  /** Used only when following. */
  orientation: RouteInsetOrientation;
  shape: RouteInsetShape;
  /** `width` is a share of the frame's shorter side; 0 draws none. */
  border: { width: number; color: string };
  /** The trail behind: all of it, or the last this many minutes (1 to 60). */
  trail: 'all' | number;
  ahead: RouteInsetAhead;
  /** Absent: the component's text colour, as the line always was. */
  lineColor?: string;
  /** A share of the inset's shorter side. */
  lineWidth: number;
  map: { provider: InsetMapProvider; style: string };
}

export const ROUTE_INSET_ZOOM = { min: 10, max: 18, default: 15 } as const;
export const ROUTE_INSET_TRAIL_MINUTES = { min: 1, max: 60 } as const;
export const ROUTE_INSET_LINE_WIDTH = { min: 0.005, max: 0.2, default: 0.03 } as const;
export const ROUTE_INSET_BORDER_MAX = 0.05;
/** At most this many insets in one overlay carry a map: each is a map the page holds open for the export. */
export const MAX_MAP_INSETS = 2;

export const DEFAULT_ROUTE_INSET: OverlayRouteInsetSetting = {
  view: 'whole',
  zoom: ROUTE_INSET_ZOOM.default,
  orientation: 'north',
  shape: 'square',
  border: { width: 0, color: '#ffffff' },
  trail: 'all',
  ahead: 'shown',
  lineWidth: ROUTE_INSET_LINE_WIDTH.default,
  map: { provider: 'none', style: INSET_OPENFREEMAP_STYLES[0] },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const HEX6 = /^#[0-9a-f]{6}$/i;
const hex6 = (value: unknown, fallback: string) => (typeof value === 'string' && HEX6.test(value) ? value.toLowerCase() : fallback);

/** The styles a provider has; `none` has none. */
export const insetMapStyles = (provider: InsetMapProvider): readonly string[] =>
  provider === 'openfreemap' ? INSET_OPENFREEMAP_STYLES : provider === 'maptiler' ? INSET_MAPTILER_STYLES : [];

/** A style of this provider, or the provider's first where it is not one. */
export function insetMapStyleOf(provider: InsetMapProvider, style: unknown): string {
  const styles = insetMapStyles(provider);
  return typeof style === 'string' && styles.includes(style) ? style : (styles[0] ?? INSET_OPENFREEMAP_STYLES[0]);
}

/**
 * The setting as it may be drawn, by its defaults where it does not read: every number clamped
 * to its range, every choice one of its own, the colours `#rrggbb`. Nothing here throws on any input.
 */
export function parseRouteInsetSetting(raw: unknown): OverlayRouteInsetSetting {
  const record = isRecord(raw) ? raw : {};
  const border = isRecord(record.border) ? record.border : {};
  const map = isRecord(record.map) ? record.map : {};
  const provider: InsetMapProvider = map.provider === 'openfreemap' || map.provider === 'maptiler' ? map.provider : 'none';
  const setting: OverlayRouteInsetSetting = {
    view: record.view === 'follow' ? 'follow' : 'whole',
    zoom: isNumber(record.zoom) ? clamp(Math.round(record.zoom * 10) / 10, ROUTE_INSET_ZOOM.min, ROUTE_INSET_ZOOM.max) : ROUTE_INSET_ZOOM.default,
    orientation: record.orientation === 'heading' ? 'heading' : 'north',
    shape: record.shape === 'round' ? 'round' : 'square',
    border: {
      width: isNumber(border.width) ? clamp(border.width, 0, ROUTE_INSET_BORDER_MAX) : 0,
      color: hex6(border.color, DEFAULT_ROUTE_INSET.border.color),
    },
    trail:
      isNumber(record.trail) && record.trail > 0
        ? clamp(Math.round(record.trail), ROUTE_INSET_TRAIL_MINUTES.min, ROUTE_INSET_TRAIL_MINUTES.max)
        : 'all',
    ahead: record.ahead === 'dimmed' || record.ahead === 'hidden' ? record.ahead : 'shown',
    lineWidth: isNumber(record.lineWidth) && record.lineWidth > 0 ? clamp(record.lineWidth, ROUTE_INSET_LINE_WIDTH.min, ROUTE_INSET_LINE_WIDTH.max) : ROUTE_INSET_LINE_WIDTH.default,
    map: { provider, style: insetMapStyleOf(provider, map.style) },
  };
  if (typeof record.lineColor === 'string' && HEX6.test(record.lineColor)) setting.lineColor = record.lineColor.toLowerCase();
  return setting;
}

/** The setting a component draws with: its own over the defaults. */
export const routeInsetOf = (setting: OverlayRouteInsetSetting | undefined): OverlayRouteInsetSetting => setting ?? DEFAULT_ROUTE_INSET;

/** Whether an inset draws a basemap. */
export const hasInsetMap = (setting: OverlayRouteInsetSetting | undefined): boolean => setting !== undefined && setting.map.provider !== 'none';

/**
 * Whether an inset is drawn exactly as it was before AV-1023: the whole route fitted in its box,
 * square, no border, the line at its old width and in the text colour, no map. Those are drawn by
 * the old path, so what exists does not change by a pixel.
 */
export function isPlainInset(setting: OverlayRouteInsetSetting | undefined): boolean {
  if (!setting) return true;
  const d = DEFAULT_ROUTE_INSET;
  return (
    setting.view === d.view &&
    setting.shape === d.shape &&
    setting.border.width === 0 &&
    setting.trail === 'all' &&
    setting.ahead === 'shown' &&
    setting.lineColor === undefined &&
    setting.lineWidth === d.lineWidth &&
    setting.map.provider === 'none'
  );
}

/** The credit a map's provider asks for, drawn in the inset while its map shows (the map video's text). */
export const OPENFREEMAP_CREDIT = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';
export const MAPTILER_CREDIT = '© MapTiler © OpenStreetMap contributors';
export const insetMapCredit = (provider: InsetMapProvider): string | undefined =>
  provider === 'openfreemap' ? OPENFREEMAP_CREDIT : provider === 'maptiler' ? MAPTILER_CREDIT : undefined;

/** The provider's name, for the notice. */
export const insetProviderName = (provider: InsetMapProvider): string => (provider === 'maptiler' ? 'MapTiler' : 'OpenFreeMap');
