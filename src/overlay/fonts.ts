import { OverlayExportError } from './export/errors';

/**
 * AV-1031 (TD-103). The overlay's font: which one a text is drawn in, and the bytes it is drawn from.
 *
 * A layout names a family and nothing else. The bytes come from this app's own origin (the four fonts
 * under `public/fonts/`) or from a file of the reader's own, kept in memory for the session and, if
 * they ask, in IndexedDB (`fontStore.ts`). One session registry holds the bytes of every font in use:
 * the page registers them with `FontFace`, and an export worker is handed the same bytes and registers
 * them before its first frame, so a frame is never drawn in a fallback font.
 */

export const SYSTEM_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** The largest font file read, in bytes, and the most the browser may keep of them. */
export const FONT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const KEPT_FONTS_MAX_BYTES = 50 * 1024 * 1024;
export const FONT_FAMILY_MAX = 64;
export const FONT_FILE_KINDS_TEXT = 'a TTF, OTF, WOFF or WOFF2 font';

/** A family name that is safe between quotes in a CSS font string: letters, digits, spaces and a little punctuation. */
const FAMILY_PATTERN = /^[\p{L}\p{N} ._+()-]+$/u;

/** The family as written, or `undefined` when it is not a name this app would put in a font string. */
export function cleanFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const family = value.trim().replace(/ {2,}/g, ' ');
  return family.length > 0 && family.length <= FONT_FAMILY_MAX && FAMILY_PATTERN.test(family) ? family : undefined;
}

/** The family followed by the system stack, so a glyph the font lacks is still drawn; the system stack alone for none. */
export function fontStack(family?: string): string {
  const clean = cleanFamily(family);
  return clean ? `"${clean}", ${SYSTEM_STACK}` : SYSTEM_STACK;
}

export interface BundledFont {
  family: string;
  slug: string;
  /** The notice at the top of the licence file shipped beside the font. */
  copyright: string;
}

export const BUNDLED_LICENCE = 'SIL Open Font License 1.1';

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'Inter', slug: 'inter', copyright: 'Copyright 2016 The Inter Project Authors' },
  { family: 'Roboto Condensed', slug: 'roboto-condensed', copyright: 'Copyright 2011 Google Inc.' },
  { family: 'JetBrains Mono', slug: 'jetbrains-mono', copyright: 'Copyright 2020 The JetBrains Mono Project Authors' },
  { family: 'Oswald', slug: 'oswald', copyright: 'Copyright 2016 The Oswald Project Authors' },
];

const WEIGHTS = [400, 700] as const;

/** Where a bundled font's file is served from: this app's own path, never another origin. */
export function bundledFontUrl(font: BundledFont, weight: number): string {
  return `${import.meta.env.BASE_URL}fonts/${font.slug}/${font.slug}-latin-${weight}-normal.woff2`;
}
export const bundledLicenceUrl = (font: BundledFont): string => `${import.meta.env.BASE_URL}fonts/${font.slug}/OFL.txt`;

export const bundledFont = (family: string | undefined): BundledFont | undefined => BUNDLED_FONTS.find((font) => font.family === family);

/** One face of a font, as a worker is handed it. */
export interface FontBytes {
  family: string;
  weight: number;
  bytes: ArrayBuffer;
}

/** The session registry: every font loaded in this tab, by family. */
const session = new Map<string, FontBytes[]>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};
/** For `useSyncExternalStore`: re-draw when a font arrives. */
export const subscribeFonts = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const fontsVersion = (): number => version;

/** The families the reader has loaded this session (not the bundled ones, until they are chosen). */
export const loadedFamilies = (): string[] => [...session.keys()];
export const isLoaded = (family: string): boolean => session.has(family);

/** Forgets the session's fonts; for tests. */
export function resetFontRegistry(): void {
  session.clear();
  changed();
}

/** The part of a `FontFaceSet` this uses (methods, so a test's stand-in fits). */
export interface FontSet {
  add(face: FontFace): unknown;
  forEach?(callback: (face: FontFace) => void): unknown;
}
const ownFontSet = (): FontSet | undefined => (typeof document !== 'undefined' ? document.fonts : (self as unknown as { fonts?: FontSet }).fonts);

/**
 * Registers faces with `FontFace` and waits for them to load: on the page, and in an export worker
 * (`self.fonts`) before its first frame. A face that fails stops the export with the reason.
 */
export async function installFonts(fonts: readonly FontBytes[], target: FontSet | undefined = ownFontSet()): Promise<void> {
  if (fonts.length === 0) return;
  if (!target || typeof FontFace === 'undefined') throw new OverlayExportError('unsupported_browser', 'This browser cannot load a font for the export.');
  const present = new Set<string>();
  target.forEach?.((face: FontFace) => present.add(`${face.family.replace(/^"|"$/g, '')}|${face.weight}`));
  for (const { family, weight, bytes } of fonts) {
    if (present.has(`${family}|${weight}`)) continue;
    try {
      const face = new FontFace(family, bytes, { weight: String(weight) });
      await face.load();
      target.add(face);
    } catch (error) {
      throw new OverlayExportError('render_failed', `The font ${family} could not be loaded${error instanceof Error && error.message ? ` (${error.message})` : ''}.`);
    }
  }
}

