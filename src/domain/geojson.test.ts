import { describe, expect, it } from 'vitest';
import { activityToRouteGeoJSON, pointToGeoJSON } from './geojson';
import { makeActivity } from '../test/helpers/activity';

describe('activityToRouteGeoJSON (AV-301)', () => {
  it('builds a LineString from valid points in [lon, lat] order', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.1 },
        { lat: 51.6, lon: -0.2 },
        { lat: 51.7, lon: -0.3 },
      ]),
    );

    expect(route.isEmpty).toBe(false);
    expect(route.featureCollection.features).toHaveLength(1);
    expect(route.featureCollection.features[0]?.geometry.coordinates).toEqual([
      [-0.1, 51.5],
      [-0.2, 51.6],
      [-0.3, 51.7],
    ]);
    expect(route.featureCollection.features[0]?.properties.pointCount).toBe(3);
  });

  it('computes bounds as [west, south, east, north]', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.3 },
        { lat: 51.9, lon: 0.2 },
      ]),
    );

    expect(route.bounds).toEqual([-0.3, 51.5, 0.2, 51.9]);
  });

  it('skips invalid points and maps coordinates back to point indices', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.1 },
        { elevationMeters: 12 },
        { lat: 200, lon: -0.2 },
        { lat: 51.7, lon: -0.3 },
      ]),
    );

    expect(route.featureCollection.features[0]?.geometry.coordinates).toHaveLength(2);
    expect(route.sourceIndices).toEqual([[0, 3]]);
  });

  it('drops Null Island coordinates', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([{ lat: 0, lon: 0 }, { lat: 51.5, lon: -0.1 }, { lat: 51.6, lon: -0.2 }]),
    );

    expect(route.sourceIndices).toEqual([[1, 2]]);
  });

  it('returns an empty result for an activity with no location', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([{ elevationMeters: 10 }, { elevationMeters: 20 }]),
    );

    expect(route.isEmpty).toBe(true);
    expect(route.featureCollection.features).toHaveLength(0);
    expect(route.bounds).toBeUndefined();
  });

  it('treats a single located point as empty but keeps its bounds', () => {
    const route = activityToRouteGeoJSON(makeActivity([{ lat: 51.5, lon: -0.1 }]));

    expect(route.isEmpty).toBe(true);
    expect(route.bounds).toEqual([-0.1, 51.5, -0.1, 51.5]);
  });
});

describe('segment boundaries (AV-301)', () => {
  const twoSegments = () =>
    makeActivity([
      { lat: 51.5, lon: -0.1, segmentIndex: 0 },
      { lat: 51.51, lon: -0.1, segmentIndex: 0 },
      // A long way away: the recording was stopped in between.
      { lat: 48.85, lon: 2.35, segmentIndex: 1 },
      { lat: 48.86, lon: 2.35, segmentIndex: 1 },
    ]);

  it('draws one line per segment instead of joining them', () => {
    // Regression: a single LineString drew a straight line across the gap,
    // implying a route that was never travelled.
    const route = activityToRouteGeoJSON(twoSegments());

    expect(route.featureCollection.features).toHaveLength(2);
    expect(route.featureCollection.features[0]?.geometry.coordinates).toEqual([
      [-0.1, 51.5],
      [-0.1, 51.51],
    ]);
    expect(route.featureCollection.features[1]?.geometry.coordinates).toEqual([
      [2.35, 48.85],
      [2.35, 48.86],
    ]);
  });

  it('maps each feature back to its own activity point indices', () => {
    const route = activityToRouteGeoJSON(twoSegments());

    expect(route.sourceIndices).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(route.featureCollection.features[1]?.properties.segmentIndex).toBe(1);
    expect(route.featureCollection.features[1]?.properties.featureIndex).toBe(1);
  });

  it('still bounds the whole activity', () => {
    expect(activityToRouteGeoJSON(twoSegments()).bounds).toEqual([-0.1, 48.85, 2.35, 51.51]);
  });

  it('drops a segment that has only one located point', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.1, segmentIndex: 0 },
        { lat: 51.51, lon: -0.1, segmentIndex: 0 },
        { lat: 48.85, lon: 2.35, segmentIndex: 1 },
      ]),
    );

    expect(route.featureCollection.features).toHaveLength(1);
    // ...but it still counts towards the bounds, so the map shows where it was.
    expect(route.bounds).toEqual([-0.1, 48.85, 2.35, 51.51]);
  });

  it('treats points without a segment index as one continuous run', () => {
    const route = activityToRouteGeoJSON(
      makeActivity([
        { lat: 51.5, lon: -0.1 },
        { lat: 51.51, lon: -0.1 },
      ]),
    );

    expect(route.featureCollection.features).toHaveLength(1);
  });
});

describe('pointToGeoJSON', () => {
  it('wraps a located point in a single-feature collection', () => {
    const activity = makeActivity([{ lat: 51.5, lon: -0.1 }]);
    const collection = pointToGeoJSON(activity.points[0]);

    expect(collection.features[0]?.geometry.coordinates).toEqual([-0.1, 51.5]);
    expect(collection.features[0]?.properties.index).toBe(0);
  });

  it('returns an empty collection for undefined or unlocated points', () => {
    expect(pointToGeoJSON(undefined).features).toHaveLength(0);
    expect(pointToGeoJSON({ index: 0 }).features).toHaveLength(0);
  });
});
