import { describe, expect, it } from 'vitest';
import {
  defaultPerformanceMetric,
  isAmbiguousSport,
  isPerformanceMetricSelectable,
  resolvePerformanceMetric,
} from './performance';
import { makeActivity } from '../test/helpers/activity';
import type { ActivitySport } from './activity';

/** A minute of movement: enough for both a speed and a pace to exist. */
const moving = (sport?: ActivitySport) => {
  // Not starting at (0, 0): the app treats Null Island as a device artefact
  // rather than a place, so a point there never enters the distance at all.
  const activity = makeActivity([
    { lat: 41.3874, lon: 2.1686, time: new Date('2024-01-01T10:00:00Z') },
    { lat: 41.3924, lon: 2.1686, time: new Date('2024-01-01T10:01:00Z') },
  ]);
  activity.metadata.sport = sport;
  return activity;
};

describe('which metric an activity shows (AV-908)', () => {
  it('reads a run in pace', () => {
    expect(defaultPerformanceMetric(moving('running'))).toBe('pace');
  });

  it('reads a ride in speed', () => {
    expect(defaultPerformanceMetric(moving('cycling'))).toBe('speed');
  });

  it('reads a video in speed, because a camera does not know the sport', () => {
    // What `parseGopro` produces: a moving track, and no claim about what was
    // moving. Speed means something for a bike, a pair of skis and a car.
    expect(defaultPerformanceMetric(moving('unknown'))).toBe('speed');
  });
});

describe('when the reader is offered the choice (AV-908)', () => {
  it('offers it where the file said nothing about the sport', () => {
    expect(isAmbiguousSport(moving('unknown'))).toBe(true);
    expect(isAmbiguousSport(moving(undefined))).toBe(true);

    expect(isPerformanceMetricSelectable(moving('unknown'))).toBe(true);
  });

  it('offers it for a sport this app does not model', () => {
    // `other` is not silence: a GPX `<type>kayaking</type>` said something,
    // and every TCX that is neither Running nor Biking lands here too. What
    // this app lacks is a convention for it, which is the same problem.
    expect(isAmbiguousSport(moving('other'))).toBe(true);
    expect(isPerformanceMetricSelectable(moving('other'))).toBe(true);
    expect(defaultPerformanceMetric(moving('other'))).toBe('speed');
  });

  it('does not re-ask a question the file already answered', () => {
    // A run reads in pace and a ride in speed as they always have. A control
    // offering to change that would appear on every activity that is not a
    // video, to no purpose.
    for (const sport of ['running', 'cycling', 'hiking', 'swimming'] as const) {
      expect(isPerformanceMetricSelectable(moving(sport))).toBe(false);
    }
  });

  it('does not offer pace to a recording that never went anywhere', () => {
    // Coordinates and timestamps throughout, and a total of zero. Pace's only
    // possible answer here is "no distance covered", which is not a mode worth
    // offering — speed's answer, 0 km/h, is a real one.
    const stationary = makeActivity([
      { lat: 41.3874, lon: 2.1686, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 41.3874, lon: 2.1686, time: new Date('2024-01-01T10:05:00Z') },
    ]);
    stationary.metadata.sport = 'unknown';

    expect(isPerformanceMetricSelectable(stationary)).toBe(false);
    expect(resolvePerformanceMetric(stationary, 'pace')).toBe('speed');
  });

  it('does not offer pace for an activity that cannot have one', () => {
    const noTime = makeActivity([
      { lat: 0, lon: 0 },
      { lat: 0.005, lon: 0 },
    ]);
    noTime.metadata.sport = 'unknown';

    expect(isPerformanceMetricSelectable(noTime)).toBe(false);
  });
});

describe('resolving the metric against a preference (AV-908)', () => {
  it('honours the choice for an activity that offers one', () => {
    expect(resolvePerformanceMetric(moving('unknown'), 'pace')).toBe('pace');
    expect(resolvePerformanceMetric(moving('unknown'), 'speed')).toBe('speed');
  });

  it('ignores a choice an activity does not offer', () => {
    // The preference is kept for the next file rather than cleared, exactly as
    // the chart x-axis preference is — so a run must not silently adopt it.
    expect(resolvePerformanceMetric(moving('running'), 'speed')).toBe('pace');
    expect(resolvePerformanceMetric(moving('cycling'), 'pace')).toBe('speed');
  });

  it('falls back to the sport when no choice was made', () => {
    expect(resolvePerformanceMetric(moving('unknown'))).toBe('speed');
    expect(resolvePerformanceMetric(moving('running'))).toBe('pace');
  });

  it('never touches the activity it is asked about', () => {
    const activity = moving('unknown');
    const before = JSON.stringify(activity);

    resolvePerformanceMetric(activity, 'pace');

    // TD-006: switching is a view decision, not a change to the file's data —
    // and for a video, nothing is re-read to answer it.
    expect(JSON.stringify(activity)).toBe(before);
  });
});
