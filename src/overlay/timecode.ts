/**
 * AV-1026 (TD-095). The source video's timecode, as an editor counts it, and
 * the arithmetic that moves it with the cut. Pure: the reader of the container
 * and the exports both lean on it, and neither on the other.
 *
 * A timecode track stores one number, the frame counter at the file's first
 * frame, and says how fast the frames come and whether the label skips numbers.
 * Everything here turns that counter into the `HH:MM:SS:FF` an editor shows,
 * and back, the way SMPTE 12M counts it.
 */

export interface TimecodeRate {
  numerator: number;
  denominator: number;
}

export interface SourceTimecode {
  /** The counter at the file's first frame: whole frames since 00:00:00:00, drop-frame or not. */
  startFrame: number;
  /** The exact frame rate, 30000/1001 for 29.97. */
  rate: TimecodeRate;
  /** The nominal frames a second the label counts to: 24, 25, 30, 50, 60. */
  timebase: number;
  /** Whether the label skips numbers to keep to the clock. Only true at 29.97 and 59.94. */
  dropFrame: boolean;
  /** The video's timecode track, or the container's creation time read as a time of day (UTC). */
  source: 'timecode-track' | 'creation-time';
  /** Something to tell the reader about how this was read, when there is. */
  note?: string;
}

export const DROP_FRAME_IGNORED_NOTE =
  'The video says drop-frame, but its frame rate is not 29.97 or 59.94, so the timecode is counted without dropping.';

const FRAMES_PER_SECOND = (rate: TimecodeRate) => rate.numerator / rate.denominator;

/** The frames a drop-frame label skips at each minute but every tenth: 2 at 29.97, 4 at 59.94. */
function droppedPerMinute(timebase: number): number {
  return timebase === 30 ? 2 : timebase === 60 ? 4 : 0;
}

