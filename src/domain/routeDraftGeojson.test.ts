import { describe, expect, it } from 'vitest';
import { draftBounds, draftLineGeoJSON, draftPointsGeoJSON } from './routeDraftGeojson';

const p = (lat: number, lon: number, segmentIndex = 0) => ({ lat, lon, segmentIndex });

describe('draft map data (AV-1104)', () => {
  it('draws one line per segment, longitude first', () => {
    const lines = draftLineGeoJSON([p(1, 2), p(3, 4), p(5, 6, 1), p(7, 8, 1)]);
    expect(lines.features.map((f) => f.geometry.coordinates)).toEqual([
      [[2, 1], [4, 3]],
      [[6, 5], [8, 7]],
    ]);
  });

  it('draws no line for fewer than two points', () => {
    expect(draftLineGeoJSON([]).features).toEqual([]);
    expect(draftLineGeoJSON([p(1, 2)]).features).toEqual([]);
    // A lone point between two segments is a dot, not a line.
    expect(draftLineGeoJSON([p(1, 2), p(3, 4, 1), p(5, 6, 2), p(7, 8, 2)]).features).toHaveLength(1);
  });

  it('gives every point its position, selection and endpoint state', () => {
    const dots = draftPointsGeoJSON([p(1, 2), p(3, 4), p(5, 6)], 1);
    expect(dots.features.map((f) => f.properties)).toEqual([
      { index: 0, selected: false, endpoint: true },
      { index: 1, selected: true, endpoint: false },
      { index: 2, selected: false, endpoint: true },
    ]);
  });

  it('bounds the draft', () => {
    expect(draftBounds([])).toBeUndefined();
    expect(draftBounds([p(1, 2), p(5, -3)])).toEqual([-3, 1, 2, 5]);
  });
});
