import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const maps: { options: Record<string, unknown>; jumps: Record<string, unknown>[]; removed: boolean }[] = [];
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  Map: class {
    state: { options: Record<string, unknown>; jumps: Record<string, unknown>[]; removed: boolean };
    constructor(options: Record<string, unknown>) {
      this.state = { options, jumps: [], removed: false };
      maps.push(this.state);
    }
    jumpTo(options: Record<string, unknown>) {
      this.state.jumps.push(options);
    }
    remove() {
      this.state.removed = true;
    }
  },
}));

import InsetMapLayer from './InsetMapLayer';
import { parseRouteInsetSetting } from '../overlay/routeInset';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayTemplate } from '../overlay/template';
import { buildOverlayTimeline } from '../overlay/timeline';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';

/** AV-1023 (TD-092). The preview's live maps: one for each inset with a map, in its box, at the renderer's camera, without waiting for tiles. */

const ride = activityThrough(straightNorth(1000, 10, 5));
const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
const template = (...settings: object[]): OverlayTemplate => ({
  version: OVERLAY_TEMPLATE_VERSION,
  name: 't',
  style: DEFAULT_OVERLAY_STYLE,
  components: settings.map((setting, i) => ({
    id: `route-${i}`,
    type: 'routeInset' as const,
    visible: true,
    rect: { x: 0.1, y: 0.1 + i * 0.4, width: 0.25, height: 0.3 },
    unitMode: 'auto' as const,
    style: {},
    routeInset: parseRouteInsetSetting(setting),
  })),
});
const ofm = { view: 'follow', zoom: 16, map: { provider: 'openfreemap', style: 'positron' } };
const layer = (given: OverlayTemplate, seconds: number, maptilerKey = '') => (
  <InsetMapLayer template={given} timeline={timeline} activity={ride} width={720} height={405} seconds={seconds} maptilerKey={maptilerKey} />
);

afterEach(() => {
  cleanup();
  maps.length = 0;
});

describe('the preview’s live maps (AV-1023)', () => {
  it('makes a map for an inset with one, from its style, and none for one without', () => {
    render(layer(template(ofm, { view: 'follow' }), 100));
    expect(maps).toHaveLength(1);
    expect(maps[0]!.options).toMatchObject({ style: 'https://tiles.openfreemap.org/styles/positron', interactive: false, attributionControl: false, fadeDuration: 0, zoom: 16 });
  });

  it('puts the map in the inset’s box, as shares of the canvas', () => {
    const { container } = render(layer(template(ofm), 100));
    const box = container.querySelector('.inset-map') as HTMLElement;
    expect(box.style.left).toBe('10%');
    expect(box.style.width).toBe('25%');
    expect(box.style.visibility).toBe('visible');
  });

  it('is round for a round inset, in its centred square', () => {
    const { container } = render(layer(template({ ...ofm, shape: 'round' }), 100));
    const box = container.querySelector('.inset-map') as HTMLElement;
    expect(box.style.borderRadius).toBe('50%');
    // 180 x 121.5 canvas pixels: the circle is the shorter side.
    expect(parseFloat(box.style.width)).toBeCloseTo((121.5 / 720) * 100, 3);
  });

  it('moves to the camera of each moment without waiting for tiles', () => {
    const { rerender } = render(layer(template(ofm), 100));
    const position = (seconds: number) => timeline.sampleAt(seconds)!.position!;
    const before = maps[0]!.jumps.length;
    rerender(layer(template(ofm), 120));
    const jump = maps[0]!.jumps.at(-1)! as { center: [number, number]; zoom: number; bearing: number };
    expect(maps[0]!.jumps.length).toBeGreaterThan(before);
    expect(jump.center[1]).toBeCloseTo(position(120).lat, 9);
    expect(jump.zoom).toBe(16);
    expect(jump.bearing).toBe(0);
    expect(maps).toHaveLength(1);
  });

  it('hides the map where the inset is not drawn: outside the activity', () => {
    const { container } = render(layer(template(ofm), 9999));
    expect((container.querySelector('.inset-map') as HTMLElement).style.visibility).toBe('hidden');
  });

  it('draws no map for MapTiler until a key is typed, then one with it', () => {
    const mapTiler = { view: 'follow', map: { provider: 'maptiler', style: 'outdoor-v2' } };
    const { rerender, container } = render(layer(template(mapTiler), 100));
    expect(maps).toHaveLength(0);
    expect(container.querySelector('.inset-map')).toBeNull();
    rerender(layer(template(mapTiler), 100, 'my key'));
    expect(maps[0]!.options.style).toBe('https://api.maptiler.com/maps/outdoor-v2/style.json?key=my%20key');
  });

  it('holds a camera that does not follow: the whole route, north up', () => {
    render(layer(template({ view: 'whole', map: { provider: 'openfreemap', style: 'liberty' } }), 100));
    const first = maps[0]!.options as { bearing: number; zoom: number };
    expect(first.bearing).toBe(0);
    expect(first.zoom).toBeGreaterThan(10);
  });

  it('ends its maps when it goes', () => {
    const { unmount } = render(layer(template(ofm), 100));
    unmount();
    expect(maps[0]!.removed).toBe(true);
  });
});
