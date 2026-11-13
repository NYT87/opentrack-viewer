import { describe, expect, it } from 'vitest';
import { MAP_VIDEO_BASEMAP_STYLES, MAPTILER_STYLES } from '../mapVideo/project';
import { mapVideoAttribution } from '../mapVideo/style';
import { DEFAULT_MAP_VIDEO_SETTINGS } from '../mapVideo/project';
import {
  DEFAULT_ROUTE_INSET,
  INSET_MAPTILER_STYLES,
  INSET_OPENFREEMAP_STYLES,
  MAX_MAP_INSETS,
  MAPTILER_CREDIT,
  OPENFREEMAP_CREDIT,
  insetMapCredit,
  insetMapStyleOf,
  isPlainInset,
  parseRouteInsetSetting,
} from './routeInset';
import { OVERLAY_TEMPLATE_VERSION, parseOverlayTemplate } from './template';

describe('the route inset’s settings (AV-1023, TD-092)', () => {
  it('reads nothing as the defaults: a whole route, north up, a square, no map', () => {
    expect(parseRouteInsetSetting(undefined)).toEqual(DEFAULT_ROUTE_INSET);
    expect(parseRouteInsetSetting(null)).toEqual(DEFAULT_ROUTE_INSET);
    expect(parseRouteInsetSetting('x')).toEqual(DEFAULT_ROUTE_INSET);
    expect(parseRouteInsetSetting({})).toEqual(DEFAULT_ROUTE_INSET);
    expect(DEFAULT_ROUTE_INSET).toMatchObject({ view: 'whole', zoom: 15, orientation: 'north', shape: 'square', trail: 'all', ahead: 'shown', map: { provider: 'none' } });
  });

  it('clamps every number and keeps every choice to its own', () => {
    const read = parseRouteInsetSetting({
      view: 'sideways',
      zoom: 400,
      orientation: 'up',
      shape: 'hexagon',
      border: { width: 9, color: 'red' },
      trail: 600,
      ahead: 'loud',
      lineColor: '#ABCDEF',
      lineWidth: 5,
      map: { provider: 'google', style: 'x' },
    });
    expect(read).toEqual({
      view: 'whole',
      zoom: 18,
      orientation: 'north',
      shape: 'square',
      border: { width: 0.05, color: '#ffffff' },
      trail: 60,
      ahead: 'shown',
      lineColor: '#abcdef',
      lineWidth: 0.2,
      map: { provider: 'none', style: 'liberty' },
    });
    expect(parseRouteInsetSetting({ trail: 0.2 }).trail).toBe(1);
    expect(parseRouteInsetSetting({ trail: -3 }).trail).toBe('all');
    expect(parseRouteInsetSetting({ trail: 'all' }).trail).toBe('all');
    expect(parseRouteInsetSetting({ lineWidth: 0 }).lineWidth).toBe(0.03);
    expect(parseRouteInsetSetting({ zoom: Number.NaN }).zoom).toBe(15);
  });

  it('keeps a map style only of its own provider', () => {
    expect(parseRouteInsetSetting({ map: { provider: 'openfreemap', style: 'dark' } }).map).toEqual({ provider: 'openfreemap', style: 'dark' });
    expect(parseRouteInsetSetting({ map: { provider: 'openfreemap', style: 'satellite' } }).map).toEqual({ provider: 'openfreemap', style: 'liberty' });
    expect(parseRouteInsetSetting({ map: { provider: 'maptiler', style: 'hybrid' } }).map).toEqual({ provider: 'maptiler', style: 'hybrid' });
    expect(parseRouteInsetSetting({ map: { provider: 'maptiler', style: 'liberty' } }).map).toEqual({ provider: 'maptiler', style: 'satellite' });
    expect(insetMapStyleOf('none', 'liberty')).toBe('liberty');
  });

  it('offers the map video’s styles and no others', () => {
    expect([...INSET_OPENFREEMAP_STYLES]).toEqual([...MAP_VIDEO_BASEMAP_STYLES]);
    expect([...INSET_MAPTILER_STYLES]).toEqual([...MAPTILER_STYLES]);
  });

  it('credits a provider in the map video’s own words', () => {
    expect(mapVideoAttribution({ ...DEFAULT_MAP_VIDEO_SETTINGS, basemap: { ...DEFAULT_MAP_VIDEO_SETTINGS.basemap, source: 'online' }, terrain: { ...DEFAULT_MAP_VIDEO_SETTINGS.terrain, enabled: false } })).toBe(OPENFREEMAP_CREDIT);
    expect(mapVideoAttribution({ ...DEFAULT_MAP_VIDEO_SETTINGS, basemap: { ...DEFAULT_MAP_VIDEO_SETTINGS.basemap, source: 'maptiler' }, terrain: { ...DEFAULT_MAP_VIDEO_SETTINGS.terrain, enabled: false } })).toBe(MAPTILER_CREDIT);
    expect(insetMapCredit('none')).toBeUndefined();
    expect(insetMapCredit('openfreemap')).toBe(OPENFREEMAP_CREDIT);
  });

  it('calls an inset with no setting, or only the defaults, plain: the old inset', () => {
    expect(isPlainInset(undefined)).toBe(true);
    expect(isPlainInset(DEFAULT_ROUTE_INSET)).toBe(true);
    // Orientation and zoom matter only when following.
    expect(isPlainInset({ ...DEFAULT_ROUTE_INSET, orientation: 'heading', zoom: 12 })).toBe(true);
    for (const patch of [
      { view: 'follow' as const },
      { shape: 'round' as const },
      { border: { width: 0.01, color: '#ffffff' } },
      { trail: 5 },
      { ahead: 'hidden' as const },
      { lineColor: '#ff0000' },
      { lineWidth: 0.05 },
      { map: { provider: 'openfreemap' as const, style: 'liberty' } },
    ]) {
      expect(isPlainInset({ ...DEFAULT_ROUTE_INSET, ...patch })).toBe(false);
    }
  });
});

