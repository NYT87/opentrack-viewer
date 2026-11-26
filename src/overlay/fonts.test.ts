import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { figureLayout } from './figureLayout';
import {
  BUNDLED_FONTS,
  type FontSet,
  FONT_FILE_MAX_BYTES,
  SYSTEM_STACK,
  bundledFontUrl,
  cleanFamily,
  ensureFamily,
  fontStack,
  installFonts,
  isFontBytes,
  loadFontFile,
  loadedFamilies,
  missingFamilies,
  nameForFile,
  prepareTemplateFonts,
  resetFontRegistry,
  usedFamilies,
  type FontBytes,
} from './fonts';
import { DEFAULT_OVERLAY_STYLE, OVERLAY_TEMPLATE_VERSION, parseOverlayTemplate, resolveOverlayComponent, serializeOverlayTemplate, type OverlayComponent, type OverlayTemplate } from './template';
import { buildOverlayTimeline, dataSourceId } from './timeline';
import { makeActivity } from '../test/helpers/activity';
import { layoutStillText } from './staticImage';

/** The browser's `FontFace`, with a font that loads unless its bytes say 'BAD!'. */
class FakeFace {
  static created: FakeFace[] = [];
  constructor(
    readonly family: string,
    readonly source: ArrayBuffer,
    readonly descriptors: { weight?: string } = {},
  ) {
    FakeFace.created.push(this);
  }
  get weight() {
    return this.descriptors.weight ?? 'normal';
  }
  async load() {
    if (new TextDecoder().decode(this.source.slice(0, 4)) === 'BAD!') throw new Error('invalid font data');
    return this;
  }
}

const added: FakeFace[] = [];
const fontSet = { add: (face: FakeFace) => void added.push(face), forEach: (callback: (face: FakeFace) => void) => added.forEach(callback) };

const bytesOf = (tag: string, size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(tag));
  return bytes;
};
const TTF = new Uint8Array([0, 1, 0, 0, 7, 7, 7, 7]);
const fileOf = (name: string, bytes: Uint8Array) => new File([bytes as BlobPart], name);

beforeEach(() => {
  vi.stubGlobal('FontFace', FakeFace);
  Object.defineProperty(document, 'fonts', { value: fontSet, configurable: true });
  FakeFace.created = [];
  added.length = 0;
  resetFontRegistry();
});
const realLoad = FakeFace.prototype.load;
afterEach(() => {
  FakeFace.prototype.load = realLoad;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'fonts');
});

const component = (over: Partial<OverlayComponent> & Pick<OverlayComponent, 'id' | 'type'>): OverlayComponent => ({
  visible: true,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  unitMode: 'auto',
  style: {},
  ...over,
});

describe('a font family’s name (AV-1031, TD-103)', () => {
  it('is kept as a plain name and nothing that could leave the quotes of a font string', () => {
    expect(cleanFamily('  Roboto   Condensed ')).toBe('Roboto Condensed');
    expect(cleanFamily('My Font (Bold) 2')).toBe('My Font (Bold) 2');
    for (const bad of ['', '   ', 'a"b', 'a\\b', 'a;b', 'a\nb', '<b>', 'x'.repeat(65), 42, undefined, null]) expect(cleanFamily(bad)).toBeUndefined();
  });

  it('is followed by the system stack, so a glyph it lacks is still drawn; the stack alone for none or a bad name', () => {
    expect(fontStack('Oswald')).toBe(`"Oswald", ${SYSTEM_STACK}`);
    expect(fontStack(undefined)).toBe(SYSTEM_STACK);
    expect(fontStack('a"; color: red')).toBe(SYSTEM_STACK);
  });

  it('is found from the file’s name without its extension, made safe, and never one already in use', async () => {
    expect(nameForFile('Fira Sans.ttf')).toBe('Fira Sans');
    expect(nameForFile('we!rd:name.otf')).toBe('we-rd-name');
    expect(nameForFile('.ttf')).toBe('My font');
    expect(nameForFile('Inter.woff2')).toBe('Inter 2');
    expect((await loadFontFile(fileOf('Fira.ttf', TTF))).ok).toBe(true);
    expect(nameForFile('Fira.woff')).toBe('Fira 2');
  });
});

