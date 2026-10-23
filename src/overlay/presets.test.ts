import { describe, expect, it } from 'vitest';
import {
  BASE_FONT_CQW,
  TILE_HEIGHT_EMS,
  TILE_WIDTH_EMS,
  MIN_STRIP_TYPE,
  metricStripCapacity,
  DEFAULT_OVERLAY_CONTROLS,
  OVERLAY_PRESETS,
  buildOverlay,
  isEntryAvailable,
  overlayCatalog,
  type OverlayControls,
  type OverlayPresetId,
} from './presets';
import { buildOverlayTimeline } from './timeline';
import { makeActivity } from '../test/helpers/activity';
import type { ActivitySensorStream } from '../domain/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const stream: ActivitySensorStream = {
  key: 'ACCL',
  label: 'Acceleration',
  unit: 'm/s²',
  display: 'chart',
  valuesByPoint: [2, 8, undefined, 5],
};

/** Everything a timeline can offer: every metric, a route, a sensor stream. */
const full = () => ({
  ...makeActivity(
    Array.from({ length: 4 }, (_, i) => ({
      time: at(i),
      lat: 10 + i * 0.01,
      lon: 20 + i * 0.01,
      distanceMeters: i * 10,
      speedMetersPerSecond: 3 + i,
      elevationMeters: 100 + i,
      heartRateBpm: 120 + i,
      runningCadenceSpm: 80,
      cyclingCadenceRpm: 90,
      powerWatts: 200,
    })),
  ),
  sensorStreams: [stream],
});

const sparse = () =>
  makeActivity([
    { time: at(0), distanceMeters: 0, speedMetersPerSecond: 3 },
    { time: at(3), distanceMeters: 30, speedMetersPerSecond: 3 },
  ]);

const controls = (patch: Partial<OverlayControls> = {}): OverlayControls => ({
  ...DEFAULT_OVERLAY_CONTROLS,
  ...patch,
});
const ids = (built: ReturnType<typeof buildOverlay>) => built.template.components.map((c) => c.id);

