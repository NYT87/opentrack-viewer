import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInsetMaps } from './insetMaps';
import type { ExportMap } from '../../mapVideo/export/renderMapVideo';
import { parseRouteInsetSetting } from '../routeInset';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayTemplate } from '../template';
import { buildOverlayTimeline } from '../timeline';
import { activityThrough, straightNorth } from '../../test/helpers/mapVideoRoutes';

/**
 * AV-1023 (TD-092). The page's maps for an export: one for each inset with a basemap, at the inset's size in output
 * pixels, moved to the renderer's camera with every tile waited for (`settle`), a picture taken, and nothing asked
 * for a hidden stretch.
 */

const ride = activityThrough(straightNorth(1000, 10, 5));
const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 200 } });
const template = (setting: object = {}, trim?: OverlayTemplate['privacyTrim']): OverlayTemplate => ({
  version: OVERLAY_TEMPLATE_VERSION,
  name: 't',
  style: DEFAULT_OVERLAY_STYLE,
  components: [
    { id: 'route', type: 'routeInset', visible: true, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.3555556 }, unitMode: 'auto', style: {}, routeInset: parseRouteInsetSetting({ view: 'follow', zoom: 15, map: { provider: 'openfreemap', style: 'liberty' }, ...setting }) },
  ],
  ...(trim ? { privacyTrim: trim } : {}),
});

function fakeMap() {
  const jumps: { center: [number, number]; zoom: number; bearing: number; pitch: number }[] = [];
  const settle = vi.fn(async (move: () => void) => move());
  const close = vi.fn();
  const canvas = { width: 384, height: 384 };
  const exportMap = {
    map: { jumpTo: (options: (typeof jumps)[number]) => void jumps.push(options), getCanvas: () => canvas },
    settle,
    requests: () => 0,
    close,
  } as unknown as ExportMap;
  return { exportMap, jumps, settle, close, canvas };
}

