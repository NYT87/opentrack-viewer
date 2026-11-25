import { describe, expect, it } from 'vitest';
import { OPENFREEMAP_TILE_BUDGET } from '../mapVideo/export/tileBudget';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { checkInsetExport, checkInsetExportCached, insetTilesText, type InsetExportInput } from './insetExportCheck';
import { parseRouteInsetSetting } from './routeInset';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayTemplate } from './template';
import { buildOverlayTimeline } from './timeline';

/** AV-1023 (TD-092). What an export with a map asks of its providers, counted before it starts, and when it is refused. */

const ride = activityThrough(straightNorth(1000, 10, 5));
const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
const template = (setting: object, trim?: OverlayTemplate['privacyTrim']): OverlayTemplate => ({
  version: OVERLAY_TEMPLATE_VERSION,
  name: 't',
  style: DEFAULT_OVERLAY_STYLE,
  components: [{ id: 'route', type: 'routeInset', visible: true, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.5 }, unitMode: 'auto', style: {}, routeInset: parseRouteInsetSetting(setting) }],
  ...(trim ? { privacyTrim: trim } : {}),
});
const input = (given: OverlayTemplate, extra: Partial<InsetExportInput> = {}): InsetExportInput => ({
  template: given,
  activity: ride,
  timeline,
  width: 1920,
  height: 1080,
  fps: 10,
  frameCount: 2000,
  kind: 'burned',
  maptilerKey: '',
  ...extra,
});
const ofm = { provider: 'openfreemap', style: 'liberty' };

describe('counting an export’s tiles (AV-1023)', () => {
  it('has nothing to say for an export with no map', () => {
    expect(checkInsetExport(input(template({ view: 'follow' })))).toBeUndefined();
    expect(checkInsetExport(input({ ...template({}), components: [] }))).toBeUndefined();
  });

  it('counts the distinct tiles of every frame’s camera: the whole route is one view, following many', () => {
    const whole = checkInsetExport(input(template({ view: 'whole', map: ofm })))!;
    const follow = checkInsetExport(input(template({ view: 'follow', zoom: 15, map: ofm })))!;
    expect(whole.tiles).toBeGreaterThan(0);
    expect(whole.tiles).toBeLessThan(30);
    expect(follow.tiles).toBeGreaterThan(whole.tiles);
    expect(follow.insets).toEqual([{ id: 'route', provider: 'openfreemap', tiles: follow.tiles }]);
    expect(follow.refusal).toBeUndefined();
  });

  it('counts fewer tiles for a shorter part of the video, and fewer for hidden ends', () => {
    const wide = activityThrough(Array.from({ length: 1001 }, (_, i) => ({ north: 0, east: i * 1000, second: i })));
    const wideTimeline = buildOverlayTimeline(wide, { video: { durationSeconds: 1000 } });
    const count = (extra: Partial<InsetExportInput>, trim?: OverlayTemplate['privacyTrim']) =>
      checkInsetExport(input(template({ view: 'follow', zoom: 17, map: ofm }, trim), { activity: wide, timeline: wideTimeline, frameCount: 10_000, ...extra }))!.tiles;
    const all = count({});
    expect(count({ frameCount: 2000, trimStartSeconds: 400 })).toBeLessThan(all);
    expect(count({}, { start: 0.3, end: 0.3 })).toBeLessThan(all);
  });

  it('counts nothing where too little is left to draw', () => {
    const short = activityThrough(straightNorth(150, 10, 5));
    const check = checkInsetExport(input(template({ view: 'follow', map: ofm }, { start: 0.45, end: 0.45 }), { activity: short, timeline: buildOverlayTimeline(short, { video: { durationSeconds: 40 } }) }))!;
    expect(check.tiles).toBe(0);
    expect(insetTilesText(check)).toContain('no tiles');
  });

  it('refuses above OpenFreeMap’s 3,000 tiles at a time, with the reason and the way out', () => {
    const wide = activityThrough(Array.from({ length: 1001 }, (_, i) => ({ north: 0, east: i * 10_000, second: i })));
    const check = checkInsetExport(
      input(template({ view: 'follow', zoom: 18, map: ofm }), { activity: wide, timeline: buildOverlayTimeline(wide, { video: { durationSeconds: 1000 } }), frameCount: 10000, fps: 10 }),
    )!;
    expect(check.tiles).toBeGreaterThan(OPENFREEMAP_TILE_BUDGET);
    expect(check.refusal).toMatch(/OpenFreeMap for [\d,]+ tiles.*3,000/);
  });

  it('says where the tiles come from, how many, and that the trim keeps the ends out', () => {
    const text = insetTilesText(checkInsetExport(input(template({ view: 'whole', map: ofm })))!);
    expect(text).toMatch(/asks OpenFreeMap for \d+ tiles?, each once/);
    expect(text).toContain('No privacy trim is set');
    const trimmed = insetTilesText(checkInsetExport(input(template({ view: 'whole', map: ofm }, { start: 0.1, end: 0.1 })))!);
    expect(trimmed).toContain('privacy trim keeps the start and end out of every request');
    expect(trimmed).not.toContain('No privacy trim');
  });
});

describe('providers by export kind (AV-1023, TD-079)', () => {
  const maptiler = { provider: 'maptiler', style: 'satellite' };
  it('never lets MapTiler into the PNG sequence', () => {
    const check = checkInsetExport(input(template({ map: maptiler }), { kind: 'png', maptilerKey: 'k' }))!;
    expect(check.refusal).toContain('MapTiler map cannot go into the PNG sequence');
  });
  it('lets MapTiler into the transparent video and the video with the overlay drawn in, with a key', () => {
    for (const kind of ['webm', 'burned'] as const) {
      expect(checkInsetExport(input(template({ map: maptiler }), { kind, maptilerKey: 'k' }))!.refusal).toBeUndefined();
    }
  });
  it('refuses MapTiler without a key rather than export it without its map', () => {
    expect(checkInsetExport(input(template({ map: maptiler }), { kind: 'webm' }))!.refusal).toContain('no key');
  });
  it('lets OpenFreeMap into all three', () => {
    for (const kind of ['png', 'webm', 'burned'] as const) {
      expect(checkInsetExport(input(template({ map: ofm }), { kind }))!.refusal).toBeUndefined();
    }
  });
  it('is remembered for the same input, and asked again for another', () => {
    const given = input(template({ map: ofm }));
    expect(checkInsetExportCached(given)).toBe(checkInsetExportCached({ ...given }));
    expect(checkInsetExportCached({ ...given, kind: 'png' })).not.toBe(checkInsetExportCached(given));
  });
});