describe('which font a text is drawn in: the component, then the layout, then the system (AV-1031)', () => {
  const timeline = buildOverlayTimeline(makeActivity([{ time: new Date(0), lat: 1, lon: 1 }, { time: new Date(1000), lat: 1, lon: 1.001 }]), { video: { durationSeconds: 1 } });
  const sample = { videoTimeSeconds: 0, activityElapsedSeconds: 0, values: { [dataSourceId({ kind: 'metric', metric: 'speed' })]: 5 } };
  const speed = (style: OverlayComponent['style']) => component({ id: 'speed', type: 'text', source: { kind: 'metric', metric: 'speed' }, style });
  const resolved = (layout: string | undefined, own: string | undefined) => {
    const template: OverlayTemplate = { version: OVERLAY_TEMPLATE_VERSION, name: 't', style: { ...DEFAULT_OVERLAY_STYLE, ...(layout ? { fontFamily: layout } : {}) }, components: [speed(own ? { fontFamily: own } : {})] };
    const ready = resolveOverlayComponent(template, template.components[0]!, sample, timeline, 'metric');
    if (ready.status !== 'ready') throw new Error('not ready');
    return ready.style.fontFamily;
  };

  it('takes the component’s own over the layout’s, and the layout’s over none', () => {
    expect(resolved('Inter', 'Oswald')).toBe('Oswald');
    expect(resolved('Inter', undefined)).toBe('Inter');
    expect(resolved(undefined, 'Oswald')).toBe('Oswald');
    expect(resolved(undefined, undefined)).toBeUndefined();
  });

  it('puts the resolved family in a figure’s fonts, and a still text’s, and measures in it', () => {
    const measure = (text: string, font: string) => text.length * (font.includes('"Narrow"') ? 5 : 9);
    const input = { em: 40, frameWidth: 2000, label: 'Speed', value: '18.0 km/h', figure: undefined, track: false, measure };
    const system = figureLayout(input);
    const narrow = figureLayout({ ...input, fontFamily: 'Narrow' });
    expect(system.valueFont).toBe(`bold 44px ${SYSTEM_STACK}`);
    expect(narrow.valueFont).toBe(`bold 44px "Narrow", ${SYSTEM_STACK}`);
    expect(narrow.neededWidth).toBeLessThan(system.neededWidth);

    const text = component({ id: 'note', type: 'label', text: { align: 'left', weight: 'bold' } });
    const value = { ok: true as const, caption: '', value: 'Morning ride', kind: 'text' as const } as unknown as Parameters<typeof layoutStillText>[1];
    const frame = { width: 1000, height: 500 };
    const plain = layoutStillText(text, value, '#ffffff', frame, measure);
    const layoutFont = layoutStillText(text, value, '#ffffff', frame, measure, 'Narrow');
    const own = layoutStillText({ ...text, style: { fontFamily: 'Other' } }, value, '#ffffff', frame, measure, 'Narrow');
    expect(plain.lines[0]!.font).toContain(SYSTEM_STACK);
    expect(layoutFont.lines[0]!.font).toContain('"Narrow"');
    expect(layoutFont.box.w).toBeLessThan(plain.box.w);
    expect(own.lines[0]!.font).toContain('"Other"');
  });
});

describe('the template keeps a font’s name and never its file (AV-1031)', () => {
  const base: OverlayTemplate = {
    version: OVERLAY_TEMPLATE_VERSION,
    name: 'fonts',
    style: { ...DEFAULT_OVERLAY_STYLE, fontFamily: 'Inter' },
    components: [
      component({ id: 'a', type: 'text', source: { kind: 'metric', metric: 'speed' }, style: { fontFamily: 'My Font' } }),
      component({ id: 'b', type: 'text', source: { kind: 'metric', metric: 'speed' } }),
    ],
  };

  it('round-trips the layout’s and a component’s family within version 2', () => {
    const json = serializeOverlayTemplate(base);
    expect(json).not.toMatch(/bytes|base64/);
    expect(parseOverlayTemplate(json)).toEqual({ ok: true, template: base, warnings: [] });
    expect(JSON.parse(json).version).toBe(2);
  });

  it('opens an older layout, with no font, unchanged, and drops a name it will not put in a font string', () => {
    const older = JSON.parse(serializeOverlayTemplate({ ...base, style: DEFAULT_OVERLAY_STYLE, components: [base.components[1]!] }));
    const parsed = parseOverlayTemplate(JSON.stringify(older));
    expect(parsed.ok && parsed.template.style).toEqual(DEFAULT_OVERLAY_STYLE);
    expect(parsed.ok && 'fontFamily' in parsed.template.components[0]!.style).toBe(false);
    expect(parsed.ok && parsed.warnings).toEqual([]);
    older.style.fontFamily = 'a"; x';
    older.components[0].style.fontFamily = 7;
    const hostile = parseOverlayTemplate(JSON.stringify(older));
    expect(hostile.ok && hostile.template.style.fontFamily).toBeUndefined();
    expect(hostile.ok && hostile.template.components[0]!.style.fontFamily).toBeUndefined();
  });

  it('lists the families a layout uses (its own and its visible components’) and which of them are missing', async () => {
    const hidden = { ...base, components: [...base.components, component({ id: 'c', type: 'label', visible: false, style: { fontFamily: 'Hidden' } })] };
    expect(usedFamilies(hidden).sort()).toEqual(['Inter', 'My Font']);
    // Bundled ones are not missing (they load when asked); the reader's are, until loaded.
    expect(missingFamilies(usedFamilies(hidden))).toEqual(['My Font']);
    await loadFontFile(fileOf('x.ttf', TTF), 'My Font');
    expect(missingFamilies(usedFamilies(hidden))).toEqual([]);
  });
});