beforeEach(() => {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ close: vi.fn(), width: 384, height: 384 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const make = (given: OverlayTemplate, extra: { maptilerKey?: string; signal?: AbortSignal } = {}) => {
  const map = fakeMap();
  const open = vi.fn(async (_options: unknown) => map.exportMap);
  const session = createInsetMaps({ template: given, activity: ride, timeline, width: 1920, height: 1080, maptilerKey: extra.maptilerKey ?? '', signal: extra.signal, open });
  return { ...map, open, session };
};

describe('the page’s maps for an export (AV-1023)', () => {
  it('opens one map for the inset, at its size in reference pixels drawn at the output’s, from the style chosen', async () => {
    const { session, open } = make(template());
    await session.bitmapsAt(100, ['route']);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({
      width: 384,
      height: expect.closeTo(384, 3),
      pixelRatio: 1,
      styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
      what: 'a frame',
      // Born at the first frame's camera: its first draw asks for no tile of the world's default view.
      camera: expect.objectContaining({ zoom: 15, bearing: 0 }),
    });
  });

  it('draws a larger frame at a larger pixel ratio over the same laid-out map', async () => {
    const map = fakeMap();
    const open = vi.fn(async (_options: unknown) => map.exportMap);
    const session = createInsetMaps({ template: template(), activity: ride, timeline, width: 3840, height: 2160, maptilerKey: '', open });
    await session.bitmapsAt(100, ['route']);
    expect(open.mock.calls[0]![0]).toMatchObject({ width: 384, pixelRatio: 2 });
  });

  it('moves the map to the camera, waiting for every tile, and takes a picture of the canvas', async () => {
    const { session, jumps, settle, canvas } = make(template());
    const pictures = await session.bitmapsAt(100, ['route']);
    expect(settle).toHaveBeenCalledTimes(1);
    const position = timeline.sampleAt(100)!.position!;
    expect(jumps[0]).toMatchObject({ zoom: 15, bearing: 0, pitch: 0 });
    expect(jumps[0]!.center[0]).toBeCloseTo(position.lon, 9);
    expect(jumps[0]!.center[1]).toBeCloseTo(position.lat, 9);
    expect(createImageBitmap).toHaveBeenCalledWith(canvas);
    expect(Object.keys(pictures)).toEqual(['route']);
  });

  it('does not wait for a map that has not moved: no `idle` would come', async () => {
    const { session, settle } = make(template({ view: 'whole' }));
    await session.bitmapsAt(10, ['route']);
    await session.bitmapsAt(20, ['route']);
    await session.bitmapsAt(30, ['route']);
    // The whole route is the same camera at every moment.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(createImageBitmap).toHaveBeenCalledTimes(3);
  });

  it('opens one map for an inset, once, for every frame', async () => {
    const { session, open } = make(template());
    await session.bitmapsAt(10, ['route']);
    await session.bitmapsAt(11, ['route']);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing at a moment in a hidden stretch beyond the held kept end: the camera does not leave it', async () => {
    const { session, jumps } = make(template({}, { start: 0.2, end: 0.2 }));
    await session.bitmapsAt(2, ['route']);
    await session.bitmapsAt(30, ['route']);
    // Both are before the first kept place (200 m, 40 s): the camera is held at it, and settled once.
    expect(jumps).toHaveLength(1);
    const north = (lat: number) => (lat - 46) * 111_195;
    expect(north(jumps[0]!.center[1])).toBeCloseTo(200, 0);
    await session.bitmapsAt(190, ['route']);
    expect(north(jumps[1]!.center[1])).toBeCloseTo(800, 0);
  });

  it('answers for an inset with no moment (outside the activity) with no picture', async () => {
    const { session, open } = make(template());
    expect(await session.bitmapsAt(9999, ['route'])).toEqual({});
    expect(open).not.toHaveBeenCalledWith(expect.objectContaining({ width: 0 }));
  });

  it('opens no map for MapTiler without a key: the line is drawn alone, nothing is asked of anyone', async () => {
    const { session, open } = make(template({ map: { provider: 'maptiler', style: 'satellite' } }));
    expect(await session.bitmapsAt(100, ['route'])).toEqual({});
    expect(open).not.toHaveBeenCalled();
  });

  it('opens MapTiler’s style with the reader’s key, encoded', async () => {
    const { session, open } = make(template({ map: { provider: 'maptiler', style: 'satellite' } }), { maptilerKey: 'a b&c' });
    await session.bitmapsAt(100, ['route']);
    expect(open.mock.calls[0]![0]).toMatchObject({ styleUrl: 'https://api.maptiler.com/maps/satellite/style.json?key=a%20b%26c' });
  });

  it('gives up at once when the export is stopped, and closes what it took', async () => {
    const controller = new AbortController();
    const { session } = make(template(), { signal: controller.signal });
    controller.abort();
    await expect(session.bitmapsAt(100, ['route'])).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('closes the pictures already taken when a later one fails, so none leaks', async () => {
    const first = { close: vi.fn() };
    const create = createImageBitmap as unknown as ReturnType<typeof vi.fn>;
    create.mockResolvedValueOnce(first);
    const map = fakeMap();
    const second = fakeMap();
    second.settle.mockRejectedValue(new Error('A map tile could not be loaded'));
    const two: OverlayTemplate = { ...template(), components: [...template().components, { ...template().components[0]!, id: 'other' }] };
    const open = vi.fn().mockResolvedValueOnce(map.exportMap).mockResolvedValueOnce(second.exportMap);
    const session = createInsetMaps({ template: two, activity: ride, timeline, width: 1920, height: 1080, maptilerKey: '', open });
    await expect(session.bitmapsAt(100, ['route', 'other'])).rejects.toThrow('tile could not be loaded');
    expect(first.close).toHaveBeenCalledTimes(1);
  });

  it('ends every map once, and refuses to work after', async () => {
    const { session, close } = make(template());
    await session.bitmapsAt(100, ['route']);
    session.close();
    session.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(session.bitmapsAt(101, ['route'])).rejects.toMatchObject({ code: 'cancelled' });
  });

  describe('loading every tile of a plan before a recording starts (the transparent WebM)', () => {
    it('visits the cameras of the plan once, enough to see every tile, not every frame', async () => {
      const { session, settle } = make(template({ zoom: 16 }));
      const times = Array.from({ length: 100 }, (_, i) => 50 + i / 10);
      await session.warm(times);
      // A hundred frames over ten seconds move 50 m: a few visits, not a hundred.
      expect(settle.mock.calls.length).toBeGreaterThan(0);
      expect(settle.mock.calls.length).toBeLessThan(40);
    });

    it('visits more where the camera moves far: the whole ride at a high zoom', async () => {
      const { session, settle } = make(template({ zoom: 17 }));
      await session.warm(Array.from({ length: 190 }, (_, i) => 5 + i));
      expect(settle.mock.calls.length).toBeGreaterThan(20);
    });

    it('reports its progress and stops when the export is stopped', async () => {
      const controller = new AbortController();
      const { session } = make(template(), { signal: controller.signal });
      const progress = vi.fn();
      await session.warm([10, 20, 30], progress);
      expect(progress).toHaveBeenLastCalledWith(3, 3);
      controller.abort();
      await expect(session.warm([40, 50])).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('never visits a hidden stretch: both ends of a trimmed ride are one camera', async () => {
      const { session, jumps } = make(template({ zoom: 15 }, { start: 0.3, end: 0.3 }));
      await session.warm([1, 5, 10, 20, 30, 40]);
      const north = (lat: number) => (lat - 46) * 111_195;
      // Everything before 300 m (60 s) is one camera, at 300 m.
      expect(jumps).toHaveLength(1);
      expect(north(jumps[0]!.center[1])).toBeCloseTo(300, 0);
    });
  });
});
