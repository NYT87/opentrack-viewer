import { describe, expect, it } from 'vitest';
import { buildMapVideoRoute, type MapVideoRoute } from './route';
import { buildMapVideoTimeline, MIN_PAUSE_SECONDS, type MapVideoTimingOptions } from './timing';
import { activityThrough, straightNorth, type TestPoint } from '../test/helpers/mapVideoRoutes';

const options = (patch: Partial<MapVideoTimingOptions> = {}): MapVideoTimingOptions => ({
  lengthSeconds: 30,
  mode: 'distance',
  pauseBeatSeconds: 0.5,
  introSeconds: 2,
  outroSeconds: 3,
  ...patch,
});
const routeOf = (points: TestPoint[]) => buildMapVideoRoute(activityThrough(points))!;
const timelineOf = (route: MapVideoRoute, patch?: Partial<MapVideoTimingOptions>) => {
  const built = buildMapVideoTimeline(route, options(patch));
  if (!built.ok) throw new Error(built.error);
  return built.timeline;
};

/** 1 km north at 5 m/s, a stop of `stop` seconds standing still (fixes every 5 s), then 1 km more. */
function rideWithStop(stop: number): TestPoint[] {
  const out = straightNorth(1000, 10, 5);
  const t = out[out.length - 1]!.second!;
  for (let s = 5; s <= stop; s += 5) out.push({ north: 1000, east: 0, second: t + s });
  const after = straightNorth(1000, 10, 5).slice(1);
  for (const point of after) out.push({ north: 1000 + point.north, east: 0, second: t + stop + point.second! });
  return out;
}

describe('the phases (AV-1203)', () => {
  const route = routeOf(straightNorth(2000));
  const timeline = timelineOf(route);

  it('holds the marker at the start through the intro, and at the end through the outro', () => {
    expect(timeline.at(0)).toMatchObject({ phase: 'intro', phaseProgress: 0, distance: 0 });
    expect(timeline.at(1.999)).toMatchObject({ phase: 'intro', distance: 0 });
    expect(timeline.at(2)).toMatchObject({ phase: 'follow', phaseProgress: 0, distance: 0 });
    expect(timeline.at(27)).toMatchObject({ phase: 'follow', phaseProgress: 1, distance: route.totalMeters });
    expect(timeline.at(27.001)).toMatchObject({ phase: 'outro', distance: route.totalMeters });
    expect(timeline.at(30)).toMatchObject({ phase: 'outro', phaseProgress: 1 });
  });

  it('starts the follow at once, and ends it on the last frame, without an intro or outro', () => {
    const bare = timelineOf(route, { introSeconds: 0, outroSeconds: 0 });
    const frames = 30 * 30;
    expect(bare.at(bare.frameSeconds(0, frames))).toMatchObject({ phase: 'follow', distance: 0 });
    expect(bare.at(bare.frameSeconds(frames - 1, frames)).distance).toBe(route.totalMeters);
  });

  it('refuses an intro and outro that leave no time for the route', () => {
    const built = buildMapVideoTimeline(route, options({ lengthSeconds: 5, introSeconds: 2.5, outroSeconds: 2 }));
    expect(built.ok).toBe(false);
  });
});

describe('by distance: an even pace along the route (AV-1203)', () => {
  const route = routeOf(rideWithStop(600));
  const timeline = timelineOf(route);

  it('moves the same distance every second, stops or not', () => {
    const perSecond = route.totalMeters / timeline.followSeconds;
    for (let t = 2; t <= 27; t += 0.5) expect(timeline.at(t).distance).toBeCloseTo((t - 2) * perSecond, 6);
    expect(timeline.pauses).toEqual([]);
  });

  it('maps both ways', () => {
    for (let d = 0; d <= route.totalMeters; d += 97) expect(timeline.at(timeline.secondsAt(d)).distance).toBeCloseTo(d, 6);
  });
});

