import { vi } from 'vitest';
import { resetFontRegistry } from '../../overlay/fonts';

/** The first bytes of a WOFF2, a TTF and a file that is not a font. */
export const WOFF2 = [0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4];
export const NOT_A_FONT = new TextEncoder().encode('just some words');

export const fontFile = (name: string, bytes: ArrayLike<number> = WOFF2) => new File([Uint8Array.from(bytes)], name);

/**
 * AV-1031. The browser's font loading, stood in for: `FontFace` loads unless it is given the bytes
 * of `FAILING` after the first four (a font's signature), `document.fonts` collects what is registered, and `fetch` serves the bundled fonts
 * and records every URL it is asked for. Call `unstub()` (or `vi.unstubAllGlobals()`) afterwards.
 */
export const FAILING = [0x42, 0x41, 0x44, 0x21];

export function stubFonts() {
  const registered: { family: string; weight: string }[] = [];
  const requests: string[] = [];
  class Face {
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer,
      readonly descriptors: { weight?: string } = {},
    ) {}
    get weight() {
      return this.descriptors.weight ?? 'normal';
    }
    async load() {
      if (new Uint8Array(this.source)[4] === FAILING[0]) throw new Error('invalid font data');
      return this;
    }
  }
  vi.stubGlobal('FontFace', Face);
  const set = {
    add: (face: Face) => void registered.push({ family: face.family, weight: face.weight }),
    forEach: (callback: (face: Face) => void) => void callback,
  };
  Object.defineProperty(document, 'fonts', { value: set, configurable: true });
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(WOFF2).buffer };
  });
  resetFontRegistry();
  return {
    registered,
    requests,
    unstub: () => {
      Reflect.deleteProperty(document, 'fonts');
      vi.unstubAllGlobals();
      resetFontRegistry();
    },
  };
}
