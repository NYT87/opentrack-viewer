import type { MapVideoRoute } from './route';
import { timeModeRefusal } from './timing';

/**
 * AV-1208. The reader's photos along the route: each placed by when it was
 * taken against the activity's clock, by where it was taken, or by hand; and
 * held on screen while the marker waits there.
 *
 * What a photo's EXIF says (its time and position) is used here and kept in
 * memory only. The project holds a photo's name, how it is placed and, for
 * one placed by hand, how far along the route: nothing the camera wrote
 * (TD-071).
 */

export type PhotoPlacementMethod = 'time' | 'position' | 'hand';
export const PHOTO_PLACEMENT_METHODS: readonly PhotoPlacementMethod[] = ['time', 'position', 'hand'];

/** A photo as the page read it, in memory: never written anywhere. */
export interface PhotoInput {
  id: string;
  name: string;
  /** When it was taken, in UTC milliseconds, before the camera clock offset. */
  takenAt?: number;
  lat?: number;
  lon?: number;
  /** Why it could not be decoded, when it could not. */
  decodeError?: string;
}

/** How the reader placed a photo, kept in the project by its name. */
export interface PhotoSetting {
  name: string;
  method: PhotoPlacementMethod;
  /** For one placed by hand: metres along the route as recorded, before the privacy trim. */
  handMeters?: number;
}

export interface PhotosSettings {
  /** Seconds each photo is shown while the marker waits. */
  holdSeconds: number;
  /** Seconds the camera's clock was ahead of the activity's (behind, if negative). */
  clockOffsetSeconds: number;
  items: PhotoSetting[];
}

export const DEFAULT_PHOTOS_SETTINGS: PhotosSettings = { holdSeconds: 3, clockOffsetSeconds: 0, items: [] };
export const PHOTO_LIMITS = { holdSeconds: [1, 10] as const, clockOffsetSeconds: [-86_400, 86_400] as const, maxPhotos: 100 };
/** A photo taken further than this from the route is not placed by its position. */
export const MAX_PHOTO_DISTANCE_METERS = 200;

export interface PhotoPlacement {
  id: string;
  name: string;
  method: PhotoPlacementMethod;
  /** Metres along the shown (trimmed) route; absent when the photo is left out. */
  distance?: number;
  /** Why it is left out. */
  reason?: string;
}

/** The method a photo is placed by: the reader's, else its time, else its position, else by hand. */
export function photoMethod(photo: PhotoInput, setting: PhotoSetting | undefined): PhotoPlacementMethod {
  if (setting) return setting.method;
  if (photo.takenAt !== undefined) return 'time';
  if (photo.lat !== undefined && photo.lon !== undefined) return 'position';
  return 'hand';
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** Metres along the route at a moment, or why there is no such place. */
function distanceAtTime(route: MapVideoRoute, at: number): number | string {
  if (timeModeRefusal(route)) return 'The activity has no clock to place it by: place it by position or by hand.';
  const { vertices } = route;
  const first = vertices[0]!.time!;
  const last = vertices[vertices.length - 1]!.time!;
  if (at < first || at > last) {
    return `Taken at ${clock(at)} UTC, outside the activity (${clock(first)}–${clock(last)} UTC). Set the camera clock offset, or place it by position or by hand.`;
  }
  let lo = 0;
  let hi = vertices.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (vertices[mid]!.time! <= at) lo = mid;
    else hi = mid;
  }
  const a = vertices[lo]!;
  const b = vertices[hi]!;
  const span = b.time! - a.time!;
  return span > 0 ? a.distance + ((b.distance - a.distance) * (at - a.time!)) / span : a.distance;
}

/** Metres along the route nearest a place, or why it is too far from it. */
function distanceAtPlace(route: MapVideoRoute, lat: number, lon: number): number | string {
  const { vertices } = route;
  const cos = Math.cos((lat * Math.PI) / 180);
  const toLocal = (vertex: { lat: number; lon: number }) => [(vertex.lon - lon) * 111_320 * cos, (vertex.lat - lat) * 110_574] as const;
  let best = Infinity;
  let along = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const b = vertices[i + 1];
    const [ax, ay] = toLocal(a);
    if (!b || b.segment !== a.segment) {
      const d = Math.hypot(ax, ay);
      if (d < best) [best, along] = [d, a.distance];
      continue;
    }
    const [bx, by] = toLocal(b);
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) [best, along] = [d, a.distance + t * (b.distance - a.distance)];
  }
  if (best > MAX_PHOTO_DISTANCE_METERS) {
    const away = best >= 1000 ? `${(best / 1000).toFixed(1)} km` : `${Math.round(best)} m`;
    return `Taken ${away} from the route: place it by time or by hand.`;
  }
  return along;
}

/**
 * Where each photo goes, on the route as recorded (`full`), then on the route
 * as shown: `trimStart` metres in, `shownMeters` long. A photo in a trimmed
 * stretch is left out, so the trim hides it too.
 */
export function placePhotos(
  photos: PhotoInput[],
  settings: PhotosSettings,
  full: MapVideoRoute,
  trimStart: number,
  shownMeters: number,
): PhotoPlacement[] {
  return photos.map((photo): PhotoPlacement => {
    const setting = settings.items.find((item) => item.name === photo.name);
    const method = photoMethod(photo, setting);
    const out = (reason: string): PhotoPlacement => ({ id: photo.id, name: photo.name, method, reason });
    if (photo.decodeError) return out(photo.decodeError);
    let along: number | string;
    if (method === 'time') {
      along =
        photo.takenAt === undefined
          ? 'It records no time taken: place it by position or by hand.'
          : distanceAtTime(full, photo.takenAt - settings.clockOffsetSeconds * 1000);
    } else if (method === 'position') {
      along =
        photo.lat === undefined || photo.lon === undefined
          ? 'It records no position: place it by time or by hand.'
          : distanceAtPlace(full, photo.lat, photo.lon);
    } else {
      along = setting?.handMeters === undefined ? 'Not placed yet: choose where on the route it goes.' : Math.min(full.totalMeters, Math.max(0, setting.handMeters));
    }
    if (typeof along === 'string') return out(along);
    const shown = along - trimStart;
    if (shown < 0 || shown > shownMeters) return out('It falls in a stretch the privacy trim hides, so it is left out too.');
    return { id: photo.id, name: photo.name, method, distance: shown };
  });
}
