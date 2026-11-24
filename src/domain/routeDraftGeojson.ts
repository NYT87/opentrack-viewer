import type { Feature, FeatureCollection, LineString, Point, Position } from 'geojson';
import type { DraftPoint } from './routeDraft';

/**
 * AV-1104. Map data for a draft: a line per segment, and one dot per point.
 *
 * Separate from `activityToRouteGeoJSON` because an editor needs every point
 * addressable by its position in the draft (to select, drag and delete it),
 * and because it must be cheap enough to rebuild on every pointer move while a
 * point is being dragged.
 */
export function draftLineGeoJSON(points: readonly DraftPoint[]): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  let run: Position[] = [];
  let segment: number | undefined;

  const flush = () => {
    // One coordinate draws nothing; the dot layer shows it.
    if (run.length >= 2) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: run },
      });
    }
    run = [];
  };

  for (const point of points) {
    if (segment !== undefined && point.segmentIndex !== segment) flush();
    segment = point.segmentIndex;
    run.push([point.lon, point.lat]);
  }
  flush();

  return { type: 'FeatureCollection', features };
}

export interface DraftDotProperties {
  /** Position in the draft. */
  index: number;
  selected: boolean;
  /** First or last point, drawn distinctly so the direction of travel is clear. */
  endpoint: boolean;
}

export function draftPointsGeoJSON(
  points: readonly DraftPoint[],
  selectedIndex?: number,
): FeatureCollection<Point, DraftDotProperties> {
  return {
    type: 'FeatureCollection',
    features: points.map((point, index) => ({
      type: 'Feature',
      properties: {
        index,
        selected: index === selectedIndex,
        endpoint: index === 0 || index === points.length - 1,
      },
      geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    })),
  };
}

/** `[west, south, east, north]`, or undefined for an empty draft. */
export function draftBounds(
  points: readonly DraftPoint[],
): [number, number, number, number] | undefined {
  if (points.length === 0) return undefined;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const point of points) {
    west = Math.min(west, point.lon);
    east = Math.max(east, point.lon);
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
  }
  return [west, south, east, north];
}
