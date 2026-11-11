import type { MapVideoRoute } from './route';

/**
 * AV-1203. How video time maps to progress along the route. Computed once,
 * as a list of knots — (video seconds, metres) pairs, both never decreasing —
 * and read by interpolation for every frame.
 *
 * The video is an intro (the camera flies in from the overview), the follow
 * (the marker runs the route from its first point to its last) and an outro
 * (the camera pulls back to the whole route). The intro and the outro hold
 * the marker at the start and at the end.
 */

/**
 * `distance`: an even pace along the route, whatever the speed was.
 * `time`: as recorded, with each long stop shortened to a beat.
 */
export type MapVideoTimingMode = 'distance' | 'time';

export interface MapVideoTimingOptions {
  lengthSeconds: number;
  mode: MapVideoTimingMode;
  /** Video seconds a long stop is shortened to, in `time` mode. */
  pauseBeatSeconds: number;
  introSeconds: number;
  outroSeconds: number;
  /** AV-1208. Places where the marker waits a while, each a photo shown: metres along the route, and for how long. */
  holds?: { id: string; distance: number; seconds: number }[];
}

/** Slower than this, a stretch is standing still: the moving-time rule of the stats (`computeStats`). */
export const STOPPED_SPEED_MPS = 0.5;
/** A stop at least this long is shortened to a beat; a shorter one plays at the recorded pace. */
export const MIN_PAUSE_SECONDS = 60;
/** The follow is never shorter than this. */
export const MIN_FOLLOW_SECONDS = 1;
/** Beats never take more than this share of the follow; with many stops, each beat is shortened. */
const MAX_BEAT_SHARE = 0.25;
/** Photos never take more than this share of the follow; with many, each is shown for less. */
const MAX_HOLD_SHARE = 0.5;

export type MapVideoPhase = 'intro' | 'follow' | 'outro';

export interface TimelineSample {
  phase: MapVideoPhase;
  /** 0 to 1 through the phase. */
  phaseProgress: number;
  /** Metres along the (trimmed) route where the marker is. */
  distance: number;
  /** Whether the marker is held in a shortened stop. */
  paused: boolean;
  /** AV-1208. The photo shown while the marker waits for it: how far into its showing, and for how long. */
  photo?: { id: string; elapsed: number; duration: number };
}

/** A stop as shown: the video seconds it takes, and where on the route it is. */
export interface TimelinePause {
  startSeconds: number;
  endSeconds: number;
  /** The recorded length of the stop, in seconds. */
  recordedSeconds: number;
  distance: number;
  /** When the stop began, on the recording's clock (ms): figures hold its values through the beat (AV-1207). */
  startTime: number;
}

export interface MapVideoTimeline {
  lengthSeconds: number;
  introSeconds: number;
  followSeconds: number;
  outroSeconds: number;
  /** The mode used: `time` falls back to `distance` when the route cannot be timed, with the reason. */
  mode: MapVideoTimingMode;
  modeNote?: string;
  /** The beat each long stop was given, after shortening for many stops. */
  beatSeconds: number;
  pauses: TimelinePause[];
  /** AV-1208. Each photo's showing, in follow seconds (as `pauses`). */
  holds: { id: string; startSeconds: number; endSeconds: number; distance: number }[];
  /** Why the photos are shown for less than asked, when they are. */
  holdNote?: string;
  /** Where the video is at `seconds`, from 0 to `lengthSeconds`. */
  at: (seconds: number) => TimelineSample;
  /** The first video second at which the marker reaches `distance`. */
  secondsAt: (distance: number) => number;
  /** Story time of frame `frame` of `frameCount`: the first frame is 0, the last is the end. */
  frameSeconds: (frame: number, frameCount: number) => number;
}

export type BuildTimelineResult = { ok: true; timeline: MapVideoTimeline } | { ok: false; error: string };

interface Knots {
  seconds: number[];
  meters: number[];
  pauses: TimelinePause[];
  beat: number;
}

/** Why `time` mode cannot be used for this route, or undefined when it can. */
export function timeModeRefusal(route: MapVideoRoute): string | undefined {
  let previous: number | undefined;
  for (const vertex of route.vertices) {
    if (vertex.time === undefined) return 'Not every point has a time, so the video follows the route at an even pace.';
    if (previous !== undefined && vertex.time < previous) {
      return 'The times go backwards in places, so the video follows the route at an even pace.';
    }
    previous = vertex.time;
  }
  if (route.vertices[route.vertices.length - 1]!.time! <= route.vertices[0]!.time!) {
    return 'The points all have the same time, so the video follows the route at an even pace.';
  }
  return undefined;
}

