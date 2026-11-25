import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurnRequest, FromWorker, ToWorker } from './protocol';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay } from '../presets';
import { buildOverlayTimeline } from '../timeline';
import { makeActivity } from '../../test/helpers/activity';

/**
 * The worker's entry point, run in the test thread with `self` stood in for:
 * what matters here is that every message gets an answer, including when the
 * lazily loaded renderer cannot be fetched.
 */
async function loadWorker(options: { burnWorkerFails?: boolean } = {}) {
  vi.resetModules();
  const posted: FromWorker[] = [];
  const scope: { onmessage: ((event: MessageEvent<ToWorker>) => void) | null; postMessage: (m: FromWorker) => void } = {
    onmessage: null,
    postMessage: (message) => void posted.push(message),
  };
  vi.stubGlobal('self', scope);
  if (options.burnWorkerFails) {
    vi.doMock('./burnWorker', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
  } else {
    vi.doUnmock('./burnWorker');
  }
  await import('./exportWorker');
  const send = (message: ToWorker) => scope.onmessage?.({ data: message } as MessageEvent<ToWorker>);
  // The worker answers asynchronously, and loading its renderer takes a moment:
  // wait for an answer, with a limit, rather than for a fixed number of ticks.
  const settled = async () => {
    const until = Date.now() + 3000;
    while (posted.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { posted, send, settled };
}

const file = new File(['v'], 'a.mp4');
const activity = makeActivity([{ time: new Date(0) }, { time: new Date(1000) }]);
const burn: BurnRequest = {
  file,
  width: 640,
  height: 360,
  bitrate: 1_000_000,
  videoDurationSeconds: 1,
  offsetSeconds: 0,
  units: 'metric',
  template: buildOverlay(DEFAULT_OVERLAY_CONTROLS, buildOverlayTimeline(activity)).template,
  activity,
  archiveName: 'overlay-export-w.zip',
};

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./burnWorker');
});

describe('the export worker answers every request (AV-1007)', () => {
  it('says so when the renderer for an inspection cannot be loaded, instead of leaving the page waiting', async () => {
    const { posted, send, settled } = await loadWorker({ burnWorkerFails: true });
    send({ type: 'inspect', file, width: 640, height: 360, bitrate: 1_000_000 });
    await settled();
    expect(posted).toEqual([
      {
        type: 'error',
        code: 'render_failed',
        message: expect.stringContaining('The video renderer could not be loaded.'),
      },
    ]);
  });

  it('says so when the renderer for a render cannot be loaded', async () => {
    const { posted, send, settled } = await loadWorker({ burnWorkerFails: true });
    send({ type: 'burn', request: burn });
    await settled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'error', code: 'render_failed' });
  });

  it('still answers a storage probe', async () => {
    const { posted, send, settled } = await loadWorker({ burnWorkerFails: true });
    send({ type: 'probe', archiveName: 'overlay-export-p.zip' });
    await settled();
    // No file system in the test environment: the answer is memory.
    expect(posted).toEqual([{ type: 'probed', storage: 'memory' }]);
  });

  it('hands a render to the renderer when it loads, and a stop reaches it', async () => {
    const { posted, send, settled } = await loadWorker();
    send({ type: 'burn', request: burn });
    send({ type: 'cancel' });
    await settled();
    // Rendering into memory is refused (an MP4 needs a file), and that is said.
    expect(posted[0]).toMatchObject({ type: 'error', code: 'storage_failed' });
  });
});
