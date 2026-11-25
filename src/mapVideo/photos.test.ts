import { describe, expect, it } from 'vitest';
import type { OverlayContext2D } from '../overlay/export/drawOverlay';
import { activityThrough, straightNorth, type TestPoint } from '../test/helpers/mapVideoRoutes';
import { createMapVideoFigures, drawPhoto } from './figures';
import { buildMapVideoModel } from './model';
import { MAX_PHOTO_DISTANCE_METERS, photoItemsForSave, type PhotoInput, type PhotosSettings } from './photos';
import { DEFAULT_MAP_VIDEO_SETTINGS, parseMapVideoProject, serializeMapVideoProject, type MapVideoSettings } from './project';
import { buildMapVideoRoute, positionAt } from './route';

// 3 km north at 5 m/s from 08:00:00 UTC on 10 November 2026: 600 s, a point every 10 m.
const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
const ride = activityThrough(straightNorth(3000, 10, 5));
const full = buildMapVideoRoute(ride)!;
const photos = (patch: Partial<PhotosSettings> = {}): PhotosSettings => ({ holdSeconds: 3, clockOffsetSeconds: 0, items: [], ...patch });
const modelWith = (inputs: PhotoInput[], patch: Partial<MapVideoSettings> = {}) => {
  const built = buildMapVideoModel(ride, { ...DEFAULT_MAP_VIDEO_SETTINGS, lengthSeconds: 30, ...patch }, inputs);
  if (!built.ok) throw new Error(built.error);
  return built.model;
};
const at = (meters: number) => positionAt(full, meters);

describe('placing photos on the route (AV-1208)', () => {
  it('places one by when it was taken, against the activity\'s clock', () => {
    const [placed] = modelWith([{ id: 'p', name: 'IMG_1.jpg', takenAt: T0 + 120_000 }]).photos;
    expect(placed).toMatchObject({ method: 'time', distance: expect.closeTo(600, 2) });
  });

  it('moves one by the camera clock offset', () => {
    // The camera was a minute ahead: taken at its 08:03, really at 08:02.
    const [placed] = modelWith([{ id: 'p', name: 'IMG_1.jpg', takenAt: T0 + 180_000 }], { photos: photos({ clockOffsetSeconds: 60 }) }).photos;
    expect(placed!.distance).toBeCloseTo(600, 2);
  });

  it('leaves out one taken outside the activity, saying when', () => {
    const [placed] = modelWith([{ id: 'p', name: 'IMG_1.jpg', takenAt: T0 - 3_600_000 }]).photos;
    expect(placed!.distance).toBeUndefined();
    expect(placed!.reason).toMatch(/^Taken at 07:00 UTC, outside the activity \(08:00–08:10 UTC\)/);
  });

  it('places one by where it was taken, at the nearest place on the route', () => {
    const place = at(1500);
    const [placed] = modelWith([{ id: 'p', name: 'IMG_2.jpg', lat: place.lat, lon: place.lon + 50 / (111_320 * Math.cos((46 * Math.PI) / 180)) }]).photos;
    expect(placed).toMatchObject({ method: 'position', distance: expect.closeTo(1500, 0) });
  });

  it('leaves out one taken too far from the route', () => {
    const place = at(1500);
    const [placed] = modelWith([{ id: 'p', name: 'IMG_2.jpg', lat: place.lat, lon: place.lon + 0.05 }]).photos;
    expect(placed!.reason).toMatch(/^Taken 3\.\d km from the route/);
    expect(MAX_PHOTO_DISTANCE_METERS).toBe(200);
  });

  it('places one by hand, and asks for a place until it has one', () => {
    const settings = photos({ items: [{ name: 'IMG_3.png', method: 'hand', handMeters: 2200 }] });
    expect(modelWith([{ id: 'p', name: 'IMG_3.png' }], { photos: settings }).photos[0]).toMatchObject({ method: 'hand', distance: 2200 });
    expect(modelWith([{ id: 'p', name: 'IMG_3.png' }]).photos[0]).toMatchObject({ method: 'hand', reason: expect.stringMatching(/^Not placed yet/) });
  });

  it('measures a placement on the shown route, and leaves out one the privacy trim hides', () => {
    const trim = { privacyTrim: { startMeters: 500, endMeters: 500 } };
    const settings = photos({ items: [{ name: 'a', method: 'hand', handMeters: 1000 }, { name: 'b', method: 'hand', handMeters: 200 }] });
    const [kept, hidden] = modelWith([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], { ...trim, photos: settings }).photos;
    expect(kept!.distance).toBeCloseTo(500, 6);
    expect(hidden!.reason).toMatch(/privacy trim hides/);
  });

  it('lists one that could not be decoded, with the reason, and leaves it out', () => {
    const [placed] = modelWith([{ id: 'p', name: 'IMG_4.heic', takenAt: T0 + 60_000, decodeError: 'This browser cannot decode HEIC photos (Safari can).' }]).photos;
    expect(placed).toMatchObject({ reason: 'This browser cannot decode HEIC photos (Safari can).' });
    expect(placed!.distance).toBeUndefined();
  });

  it('places by time only an activity that has a clock', () => {
    const untimed = activityThrough(straightNorth(3000).map(({ north, east }): TestPoint => ({ north, east })));
    const built = buildMapVideoModel(untimed, DEFAULT_MAP_VIDEO_SETTINGS, [{ id: 'p', name: 'x', takenAt: T0 }]);
    expect(built.ok && built.model.photos[0]!.reason).toMatch(/no clock/);
  });
});

