import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AV-1008. The overlay features hold a user's video, their telemetry and the
 * frames made from them. The promise is that none of it leaves the tab and none
 * of it is kept (§5). A browser test watches the network while the features run;
 * this watches the code, so a network or storage call cannot be added without a
 * test failing and someone having to say why.
 *
 * It reads the source rather than running it, so it also covers paths no test
 * happens to drive — an error handler, a rarely used option.
 */

const ROOT = join(__dirname, '..');

/** Everything that handles overlay data: the pure modules, the page, its components and its state. */
function overlaySources(): { path: string; text: string }[] {
  const files: string[] = [];
  const add = (dir: string, accept: (name: string) => boolean) => {
    for (const name of readdirSync(join(ROOT, dir))) if (accept(name)) files.push(join(dir, name));
  };
  add('overlays', (n) => /\.tsx?$/.test(n) && !/\.test\./.test(n));
  add('components', (n) => /^Overlay.*\.tsx$/.test(n) && !/\.test\./.test(n));
  add('state', (n) => /^overlay.*\.ts$/.test(n));
  add('app', (n) => n === 'OverlayPage.tsx');
  files.push(join('domain', 'routeProjection.ts'));
  return files.map((path) => ({ path, text: stripComments(readFileSync(join(ROOT, path), 'utf8')) }));
}

/** Comments explain the privacy rules in the words this test forbids; they are not code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN: [string, RegExp][] = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['a worker that could reach out', /\bnew\s+(?:Shared)?Worker\b/],
  ['importScripts', /\bimportScripts\b/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['cookies', /\bdocument\.cookie\b/],
  ['the Cache API', /\bcaches\.(?:open|put|match)\b/],
  ['a persisted store', /zustand\/middleware/],
  ['the File System Access API', /\bshowSaveFilePicker\b|\bshowOpenFilePicker\b/],
  ['a remote URL', /["'`]https?:\/\//],
];

describe('overlay code stays on the device (AV-1008)', () => {
  const sources = overlaySources();

  it('covers the code that handles overlay data', () => {
    const names = sources.map((s) => s.path.replace(/\\/g, '/'));
    for (const expected of [
      'overlays/renderOverlay.ts',
      'overlays/exportFrames.ts',
      'overlays/burnIn.ts',
      'overlays/webmDuration.ts',
      'overlays/zip.ts',
      'overlays/templateIO.ts',
      'overlays/routeImage.ts',
      'components/OverlayVideoPreview.tsx',
      'components/OverlayFrameExport.tsx',
      'components/OverlayBurnInExport.tsx',
      'components/OverlayTemplateEditor.tsx',
      'app/OverlayPage.tsx',
      'state/overlayStore.ts',
      'state/overlayTemplateStore.ts',
    ]) {
      expect(names).toContain(expected);
    }
  });

  for (const [what, pattern] of FORBIDDEN) {
    it(`uses no ${what}`, () => {
      const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.path);
      expect(hits).toEqual([]);
    });
  }

  it('keeps the strip honest: it does remove comments, and only comments', () => {
    expect(stripComments('a /* fetch( */ b // sendBeacon\nc')).toBe('a  b \nc');
    // A URL in code is not a comment.
    expect(stripComments('const u = "https://x";')).toContain('https://x');
  });

  it('would catch a violation if one were added', () => {
    expect(FORBIDDEN.some(([, p]) => p.test('await fetch("/x", { body })'))).toBe(true);
    expect(FORBIDDEN.some(([, p]) => p.test('navigator.sendBeacon(url, data)'))).toBe(true);
    expect(FORBIDDEN.some(([, p]) => p.test("localStorage.setItem('k', v)"))).toBe(true);
    expect(FORBIDDEN.some(([, p]) => p.test('const x = "https://example.com/upload"'))).toBe(true);
  });

  it('releases every object URL it creates', () => {
    for (const { path, text } of sources) {
      const created = (text.match(/URL\.createObjectURL/g) ?? []).length;
      const revoked = (text.match(/URL\.revokeObjectURL/g) ?? []).length;
      if (created > 0) expect(revoked, `${path} creates object URLs`).toBeGreaterThan(0);
    }
  });
});
