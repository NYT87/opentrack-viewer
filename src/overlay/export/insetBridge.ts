import { OverlayExportError } from './errors';
import type { OverlayRenderer } from './drawOverlay';
import type { InsetMapSource } from './drawInset';
import type { FromWorker, ToWorker } from './protocol';

/**
 * AV-1023 (TD-092). The worker's side of the route insets' maps. A worker cannot hold a map (MapLibre
 * needs a page), so before it draws a frame that has a basemap behind a route inset it posts
 * `insets` and waits for the page's `insetBitmaps` for that frame: one picture per inset, as an
 * `ImageBitmap` transferred to it. It draws them under the line and closes them, so one frame's
 * pictures are in memory at a time. A frame with no basemap inset, and a template with none, make
 * no round trip.
 *
 * One export runs in a worker at a time, so one request is outstanding at a time.
 */

type Post = (message: FromWorker) => void;

interface Pending {
  frame: number;
  resolve: (bitmaps: Map<string, ImageBitmap>) => void;
}
let pending: Pending | undefined;

const closeAll = (bitmaps: Iterable<ImageBitmap>) => {
  for (const bitmap of bitmaps) bitmap.close();
};

/** The page's answer: given to whoever asked for this frame; pictures nobody is waiting for are closed. */
export function receiveInsetBitmaps(message: Extract<ToWorker, { type: 'insetBitmaps' }>): void {
  const waiting = pending;
  if (!waiting || waiting.frame !== message.frame) {
    closeAll(Object.values(message.bitmaps));
    return;
  }
  pending = undefined;
  waiting.resolve(new Map(Object.entries(message.bitmaps)));
}

/** What a frame is drawn with: the maps' pictures if it has any, and the way to let them go once it is drawn. */
export interface AcquiredInsets {
  maps: InsetMapSource | undefined;
  release: () => void;
}

const NONE: AcquiredInsets = { maps: undefined, release: () => undefined };

/** Asks the page for the pictures frame `frame` needs, at `seconds`; none to ask for is no round trip. */
export async function acquireInsets(renderer: OverlayRenderer, post: Post, frame: number, seconds: number, signal?: AbortSignal): Promise<AcquiredInsets> {
  const ids = renderer.insetsAt(seconds);
  if (ids.length === 0) return NONE;
  if (signal?.aborted) throw new OverlayExportError('cancelled', 'The export was stopped.');
  const bitmaps = await new Promise<Map<string, ImageBitmap>>((resolve, reject) => {
    const onAbort = () => {
      pending = undefined;
      reject(new OverlayExportError('cancelled', 'The export was stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending = {
      frame,
      resolve: (answer) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      },
    };
    post({ type: 'insets', frame, seconds, ids });
  });
  if (signal?.aborted) {
    closeAll(bitmaps.values());
    throw new OverlayExportError('cancelled', 'The export was stopped.');
  }
  return { maps: { bitmaps }, release: () => closeAll(bitmaps.values()) };
}
