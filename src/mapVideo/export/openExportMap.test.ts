import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const instances: { once: Record<string, (() => void)[]>; options: Record<string, unknown> }[] = [];
vi.mock('maplibre-gl', () => ({
  setWorkerUrl: vi.fn(),
  addProtocol: vi.fn(),
  removeProtocol: vi.fn(),
  Map: class {
    state: { once: Record<string, (() => void)[]>; options: Record<string, unknown> };
    constructor(options: Record<string, unknown>) {
      this.state = { once: {}, options };
      instances.push(this.state);
    }
    once(event: string, handler: () => void) {
      (this.state.once[event] ??= []).push(handler);
    }
    on() {}
    isStyleLoaded() {
      return false;
    }
    remove() {}
  },
}));

import { openExportMap } from './renderMapVideo';

/** AV-1023. The map's first load is waited on in the open: slow tiles or a hidden tab are said, not silent; and a map may start at a camera. */
describe('opening an export map', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says it is waiting for tiles when the first load is slow, and stops saying so once loaded', async () => {
    const onWaiting = vi.fn();
    const opened = openExportMap({ width: 100, height: 100, styleUrl: 'https://tiles.openfreemap.org/styles/liberty', what: 'a frame', onWaiting });
    await vi.advanceTimersByTimeAsync(400);
    expect(onWaiting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(onWaiting).toHaveBeenCalledWith('tiles');
    instances[0]!.once.load!.forEach((handler) => handler());
    await opened;
    expect(onWaiting).toHaveBeenLastCalledWith(undefined);
  });

  it('says a hidden tab is why, while the first load waits', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const onWaiting = vi.fn();
    const opened = openExportMap({ width: 100, height: 100, styleUrl: undefined, what: 'a frame', onWaiting });
    await vi.advanceTimersByTimeAsync(250);
    expect(onWaiting).toHaveBeenCalledWith('hidden');
    instances[0]!.once.load!.forEach((handler) => handler());
    await opened;
  });

  it('starts at the camera it is given, and at the default for a map video', async () => {
    const a = openExportMap({ width: 100, height: 100, styleUrl: undefined, what: 'a frame', camera: { center: [7, 46], zoom: 15, bearing: 30 } });
    instances[0]!.once.load!.forEach((handler) => handler());
    await a;
    expect(instances[0]!.options).toMatchObject({ center: [7, 46], zoom: 15, bearing: 30, pixelRatio: 1 });
    const b = openExportMap({ width: 100, height: 100, styleUrl: undefined, what: 'a frame' });
    instances[1]!.once.load!.forEach((handler) => handler());
    await b;
    expect(instances[1]!.options).not.toHaveProperty('center');
  });
});
