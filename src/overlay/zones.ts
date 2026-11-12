import type { Activity } from '../domain/activity';
import type {
  OverlayZone,
  OverlayZonesSetting,
  PersonalFigures,
  ZonesSource,
} from './template';
import { dataSourceId, type OverlayDataSource, type OverlayTimeline } from './timeline';

/**
 * AV-1018 (TD-086). Zones: the pure part. Which zone a value is in, the bounds
 * in the units the value is in, where in its zone it sits, the defaults for
 * heart rate and power, and the time spent in each zone. Nothing here draws,
 * stores or reads a file: the renderer, the editor, the layout parser and the
 * contract all call it, so they cannot disagree about a zone.
 */

/** How many zones a set has: two or more, so there is something to be in, and a bar stays legible. */
export const ZONE_LIMITS = { min: 2, max: 10 } as const;

/** A zone's name is a label, not a sentence. */
export const ZONE_NAME_MAX = 24;

/** The most a zone's lower bound can be: a share of the reference in percent, or a bpm or W. */
export const ZONE_FROM_MAX = { percent: 500, value: 3000 } as const;

/**
 * What a reader's own figures can be, in bpm and W. The field keeps a typed
 * value inside these, so a typing slip is not a zone set nobody has.
 */
export const PERSONAL_LIMITS = {
  maxHeartRate: { min: 100, max: 230 },
  ftp: { min: 50, max: 600 },
} as const;

export type PersonalKey = keyof typeof PERSONAL_LIMITS;

/** Which of the reader's figures a source is measured against. */
export const REFERENCE_KEY: Record<ZonesSource, PersonalKey> = { heartRate: 'maxHeartRate', power: 'ftp' };

export const ZONES_UNIT: Record<ZonesSource, 'bpm' | 'W'> = { heartRate: 'bpm', power: 'W' };

/** How the figure is named to the reader. */
export const REFERENCE_LABEL: Record<ZonesSource, string> = {
  heartRate: 'maximum heart rate',
  power: 'FTP',
};

