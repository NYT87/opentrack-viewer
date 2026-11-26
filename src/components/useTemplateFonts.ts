import { useEffect, useState, useSyncExternalStore } from 'react';
import { ensureFamily, fontsVersion, subscribeFonts, usedFamilies } from '../overlay/fonts';

export interface FontProblem {
  family: string;
  reason: string;
  /** Nothing here has this font: the reader's file is the way to it. */
  missing: boolean;
}

/**
 * AV-1031 (TD-103). A preview's fonts: each family the template names is made ready (a bundled font
 * fetched from this app, a kept one put back), `version` changes when one arrives so the preview draws
 * again, and a family that cannot be had is listed with why. Until it arrives the preview draws in the
 * system font, as it does for a missing one.
 */
export function useTemplateFonts(template: Parameters<typeof usedFamilies>[0] | undefined): { version: number; problems: FontProblem[] } {
  const version = useSyncExternalStore(subscribeFonts, fontsVersion);
  const families = template ? usedFamilies(template) : [];
  const key = families.join('\n');
  const [problems, setProblems] = useState<FontProblem[]>([]);
  useEffect(() => {
    let current = true;
    const wanted = key === '' ? [] : key.split('\n');
    void Promise.all(wanted.map(async (family) => ({ family, result: await ensureFamily(family) }))).then((results) => {
      if (!current) return;
      const failed: FontProblem[] = [];
      for (const { family, result } of results) if (!result.ok) failed.push({ family, reason: result.reason, missing: result.missing });
      setProblems((was) => (was.length === 0 && failed.length === 0 ? was : failed));
    });
    return () => {
      current = false;
    };
  }, [key, version]);
  return { version, problems };
}
