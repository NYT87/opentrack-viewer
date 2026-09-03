/**
 * Display formatting. The app is metric-first (open question §17 resolved:
 * metric default, with a unit system switch available per session).
 */
export type UnitSystem = 'metric' | 'imperial';

export const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

/** Placeholder shown wherever a value is genuinely absent (AV-404). */
export const MISSING = '—';

/** Converts a raw elevation to the display unit, for axis ticks and the like. */
export function toDisplayElevation(meters: number, units: UnitSystem): number {
  return units === 'imperial' ? meters / METERS_PER_FOOT : meters;
}

export function elevationUnitLabel(units: UnitSystem): string {
  return units === 'imperial' ? 'ft' : 'm';
}

export function formatDistance(meters: number | undefined, units: UnitSystem = 'metric'): string {
  if (!Number.isFinite(meters)) return MISSING;
  const value = meters as number;
  if (units === 'imperial') {
    const miles = value / METERS_PER_MILE;
    return miles < 0.1 ? `${Math.round(value / METERS_PER_FOOT)} ft` : `${miles.toFixed(2)} mi`;
  }
  return value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(2)} km`;
}

export function formatElevation(meters: number | undefined, units: UnitSystem = 'metric'): string {
  if (!Number.isFinite(meters)) return MISSING;
  const value = meters as number;
  return units === 'imperial'
    ? `${Math.round(value / METERS_PER_FOOT)} ft`
    : `${Math.round(value)} m`;
}

/** Formats a duration as H:MM:SS, or M:SS when under an hour. */
export function formatDuration(seconds: number | undefined): string {
  if (!Number.isFinite(seconds) || (seconds as number) < 0) return MISSING;
  const total = Math.round(seconds as number);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Local-time rendering; the file's own timestamps are never sent anywhere. */
export function formatDateTime(date: Date | undefined): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return MISSING;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Pace is stored as seconds per kilometre — metric-based like every other
 * domain value — and converted only for display.
 */
export function toDisplayPace(secondsPerKm: number, units: UnitSystem): number {
  return units === 'imperial' ? (secondsPerKm * METERS_PER_MILE) / 1000 : secondsPerKm;
}

export function paceUnitLabel(units: UnitSystem): string {
  return units === 'imperial' ? '/mi' : '/km';
}

/** Formats pace as M:SS per unit distance, the convention runners expect. */
export function formatPace(
  secondsPerKm: number | undefined,
  units: UnitSystem = 'metric',
): string {
  if (!Number.isFinite(secondsPerKm) || (secondsPerKm as number) <= 0) return MISSING;
  const perUnit = toDisplayPace(secondsPerKm as number, units);
  const total = Math.round(perUnit);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} ${paceUnitLabel(units)}`;
}

export function formatSpeed(
  metersPerSecond: number | undefined,
  units: UnitSystem = 'metric',
): string {
  if (!Number.isFinite(metersPerSecond)) return MISSING;
  const value = metersPerSecond as number;
  return units === 'imperial'
    ? `${((value * 3600) / METERS_PER_MILE).toFixed(1)} mph`
    : `${((value * 3600) / 1000).toFixed(1)} km/h`;
}

export function formatFileSize(bytes: number | undefined): string {
  if (!Number.isFinite(bytes)) return MISSING;
  const value = bytes as number;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