/** The figure kept inside its limits and whole, or `undefined` when it is not a usable number. */
export function cleanFigure(key: PersonalKey, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const { min, max } = PERSONAL_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A reader's figures as they may be kept: each inside its limits, the unusable left out. */
export function cleanPersonal(raw: unknown): PersonalFigures {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const personal: PersonalFigures = {};
  const maxHeartRate = cleanFigure('maxHeartRate', record.maxHeartRate);
  if (maxHeartRate !== undefined) personal.maxHeartRate = maxHeartRate;
  const ftp = cleanFigure('ftp', record.ftp);
  if (ftp !== undefined) personal.ftp = ftp;
  return personal;
}

/**
 * The figures a zone set is measured with: the session's own where it has
 * them, and what the layout file held only where the session has none (TD-086).
 */
export function effectivePersonal(
  session: PersonalFigures | undefined,
  setting: Pick<OverlayZonesSetting, 'personal'> | undefined,
): PersonalFigures {
  const personal: PersonalFigures = {};
  const maxHeartRate = session?.maxHeartRate ?? setting?.personal?.maxHeartRate;
  if (maxHeartRate !== undefined) personal.maxHeartRate = maxHeartRate;
  const ftp = session?.ftp ?? setting?.personal?.ftp;
  if (ftp !== undefined) personal.ftp = ftp;
  return personal;
}

// ---------------------------------------------------------------------------
// Defaults

/** Cool to hot, readable on a video: the same ramp for every source. */
export const ZONE_RAMP: readonly string[] = [
  '#4dabf7',
  '#22b8cf',
  '#38d9a9',
  '#69db7c',
  '#c0eb75',
  '#ffd43b',
  '#ffa94d',
  '#ff6b6b',
  '#f03e3e',
  '#c2255c',
];

/** `count` colours spread along the ramp, the first cool and the last hot. */
export function rampColors(count: number): string[] {
  if (count <= 1) return [ZONE_RAMP[0]!];
  return Array.from({ length: count }, (_, i) => ZONE_RAMP[Math.round((i * (ZONE_RAMP.length - 1)) / (count - 1))]!);
}

const HEART_RATE_ZONES: readonly [string, number][] = [
  ['Recovery', 50],
  ['Endurance', 60],
  ['Tempo', 70],
  ['Threshold', 80],
  ['Maximum', 90],
];

/** Coggan's seven zones of FTP. */
const POWER_ZONES: readonly [string, number][] = [
  ['Active recovery', 0],
  ['Endurance', 56],
  ['Tempo', 76],
  ['Threshold', 91],
  ['VO2 max', 106],
  ['Anaerobic', 121],
  ['Neuromuscular', 151],
];

/** The zones a source starts with: five of the maximum heart rate, or Coggan's seven of FTP. */
export function defaultZones(source: ZonesSource): OverlayZone[] {
  const table = source === 'heartRate' ? HEART_RATE_ZONES : POWER_ZONES;
  const colors = rampColors(table.length);
  return table.map(([name, from], i) => ({ name, color: colors[i]!, from }));
}

/** A new zones component's settings: the source's own zones, in percent of the reference, as a horizontal bar. */
export function defaultZonesSetting(source: ZonesSource): OverlayZonesSetting {
  return {
    source,
    basis: 'percent',
    zones: defaultZones(source),
    shape: 'horizontal',
    show: { number: true, name: true, value: true, timeInZone: false },
  };
}

/** Smoothing a source starts with: 3 s for power, which flickers, and none for heart rate. */
export const DEFAULT_ZONES_SMOOTHING_SECONDS: Record<ZonesSource, number> = { heartRate: 0, power: 3 };

// ---------------------------------------------------------------------------
// Lookup

/**
 * The zone a value is in: the last whose lower bound is at or under it, and
 * the first for a value under every bound (a value below the floor still
 * counts, in zone 1). `bounds` is ascending, in the value's own unit. Returns
 * a 0-based index.
 */
export function zoneIndex(value: number, bounds: readonly number[]): number {
  let found = 0;
  for (let i = 1; i < bounds.length; i += 1) {
    if (bounds[i]! <= value) found = i;
    else break;
  }
  return found;
}

/** The reference a source is measured against, or `undefined` when the reader has not given it. */
export function referenceFor(source: ZonesSource, personal: PersonalFigures | undefined): number | undefined {
  return personal?.[REFERENCE_KEY[source]];
}

/**
 * The zones' lower bounds in the value's own unit (bpm or W). A set measured
 * in percent needs the reader's figure and has no bounds without it; a set in
 * values needs nothing. The share is taken before the division, so a whole
 * share of a whole figure is exact (60 % of 190 is 114, not 113.99999999999999).
 */
export function zoneBounds(setting: OverlayZonesSetting, personal: PersonalFigures | undefined): number[] | undefined {
  if (setting.basis === 'value') return setting.zones.map((zone) => zone.from);
  const reference = referenceFor(setting.source, personal);
  if (reference === undefined) return undefined;
  return setting.zones.map((zone) => (zone.from * reference) / 100);
}

/**
 * Where in its zone a value is, 0..1 (0 at its lower bound, 1 at the next's).
 * The last zone has no upper bound, so it is as wide as the one before it.
 */
export function withinZone(value: number, index: number, bounds: readonly number[]): number {
  const low = bounds[index]!;
  const high = index + 1 < bounds.length ? bounds[index + 1]! : low + (low - (bounds[index - 1] ?? low - 1));
  if (!(high > low)) return 0;
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/** The activity's highest reading of a source, for offering as a starting point; `undefined` without one. */
export function activityHighest(activity: Activity, source: ZonesSource): number | undefined {
  let highest: number | undefined;
  for (const point of activity.points) {
    const value = source === 'heartRate' ? point.heartRateBpm : point.powerWatts;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (highest === undefined || value > highest) highest = value;
  }
  return highest === undefined ? undefined : Math.round(highest);
}

// ---------------------------------------------------------------------------
// Editing a set of zones: each a pure function of the set

const withLimits = (zones: OverlayZone[]) => zones.slice(0, ZONE_LIMITS.max);

/**
 * One zone more, above the last: its bound a step past the last's (the step
 * between the last two), its colour the next along the ramp.
 */
export function addZone(setting: OverlayZonesSetting): OverlayZonesSetting {
  const { zones } = setting;
  if (zones.length >= ZONE_LIMITS.max) return setting;
  const last = zones[zones.length - 1]!;
  const step = zones.length > 1 ? Math.max(1, last.from - zones[zones.length - 2]!.from) : 10;
  const max = ZONE_FROM_MAX[setting.basis];
  const from = Math.min(max, last.from + step);
  if (!(from > last.from)) return setting;
  const color = rampColors(zones.length + 1)[zones.length]!;
  return { ...setting, zones: withLimits([...zones, { name: `Zone ${zones.length + 1}`, color, from }]) };
}

/** The last zone taken away; a set never has fewer than `ZONE_LIMITS.min`. */
export function removeLastZone(setting: OverlayZonesSetting): OverlayZonesSetting {
  if (setting.zones.length <= ZONE_LIMITS.min) return setting;
  return { ...setting, zones: setting.zones.slice(0, -1) };
}

/**
 * A zone changed. A bound is kept strictly above the one before it and under
 * the one after, so the set stays ascending whatever is typed.
 */
export function setZone(setting: OverlayZonesSetting, index: number, patch: Partial<OverlayZone>): OverlayZonesSetting {
  const zones = setting.zones.map((zone, i) => {
    if (i !== index) return zone;
    const next = { ...zone, ...patch };
    if (patch.from !== undefined) {
      const floor = i > 0 ? setting.zones[i - 1]!.from + 1 : 0;
      const ceiling = i + 1 < setting.zones.length ? setting.zones[i + 1]!.from - 1 : ZONE_FROM_MAX[setting.basis];
      // No room between the neighbours (a file can have bounds under 1 apart): the bound stays as it is.
      next.from = floor > ceiling ? zone.from : Math.min(Math.max(patch.from, floor), ceiling);
    }
    return next;
  });
  return { ...setting, zones };
}

/**
 * The same zones in the other basis, so a set the reader built is not thrown
 * away by changing how it is measured: percent to values with a reference,
 * values to percent likewise. Without the reference the set is kept as it is
 * and only the basis changes.
 */
export function changeBasis(
  setting: OverlayZonesSetting,
  basis: OverlayZonesSetting['basis'],
  personal: PersonalFigures | undefined,
): OverlayZonesSetting {
  if (basis === setting.basis) return setting;
  const reference = referenceFor(setting.source, personal);
  if (reference === undefined) return { ...setting, basis };
  const zones = setting.zones.map((zone) => ({
    ...zone,
    from: Math.min(
      ZONE_FROM_MAX[basis],
      Math.max(0, basis === 'value' ? Math.round((zone.from * reference) / 100) : Math.round((zone.from * 100) / reference)),
    ),
  }));
  // Rounding can make two bounds equal; keep them ascending.
  for (let i = 1; i < zones.length; i += 1) {
    if (zones[i]!.from <= zones[i - 1]!.from) zones[i] = { ...zones[i]!, from: zones[i - 1]!.from + 1 };
  }
  return { ...setting, basis, zones };
}

// ---------------------------------------------------------------------------
// Time in zone

/**
 * The seconds spent moving in each zone up to a moment. It is the timeline's
 * to build (it knows the points, the segments and the moving rule); the
 * renderer asks once per component and bounds and reuses the answer, so a
 * frame costs a search, not a pass over the activity.
 */
export interface ZoneTimes {
  /** Seconds in each zone, in zone order, up to `activitySeconds` since the activity's first timed point. */
  at: (activitySeconds: number) => number[];
}

const cache = new WeakMap<OverlayTimeline, Map<string, ZoneTimes | null>>();

/**
 * `timeline.zoneTimes` for a source and bounds, kept per timeline so the pass
 * over the activity is made once for as long as the same timeline, source and
 * bounds are drawn: every frame of an export, every repaint of the preview.
 */
export function zoneTimesFor(
  timeline: OverlayTimeline,
  source: OverlayDataSource,
  bounds: readonly number[],
): ZoneTimes | undefined {
  if (!timeline.zoneTimes) return undefined;
  let byKey = cache.get(timeline);
  if (!byKey) {
    byKey = new Map();
    cache.set(timeline, byKey);
  }
  const key = `${dataSourceId(source)}|${bounds.join(',')}`;
  let times = byKey.get(key);
  if (times === undefined) {
    times = timeline.zoneTimes(source, bounds) ?? null;
    // A reader typing a bound makes a key per keystroke: keep the latest three (an entry is a few MB for a long recording).
    if (byKey.size >= 3) byKey.delete(byKey.keys().next().value as string);
    byKey.set(key, times);
  }
  return times ?? undefined;
}