/** Drop-frame exists for 29.97 and 59.94 only. */
export function dropFrameAllowed(rate: TimecodeRate, timebase: number): boolean {
  if (timebase !== 30 && timebase !== 60) return false;
  return Math.abs(FRAMES_PER_SECOND(rate) - (timebase * 1000) / 1001) < 1e-3;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** A rate as its lowest fraction: 90000/3003 is 30000/1001. */
export function reduceRate(numerator: number, denominator: number): TimecodeRate {
  const divisor = gcd(Math.abs(numerator), Math.abs(denominator)) || 1;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

const KNOWN_RATES: TimecodeRate[] = [
  { numerator: 24000, denominator: 1001 },
  { numerator: 24, denominator: 1 },
  { numerator: 25, denominator: 1 },
  { numerator: 30000, denominator: 1001 },
  { numerator: 30, denominator: 1 },
  { numerator: 50, denominator: 1 },
  { numerator: 60000, denominator: 1001 },
  { numerator: 60, denominator: 1 },
];

/** The exact rate nearest a measured one: 29.97 becomes 30000/1001, an odd rate keeps three decimals. */
export function rateFromFps(fps: number): TimecodeRate | undefined {
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) return undefined;
  const known = KNOWN_RATES.find((rate) => Math.abs(FRAMES_PER_SECOND(rate) - fps) < 0.01);
  return known ?? reduceRate(Math.round(fps * 1000), 1000);
}

/**
 * A timecode from what a file states, checked. Undefined when the numbers
 * cannot be a timecode. A drop-frame flag at a rate that has no drop-frame is
 * read as non-drop, and says so.
 */
export function makeSourceTimecode(fields: {
  startFrame: number;
  rate: TimecodeRate;
  timebase: number;
  dropFrame: boolean;
  source: SourceTimecode['source'];
}): SourceTimecode | undefined {
  const { startFrame, rate, timebase, source } = fields;
  const fps = FRAMES_PER_SECOND(rate);
  if (!Number.isInteger(rate.numerator) || !Number.isInteger(rate.denominator)) return undefined;
  if (rate.numerator <= 0 || rate.denominator <= 0 || !(fps >= 1 && fps <= 240)) return undefined;
  if (!Number.isInteger(timebase) || timebase < 1 || timebase > 240) return undefined;
  if (!Number.isInteger(startFrame) || startFrame < 0) return undefined;

  const dropFrame = fields.dropFrame && dropFrameAllowed(rate, timebase);
  const made: SourceTimecode = { startFrame: 0, rate, timebase, dropFrame, source };
  if (fields.dropFrame && !dropFrame) made.note = DROP_FRAME_IGNORED_NOTE;
  // A day wraps: a counter past it is the same label a day later.
  made.startFrame = startFrame % framesPerDay(made);
  return made;
}

/** The frames in a day of this label: 24 hours of the clock, which drop-frame keeps to. */
export function framesPerDay(tc: Pick<SourceTimecode, 'timebase' | 'dropFrame'>): number {
  const nominal = tc.timebase * 86_400;
  // 1440 minutes in a day, 144 of them every tenth.
  return tc.dropFrame ? nominal - droppedPerMinute(tc.timebase) * (1440 - 144) : nominal;
}

const mod = (value: number, size: number) => ((value % size) + size) % size;
const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** `HH:MM:SS:FF`, or `HH:MM:SS;FF` where the label drops frames. */
export function frameCountToTimecode(
  frame: number,
  tc: Pick<SourceTimecode, 'timebase' | 'dropFrame'>,
): string {
  const { timebase } = tc;
  let count = mod(Math.trunc(frame), framesPerDay(tc));
  if (tc.dropFrame) {
    const dropped = droppedPerMinute(timebase);
    const perMinute = timebase * 60 - dropped;
    const perTenMinutes = perMinute * 10 + dropped;
    const tens = Math.floor(count / perTenMinutes);
    const rest = count % perTenMinutes;
    // Nine of every ten minutes skip `dropped` labels; the tenth keeps them.
    count += 9 * dropped * tens + (rest > dropped ? dropped * Math.floor((rest - dropped) / perMinute) : 0);
  }
  const frames = count % timebase;
  const seconds = Math.floor(count / timebase) % 60;
  const minutes = Math.floor(count / (timebase * 60)) % 60;
  const hours = Math.floor(count / (timebase * 3600)) % 24;
  const width = Math.max(2, String(timebase - 1).length);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${tc.dropFrame ? ';' : ':'}${pad(frames, width)}`;
}

/** The counter a label stands for, or undefined for text that is not a timecode or a label dropped. */
export function timecodeToFrameCount(
  text: string,
  tc: Pick<SourceTimecode, 'timebase' | 'dropFrame'>,
): number | undefined {
  const parts = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2,3})$/.exec(text.trim());
  if (!parts) return undefined;
  const [hours, minutes, seconds, frames] = parts.slice(1).map(Number) as [number, number, number, number];
  const { timebase } = tc;
  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= timebase) return undefined;
  let count = ((hours * 60 + minutes) * 60 + seconds) * timebase + frames;
  if (tc.dropFrame) {
    const dropped = droppedPerMinute(timebase);
    // The labels at the start of a minute that is not a tenth do not exist.
    if (seconds === 0 && frames < dropped && minutes % 10 !== 0) return undefined;
    const totalMinutes = hours * 60 + minutes;
    count -= dropped * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return count;
}

/** The label of the file's first frame. */
export function formatStartTimecode(tc: SourceTimecode): string {
  return frameCountToTimecode(tc.startFrame, tc);
}

/**
 * The timecode this many seconds on, to the nearest whole frame of the source:
 * where a cut that starts that far in begins (TD-081). Seconds may be negative.
 */
export function addSeconds(tc: SourceTimecode, seconds: number): SourceTimecode {
  if (!Number.isFinite(seconds)) return tc;
  const frames = Math.round(seconds * FRAMES_PER_SECOND(tc.rate));
  return { ...tc, startFrame: mod(tc.startFrame + frames, framesPerDay(tc)) };
}

/**
 * The container's creation time read as the time of day, in UTC, at the first
 * frame, counted without dropping. A creation time of zero is the MP4 epoch
 * a camera writes when it does not know the time, and is not one.
 */
export function timecodeFromCreationTime(
  created: Date | undefined,
  frameIntervalSeconds: number,
): SourceTimecode | undefined {
  if (!created || !(created.getTime() > 0) || !(frameIntervalSeconds > 0)) return undefined;
  const rate = rateFromFps(1 / frameIntervalSeconds);
  if (!rate) return undefined;
  const timebase = Math.round(FRAMES_PER_SECOND(rate));
  const secondOfDay = Math.floor(created.getTime() / 1000) % 86_400;
  return makeSourceTimecode({
    startFrame: secondOfDay * timebase,
    rate,
    timebase,
    dropFrame: false,
    source: 'creation-time',
  });
}

/** Whether an export at this frame rate has the source's frames, so frames can be numbered by them. */
export function sameFrameRate(fps: number, tc: SourceTimecode): boolean {
  return Math.abs(fps - FRAMES_PER_SECOND(tc.rate)) < 1e-3;
}

/** What each export can do with the timecode, for the panels (AV-1026, TD-095). */
export type TimecodeExport = 'png-sequence' | 'webm' | 'burned-in';

/** The sentence a panel shows: where the picture starts, where that came from, what the file holds. */
export function timecodeLine(tc: SourceTimecode | undefined, kind: TimecodeExport): string {
  if (!tc) return 'The source has no timecode.';
  const origin =
    tc.source === 'timecode-track' ? "the video's timecode track" : "the file's creation time";
  const parts = [`Timecode at the first frame: ${formatStartTimecode(tc)} (from ${origin}).`];
  if (tc.dropFrame) parts.push('Drop-frame: the label skips numbers to keep to the clock.');
  if (tc.note) parts.push(tc.note);
  if (kind === 'png-sequence') parts.push('It is written in the metadata file.');
  else if (kind === 'webm') {
    parts.push("A WebM has no timecode track, so this file does not hold it; the PNG sequence's metadata file does.");
  } else {
    parts.push("This file does not carry the timecode itself; the PNG sequence's metadata file does.");
  }
  return parts.join(' ');
}