describe('the marker waits at each photo (AV-1208)', () => {
  const inputs: PhotoInput[] = [
    { id: 'late', name: 'b', takenAt: T0 + 480_000 },
    { id: 'early', name: 'a', takenAt: T0 + 120_000 },
  ];
  const model = modelWith(inputs, { intro: { enabled: false, seconds: 2 }, outro: { enabled: false, seconds: 3 } });
  const { holds } = model.timeline;

  it('adds a wait of the set length where the marker reaches each, in route order', () => {
    expect(holds.map((hold) => hold.id)).toEqual(['early', 'late']);
    for (const hold of holds) expect(hold.endSeconds - hold.startSeconds).toBeCloseTo(3, 9);
    // 30 s, less 6 s of photos, is 24 s of riding: the first at a fifth of the route, after 4.8 s.
    expect(holds[0]!.startSeconds).toBeCloseTo(24 * (600 / 3000), 6);
    expect(holds[1]!.startSeconds).toBeCloseTo(24 * (2400 / 3000) + 3, 6);
  });

  it('holds the marker still while the photo is shown, and names it', () => {
    const [early] = holds;
    const start = model.at(early!.startSeconds + 0.01);
    const end = model.at(early!.endSeconds - 0.01);
    expect(end.sample.distance).toBeCloseTo(start.sample.distance, 9);
    expect(start.sample.photo).toMatchObject({ id: 'early', duration: expect.closeTo(3, 9) });
    expect(model.at(early!.endSeconds + 0.05).sample.photo).toBeUndefined();
    // And the route still ends on the last frame.
    expect(model.frame(model.frameCount - 1).sample.distance).toBe(model.route.totalMeters);
  });

  it('shows each for less when there are so many they would crowd out the route', () => {
    const many = Array.from({ length: 20 }, (_, i): PhotoInput => ({ id: `p${i}`, name: `p${i}`, takenAt: T0 + (i + 1) * 25_000 }));
    const crowded = modelWith(many, { photos: photos({ holdSeconds: 5 }) });
    const shown = crowded.timeline.holds.reduce((sum, hold) => sum + hold.endSeconds - hold.startSeconds, 0);
    expect(shown).toBeCloseTo(crowded.timeline.followSeconds * 0.5, 6);
    expect(crowded.timeline.holdNote).toMatch(/each is shown for 0\.\d s/);
  });

  it('waits beside a shortened stop without losing either', () => {
    const points: TestPoint[] = straightNorth(1500, 10, 5);
    const stop = points[points.length - 1]!.second!;
    for (let s = 5; s <= 300; s += 5) points.push({ north: 1500, east: 0, second: stop + s });
    for (const point of straightNorth(1500, 10, 5).slice(1)) points.push({ north: 1500 + point.north, east: 0, second: stop + 300 + point.second! });
    const stopped = activityThrough(points);
    const built = buildMapVideoModel(stopped, { ...DEFAULT_MAP_VIDEO_SETTINGS, timing: { mode: 'time', pauseBeatSeconds: 1 } }, [{ id: 'p', name: 'p', takenAt: T0 + 60_000 }]);
    if (!built.ok) throw new Error(built.error);
    const { pauses, holds: waits } = built.model.timeline;
    expect(pauses).toHaveLength(1);
    expect(waits).toHaveLength(1);
    expect(waits[0]!.endSeconds).toBeLessThanOrEqual(pauses[0]!.startSeconds + 1e-9);
    expect(pauses[0]!.endSeconds - pauses[0]!.startSeconds).toBeCloseTo(1, 9);
  });
});