describe('by recorded time, with long stops shortened (AV-1203)', () => {
  it('shortens a ten-minute stop to the beat, and plays the riding at an even scale', () => {
    const route = routeOf(rideWithStop(600));
    const timeline = timelineOf(route, { mode: 'time' });
    expect(timeline.mode).toBe('time');
    expect(timeline.pauses).toHaveLength(1);
    const [pause] = timeline.pauses;
    expect(pause!.endSeconds - pause!.startSeconds).toBeCloseTo(0.5, 9);
    expect(pause!.recordedSeconds).toBe(600);
    // 400 s of riding fills the follow less the beat; the stop is in the middle.
    expect(pause!.startSeconds).toBeCloseTo((25 - 0.5) / 2, 6);
    expect(timeline.at(2 + pause!.startSeconds + 0.25)).toMatchObject({ paused: true, distance: expect.closeTo(1000, 0) });
    expect(timeline.at(2 + pause!.endSeconds + 0.01).paused).toBe(false);
  });

  it('keeps a short stop at its recorded length', () => {
    const route = routeOf(rideWithStop(30));
    const timeline = timelineOf(route, { mode: 'time' });
    expect(timeline.pauses).toEqual([]);
    // 30 s standing among 430 s: the marker stands for 30/430 of the follow.
    const scale = timeline.followSeconds / 430;
    const reach = timeline.secondsAt(1000);
    // Still standing, a second before the stop ends (to the millimetre: the route measures by haversine).
    expect(timeline.at(reach + 29 * scale).distance).toBeCloseTo(1000, 2);
    expect(timeline.at(reach + 31 * scale).distance).toBeGreaterThan(1001);
  });

  it('takes a gap between recordings as a stop, however long', () => {
    const first = straightNorth(1000, 10, 5).map((point) => ({ ...point, segment: 0 }));
    const second = straightNorth(1000, 10, 5).map((point) => ({ north: 1000 + point.north, east: 0, second: 200 + 4469 + point.second!, segment: 1 }));
    const timeline = timelineOf(routeOf([...first, ...second]), { mode: 'time' });
    expect(timeline.pauses.map((pause) => pause.recordedSeconds)).toEqual([4469]);
  });

  it('is monotonic and maps both ways', () => {
    const route = routeOf(rideWithStop(600));
    const timeline = timelineOf(route, { mode: 'time' });
    let previous = -1;
    for (let t = 0; t <= 30; t += 0.01) {
      const { distance } = timeline.at(t);
      expect(distance).toBeGreaterThanOrEqual(previous);
      previous = distance;
    }
    for (let d = 0; d <= route.totalMeters; d += 97) expect(timeline.at(timeline.secondsAt(d)).distance).toBeCloseTo(d, 6);
  });

  it('shortens every beat when there are many stops, so the stops never take over', () => {
    let points: TestPoint[] = straightNorth(100, 10, 5);
    for (let k = 1; k <= 40; k += 1) {
      const t = points[points.length - 1]!.second!;
      points = [...points, { north: k * 100, east: 0, second: t + MIN_PAUSE_SECONDS + 5 }];
      points.push(...straightNorth(100, 10, 5).slice(1).map((p) => ({ north: k * 100 + p.north, east: 0, second: t + MIN_PAUSE_SECONDS + 5 + p.second! })));
    }
    const timeline = timelineOf(routeOf(points), { mode: 'time', pauseBeatSeconds: 1 });
    expect(timeline.pauses).toHaveLength(40);
    expect(timeline.beatSeconds * 40).toBeCloseTo(timeline.followSeconds * 0.25, 6);
  });

  it('falls back to an even pace, saying why, when the points have no times', () => {
    const untimed = straightNorth(1000).map(({ north, east }) => ({ north, east }));
    const timeline = timelineOf(routeOf(untimed), { mode: 'time' });
    expect(timeline.mode).toBe('distance');
    expect(timeline.modeNote).toMatch(/Not every point has a time/);
  });

  it('falls back when the times go backwards', () => {
    const points = straightNorth(1000);
    points[5] = { ...points[5]!, second: 0 };
    expect(timelineOf(routeOf(points), { mode: 'time' }).modeNote).toMatch(/backwards/);
  });
});
