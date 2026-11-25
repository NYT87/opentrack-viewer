import { describe, expect, it, vi } from 'vitest';
import { startBurnedInExport, startOverlayExport, MAPTILER_PNG_REFUSAL, type WorkerLike } from './client';
import type { InsetMapSession, InsetMapsInput } from './insetMaps';
import type { BurnRequest, ExportRequest, FromWorker, ToWorker } from './protocol';
import { parseRouteInsetSetting } from '../routeInset';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, type OverlayTemplate } from '../template';
import { activityThrough, straightNorth } from '../../test/helpers/mapVideoRoutes';

/**
 * AV-1023 (TD-092). The page's side of a route inset's map in an export: the worker asks for a frame's
 * pictures, the page's maps make them, they go back transferred; no round trip without a map; MapTiler never
 * for the PNG sequence; and the maps end with the job however it ends.
 */

const ride = activityThrough(straightNorth(500, 10, 5));
const templateWith = (provider: 'none' | 'openfreemap' | 'maptiler'): OverlayTemplate => ({
  version: OVERLAY_TEMPLATE_VERSION,
  name: 't',
  style: DEFAULT_OVERLAY_STYLE,
  components: [
    {
      id: 'route',
      type: 'routeInset',
      visible: true,
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
      unitMode: 'auto',
      style: {},
      routeInset: parseRouteInsetSetting({ view: 'follow', map: { provider, style: provider === 'maptiler' ? 'satellite' : 'liberty' } }),
    },
  ],
});
const request = (template: OverlayTemplate): Omit<ExportRequest, 'archiveName'> => ({
  width: 320,
  height: 180,
  fps: 10,
  frameCount: 3,
  videoDurationSeconds: 100,
  offsetSeconds: 0,
  units: 'metric',
  template,
  activity: ride,
});

function fakeWorker() {
  const posted: { message: ToWorker; transfer?: Transferable[] }[] = [];
  const worker: WorkerLike & { terminated: boolean; emit: (message: FromWorker) => void } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage: (message, transfer) => void posted.push({ message, transfer }),
    terminate() {
      worker.terminated = true;
    },
    emit(message) {
      worker.onmessage?.({ data: message } as MessageEvent<FromWorker>);
    },
  };
  return { worker, posted };
}