/** Every call on a context, its alpha with it: enough to see a photo come and go. */
function record(draw: (ctx: OverlayContext2D) => void): string[] {
  const lines: string[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, save: () => lines.push('save'), restore: () => lines.push('restore') };
  const ctx = new Proxy(state, {
    get: (target, key: string) =>
      key in target ? target[key] : (...args: unknown[]) => lines.push(`${key}(${args.map((arg) => (typeof arg === 'object' ? 'photo' : Math.round(Number(arg)))).join(', ')}) alpha=${Number(target.globalAlpha).toFixed(2)}`),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as OverlayContext2D;
  draw(ctx);
  return lines;
}

describe('drawing a photo (AV-1208)', () => {
  const photo = { image: { pixels: true } as unknown as CanvasImageSource, width: 4000, height: 3000 };

  it('comes in, stays, and goes, fitted in the middle of the frame with a white edge', () => {
    const coming = record((ctx) => drawPhoto(ctx, photo, { elapsed: 0, duration: 3 }, 1920, 1080));
    const shown = record((ctx) => drawPhoto(ctx, photo, { elapsed: 1.5, duration: 3 }, 1920, 1080));
    const going = record((ctx) => drawPhoto(ctx, photo, { elapsed: 2.99, duration: 3 }, 1920, 1080));
    expect(coming.find((line) => line.startsWith('drawImage'))).toMatch(/alpha=0\.00$/);
    expect(going.find((line) => line.startsWith('drawImage'))).toMatch(/alpha=0\.0\d$/);
    // Fully in: 4:3 fitted to three quarters of the height, 810 px, so 1080 × 810, in the middle.
    expect(shown.find((line) => line.startsWith('drawImage'))).toBe('drawImage(photo, 420, 135, 1080, 810) alpha=1.00');
  });

  it('is drawn from its decoded pixels alone, while the marker waits for it', () => {
    const model = modelWith([{ id: 'p', name: 'IMG_1.jpg', takenAt: T0 + 120_000 }]);
    const figures = createMapVideoFigures({
      activity: ride,
      model,
      settings: { ...DEFAULT_MAP_VIDEO_SETTINGS, lengthSeconds: 30 },
      units: 'metric',
      width: 1920,
      height: 1080,
      photoImages: new Map([['p', photo]]),
    });
    const hold = model.timeline.holds[0]!;
    const during = record((ctx) => figures.drawFrame(ctx, model.timeline.introSeconds + hold.startSeconds + 1.5));
    expect(during.filter((line) => line.startsWith('drawImage'))).toEqual(['drawImage(photo, 420, 135, 1080, 810) alpha=1.00']);
    expect(record((ctx) => figures.drawFrame(ctx, 1)).some((line) => line.startsWith('drawImage'))).toBe(false);
  });
});

describe('photos in the project file (AV-1208, TD-071)', () => {
  it('keep names and placements, and nothing a camera wrote', () => {
    const settings: MapVideoSettings = {
      ...DEFAULT_MAP_VIDEO_SETTINGS,
      photos: photos({ holdSeconds: 4, clockOffsetSeconds: -90, items: [{ name: 'IMG_1.jpg', method: 'time' }, { name: 'IMG_3.png', method: 'hand', handMeters: 2200 }] }),
    };
    const json = serializeMapVideoProject({ activity: { fileName: null, points: 2 }, settings });
    const reopened = parseMapVideoProject(json);
    expect(reopened.ok && reopened.project.settings.photos).toEqual(settings.photos);
    // The model's inputs (time taken, position) never reach it: the settings have no field for them.
    expect(json).not.toMatch(/takenAt|"lat"|"lon"|2026-/);
  });

  it('refuses a placement it cannot read, by name', () => {
    const file = JSON.stringify({ kind: 'opentrack-map-video', version: 1, activity: { fileName: null, points: 2 }, settings: { photos: { items: [{ name: 'a.jpg', method: 'teleport' }] } } });
    expect(parseMapVideoProject(file)).toEqual({ ok: false, error: expect.stringContaining('settings.photos.items[0].method') });
  });
});

describe('fixes from the M10 review (TD-073)', () => {
  it('leaves out a photo from the trimmed side of a gap, though it shares its distance with the kept side', () => {
    const points: TestPoint[] = [
      ...straightNorth(500, 10, 5).map((point) => ({ ...point, segment: 0 })),
      ...straightNorth(500, 10, 5).map((point) => ({ north: 3000 + point.north, east: 0, second: 1000 + point.second!, segment: 1 })),
    ];
    const gapped = activityThrough(points);
    const route = buildMapVideoRoute(gapped)!;
    const gap = route.vertices[50]!.distance;
    // Taken at the first segment's very end, which the trim removes: the start is cut exactly at the gap.
    const built = buildMapVideoModel(gapped, { ...DEFAULT_MAP_VIDEO_SETTINGS, privacyTrim: { startMeters: gap, endMeters: 0 } }, [
      { id: 'p', name: 'p', takenAt: T0 + 100_000 },
    ]);
    expect(built.ok && built.model.photos[0]!.reason).toMatch(/privacy trim hides/);
  });

  it('shows two photos taken at one place one after the other', () => {
    const model = modelWith([{ id: 'a', name: 'a', takenAt: T0 + 120_000 }, { id: 'b', name: 'b', takenAt: T0 + 120_000 }]);
    const [a, b] = model.timeline.holds;
    expect(b!.startSeconds).toBeCloseTo(a!.endSeconds, 9);
    expect(model.at(model.timeline.introSeconds + a!.startSeconds + 1).sample.photo?.id).toBe('a');
    expect(model.at(model.timeline.introSeconds + b!.startSeconds + 1).sample.photo?.id).toBe('b');
  });

  it('shows three photos at the start one after another, none over another (Fable review)', () => {
    const model = modelWith(['a', 'b', 'c'].map((id) => ({ id, name: id, takenAt: T0 })));
    const holds = [...model.timeline.holds].sort((x, y) => x.startSeconds - y.startSeconds);
    expect(holds.map((hold) => hold.id)).toEqual(['a', 'b', 'c']);
    expect(holds[1]!.startSeconds).toBeCloseTo(holds[0]!.endSeconds, 9);
    expect(holds[2]!.startSeconds).toBeCloseTo(holds[1]!.endSeconds, 9);
    for (const hold of holds) expect(model.at(model.timeline.introSeconds + hold.startSeconds + 1).sample.photo?.id).toBe(hold.id);
  });

  it('keeps a photo taken while standing at the start, with no trim at all (Fable review)', () => {
    // Four fixes in one place before setting off: the route's first vertices all sit at 0 m.
    const points: TestPoint[] = [0, 1, 2, 3].map((second) => ({ north: 0, east: 0, second }));
    for (const point of straightNorth(1000, 10, 5).slice(1)) points.push({ ...point, second: 3 + point.second! });
    const standing = activityThrough(points);
    const built = buildMapVideoModel(standing, DEFAULT_MAP_VIDEO_SETTINGS, [{ id: 'p', name: 'p', takenAt: T0 + 2_000 }]);
    if (!built.ok) throw new Error(built.error);
    expect(built.model.photos[0]).toMatchObject({ method: 'time', distance: 0 });
    expect(built.model.photos[0]!.reason).toBeUndefined();
  });

  it('lengthens a shortened stop by a photo shown within it', () => {
    const points: TestPoint[] = straightNorth(1500, 10, 5);
    const stop = points[points.length - 1]!.second!;
    // Standing, the fixes drift a centimetre a second (far under the 0.5 m/s of moving): a photo mid-stop lands mid-beat.
    for (let s = 5; s <= 300; s += 5) points.push({ north: 1500 + s / 100, east: 0, second: stop + s });
    for (const point of straightNorth(1500, 10, 5).slice(1)) points.push({ north: 1503 + point.north, east: 0, second: stop + 300 + point.second! });
    const stopped = activityThrough(points);
    // Taken during the stop, two and a half minutes in.
    const built = buildMapVideoModel(stopped, { ...DEFAULT_MAP_VIDEO_SETTINGS, timing: { mode: 'time', pauseBeatSeconds: 1 } }, [{ id: 'p', name: 'p', takenAt: T0 + (stop + 150) * 1000 }]);
    if (!built.ok) throw new Error(built.error);
    const [pause] = built.model.timeline.pauses;
    const [hold] = built.model.timeline.holds;
    expect(hold!.startSeconds).toBeGreaterThan(pause!.startSeconds);
    expect(pause!.endSeconds).toBeGreaterThanOrEqual(hold!.endSeconds - 1e-9);
    // Through the photo the figures still hold the stop.
    expect(built.model.at(built.model.timeline.introSeconds + hold!.startSeconds + 1).sample.paused).toBe(true);
    expect(pause!.endSeconds - pause!.startSeconds).toBeCloseTo(1 + 3, 6);
  });

  it('saves every photo on the page by name, placed as it is, besides those named and not yet added', () => {
    const items = photoItemsForSave(photos({ items: [{ name: 'hand.jpg', method: 'hand', handMeters: 10 }, { name: 'waiting.jpg', method: 'time' }] }), [
      { id: '1', name: 'hand.jpg', method: 'hand', distance: 10 },
      { id: '2', name: 'auto.jpg', method: 'time', distance: 600 },
      { id: '3', name: 'far.jpg', method: 'position', reason: 'Taken 3 km from the route' },
    ]);
    expect(items).toEqual([
      { name: 'hand.jpg', method: 'hand', handMeters: 10 },
      { name: 'waiting.jpg', method: 'time' },
      { name: 'auto.jpg', method: 'time' },
      { name: 'far.jpg', method: 'position' },
    ]);
  });
});
