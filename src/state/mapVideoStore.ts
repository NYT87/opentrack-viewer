import { create } from 'zustand';
import { hasValidLocation, type Activity } from '../domain/activity';
import { ActivityError } from '../domain/errors';

/**
 * Where the map video's activity came from: a file chosen on the page, or a
 * handoff from the viewer, Route Builder or the video telemetry page. Said
 * beside the activity, so the reader knows why it is there.
 */
export type MapVideoActivityOrigin = 'hand' | 'viewer' | 'routeBuilder' | 'videoTelemetry';

/**
 * What the map is drawn on: an online basemap, whose tile server learns which
 * area is shown, or the route alone, which fetches nothing (TD-064).
 */
export type MapVideoBasemap = 'online' | 'route-only';

interface MapVideoState {
  activity?: Activity;
  origin?: MapVideoActivityOrigin;
  /**
   * Undefined until the reader chooses; the page then follows the app's
   * basemap setting, so someone who turned tiles off is not opted back in.
   */
  basemap?: MapVideoBasemap;
  setActivity: (activity: Activity, origin: MapVideoActivityOrigin) => void;
  setBasemap: (basemap: MapVideoBasemap) => void;
  clear: () => void;
}

/**
 * AV-1202. The map video page's own store, beside the viewer's and the overlay
 * page's (TD-040): closing the viewer's activity does not take a map video's
 * with it. In memory only, like every handoff (§5); a reload leaves it empty
 * and the page asks for a file.
 */
export const useMapVideoStore = create<MapVideoState>((set) => ({
  setActivity: (activity, origin) => set({ activity, origin }),
  setBasemap: (basemap) => set({ basemap }),
  // The basemap is the reader's choice, not the file's: it stays.
  clear: () => set({ activity: undefined, origin: undefined }),
}));

/**
 * Why an activity cannot become a map video, or undefined when it can. The
 * camera follows a line, so at least two located points are needed: a single
 * fix is a place, not a route.
 */
export function mapVideoRefusal(activity: Activity): ActivityError | undefined {
  let located = 0;
  for (const point of activity.points) {
    if (hasValidLocation(point) && ++located >= 2) return undefined;
  }
  return located === 0
    ? new ActivityError('no_location_stream', 'This activity has no GPS coordinates, so there is no route to follow.')
    : new ActivityError('no_location_stream', 'This activity has only one point with a location, so there is no route to follow.');
}
