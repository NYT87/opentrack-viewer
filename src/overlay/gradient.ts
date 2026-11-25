import type { OverlayGradientBand, OverlayGradientSetting } from './template';

/**
 * AV-1019 (TD-087). The gradient indicator: the pure part. The default bands,
 * their limits, which band a grade is in and which glyph it gets. Nothing here
 * draws or reads a file.
 */

/** Two to ten bands, as zones are: fewer is not a scale, more is not legible. */
export const GRADIENT_BAND_LIMITS = { min: 2, max: 10 } as const;
/** A band starts between these, in percent: a road is never steeper, and the first is a floor, not a bound. */
export const GRADIENT_FROM_LIMITS = { min: -100, max: 100 } as const;

/**
 * Descent blue, flat green, then yellow, orange, red and dark red for the
 * climbs. The first band is the floor: it starts where the scale does, and
 * anything steeper downhill counts in it.
 */
export const DEFAULT_GRADIENT_BANDS: readonly OverlayGradientBand[] = [
  { from: GRADIENT_FROM_LIMITS.min, color: '#4aa3ff' },
  { from: -1, color: '#3ecf6b' },
  { from: 3, color: '#f5d142' },
  { from: 6, color: '#f59a3a' },
  { from: 9, color: '#e5483b' },
  { from: 12, color: '#a01d2b' },
];

export const DEFAULT_GRADIENT: OverlayGradientSetting = {
  bands: DEFAULT_GRADIENT_BANDS.map((band) => ({ ...band })),
  glyph: true,
};

/**
 * The band a grade is in: the last whose start is at or under it, and the first
 * for a grade under every start. A grade exactly on a start is in the band that
 * starts there.
 */
export function gradientBand(grade: number, bands: readonly OverlayGradientBand[]): number {
  let index = 0;
  for (let i = 0; i < bands.length; i += 1) if (grade >= bands[i]!.from) index = i;
  return index;
}

/** Under this grade, in percent either way, the road is flat and the glyph a bar. */
export const GRADIENT_FLAT_PERCENT = 1;

export type GradientGlyph = 'up' | 'down' | 'flat';

export function gradientGlyph(grade: number): GradientGlyph {
  return grade >= GRADIENT_FLAT_PERCENT ? 'up' : grade <= -GRADIENT_FLAT_PERCENT ? 'down' : 'flat';
}

/** The colours a band added by the editor takes, in turn: steeper reads redder. */
const ADDED_COLORS = ['#7a1020', '#5b0f1a', '#400b13', '#2a070d'] as const;

/**
 * One band more, above the last: its start 3 percent past the last's (or the
 * step between the last two), inside the scale. A scale never has more than ten.
 */
export function addGradientBand(setting: OverlayGradientSetting): OverlayGradientSetting {
  const { bands } = setting;
  if (bands.length >= GRADIENT_BAND_LIMITS.max) return setting;
  const last = bands[bands.length - 1]!;
  const step = bands.length > 1 ? Math.max(1, last.from - bands[bands.length - 2]!.from) : 3;
  const from = Math.min(GRADIENT_FROM_LIMITS.max, last.from + step);
  if (!(from > last.from)) return setting;
  const color = ADDED_COLORS[Math.min(ADDED_COLORS.length - 1, Math.max(0, bands.length - DEFAULT_GRADIENT_BANDS.length))]!;
  return { ...setting, bands: [...bands, { from, color }] };
}

/** The last band taken away; a scale never has fewer than two. */
export function removeLastGradientBand(setting: OverlayGradientSetting): OverlayGradientSetting {
  return setting.bands.length <= GRADIENT_BAND_LIMITS.min ? setting : { ...setting, bands: setting.bands.slice(0, -1) };
}

/**
 * A band changed. A start is kept above the band before it and under the one
 * after, by at least a tenth of a percent, so the scale stays ascending
 * whatever is typed; the first band is the floor and keeps its start.
 */
export function setGradientBand(setting: OverlayGradientSetting, index: number, patch: Partial<OverlayGradientBand>): OverlayGradientSetting {
  const bands = setting.bands.map((band, i) => {
    if (i !== index) return band;
    const next = { ...band, ...patch };
    if (patch.from !== undefined) {
      if (i === 0) return { ...band, ...(patch.color !== undefined ? { color: patch.color } : {}) };
      const floor = setting.bands[i - 1]!.from + 0.1;
      const ceiling = i + 1 < setting.bands.length ? setting.bands[i + 1]!.from - 0.1 : GRADIENT_FROM_LIMITS.max;
      next.from = floor > ceiling ? band.from : Math.round(Math.min(Math.max(patch.from, floor), ceiling) * 10) / 10;
    }
    return next;
  });
  return { ...setting, bands };
}
