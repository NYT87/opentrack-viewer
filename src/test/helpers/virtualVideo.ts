import type { ReadableVideo } from '../../parsers/gopro/extractGpmf';
import { layoutGoproMp4, type GoproMp4Options } from './goproMp4.mjs';

export interface VirtualVideo extends ReadableVideo {
  /** Every range the extractor asked for, in order. */
  reads: { start: number; end: number }[];
  bytesRead: number;
  /** The zero bytes standing in for the picture: `[start, end)`. */
  filler: { start: number; end: number };
}

/**
 * `AV-906`. A GoPro recording of any size that exists nowhere: the real boxes
 * at either end, and a picture of zero bytes generated only for the ranges
 * that are actually read. A `File` is `size` plus `slice`, and that is all the
 * extractor touches, so this stands in for one exactly — and it keeps count,
 * so a test can say how much of a multi-gigabyte video a read cost.
 */
export function virtualVideo(options: GoproMp4Options): VirtualVideo {
  const { head, fillerBytes, tail } = layoutGoproMp4(options);
  const size = head.length + fillerBytes + tail.length;
  const tailStart = head.length + fillerBytes;
  const reads: VirtualVideo['reads'] = [];

  const video: VirtualVideo = {
    size,
    reads,
    bytesRead: 0,
    filler: { start: head.length, end: tailStart },
    slice(start, end) {
      const from = Math.max(0, Math.min(start, size));
      const to = Math.max(from, Math.min(end, size));
      reads.push({ start: from, end: to });
      video.bytesRead += to - from;
      return {
        async arrayBuffer() {
          const out = new Uint8Array(to - from);
          // Whatever overlaps the head or the tail is copied; the rest is zero.
          if (from < head.length) {
            const stop = Math.min(to, head.length);
            out.set(head.subarray(from, stop), 0);
          }
          if (to > tailStart) {
            const begin = Math.max(from, tailStart);
            out.set(tail.subarray(begin - tailStart, to - tailStart), begin - from);
          }
          return out.buffer;
        },
      };
    },
  };
  return video;
}
