import { describe, expect, it } from 'vitest';
import { assertUsableActivity, validateActivity } from './validation';
import { makeActivity } from '../test/helpers/activity';
import { ActivityError } from './errors';

describe('validateActivity', () => {
  it('accepts a GPS activity with no warnings about location', () => {
    const result = validateActivity(
      makeActivity([
        { lat: 51.5, lon: -0.1, elevationMeters: 10, time: new Date('2024-01-01T10:00:00Z') },
        { lat: 51.6, lon: -0.2, elevationMeters: 20, time: new Date('2024-01-01T10:10:00Z') },
      ]),
    );

    expect(result.isUsable).toBe(true);
    expect(result.canRenderRoute).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('keeps a non-GPS activity usable but unmappable', () => {
    const result = validateActivity(
      makeActivity([
        { heartRateBpm: 120, time: new Date('2024-01-01T10:00:00Z') },
        { heartRateBpm: 140, time: new Date('2024-01-01T10:01:00Z') },
      ]),
    );

    expect(result.isUsable).toBe(true);
    expect(result.canRenderRoute).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain('no_location_stream');
  });

  it('rejects an activity with no points', () => {
    expect(validateActivity(makeActivity([])).isUsable).toBe(false);
  });
});

describe('assertUsableActivity', () => {
  it('throws no_route_points for an empty activity', () => {
    try {
      assertUsableActivity(makeActivity([]));
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ActivityError);
      expect((error as ActivityError).code).toBe('no_route_points');
    }
  });

  it('throws when points carry no usable stream at all', () => {
    try {
      assertUsableActivity(makeActivity([{ runningCadenceSpm: 80 }]));
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as ActivityError).code).toBe('no_route_points');
    }
  });
});