function fakeSession(overrides: Partial<InsetMapSession> = {}) {
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const session = {
    bitmapsAt: vi.fn(async (_seconds: number, ids: string[]) => Object.fromEntries(ids.map((id) => [id, bitmap]))),
    warm: vi.fn(async () => undefined),
    close: vi.fn(),
    ...overrides,
  };
  let input: InsetMapsInput | undefined;
  return { session, bitmap, create: (given: InsetMapsInput) => ((input = given), session), input: () => input };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a PNG export with a map in a route inset (AV-1023)', () => {
  it('answers the worker’s ask for a frame’s pictures with the maps’ own, transferred', async () => {
    const { worker, posted } = fakeWorker();
    const { session, bitmap, create, input } = fakeSession();
    startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'insets', frame: 4, seconds: 2.5, ids: ['route'] });
    await tick();
    expect(session.bitmapsAt).toHaveBeenCalledWith(2.5, ['route']);
    const reply = posted.find((entry) => entry.message.type === 'insetBitmaps')!;
    expect(reply.message).toEqual({ type: 'insetBitmaps', frame: 4, bitmaps: { route: bitmap } });
    expect(reply.transfer).toEqual([bitmap]);
    // The maps are made for this picture's size, from the same activity and template; the key is the page's own.
    expect(input()).toMatchObject({ width: 320, height: 180, maptilerKey: '' });
    expect(input()!.template).toEqual(templateWith('openfreemap'));
  });

  it('keeps the MapTiler key on the page: the worker’s request never holds it', async () => {
    const { worker, posted } = fakeWorker();
    const { create, input } = fakeSession();
    startBurnedInExport(
      { ...(request(templateWith('maptiler')) as object), file: new File(['v'], 'a.mp4'), bitrate: 1_000_000 } as Omit<BurnRequest, 'archiveName'>,
      () => undefined,
      { createWorker: () => worker, createInsets: create, maptilerKey: 'secret-key' },
    );
    await tick();
    expect(input()!.maptilerKey).toBe('secret-key');
    expect(JSON.stringify(posted.map((entry) => ({ ...entry.message, request: { ...(entry.message as { request?: object }).request, file: undefined, activity: undefined } })))).not.toContain('secret-key');
  });

  it('makes no maps, and answers no round trips, for a template with no map', async () => {
    const { worker, posted } = fakeWorker();
    const create = vi.fn();
    startOverlayExport(request(templateWith('none')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    expect(create).not.toHaveBeenCalled();
    worker.emit({ type: 'insets', frame: 0, seconds: 0, ids: ['route'] });
    await tick();
    expect(posted.some((entry) => entry.message.type === 'insetBitmaps')).toBe(false);
  });

  it('refuses a MapTiler map, with the reason, and starts nothing', async () => {
    const { worker, posted } = fakeWorker();
    const create = vi.fn();
    const job = startOverlayExport(request(templateWith('maptiler')), () => undefined, { createWorker: () => worker, createInsets: create });
    await expect(job.done).rejects.toMatchObject({ code: 'render_failed', message: MAPTILER_PNG_REFUSAL });
    await tick();
    expect(posted).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('ends the maps when the export is done', async () => {
    const { worker } = fakeWorker();
    const { session, create } = fakeSession();
    const job = startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'done', file: new Blob(['z']), bytes: 1, frameCount: 3, storage: 'memory' });
    await job.done;
    expect(session.close).toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it('ends the maps when the worker fails', async () => {
    const { worker } = fakeWorker();
    const { session, create } = fakeSession();
    const job = startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'error', code: 'render_failed', message: 'no' });
    await expect(job.done).rejects.toMatchObject({ message: 'no' });
    expect(session.close).toHaveBeenCalled();
  });

  it('stops the maps waiting on a tile when the export is stopped, and says it was stopped', async () => {
    const { worker } = fakeWorker();
    const gate = { reject: (_: unknown) => undefined as void };
    const { session, create, input } = fakeSession({
      bitmapsAt: vi.fn(
        () =>
          new Promise<Record<string, ImageBitmap>>((_resolve, reject) => {
            gate.reject = reject;
          }),
      ),
    });
    const job = startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'insets', frame: 0, seconds: 0, ids: ['route'] });
    await tick();
    job.cancel();
    expect(input()!.signal!.aborted).toBe(true);
    const { OverlayExportError } = await import('./errors');
    gate.reject(new OverlayExportError('cancelled', 'The export was stopped.'));
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
    expect(session.close).toHaveBeenCalled();
  });

  it('hands the page’s waiting report to the maps', async () => {
    const { worker } = fakeWorker();
    const { create, input } = fakeSession();
    const onWaiting = vi.fn();
    startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create, onWaiting });
    await tick();
    expect(input()!.onWaiting).toBe(onWaiting);
  });

  it('lets the worker end a stop pressed while it waits on a picture: it aborts its archive and says so; the page does not end the job first', async () => {
    const { worker } = fakeWorker();
    const gate = { reject: (_: unknown) => undefined as void };
    const { create } = fakeSession({
      bitmapsAt: vi.fn(() => new Promise<Record<string, ImageBitmap>>((_resolve, reject) => void (gate.reject = reject))),
    });
    const job = startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'insets', frame: 0, seconds: 0, ids: ['route'] });
    await tick();
    job.cancel();
    const { OverlayExportError } = await import('./errors');
    gate.reject(new OverlayExportError('cancelled', 'The export was stopped.'));
    await tick();
    // Not ended by the page: the worker is still there to abort its archive.
    expect(worker.terminated).toBe(false);
    worker.emit({ type: 'error', code: 'cancelled', message: 'The export was stopped.' });
    await expect(job.done).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminated).toBe(true);
  });

  it('fails the export, with the map’s own reason, when a tile could not be loaded, and does not send the worker a hole', async () => {
    const { worker, posted } = fakeWorker();
    const { session, create } = fakeSession({ bitmapsAt: vi.fn(async () => Promise.reject(new Error('A map tile could not be loaded after 3 tries'))) });
    const job = startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'insets', frame: 0, seconds: 0, ids: ['route'] });
    await expect(job.done).rejects.toMatchObject({ code: 'render_failed', message: expect.stringContaining('tile could not be loaded') });
    expect(posted.some((entry) => entry.message.type === 'insetBitmaps')).toBe(false);
    expect(worker.terminated).toBe(true);
    expect(session.close).toHaveBeenCalled();
  });

  it('closes pictures that arrive after the job has ended', async () => {
    const { worker, posted } = fakeWorker();
    const release: { resolve: (value: Record<string, ImageBitmap>) => void } = { resolve: () => undefined };
    const late = { close: vi.fn() } as unknown as ImageBitmap;
    const { create } = fakeSession({
      bitmapsAt: vi.fn(() => new Promise<Record<string, ImageBitmap>>((resolve) => (release.resolve = resolve))),
    });
    const job = startOverlayExport(request(templateWith('openfreemap')), () => undefined, { createWorker: () => worker, createInsets: create });
    await tick();
    worker.emit({ type: 'insets', frame: 0, seconds: 0, ids: ['route'] });
    await tick();
    worker.emit({ type: 'error', code: 'render_failed', message: 'gone' });
    await expect(job.done).rejects.toBeDefined();
    release.resolve({ route: late });
    await tick();
    expect((late as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(posted.some((entry) => entry.message.type === 'insetBitmaps')).toBe(false);
  });
});

describe('a burned-in render with a map in a route inset (AV-1023)', () => {
  it('asks the page’s maps for the frame the worker is about to draw', async () => {
    const { worker, posted } = fakeWorker();
    const { session, create } = fakeSession();
    startBurnedInExport(
      { ...(request(templateWith('openfreemap')) as object), file: new File(['v'], 'a.mp4'), bitrate: 1_000_000 } as Omit<BurnRequest, 'archiveName'>,
      () => undefined,
      { createWorker: () => worker, createInsets: create },
    );
    await tick();
    expect(posted[0]!.message.type).toBe('burn');
    worker.emit({ type: 'insets', frame: 0, seconds: 12, ids: ['route'] });
    await tick();
    expect(session.bitmapsAt).toHaveBeenCalledWith(12, ['route']);
  });

  it('is not refused for MapTiler: a video may carry it', async () => {
    const { worker, posted } = fakeWorker();
    const { create } = fakeSession();
    const job = startBurnedInExport(
      { ...(request(templateWith('maptiler')) as object), file: new File(['v'], 'a.mp4'), bitrate: 1_000_000 } as Omit<BurnRequest, 'archiveName'>,
      () => undefined,
      { createWorker: () => worker, createInsets: create, maptilerKey: 'k' },
    );
    await tick();
    expect(posted[0]!.message.type).toBe('burn');
    worker.emit({ type: 'error', code: 'render_failed', message: 'end of test' });
    await expect(job.done).rejects.toBeDefined();
  });
});
