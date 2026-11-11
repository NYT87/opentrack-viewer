/**
 * TD-081. The part of the video that is exported, in the video's own seconds.
 * The preview still plays the whole video; the exports draw from `start` to
 * `end`, so a long ride can be cut to the stretch that matters, at either end.
 */
export interface VideoTrim {
  startSeconds: number;
  /** Absent: to the video's end. */
  endSeconds?: number;
}

/** The shortest part that can be kept. */
export const MIN_TRIM_SECONDS = 1;

export interface TrimRange {
  start: number;
  end: number;
  length: number;
  /** Whether anything is cut at all. */
  trimmed: boolean;
}

/** The trim against a video of this length, held inside it and at least `MIN_TRIM_SECONDS` long. */
export function trimRange(trim: VideoTrim | undefined, durationSeconds: number): TrimRange {
  const duration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
  const shortest = Math.min(MIN_TRIM_SECONDS, duration);
  const end = Math.min(duration, Math.max(shortest, trim?.endSeconds ?? duration));
  const start = Math.min(Math.max(0, trim?.startSeconds ?? 0), end - shortest);
  return { start, end, length: end - start, trimmed: start > 0 || end < duration };
}

/** A trim with its start moved, kept short of its end. */
export function withTrimStart(trim: VideoTrim | undefined, seconds: number, durationSeconds: number): VideoTrim | undefined {
  const { end } = trimRange(trim, durationSeconds);
  const start = Math.min(Math.max(0, seconds), Math.max(0, end - MIN_TRIM_SECONDS));
  return tidy({ startSeconds: start, endSeconds: trim?.endSeconds }, durationSeconds);
}

/** A trim with its end moved, kept past its start. */
export function withTrimEnd(trim: VideoTrim | undefined, seconds: number, durationSeconds: number): VideoTrim | undefined {
  const { start } = trimRange(trim, durationSeconds);
  const end = Math.max(Math.min(durationSeconds, seconds), Math.min(durationSeconds, start + MIN_TRIM_SECONDS));
  return tidy({ startSeconds: trim?.startSeconds ?? 0, endSeconds: end }, durationSeconds);
}

/** No trim where nothing is cut, and no end where it is the video's own. */
function tidy(trim: VideoTrim, durationSeconds: number): VideoTrim | undefined {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const startSeconds = round(trim.startSeconds);
  const endSeconds = trim.endSeconds === undefined || trim.endSeconds >= durationSeconds ? undefined : round(trim.endSeconds);
  if (startSeconds <= 0 && endSeconds === undefined) return undefined;
  return endSeconds === undefined ? { startSeconds } : { startSeconds, endSeconds };
}
