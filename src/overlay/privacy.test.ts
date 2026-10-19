import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AV-1008. A guard at the source: the code that touches a reader's video,
 * telemetry and rendered frames contains no way to send them anywhere, and
 * does not persist them. The browser test (`e2e/overlay-privacy.spec.ts`)
 * watches what a page actually does; this one stops the code that would make it
 * do otherwise from being written in the first place, and runs in every unit
 * run, not only in the browser job.
 *
 * Reading from the origin-private file system is deliberately not forbidden: the
 * export writes its archive there and deletes it. What is forbidden is
 * everything that sends bytes off the device or keeps them across a reload
 * (TD-040: nothing but the theme is stored).
 */
const SRC = join(process.cwd(), 'src');

export const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'fetch', pattern: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'sendBeacon', pattern: /\bsendBeacon\b/ },
  { name: 'WebSocket', pattern: /\bWebSocket\b/ },
  { name: 'EventSource', pattern: /\bEventSource\b/ },
  { name: 'Image()', pattern: /\bnew\s+Image\s*\(/ },
  { name: 'importScripts', pattern: /\bimportScripts\b/ },
  { name: 'a remote URL', pattern: /['"`]https?:\/\//i },
  { name: 'localStorage', pattern: /\blocalStorage\b/ },
  { name: 'sessionStorage', pattern: /\bsessionStorage\b/ },
  { name: 'indexedDB', pattern: /\bindexedDB\b/ },
  { name: 'cookies', pattern: /\bdocument\.cookie\b/ },
  { name: 'Cache API', pattern: /\bcaches\.(open|put|match)\b/ },
];

/** What a source file does wrong, if anything. Comments are not code, so they are skipped. */
export function violationsIn(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__golden__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/** Everything that handles the overlay's video, telemetry or frames. */
const overlayFiles = [
  ...sourceFiles(join(SRC, 'overlay')),
  join(SRC, 'state/overlayStore.ts'),
  join(SRC, 'app/OverlayPage.tsx'),
  join(SRC, 'components/OverlayControls.tsx'),
  join(SRC, 'components/OverlayExportPanel.tsx'),
  join(SRC, 'components/OverlayLayer.tsx'),
  join(SRC, 'components/OverlayPreview.tsx'),
  join(SRC, 'components/BurnedInExportPanel.tsx'),
  join(SRC, 'components/RouteOverlayPanel.tsx'),
  join(SRC, 'components/RouteOverlayLink.tsx'),
];

describe('the overlay code can send nothing anywhere and keeps nothing (AV-1008)', () => {
  it('covers the files that handle the video, the telemetry and the frames', () => {
    const names = overlayFiles.map((file) => relative(SRC, file));
    expect(names).toEqual(
      expect.arrayContaining([
        'overlay/timeline.ts',
        'overlay/export/exportWorker.ts',
        'overlay/export/burnRun.ts',
        'overlay/export/archiveSink.ts',
        'components/OverlayPreview.tsx',
        'components/BurnedInExportPanel.tsx',
        'components/RouteOverlayPanel.tsx',
        'overlay/export/drawRouteImage.ts',
        'overlay/routeImage.ts',
        'app/OverlayPage.tsx',
      ]),
    );
    expect(overlayFiles.length).toBeGreaterThan(20);
  });

  it.each(overlayFiles.map((file) => [relative(SRC, file), file]))('%s', (_name, file) => {
    expect(violationsIn(readFileSync(file as string, 'utf8'))).toEqual([]);
  });

  describe('the guard itself catches what it is for', () => {
    it.each([
      ['fetch', "await fetch('/api', { method: 'POST', body: bytes })"],
      ['XMLHttpRequest', 'const x = new XMLHttpRequest();'],
      ['sendBeacon', 'navigator.sendBeacon(url, frame)'],
      ['WebSocket', 'new WebSocket(address)'],
      ['EventSource', 'new EventSource(address)'],
      ['Image()', 'new Image().src = url + telemetry'],
      ['importScripts', 'importScripts(remote)'],
      ['a remote URL', "const base = 'https://example.com/collect'"],
      ['localStorage', "localStorage.setItem('last', fileName)"],
      ['sessionStorage', 'sessionStorage.getItem(key)'],
      ['indexedDB', 'indexedDB.open("frames")'],
      ['cookies', 'document.cookie = value'],
      ['Cache API', "caches.open('frames')"],
    ])('flags %s', (name, code) => {
      expect(violationsIn(code)).toContain(name);
    });

    it('does not flag comments, local worker URLs, or the file system the export is written to', () => {
      const fine = `
        // Nothing is sent: no fetch( and no XMLHttpRequest here, as the plan says.
        /* a block comment about sendBeacon and localStorage */
        const worker = new Worker(new URL('./exportWorker.ts', import.meta.url), { type: 'module' });
        const root = await navigator.storage.getDirectory();
        const tail = 1; // see https://example.com/docs for why
      `;
      expect(violationsIn(fine)).toEqual([]);
    });
  });
});
