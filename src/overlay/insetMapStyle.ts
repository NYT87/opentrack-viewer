import { MAPTILER_STYLE_URL, OPENFREEMAP_STYLE_URL } from '../mapVideo/videoMap';
import type { OverlayRouteInsetSetting } from './routeInset';

/**
 * AV-1023 (TD-092). The style an inset's basemap is drawn from: OpenFreeMap's, keyless, or
 * MapTiler's with the reader's own key (never for the PNG sequence, TD-079). `undefined` for no
 * map, or for MapTiler without a key: the line is drawn alone, and nothing is asked of anyone.
 */
export function insetStyleUrl(setting: OverlayRouteInsetSetting, maptilerKey: string): string | undefined {
  const { provider, style } = setting.map;
  if (provider === 'openfreemap') return `${OPENFREEMAP_STYLE_URL}${style}`;
  if (provider === 'maptiler') {
    const key = maptilerKey.trim();
    return key ? `${MAPTILER_STYLE_URL}${style}/style.json?key=${encodeURIComponent(key)}` : undefined;
  }
  return undefined;
}
