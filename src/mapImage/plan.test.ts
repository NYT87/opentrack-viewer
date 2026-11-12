import { describe, expect, it } from 'vitest';
import { canvasElementChoices, canvasTemplate, newCanvasComponents } from '../overlay/customCanvas';
import { createOverlayRenderer, type OverlayContext2D } from '../overlay/export/drawOverlay';
import { extractRoute } from '../overlay/routeImage';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { stillOverlayClock } from './plan';

/** TD-088 (TD-061). The free canvas's clock for a still, where the activity has no timestamps. */

const size = { width: 1080, height: 1350 };
/** An untimed route, as a GPX route or a KML path is: positions and elevation, no clock. */
const untimed = activityThrough(straightNorth(2000, 20, 5).map((place) => ({ north: place.north, east: place.east, elevation: 100 + place.north / 20 })));
const timed = activityThrough(straightNorth(2000, 20, 5).map((point) => ({ ...point, elevation: 100 + point.north / 20 })));

function recording() {
  const calls: string[] = [];
  const state: Record<string, unknown> = { measureText: (text: string) => ({ width: text.length * 6 }) };
  const ctx = new Proxy(state, {
    get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => void calls.push(`${key}(${args.length})`)),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as OverlayContext2D;
  return { ctx, count: (name: string) => calls.filter((call) => call.startsWith(`${name}(`)).length };
}

describe('the clock of a still without timestamps', () => {
  it('lets the route inset and the elevation profile be offered, and live figures not', () => {
    const { timeline } = stillOverlayClock(untimed);
    const choices = canvasElementChoices(timeline, { activity: untimed, route: extractRoute(untimed), units: 'metric' });
    const offered = (key: string) => choices.find((choice) => choice.key === key)?.available;
    expect(offered('route')).toBe(true);
    expect(offered('elevationProfile')).toBe(true);
    expect(offered('metric:speed')).toBe(false);
    expect(offered('metric:heartRate')).toBe(false);
  });

  it('draws the route with its position at the end, and the profile with its cursor at the end', () => {
    const { timeline, seconds } = stillOverlayClock(untimed);
    const template = canvasTemplate([
      ...newCanvasComponents(canvasTemplate([]), 'route', size, timeline),
      ...newCanvasComponents(canvasTemplate([]), 'elevationProfile', size, timeline),
    ]);
    expect(template.components.map((component) => component.type)).toEqual(['routeInset', 'elevationProfile']);
    const renderer = createOverlayRenderer({ template, timeline, activity: untimed, units: 'metric', ...size });
    const { ctx, count } = recording();
    renderer.drawFrame(ctx, seconds, { clear: false });
    // A dot for the position on the route and one for the cursor on the profile; the lines and the fill.
    expect(count('arc')).toBe(2);
    expect(count('stroke')).toBeGreaterThanOrEqual(2);
    const end = timeline.sampleAt(seconds)!;
    expect(end.progress).toBe(1);
    expect(end.position!.lat).toBeCloseTo(untimed.points[untimed.points.length - 1]!.lat!, 9);
    expect(end.values).toEqual({});
  });

  it('is the activity\'s own clock, read at its end, where it has timestamps', () => {
    const { timeline, seconds } = stillOverlayClock(timed);
    expect(timeline.unavailable).toBeUndefined();
    expect(seconds).toBeCloseTo(400, 6);
    expect(timeline.available.has('metric:speed')).toBe(true);
  });
});