describe('overlay presets (AV-1005)', () => {
  it('offers the three templates', () => {
    expect(OVERLAY_PRESETS.map((preset) => preset.id)).toEqual([
      'compact-hud',
      'route-inset',
      'metric-strip',
    ]);
  });

  it('turns different components on by default in each template', () => {
    const timeline = buildOverlayTimeline(full());
    const hud = ids(buildOverlay(controls({ presetId: 'compact-hud' }), timeline));
    const inset = ids(buildOverlay(controls({ presetId: 'route-inset' }), timeline));
    const strip = ids(buildOverlay(controls({ presetId: 'metric-strip' }), timeline));
    expect(hud).toEqual(['speed', 'distance', 'elapsed', 'heartRate']);
    expect(inset).toEqual(['speed', 'distance', 'elapsed', 'route']);
    expect(strip).toEqual(['speed', 'distance', 'elapsed', 'elevation', 'heartRate', 'route', 'progress']);
  });

  it('shows and hides components on request, in every template', () => {
    const timeline = buildOverlayTimeline(full());
    for (const { id } of OVERLAY_PRESETS) {
      const on = buildOverlay(controls({ presetId: id, enabled: { power: true, speed: false } }), timeline);
      expect(ids(on)).toContain('power');
      expect(ids(on)).not.toContain('speed');
    }
  });

  it('supports speed or pace, either cadence, power and charted sensor streams', () => {
    const timeline = buildOverlayTimeline(full());
    const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
    const built = buildOverlay(controls({ enabled: everything }), timeline);
    expect(ids(built)).toEqual([
      'speed',
      'pace',
      'distance',
      'elapsed',
      'elevation',
      'heartRate',
      'runningCadence',
      'cyclingCadence',
      'power',
      'sensor:ACCL',
      'route',
      'progress',
    ]);
    expect(built.unsupported).toEqual([]);
  });

  it('gives a sensor gauge the range its values span', () => {
    const timeline = buildOverlayTimeline(full());
    const built = buildOverlay(controls({ enabled: { 'sensor:ACCL': true } }), timeline);
    const gauge = built.template.components.find((c) => c.id === 'sensor:ACCL');
    expect(gauge).toMatchObject({
      type: 'gauge',
      source: { kind: 'sensor', key: 'ACCL' },
      range: { min: 2, max: 8 },
    });
  });

  it('closes the gap when a component is turned off', () => {
    const timeline = buildOverlayTimeline(full());
    const rects = (enabled: Record<string, boolean>) =>
      buildOverlay(controls({ presetId: 'metric-strip', enabled }), timeline).template.components;
    const before = rects({}).find((c) => c.id === 'distance')!.rect;
    const after = rects({ speed: false }).find((c) => c.id === 'distance')!.rect;
    expect(after.x).toBeLessThan(before.x);
  });

  describe('unsupported metrics', () => {
    it('places nothing for data the activity lacks, and reports each one', () => {
      const timeline = buildOverlayTimeline(sparse());
      const built = buildOverlay(controls({ presetId: 'metric-strip' }), timeline);
      expect(ids(built)).toEqual(['speed', 'distance', 'elapsed', 'progress']);
      expect(built.unsupported.map((u) => u.key)).toEqual(['elevation', 'heartRate', 'route']);
      expect(built.unsupported[0]?.message).toBe('Elevation is not in this activity, so it is not shown.');
    });

    it('does not report what the reader has not asked for', () => {
      const built = buildOverlay(controls({ enabled: { power: false } }), buildOverlayTimeline(sparse()));
      expect(built.unsupported.map((u) => u.key)).not.toContain('power');
    });

    it('is quiet when the timeline has no activity at all', () => {
      const built = buildOverlay(controls(), buildOverlayTimeline(undefined));
      expect(built.template.components).toEqual([]);
      expect(built.unsupported).toEqual([]);
    });

    it('knows which catalog entries the activity supports', () => {
      const timeline = buildOverlayTimeline(sparse());
      const supported = overlayCatalog(timeline)
        .filter((entry) => isEntryAvailable(entry, timeline))
        .map((entry) => entry.key);
      expect(supported).toEqual(['speed', 'pace', 'distance', 'elapsed', 'progress']);
    });
  });

  describe('layout and style', () => {
    it('keeps every component inside the frame, whatever the settings', () => {
      const timeline = buildOverlayTimeline(full());
      const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
      for (const { id } of OVERLAY_PRESETS) {
        for (const position of ['bottom', 'top'] as const) {
          for (const scale of [0.75, 1, 1.5, 9]) {
            for (const aspect of [0.5625, 1, 16 / 9, 3]) {
              const built = buildOverlay(
                controls({ presetId: id as OverlayPresetId, position, scale, enabled: everything }),
                timeline,
                aspect,
              );
              for (const { rect } of built.template.components) {
                expect(rect.x).toBeGreaterThanOrEqual(0);
                expect(rect.y).toBeGreaterThanOrEqual(0);
                expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
                expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-9);
              }
            }
          }
        }
      }
    });

    it('never lets two components overlap, even with everything on', () => {
      const timeline = buildOverlayTimeline(full());
      const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
      for (const { id } of OVERLAY_PRESETS) {
        for (const position of ['bottom', 'top'] as const) {
          for (const scale of [0.75, 1, 1.5]) {
            for (const aspect of [0.5625, 1, 16 / 9, 3]) {
              const { template } = buildOverlay(
                controls({ presetId: id as OverlayPresetId, position, scale, enabled: everything }),
                timeline,
                aspect,
              );
              const list = template.components;
              for (let i = 0; i < list.length; i += 1) {
                for (let j = i + 1; j < list.length; j += 1) {
                  const a = list[i]!.rect;
                  const b = list[j]!.rect;
                  const apart =
                    a.x + a.width <= b.x + 1e-9 ||
                    b.x + b.width <= a.x + 1e-9 ||
                    a.y + a.height <= b.y + 1e-9 ||
                    b.y + b.height <= a.y + 1e-9;
                  expect(
                    apart,
                    `${id} ${position} x${scale} @${aspect}: ${list[i]!.id} / ${list[j]!.id}`,
                  ).toBe(true);
                }
              }
            }
          }
        }
      }
    });

    it('keeps each figure as wide as its value needs, wrapping onto rows on a narrow frame', () => {
      const timeline = buildOverlayTimeline(full());
      const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
      for (const scale of [0.75, 1, 1.5]) {
        for (const aspect of [0.5625, 1, 16 / 9]) {
          const { template } = buildOverlay(controls({ presetId: 'route-inset', scale, enabled: everything }), timeline, aspect);
          const tiles = template.components.filter((c) => c.type === 'text' || c.type === 'gauge');
          // 10 figures, none narrower than the em budget the widest value needs in a wide font.
          expect(tiles).toHaveLength(10);
          for (const tile of tiles) expect(tile.rect.width).toBeGreaterThanOrEqual(((BASE_FONT_CQW * TILE_WIDTH_EMS) / 100) * scale - 1e-9);
        }
      }
      // Narrow frame, everything on: the figures use more than one row.
      const narrow = buildOverlay(controls({ presetId: 'route-inset', enabled: everything, scale: 1.5 }), timeline, 0.5625).template;
      const rows = new Set(narrow.components.filter((c) => c.type === 'text').map((c) => c.rect.y));
      expect(rows.size).toBeGreaterThan(1);
    });

    it('keeps the metric strip to one row while its type stays readable, and wraps only past that (TD-059)', () => {
      const timeline = buildOverlayTimeline(full());
      const keys = overlayCatalog(timeline)
        .filter((entry) => entry.kind === 'metric' || entry.kind === 'sensor')
        .map((entry) => entry.key);
      for (const scale of [0.75, 1, 1.5]) {
        for (const aspect of [0.5625, 1, 16 / 9]) {
          const holds = metricStripCapacity(scale, aspect, false);
          for (const count of [holds, holds + 1]) {
            if (count > keys.length) continue;
            const enabled = Object.fromEntries(keys.map((key, i) => [key, i < count]));
            const { template } = buildOverlay(controls({ presetId: 'metric-strip', scale, enabled: { ...enabled, route: false, progress: false } }), timeline, aspect);
            const tiles = template.components.filter((c) => c.type === 'text' || c.type === 'gauge');
            expect(tiles).toHaveLength(count);
            const rows = new Set(tiles.map((tile) => tile.rect.y)).size;
            expect(rows, `${count} at ${scale}, ${aspect}`).toBe(count > holds ? 2 : 1);
            for (const tile of tiles) {
              const type = tile.style.fontScale ?? scale;
              // Never below the floor, and never clipped: the tile is as wide as its type needs.
              expect(type).toBeGreaterThanOrEqual(Math.min(scale, MIN_STRIP_TYPE) - 1e-9);
              expect(tile.rect.width).toBeGreaterThanOrEqual(((BASE_FONT_CQW * TILE_WIDTH_EMS) / 100) * type - 1e-9);
            }
            // Tiles stand apart: no two in a row touch.
            const row = tiles.filter((tile) => tile.rect.y === tiles[0]!.rect.y).sort((x, y) => x.rect.x - y.rect.x);
            for (let i = 1; i < row.length; i += 1) {
              expect(row[i]!.rect.x).toBeGreaterThan(row[i - 1]!.rect.x + row[i - 1]!.rect.width);
            }
          }
        }
      }
    });

    it('docks the strip\'s route as a square no taller than its figures (TD-059)', () => {
      const timeline = buildOverlayTimeline(full());
      const { template } = buildOverlay(controls({ presetId: 'metric-strip', scale: 1.5 }), timeline, 16 / 9);
      const route = template.components.find((c) => c.type === 'routeInset')!;
      const tile = template.components.find((c) => c.type === 'text')!;
      expect(route.rect.height).toBeCloseTo(tile.rect.height, 6);
      expect(route.rect.width).toBeLessThan(0.15);
    });

    it('sizes the type to the tile, so nothing clips, at every size and aspect', () => {
      const timeline = buildOverlayTimeline(full());
      const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
      let shrunk = 0;
      for (const { id } of OVERLAY_PRESETS) {
        for (const scale of [0.75, 1, 1.5]) {
          for (const aspect of [0.5625, 1, 16 / 9, 3]) {
            const { template } = buildOverlay(
              controls({ presetId: id as OverlayPresetId, scale, enabled: everything }),
              timeline,
              aspect,
            );
            for (const component of template.components) {
              if (component.type !== 'text' && component.type !== 'gauge') continue;
              const fontScale = component.style.fontScale ?? template.style.fontScale;
              if (component.style.fontScale !== undefined) shrunk += 1;
              // Height in ems of the type actually drawn: label, value, track, padding.
              const heightEms = (component.rect.height * 100) / aspect / (BASE_FONT_CQW * fontScale);
              expect(
                heightEms,
                `${id} x${scale} @${aspect}: ${component.id}`,
              ).toBeGreaterThanOrEqual(TILE_HEIGHT_EMS - 1e-9);
            }
          }
        }
      }
      // The wide, largest case is one that has to shrink its type.
      expect(shrunk).toBeGreaterThan(0);
    });

    it('flows a long compact HUD into more columns instead of off the frame', () => {
      const timeline = buildOverlayTimeline(full());
      const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));
      const { template } = buildOverlay(
        controls({ presetId: 'compact-hud', enabled: everything }),
        timeline,
      );
      const columns = new Set(template.components.filter((c) => c.id !== 'route' && c.id !== 'progress').map((c) => c.rect.x));
      expect(columns.size).toBeGreaterThan(1);
    });

    it('anchors to the top or the bottom edge', () => {
      const timeline = buildOverlayTimeline(full());
      const y = (position: 'top' | 'bottom') =>
        buildOverlay(controls({ position }), timeline).template.components.find((c) => c.id === 'speed')!
          .rect.y;
      expect(y('top')).toBeLessThan(0.2);
      expect(y('bottom')).toBeGreaterThan(0.7);
    });

    it('makes components bigger with the size control, within limits', () => {
      const timeline = buildOverlayTimeline(full());
      const width = (scale: number) =>
        buildOverlay(controls({ presetId: 'compact-hud', scale }), timeline).template.components[0]!
          .rect.width;
      expect(width(1.5)).toBeGreaterThan(width(1));
      expect(width(1)).toBeGreaterThan(width(0.75));
      expect(width(50)).toBe(width(1.5));
    });

    it('carries the style choices into the template, and clamps them', () => {
      const timeline = buildOverlayTimeline(full());
      const built = buildOverlay(
        controls({ accentColor: '#00ff00', backgroundOpacity: 5, scale: 1.25, unitMode: 'imperial' }),
        timeline,
      );
      expect(built.template.style).toMatchObject({
        accentColor: '#00ff00',
        backgroundOpacity: 0.8,
        fontScale: 1.25,
      });
      expect(built.template.components.every((c) => c.unitMode === 'imperial')).toBe(true);
    });

    it('gives a portrait frame proportionally shorter tiles', () => {
      const timeline = buildOverlayTimeline(full());
      const height = (aspect: number) =>
        buildOverlay(controls(), timeline, aspect).template.components[0]!.rect.height;
      expect(height(0.5625)).toBeLessThan(height(16 / 9));
    });
  });
});
