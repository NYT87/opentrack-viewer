import type { Activity } from '../domain/activity';
import { MISSING, type UnitSystem } from '../domain/units';
import { projectProfile } from '../overlay/elevationProfile';
import { formatStillDate, summaryValue, type DateZone } from '../overlay/staticImage';
import type { PanelContent } from './panel';
import type { MapImageDetail } from './settings';

/**
 * AV-1013. The details a map image's panel can show, each available or not
 * for this activity, and the panel's content for the reader's choice. The
 * figures are the whole activity's, as the still image's are: a total is a
 * number, not a place. The elevation profile is drawn from `shown`, the
 * stretch the privacy trim leaves, so it shows nothing the map hides.
 */

export interface MapImageDetailChoice {
  detail: MapImageDetail;
  label: string;
  available: boolean;
  reason?: string;
}

const LABELS: Record<MapImageDetail, string> = {
  name: 'Activity name',
  date: 'Date and time',
  distance: 'Distance',
  moving: 'Moving time',
  elapsed: 'Elapsed time',
  climb: 'Elevation gain',
  speed: 'Average speed',
  pace: 'Average pace',
  heartRate: 'Average heart rate',
  profile: 'Elevation profile',
};

export interface DetailContext {
  activity: Activity;
  /** The stretch the privacy trim leaves. */
  shown: Activity;
  units: UnitSystem;
  /** The reader's IANA time zone; the browser's own by default. */
  readerTimeZone?: string;
}

type DetailValue = { ok: true; caption: string; value: string } | { ok: false; reason: string };

function startOf(activity: Activity): Date | undefined {
  const start = activity.derived?.startTime ?? activity.metadata.startTime;
  return start instanceof Date && Number.isFinite(start.getTime()) ? start : undefined;
}

/** The activity's own name, never its file's: a file name is not a title, and may say more than the reader means to. */
function nameOf(activity: Activity): string | undefined {
  const name = activity.metadata.name?.trim();
  return name ? name : undefined;
}

function dateText(activity: Activity, readerTimeZone: string | undefined): string | undefined {
  const start = startOf(activity);
  if (!start) return undefined;
  // In the activity's own time where the file says it, else the reader's.
  const minutes = activity.metadata.utcOffsetMinutes;
  const zone: DateZone =
    minutes !== undefined
      ? { kind: 'offset', minutes }
      : { kind: 'zone', timeZone: readerTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
  return formatStillDate(start, 'long', true, zone);
}

function figureOf(detail: MapImageDetail, context: DetailContext): DetailValue {
  const { activity, units } = context;
  switch (detail) {
    case 'distance':
    case 'moving':
    case 'elapsed':
    case 'climb':
    case 'speed':
    case 'pace':
      return summaryValue(detail, activity, units);
    case 'heartRate': {
      const bpm = activity.derived?.averageHeartRateBpm;
      return bpm === undefined || !Number.isFinite(bpm)
        ? { ok: false, reason: 'This activity records no heart rate.' }
        : { ok: true, caption: 'Avg heart rate', value: `${Math.round(bpm)} bpm` };
    }
    default:
      return { ok: false, reason: '' };
  }
}

/** Every detail, available or not, with the reason when not. */
export function mapImageDetailChoices(context: DetailContext): MapImageDetailChoice[] {
  const { activity, shown, readerTimeZone } = context;
  const choice = (detail: MapImageDetail, reason: string | undefined): MapImageDetailChoice =>
    reason === undefined ? { detail, label: LABELS[detail], available: true } : { detail, label: LABELS[detail], available: false, reason };
  return [
    choice('name', nameOf(activity) ? undefined : 'The file gives this activity no name.'),
    choice('date', dateText(activity, readerTimeZone) ? undefined : 'This activity has no start time.'),
    ...(['distance', 'moving', 'elapsed', 'climb', 'speed', 'pace', 'heartRate'] as const).map((detail) => {
      const value = figureOf(detail, context);
      return choice(detail, value.ok ? undefined : value.reason);
    }),
    choice('profile', projectProfile(shown) ? undefined : 'This activity records no elevation along its route.'),
  ];
}

/**
 * What the panel holds for the details chosen, in the panel's own order; a
 * detail the activity lacks is left out, never drawn as a dash.
 */
export function mapImagePanelContent(details: readonly MapImageDetail[], context: DetailContext): PanelContent {
  const chosen = new Set(details);
  const available = new Set(mapImageDetailChoices(context).filter((choice) => choice.available).map((choice) => choice.detail));
  const wanted = (detail: MapImageDetail) => chosen.has(detail) && available.has(detail);
  const figures = (['distance', 'moving', 'elapsed', 'climb', 'speed', 'pace', 'heartRate'] as const).flatMap((detail) => {
    if (!wanted(detail)) return [];
    const value = figureOf(detail, context);
    return value.ok && value.value !== MISSING ? [{ caption: value.caption, value: value.value }] : [];
  });
  return {
    ...(wanted('name') ? { title: nameOf(context.activity) } : {}),
    ...(wanted('date') ? { date: dateText(context.activity, context.readerTimeZone) } : {}),
    figures,
    profile: wanted('profile'),
  };
}