async function register(faces: FontBytes[]): Promise<void> {
  await installFonts(faces);
  session.set(faces[0]!.family, faces);
  changed();
}

/** Fetches a bundled font's two weights from the app's own path and registers them; once. */
export async function loadBundledFont(font: BundledFont): Promise<void> {
  if (session.has(font.family)) return;
  const faces: FontBytes[] = [];
  for (const weight of WEIGHTS) {
    const response = await fetch(bundledFontUrl(font, weight));
    if (!response.ok) throw new Error(`${font.family} could not be loaded (${response.status}).`);
    faces.push({ family: font.family, weight, bytes: await response.arrayBuffer() });
  }
  await register(faces);
}

/** TTF, OTF, WOFF and WOFF2 by their first four bytes, never by the file's name. */
export function isFontBytes(bytes: Uint8Array): boolean {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  return tag === 'wOFF' || tag === 'wOF2' || tag === 'OTTO' || tag === 'true' || tag === '\u0000\u0001\u0000\u0000';
}

export type FontFileResult = { ok: true; family: string; bytes: ArrayBuffer } | { ok: false; reason: string };

/** The family a file would be offered under: its name without the extension, made safe, and not one already in use. */
export function nameForFile(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N} ._+()-]+/gu, '-').slice(0, FONT_FAMILY_MAX - 4).trim();
  const base = cleanFamily(stem) ?? 'My font';
  let name = base;
  for (let n = 2; session.has(name) || bundledFont(name); n += 1) name = `${base} ${n}`;
  return name;
}

/**
 * Reads a font file the reader chose and registers it: its size and kind are checked first, then the
 * browser must load it. `as` names the family the file is for (a layout that wants it); otherwise it
 * is offered under its file's name. The bytes stay in memory; keeping them is `fontStore.ts`'s job.
 */
export async function loadFontFile(file: File, as?: string): Promise<FontFileResult> {
  if (file.size > FONT_FILE_MAX_BYTES) return { ok: false, reason: `${file.name} is larger than 10 MB.` };
  const bytes = await file.arrayBuffer();
  if (!isFontBytes(new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)))) {
    return { ok: false, reason: `${file.name} is not ${FONT_FILE_KINDS_TEXT}.` };
  }
  const family = cleanFamily(as) ?? nameForFile(file.name);
  try {
    await register([{ family, weight: 400, bytes }]);
  } catch (error) {
    return { ok: false, reason: `${file.name} could not be read as a font${error instanceof Error && error.message ? ` (${error.message})` : ''}.` };
  }
  return { ok: true, family, bytes };
}

/** Puts back a font kept in this browser. */
export const loadKeptFont = (family: string, bytes: ArrayBuffer): Promise<void> => register([{ family, weight: 400, bytes }]);

/** The style with its font set, or with the key dropped for none (a component then follows the layout's). */
export function withFontFamily<T extends { fontFamily?: string }>(style: T, family: string | undefined): T {
  const next = { ...style };
  if (family) next.fontFamily = family;
  else delete next.fontFamily;
  return next;
}

/** Every family a template draws text in: its own and its visible components'. */
export function usedFamilies(template: { style: { fontFamily?: string }; components: readonly { visible: boolean; style: { fontFamily?: string } }[] }): string[] {
  const families = new Set<string>();
  for (const family of [template.style.fontFamily, ...template.components.filter((component) => component.visible).map((component) => component.style.fontFamily)]) {
    const clean = cleanFamily(family);
    if (clean) families.add(clean);
  }
  return [...families];
}

/** The families a template names that are neither loaded nor bundled: drawn in the system font, and said to be missing. */
export const missingFamilies = (families: readonly string[]): string[] => families.filter((family) => !session.has(family) && !bundledFont(family));

/** Makes a family ready to draw with: a bundled one is fetched, a kept one is put back; resolves with why when it cannot be. */
export type FamilyResult = { ok: true } | { ok: false; reason: string; /** Nothing here has this font: it needs the reader's file. Otherwise it is here and failed. */ missing: boolean };

export async function ensureFamily(family: string): Promise<FamilyResult> {
  if (session.has(family)) return { ok: true };
  try {
    const bundled = bundledFont(family);
    if (bundled) {
      await loadBundledFont(bundled);
      return { ok: true };
    }
    const kept = await (await import('./fontStore')).readKeptFont(family);
    if (kept) {
      await loadKeptFont(family, kept);
      return { ok: true };
    }
  } catch (error) {
    return { ok: false, missing: false, reason: error instanceof Error && error.message ? error.message : `${family} could not be loaded.` };
  }
  return { ok: false, missing: true, reason: `This layout uses ${family}, which is not loaded here.` };
}

/**
 * Before an export draws anything: every font the template uses is loaded, and its bytes are returned
 * for a worker to register. A font that cannot be loaded stops the export with the reason, rather
 * than drawing in a fallback.
 */
export async function prepareTemplateFonts(template: Parameters<typeof usedFamilies>[0]): Promise<FontBytes[]> {
  const faces: FontBytes[] = [];
  for (const family of usedFamilies(template)) {
    const ready = await ensureFamily(family);
    if (!ready.ok) throw new OverlayExportError('render_failed', ready.reason);
    faces.push(...(session.get(family) ?? []));
  }
  return faces;
}