function distanceKnots(route: MapVideoRoute, follow: number): Knots {
  return { seconds: [0, follow], meters: [0, route.totalMeters], pauses: [], beat: 0 };
}

/**
 * Recorded time, with long stops shortened. Each edge between two points is
 * moving or stopped by its speed; a gap between recorded segments is stopped.
 * A run of stopped edges lasting `MIN_PAUSE_SECONDS` or more is a pause and
 * takes `beat` video seconds; the rest of the time is scaled to fill the follow.
 */
function timeKnots(route: MapVideoRoute, follow: number, beatWanted: number): Knots | undefined {
  const { vertices } = route;
  interface Run { from: number; to: number; seconds: number }
  const pauseRuns: Run[] = [];
  let run: Run | undefined;
  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const seconds = (b.time! - a.time!) / 1000;
    const stopped = b.segment !== a.segment || (seconds > 0 && (b.distance - a.distance) / seconds < STOPPED_SPEED_MPS);
    if (stopped) {
      if (run && run.to === i) {
        run.to = i + 1;
        run.seconds += seconds;
      } else {
        run = { from: i, to: i + 1, seconds };
      }
    } else if (run) {
      if (run.seconds >= MIN_PAUSE_SECONDS) pauseRuns.push(run);
      run = undefined;
    }
  }
  if (run && run.seconds >= MIN_PAUSE_SECONDS) pauseRuns.push(run);

  const totalSeconds = (vertices[vertices.length - 1]!.time! - vertices[0]!.time!) / 1000;
  const playedSeconds = totalSeconds - pauseRuns.reduce((sum, pause) => sum + pause.seconds, 0);
  if (playedSeconds <= 0) return undefined;
  const beat = pauseRuns.length === 0 ? 0 : Math.min(beatWanted, (follow * MAX_BEAT_SHARE) / pauseRuns.length);
  const scale = (follow - beat * pauseRuns.length) / playedSeconds;

  const seconds: number[] = [0];
  const meters: number[] = [0];
  const pauses: TimelinePause[] = [];
  let clock = 0;
  let next = 0;
  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const pause = pauseRuns[next];
    if (pause && pause.from === i) {
      // The whole stop in one step: `beat` seconds, the marker drifting only as far as the fixes did.
      const startSeconds = clock;
      clock += beat;
      pauses.push({ startSeconds, endSeconds: clock, recordedSeconds: pause.seconds, distance: vertices[i]!.distance, startTime: vertices[i]!.time! });
      seconds.push(clock);
      meters.push(vertices[pause.to]!.distance);
      i = pause.to - 1;
      next += 1;
      continue;
    }
    clock += ((vertices[i + 1]!.time! - vertices[i]!.time!) / 1000) * scale;
    seconds.push(clock);
    meters.push(vertices[i + 1]!.distance);
  }
  // Rounding never leaves the follow a hair short or long of its end.
  seconds[seconds.length - 1] = follow;
  return { seconds, meters, pauses, beat };
}

/** Linear interpolation in a never-decreasing table: the first matching span for a repeated key. */
function interpolate(keys: number[], values: number[], key: number): number {
  if (key <= keys[0]!) return values[0]!;
  const last = keys.length - 1;
  if (key >= keys[last]!) return values[last]!;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < key) lo = mid;
    else hi = mid;
  }
  const span = keys[hi]! - keys[lo]!;
  return span > 0 ? values[lo]! + ((values[hi]! - values[lo]!) * (key - keys[lo]!)) / span : values[hi]!;
}

