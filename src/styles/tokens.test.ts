import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf-8');

const DEFINITION = /^\s*(--[a-z0-9-]+)\s*:/gm;
const USAGE = /var\(\s*(--[a-z0-9-]+)\s*(?:,|\))/g;

const matchAll = (pattern: RegExp) =>
  new Set([...css.matchAll(pattern)].map((match) => match[1]!));

/**
 * A `var()` naming a property that was never defined is not an error anywhere:
 * the declaration is simply dropped, and the element quietly inherits instead.
 * Nothing else in this suite can see that, so a typo in a token name survives
 * review, tests and the build — which is exactly how `--muted` reached the
 * export panel when the stylesheet defines `--text-muted`.
 */
describe('CSS custom properties', () => {
  it('never reads a token the stylesheet does not define', () => {
    const defined = matchAll(DEFINITION);
    const used = matchAll(USAGE);

    const undefinedTokens = [...used].filter((token) => !defined.has(token)).sort();
    expect(undefinedTokens).toEqual([]);
  });
});
