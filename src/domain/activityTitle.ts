import type { Activity, ActivitySport } from './activity';

/** A name that is only a timestamp: what TCX writes as an activity's `Id`. */
const TIMESTAMP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

const SPORT_NOUN: Partial<Record<ActivitySport, string>> = {
  running: 'Run',
  cycling: 'Ride',
  hiking: 'Hike',
  walking: 'Walk',
  swimming: 'Swim',
  skiing: 'Ski',
  rowing: 'Row',
};

/**
 * The title a reader sees for an activity.
 *
 * The file's own name when it gave one. A name that is only a timestamp — TCX
 * has no name field and writes its start time as the `Id` — is read as the date
 * it is, so the page's heading says "Run on 1 May 2024, 08:00" rather than
 * "2024-05-01T07:00:00Z". Nothing is invented: with no name and no start time,
 * the activity is untitled.
 */
export function activityTitle(activity: Activity, locale?: string): string {
  const name = activity.metadata.name?.trim();
  if (name && !TIMESTAMP_NAME.test(name)) return name;

  const parsed = name ? new Date(name) : undefined;
  const start =
    parsed && Number.isFinite(parsed.getTime()) ? parsed : activity.metadata.startTime ?? undefined;
  if (!start || !Number.isFinite(start.getTime())) return name || 'Untitled activity';

  const noun = SPORT_NOUN[activity.metadata.sport ?? 'unknown'] ?? 'Activity';
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(start);
  return `${noun} on ${when}`;
}
