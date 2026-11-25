import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueuedTiles } from './queuedTiles';

/** TD-088 (TD-064, TD-076, TD-078). Each export map keeps its own tiles, so closing one reaches no other's requests. */

interface Pending {
  url: string;
  signal: AbortSignal | undefined;
  finish: () => void;
}
let pending: Pending[] = [];

beforeEach(() => {
  pending = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        pending.push({
          url,
          signal,
          finish: () => resolve(new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 })),
        });
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

const tile = (path: string) => `https://tiles.example/${path}`;
const ask = (tiles: ReturnType<typeof createQueuedTiles>, url: string, controller = new AbortController()) =>
  tiles.handler({ url: tiles.queued(url).url, type: 'arrayBuffer' }, controller);

describe('the tiles an export map keeps', () => {
  it('are its own: each export has a scheme of its own, and an outside URL goes out under it', () => {
    const a = createQueuedTiles();
    const b = createQueuedTiles();
    expect(a.scheme).not.toBe(b.scheme);
    expect(a.queued(tile('1.pbf')).url).toBe(`${a.scheme}://tiles.example/1.pbf`);
    expect(a.queued('blob:local').url).toBe('blob:local');
  });

  it('are let go with the export that closes, and the other export\'s pending fetches complete', async () => {
    const a = createQueuedTiles();
    const b = createQueuedTiles();
    const fromA = ask(a, tile('a.pbf'));
    const fromB = ask(b, tile('b.pbf'));
    const sameFromB = ask(b, tile('a.pbf'));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    a.forget();
    // A's fetch is aborted; B's, even for the very same URL, is not.
    await expect(fromA).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending[0]!.signal!.aborted).toBe(true);
    expect(pending[1]!.signal!.aborted).toBe(false);
    expect(pending[2]!.signal!.aborted).toBe(false);
    pending.slice(1).forEach((entry) => entry.finish());
    expect((await fromB).data).toBeInstanceOf(ArrayBuffer);
    expect((await sameFromB).data).toBeInstanceOf(ArrayBuffer);
  });

  it('are asked once each in a render, however many times MapLibre asks (TD-076), and counted per export', async () => {
    const a = createQueuedTiles();
    const b = createQueuedTiles();
    const first = ask(b, tile('t.pbf'));
    const second = ask(b, tile('t.pbf'));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!.finish();
    await Promise.all([first, second]);
    await ask(b, tile('t.pbf'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(b.asked()).toBe(1);
    expect(a.asked()).toBe(0);
  });
});
