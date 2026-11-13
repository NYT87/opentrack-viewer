import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireInsets, receiveInsetBitmaps } from './insetBridge';
import type { OverlayRenderer } from './drawOverlay';
import type { FromWorker } from './protocol';

/** AV-1023 (TD-092). The worker's side of the route insets' maps: one frame's pictures asked for, answered, drawn with and let go. */

const bitmap = () => ({ close: vi.fn(), width: 10, height: 10 }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
const renderer = (ids: string[]): OverlayRenderer => ({ drawFrame: () => undefined, insetsAt: () => ids });

describe('asking the page for a frame’s map pictures', () => {
  const posted: FromWorker[] = [];
  const post = (message: FromWorker) => void posted.push(message);
  beforeEach(() => {
    posted.length = 0;
  });

  it('makes no round trip for a frame with no map behind an inset', async () => {
    const insets = await acquireInsets(renderer([]), post, 0, 1.5);
    expect(posted).toEqual([]);
    expect(insets.maps).toBeUndefined();
    expect(() => insets.release()).not.toThrow();
  });

  it('posts the frame, its time and the insets wanted, and waits for the answer to that frame', async () => {
    const asked = acquireInsets(renderer(['a', 'b']), post, 7, 2.5);
    expect(posted).toEqual([{ type: 'insets', frame: 7, seconds: 2.5, ids: ['a', 'b'] }]);
    const a = bitmap();
    const b = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 7, bitmaps: { a, b } });
    const insets = await asked;
    expect([...(insets.maps!.bitmaps as Map<string, ImageBitmap>).keys()]).toEqual(['a', 'b']);
    // Let go once the frame is drawn, and not before.
    expect(a.close).not.toHaveBeenCalled();
    insets.release();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('closes pictures for a frame nobody is waiting for, instead of keeping them', async () => {
    const stray = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 99, bitmaps: { a: stray } });
    expect(stray.close).toHaveBeenCalledTimes(1);

    const asked = acquireInsets(renderer(['a']), post, 3, 1);
    const late = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 2, bitmaps: { a: late } });
    expect(late.close).toHaveBeenCalledTimes(1);
    const right = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 3, bitmaps: { a: right } });
    const insets = await asked;
    expect(insets.maps).toBeDefined();
    insets.release();
  });

  it('stops waiting when the export is stopped, and closes what arrives after', async () => {
    const controller = new AbortController();
    const asked = acquireInsets(renderer(['a']), post, 1, 0, controller.signal);
    controller.abort();
    await expect(asked).rejects.toMatchObject({ code: 'cancelled' });
    const late = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 1, bitmaps: { a: late } });
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it('does not even ask once stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireInsets(renderer(['a']), post, 1, 0, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(posted).toEqual([]);
  });

  it('is one frame at a time: the answer to the frame asked is the one that is drawn', async () => {
    const first = acquireInsets(renderer(['a']), post, 0, 0);
    const a0 = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 0, bitmaps: { a: a0 } });
    const insets0 = await first;
    insets0.release();
    const second = acquireInsets(renderer(['a']), post, 1, 1);
    const a1 = bitmap();
    receiveInsetBitmaps({ type: 'insetBitmaps', frame: 1, bitmaps: { a: a1 } });
    const insets1 = await second;
    expect((insets1.maps!.bitmaps as Map<string, ImageBitmap>).get('a')).toBe(a1);
    insets1.release();
    expect(posted.map((message) => (message as { frame: number }).frame)).toEqual([0, 1]);
  });
});