describe('loading a font file (AV-1031)', () => {
  it('registers a good file from its bytes under its name, and offers it', async () => {
    const result = await loadFontFile(fileOf('Fira Sans.ttf', TTF));
    expect(result).toMatchObject({ ok: true, family: 'Fira Sans' });
    expect(loadedFamilies()).toEqual(['Fira Sans']);
    expect(added).toHaveLength(1);
    expect(FakeFace.created[0]!.family).toBe('Fira Sans');
  });

  it('takes the name a layout asked for, when the file is for that font', async () => {
    expect(await loadFontFile(fileOf('whatever.otf', bytesOf('OTTO')), 'Brand Sans')).toMatchObject({ ok: true, family: 'Brand Sans' });
    expect(loadedFamilies()).toEqual(['Brand Sans']);
  });

  it('refuses a file the browser cannot read as a font, with the reason, and registers nothing', async () => {
    // Magic numbers first: a text file named .ttf is not a font.
    expect(await loadFontFile(fileOf('notes.ttf', new TextEncoder().encode('hello there')))).toEqual({ ok: false, reason: 'notes.ttf is not a TTF, OTF, WOFF or WOFF2 font.' });
    // The right signature, but the browser's own parser refuses it.
    FakeFace.prototype.load = async () => {
      throw new Error('invalid font data');
    };
    const bad = await loadFontFile(fileOf('worse.woff', bytesOf('wOFF')));
    expect(bad).toEqual({ ok: false, reason: 'worse.woff could not be read as a font (The font worse could not be loaded (invalid font data).).' });
    expect(loadedFamilies()).toEqual([]);
    expect(added).toHaveLength(0);
  });

  it('refuses a file over 10 MB without reading it', async () => {
    const big = new File([new Uint8Array(1)], 'huge.ttf');
    Object.defineProperty(big, 'size', { value: FONT_FILE_MAX_BYTES + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');
    expect(await loadFontFile(big)).toEqual({ ok: false, reason: 'huge.ttf is larger than 10 MB.' });
    expect(read).not.toHaveBeenCalled();
  });

  it('knows each kind of font by its first bytes', () => {
    for (const tag of ['wOFF', 'wOF2', 'OTTO', 'true']) expect(isFontBytes(bytesOf(tag))).toBe(true);
    expect(isFontBytes(TTF)).toBe(true);
    expect(isFontBytes(bytesOf('<svg'))).toBe(false);
    expect(isFontBytes(new Uint8Array(2))).toBe(false);
  });
});

describe('the bundled fonts load only when chosen, from the app’s own path (AV-1031)', () => {
  const served = (status = 200) =>
    vi.fn(async (url: string) => ({ ok: status === 200, status, arrayBuffer: async () => bytesOf(url.includes('700') ? 'bold' : 'regular').buffer }));

  it('serves each from under the app’s base path, regular and bold, with a licence beside it', () => {
    expect(BUNDLED_FONTS.map((font) => font.family)).toEqual(['Inter', 'Roboto Condensed', 'JetBrains Mono', 'Oswald']);
    for (const font of BUNDLED_FONTS) {
      for (const weight of [400, 700]) expect(bundledFontUrl(font, weight)).toMatch(new RegExp(`^/fonts/${font.slug}/${font.slug}-latin-${weight}-normal\\.woff2$`));
    }
  });

  it('fetches both weights once, registers them, and asks nothing else of the network', async () => {
    const fetcher = served();
    vi.stubGlobal('fetch', fetcher);
    expect(loadedFamilies()).toEqual([]);
    expect(await ensureFamily('Inter')).toEqual({ ok: true });
    expect(await ensureFamily('Inter')).toEqual({ ok: true });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/fonts/inter/inter-latin-400-normal.woff2', '/fonts/inter/inter-latin-700-normal.woff2']);
    expect(added.map((face) => [face.family, face.weight])).toEqual([['Inter', '400'], ['Inter', '700']]);
    // The system font and a layout naming nothing fetch nothing.
    expect(usedFamilies({ style: {}, components: [] })).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('says why a bundled font could not be had, and a font nothing has is missing', async () => {
    vi.stubGlobal('fetch', served(404));
    expect(await ensureFamily('Oswald')).toEqual({ ok: false, missing: false, reason: 'Oswald could not be loaded (404).' });
    expect(await ensureFamily('Brand Sans')).toEqual({ ok: false, missing: true, reason: 'This layout uses Brand Sans, which is not loaded here.' });
  });
});

describe('before an export draws anything (AV-1031)', () => {
  const layout = (family: string): Parameters<typeof prepareTemplateFonts>[0] => ({ style: {}, components: [{ visible: true, style: { fontFamily: family } }] });

  it('hands over the bytes of every font in use, and nothing when there is none', async () => {
    vi.stubGlobal('fetch', async (url: string) => ({ ok: true, status: 200, arrayBuffer: async () => bytesOf(url).buffer }));
    expect(await prepareTemplateFonts({ style: {}, components: [] })).toEqual([]);
    const faces = await prepareTemplateFonts(layout('Inter'));
    expect(faces.map((face) => [face.family, face.weight])).toEqual([['Inter', 400], ['Inter', 700]]);
  });

  it('stops with the reason when a font is missing or cannot be loaded, instead of drawing in a fallback', async () => {
    await expect(prepareTemplateFonts(layout('Brand Sans'))).rejects.toMatchObject({ code: 'render_failed', message: 'This layout uses Brand Sans, which is not loaded here.' });
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(prepareTemplateFonts(layout('Oswald'))).rejects.toMatchObject({ message: 'Oswald could not be loaded (500).' });
  });
});

describe('the worker registers the font before it draws (AV-1031)', () => {
  const face = (family: string, weight = 400): FontBytes => ({ family, weight, bytes: bytesOf('wOF2').buffer });

  it('adds each face to the font set and waits for it to load, in order, then returns', async () => {
    const order: string[] = [];
    const target = {
      add: (value: FakeFace) => order.push(`add:${value.family}:${value.weight}`),
      forEach: () => undefined,
    };
    const load = FakeFace.prototype.load;
    FakeFace.prototype.load = async function (this: FakeFace) {
      order.push(`load:${this.family}`);
      return load.call(this);
    };
    await installFonts([face('Inter', 400), face('Inter', 700)], target as unknown as FontSet);
    order.push('first frame');
    expect(order).toEqual(['load:Inter', 'add:Inter:400', 'load:Inter', 'add:Inter:700', 'first frame']);
    FakeFace.prototype.load = load;
  });

  it('does nothing for no fonts, adds a face only once, and stops with the reason when one fails or the browser cannot', async () => {
    const target = { add: vi.fn(), forEach: vi.fn() };
    await installFonts([], target as unknown as FontSet);
    expect(target.add).not.toHaveBeenCalled();
    await installFonts([face('Inter')], fontSet as unknown as FontSet);
    await installFonts([face('Inter')], fontSet as unknown as FontSet);
    expect(added).toHaveLength(1);
    await expect(installFonts([{ family: 'Bad', weight: 400, bytes: bytesOf('BAD!').buffer }], target as unknown as FontSet)).rejects.toMatchObject({ code: 'render_failed', message: 'The font Bad could not be loaded (invalid font data).' });
    Reflect.deleteProperty(document, 'fonts');
    await expect(installFonts([face('Inter')])).rejects.toMatchObject({ code: 'unsupported_browser' });
  });
});