describe('the setting in a template file (AV-1023)', () => {
  const file = (components: unknown[]) =>
    JSON.stringify({ version: OVERLAY_TEMPLATE_VERSION, name: 't', style: {}, components });
  const inset = (id: string, extra: object = {}) => ({
    id,
    type: 'routeInset',
    visible: true,
    rect: { x: 0, y: 0, width: 0.2, height: 0.2 },
    unitMode: 'auto',
    style: {},
    ...extra,
  });

  it('opens an older layout, with no setting, as a whole-route line-only inset with none stored', () => {
    const parsed = parseOverlayTemplate(file([inset('route')]));
    expect(parsed.ok && parsed.template.components[0]!.routeInset).toBeUndefined();
  });

  it('round-trips the setting, read as it may be drawn', () => {
    const setting = { view: 'follow', zoom: 16.4, orientation: 'heading', shape: 'round', border: { width: 0.01, color: '#112233' }, trail: 10, ahead: 'dimmed', lineColor: '#ff00ff', lineWidth: 0.04, map: { provider: 'maptiler', style: 'outdoor-v2' } };
    const first = parseOverlayTemplate(file([inset('route', { routeInset: setting })]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.template.components[0]!.routeInset).toEqual(setting);
    const again = parseOverlayTemplate(JSON.stringify(first.template));
    expect(again.ok && again.template.components[0]!.routeInset).toEqual(setting);
  });

  it('ignores a setting on anything but a route inset', () => {
    const parsed = parseOverlayTemplate(file([{ ...inset('p'), type: 'progress', routeInset: { view: 'follow' } }]));
    expect(parsed.ok && parsed.template.components[0]!.routeInset).toBeUndefined();
  });

  it('keeps at most two maps: a third is a line only, with a warning', () => {
    const map = { map: { provider: 'openfreemap', style: 'liberty' } };
    const parsed = parseOverlayTemplate(file([inset('a', { routeInset: map }), inset('b', { routeInset: map }), inset('c', { routeInset: map })]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(MAX_MAP_INSETS).toBe(2);
    expect(parsed.template.components.map((c) => c.routeInset?.map.provider)).toEqual(['openfreemap', 'openfreemap', 'none']);
    expect(parsed.warnings.join(' ')).toContain('at most 2 maps');
  });
});
