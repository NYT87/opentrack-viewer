import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usePersonalStore } from '../state/personalStore';

/**
 * AV-1018 (TD-086). The reader's own maximum heart rate and FTP: held in memory
 * for the session (the store), handed to every drawing of the overlay, and
 * written nowhere else. The browser test (`e2e/overlay-privacy.spec.ts`) watches
 * the requests; these keep the code that would let them slip from being written.
 */
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__golden__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

/** The text of each `createOverlayRenderer({ ... })` call in the app, up to its closing brace. */
function rendererCalls(): { file: string; call: string }[] {
  const calls: { file: string; call: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    let from = text.indexOf('createOverlayRenderer({');
    while (from >= 0) {
      let depth = 0;
      let end = from + 'createOverlayRenderer('.length;
      for (; end < text.length; end += 1) {
        if (text[end] === '{') depth += 1;
        if (text[end] === '}' && --depth === 0) break;
      }
      calls.push({ file: relative(SRC, file), call: text.slice(from, end + 1) });
      from = text.indexOf('createOverlayRenderer({', end);
    }
  }
  return calls;
}

describe('the reader’s own figures (AV-1018, TD-086)', () => {
  it('reach the renderer from every place that draws the overlay', () => {
    const calls = rendererCalls();
    // The preview, the PNG sequence (worker), the WebM, the burned-in video, the map video (twice) and the map image (twice).
    expect(calls.map(({ file }) => file).sort()).toEqual(
      [
        'components/CustomCanvas.tsx',
        'components/MapImagePreview.tsx',
        'mapImage/render.ts',
        'mapVideo/figures.ts',
        'mapVideo/figures.ts',
        'overlay/export/burnRun.ts',
        'overlay/export/exportWorker.ts',
        'overlay/export/recordWebm.ts',
      ].sort(),
    );
    // The summary card of a map video is built from the activity alone, with no zones in it.
    for (const { file, call } of calls) {
      if (file === 'mapVideo/figures.ts' && call.includes('summaryCardTemplate')) continue;
      expect(call, file).toMatch(/\bpersonal\b/);
    }
  });

  it('is in no request but an export’s own, and never in the log', () => {
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const match of code.matchAll(/console\.\w+\([^)]*\)/g)) {
        expect(match[0], `${relative(SRC, file)} logs ${match[0]}`).not.toMatch(/personal|maxHeartRate|ftp/i);
      }
    }
  });
});

describe('the session store of the reader’s figures', () => {
  const state = () => usePersonalStore.getState();

  it('starts empty, keeps each figure inside its limits and whole, and lets one go', () => {
    state().clear();
    expect(state().personal).toEqual({});
    state().setFigure('maxHeartRate', 187.6);
    state().setFigure('ftp', 5);
    expect(state().personal).toEqual({ maxHeartRate: 188, ftp: 50 });
    state().setFigure('maxHeartRate', 9999);
    expect(state().personal.maxHeartRate).toBe(230);
    state().setFigure('ftp', undefined);
    expect(state().personal).toEqual({ maxHeartRate: 230 });
    state().setFigure('maxHeartRate', Number.NaN);
    expect(state().personal).toEqual({});
  });

  it('takes the figures of a layout over what it has, only for those the layout holds', () => {
    state().clear();
    state().setFigure('ftp', 250);
    state().adopt({ maxHeartRate: 180 });
    expect(state().personal).toEqual({ maxHeartRate: 180, ftp: 250 });
    state().adopt({ ftp: 300, maxHeartRate: Number.NaN });
    expect(state().personal).toEqual({ maxHeartRate: 180, ftp: 300 });
    state().clear();
  });

  it('writes nothing to any storage', () => {
    state().clear();
    state().setFigure('maxHeartRate', 190);
    state().adopt({ ftp: 260 });
    expect(Object.keys(localStorage).filter((key) => key !== 'opentrack-viewer:theme')).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    state().clear();
  });
});
