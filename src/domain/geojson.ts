import type { Feature, FeatureCollection, LineString, Point, Position } from 'geojson';
import { hasValidLocation, type Activity, type ActivityPoint } from './activity';

/** Properties carried on each route line so map layers can style/identify it. */
export interface RouteLineProperties {
  activityId: string;
  name?: string;
  /** The recorded segment this line came from. */
  segmentIndex: number;
  /** Position of this feature in the collection, for hover lookups. */
  featureIndex: number;
  pointCount: number;
}

export interface RouteGeometry {
  featureCollection: FeatureCollection<LineString, RouteLineProperties>;
  /**
   * `sourceIndices[featureIndex][coordinateIndex]` is the index in
   * `activity.points` that produced that coordinate.
   */
  sourceIndices: number[][];
  bounds?: [number, number, number, number]; // [west, south, east, north]
  isEmpty: boolean;
}

const EMPTY_COLLECTION: FeatureCollection<LineString, RouteLineProperties> = {
  type: 'FeatureCollection',
  features: [],
};

interface SegmentRun {
  segmentIndex: number;
  coordinates: Position[];
  sourceIndices: number[];
}

/**
 * AV-301. Converts an activity's valid coordinates into one LineString per
 * recorded segment. Invalid points are skipped rather than failing the file,
 * and an activity with no location yields an explicitly empty (not broken)
 * result.
 *
 * Segments are kept apart deliberately (§17: "Should GPX route segments be
 * preserved visually or merged?"). Merging them would draw a straight line
 * across whatever happened while the recording was stopped — a road the athlete
 * never took.
 */
export function activityToRouteGeoJSON(activity: Activity): RouteGeometry {
  const runs: SegmentRun[] = [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let locatedCount = 0;

  for (const point of activity.points) {
    if (!hasValidLocation(point)) continue;
    locatedCount += 1;

    if (point.lon < west) west = point.lon;
    if (point.lon > east) east = point.lon;
    if (point.lat < south) south = point.lat;
    if (point.lat > north) north = point.lat;

    const segmentIndex = point.segmentIndex ?? 0;
    const current = runs[runs.length - 1];
    // A new run starts whenever the segment changes, so a boundary can never
    // end up inside a single LineString.
    if (!current || current.segmentIndex !== segmentIndex) {
      runs.push({ segmentIndex, coordinates: [[point.lon, point.lat]], sourceIndices: [point.index] });
    } else {
      current.coordinates.push([point.lon, point.lat]);
      current.sourceIndices.push(point.index);
    }
  }

  const bounds: [number, number, number, number] | undefined =
    locatedCount > 0 ? [west, south, east, north] : undefined;

  // A LineString needs at least two positions to be valid GeoJSON, so a
  // single-point segment contributes bounds but no line.
  const drawable = runs.filter((run) => run.coordinates.length >= 2);

  if (drawable.length === 0) {
    return { featureCollection: EMPTY_COLLECTION, sourceIndices: [], bounds, isEmpty: true };
  }

  const features: Feature<LineString, RouteLineProperties>[] = drawable.map((run, featureIndex) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: run.coordinates },
    properties: {
      activityId: activity.id,
      name: activity.metadata.name,
      segmentIndex: run.segmentIndex,
      featureIndex,
      pointCount: run.coordinates.length,
    },
  }));

  return {
    featureCollection: { type: 'FeatureCollection', features },
    sourceIndices: drawable.map((run) => run.sourceIndices),
    bounds,
    isEmpty: false,
  };
}

/** Single-point FeatureCollection used for the hover/selection marker (AV-602). */
export function pointToGeoJSON(
  point: ActivityPoint | undefined,
): FeatureCollection<Point, { index: number }> {
  if (!point || !hasValidLocation(point)) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        properties: { index: point.index },
      },
    ],
  };
}
