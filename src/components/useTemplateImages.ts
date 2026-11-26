import { useEffect, useMemo, useState } from 'react';
import { closeImages, decodeTemplateImages, type BrokenImage } from '../overlay/images';
import type { OverlayComponent } from '../overlay/template';

export interface TemplateImages {
  /** Decoded, for the renderer; undefined while there is nothing to draw or it is being decoded. */
  images: ReadonlyMap<string, ImageBitmap> | undefined;
  /** What could not be decoded, with why. */
  broken: BrokenImage[];
}

/**
 * A short key for a data URL: its length and 4096 characters sampled along it, so a drag does not compare megabytes.
 * shortcut: two different pictures of one length that agree at every sampled character would not be told apart; a replacement changes the length or the bytes it samples.
 */
function srcKey(src: string): string {
  const step = Math.max(1, Math.floor(src.length / 4096));
  let hash = 2166136261;
  for (let i = 0; i < src.length; i += step) hash = Math.imul(hash ^ src.charCodeAt(i), 16777619);
  return `${src.length}:${hash >>> 0}`;
}

const NONE: TemplateImages = { images: undefined, broken: [] };

/**
 * AV-1030 (TD-102). A preview's images: each visible image component decoded once for the frame it is
 * drawn for (an SVG at its box in that frame), again only when an image, its fit or its box changes, and
 * closed when it is replaced or the owner goes. A moved or dragged component with the same size does not decode again.
 */
export function useTemplateImages(components: readonly OverlayComponent[], frame: { width: number; height: number }): TemplateImages {
  const signature = useMemo(() => {
    const parts = components
      .filter((component) => component.type === 'image' && component.visible && component.image)
      .map((component) => {
        const { src, fit } = component.image!;
        // Only an SVG is drawn at a size of its own, so only it depends on the box.
        const box = src.startsWith('data:image/svg') ? `${Math.round(component.rect.width * frame.width)}x${Math.round(component.rect.height * frame.height)}` : '';
        return `${component.id}|${fit}|${box}|${srcKey(src)}`;
      });
    return parts.join('\n');
  }, [components, frame.width, frame.height]);
  const [decoded, setDecoded] = useState<TemplateImages>(NONE);

  useEffect(() => {
    let current = true;
    // Set after a tick either way, never in the effect's body: with no image, what was decoded before is let go.
    const decoding = signature === '' ? Promise.resolve({ images: undefined, broken: [] as BrokenImage[] }) : decodeTemplateImages(components, frame);
    void decoding.then((result) => {
      if (!current) {
        closeImages(result.images?.values());
        return;
      }
      setDecoded(result.images ? { images: result.images, broken: result.broken } : NONE);
    });
    return () => {
      current = false;
    };
    // `signature` stands for the images, their fits and boxes: the rest of `components` moving does not decode again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Let go of a set once the next is in use, never before: a frame being drawn may still hold it.
  useEffect(() => () => closeImages(decoded.images?.values()), [decoded]);

  return decoded;
}