export function buildMapVideoTimeline(route: MapVideoRoute, options: MapVideoTimingOptions): BuildTimelineResult {
  const intro = Math.max(0, options.introSeconds);
  const outro = Math.max(0, options.outroSeconds);
  const length = options.lengthSeconds;
  const follow = length - intro - outro;
  if (!(follow >= MIN_FOLLOW_SECONDS)) {
    return { ok: false, error: `The intro and outro leave less than ${MIN_FOLLOW_SECONDS} second for the route. Shorten them or lengthen the video.` };
  }

  // Photos are held out of the follow first: the riding fills what they leave.
  const asked = (options.holds ?? []).filter((hold) => hold.seconds > 0).sort((a, b) => a.distance - b.distance);
  const askedTotal = asked.reduce((sum, hold) => sum + hold.seconds, 0);
  const holdScale = askedTotal > follow * MAX_HOLD_SHARE ? (follow * MAX_HOLD_SHARE) / askedTotal : 1;
  const holdNote = holdScale < 1 ? `So many photos would leave too little time for the route: each is shown for ${(asked[0]!.seconds * holdScale).toFixed(1)} s.` : undefined;
  const riding = follow - askedTotal * holdScale;

  let mode = options.mode;
  let modeNote: string | undefined;
  let knots: Knots | undefined;
  if (mode === 'time') {
    modeNote = timeModeRefusal(route);
    knots = modeNote ? undefined : timeKnots(route, riding, options.pauseBeatSeconds);
    if (!knots) {
      modeNote ??= 'The route is all stops, so the video follows it at an even pace.';
      mode = 'distance';
    }
  }
  knots ??= distanceKnots(route, riding);
  const { seconds, meters, pauses, beat } = knots;

  // Each photo's wait, put in where the marker reaches it: what comes after moves later.
  const holds: MapVideoTimeline['holds'] = [];
  for (const hold of asked) {
    const length = hold.seconds * holdScale;
    let at = interpolate(meters, seconds, Math.min(route.totalMeters, Math.max(0, hold.distance)));
    // A second photo at the same place waits after the first, not over it.
    const before = holds[holds.length - 1];
    if (before && at >= before.startSeconds && at <= before.endSeconds) at = before.endSeconds;
    const marker = interpolate(seconds, meters, at);
    let i = 0;
    while (i < seconds.length && seconds[i]! < at) i += 1;
    // Split the stretch it falls in, unless a knot is there already, then wait.
    if (seconds[i] !== at) {
      seconds.splice(i, 0, at);
      meters.splice(i, 0, marker);
    }
    for (let k = i + 1; k < seconds.length; k += 1) seconds[k]! += length;
    seconds.splice(i + 1, 0, at + length);
    meters.splice(i + 1, 0, marker);
    for (const pause of pauses) {
      if (pause.startSeconds >= at) {
        pause.startSeconds += length;
        pause.endSeconds += length;
      } else if (pause.endSeconds > at) {
        // A photo shown within a shortened stop lengthens the stop by its wait: the figures hold the stop through both.
        pause.endSeconds += length;
      }
    }
    for (const earlier of holds) {
      if (earlier.startSeconds > at) {
        earlier.startSeconds += length;
        earlier.endSeconds += length;
      }
    }
    holds.push({ id: hold.id, startSeconds: at, endSeconds: at + length, distance: marker });
  }
  seconds[seconds.length - 1] = Math.max(seconds[seconds.length - 1]!, follow);

  const pausedAt = (followSeconds: number) =>
    pauses.some((pause) => followSeconds >= pause.startSeconds && followSeconds < pause.endSeconds);
  const photoAt = (followSeconds: number) => {
    const hold = holds.find((entry) => followSeconds >= entry.startSeconds && followSeconds < entry.endSeconds);
    return hold && { id: hold.id, elapsed: followSeconds - hold.startSeconds, duration: hold.endSeconds - hold.startSeconds };
  };

  const at = (t: number): TimelineSample => {
    const time = Math.min(length, Math.max(0, t));
    if (time < intro) return { phase: 'intro', phaseProgress: time / intro, distance: 0, paused: false };
    if (outro > 0 && time > intro + follow) {
      return { phase: 'outro', phaseProgress: (time - intro - follow) / outro, distance: route.totalMeters, paused: false };
    }
    const s = Math.min(follow, time - intro);
    const photo = photoAt(s);
    return { phase: 'follow', phaseProgress: s / follow, distance: interpolate(seconds, meters, s), paused: pausedAt(s), ...(photo ? { photo } : {}) };
  };

  return {
    ok: true,
    timeline: {
      lengthSeconds: length,
      introSeconds: intro,
      followSeconds: follow,
      outroSeconds: outro,
      mode,
      ...(modeNote ? { modeNote } : {}),
      beatSeconds: beat,
      pauses,
      holds,
      ...(holdNote ? { holdNote } : {}),
      at,
      secondsAt: (distance) => intro + interpolate(meters, seconds, Math.min(route.totalMeters, Math.max(0, distance))),
      frameSeconds: (frame, frameCount) => (frameCount <= 1 ? 0 : (Math.min(frameCount - 1, Math.max(0, frame)) / (frameCount - 1)) * length),
    },
  };
}

/** `0:07.4`: a position in the video to a tenth of a second. */
export function formatVideoTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
