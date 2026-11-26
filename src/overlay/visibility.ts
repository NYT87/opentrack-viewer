/**
 * AV-1029 (TD-101). The part of the video a component is shown for, in the video's own seconds (the
 * output's on the map video, the overlay's with no video). One rule for the preview and every export.
 */

export interface OverlayVisibility {
  /** First second shown. Absent is the start. */
  from?: number;
  /** First second no longer shown; after `from`. Absent is the end. */
  to?: number;
  /** Seconds to rise from nothing to full after `from`. */
  fadeIn?: number;
  /** Seconds to fall to nothing before `to`. */
  fadeOut?: number;
}

export const VISIBILITY_FADE_MAX_SECONDS = 10;

const round = (value: number) => Math.round(value * 1000) / 1000;
const finite = (value: unknown): value is number => typeof value === 'number' && Math.abs(value) < 1e9;

/** Reads a saved window as it may be used; undefined when it says nothing, so an older layout is always shown. */
export function parseVisibility(raw: unknown): OverlayVisibility | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const out: OverlayVisibility = {};
  const from = finite(value.from) ? round(Math.max(0, value.from)) : 0;
  if (from > 0) out.from = from;
  const to = finite(value.to) ? round(value.to) : undefined;
  if (to !== undefined && to > from) out.to = to;
  const limit = out.to === undefined ? VISIBILITY_FADE_MAX_SECONDS : Math.min(VISIBILITY_FADE_MAX_SECONDS, out.to - from);
  // A fade out falls toward an end, so without one it says nothing.
  for (const key of out.to === undefined ? (['fadeIn'] as const) : (['fadeIn', 'fadeOut'] as const)) {
    const seconds = value[key];
    if (finite(seconds) && round(Math.min(limit, Math.max(0, seconds))) > 0) out[key] = round(Math.min(limit, Math.max(0, seconds)));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** How much of a component shows at this video time: 0 outside [from, to), a linear rise and fall at the edges. */
export function visibilityAt(visibility: OverlayVisibility | undefined, time: number): number {
  if (!visibility) return 1;
  const from = visibility.from ?? 0;
  const { to, fadeIn, fadeOut } = visibility;
  if (time < from || (to !== undefined && time >= to)) return 0;
  let opacity = 1;
  if (fadeIn) opacity = Math.min(opacity, (time - from) / fadeIn);
  if (fadeOut && to !== undefined) opacity *= Math.min(1, (to - time) / fadeOut);
  return opacity;
}
