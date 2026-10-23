import { describe, expect, it } from 'vitest';
import { activityTitle } from './activityTitle';
import { makeActivity } from '../test/helpers/activity';

const named = (name: string | undefined, extra: Partial<ReturnType<typeof makeActivity>['metadata']> = {}) => {
  const activity = makeActivity([{ lat: 0, lon: 0 }]);
  activity.metadata = { ...activity.metadata, name, ...extra };
  return activity;
};

describe('activityTitle', () => {
  it('keeps a name the file gave', () => {
    expect(activityTitle(named('Morning loop'))).toBe('Morning loop');
  });

  it('reads a name that is only a timestamp as the date it is, with the sport', () => {
    const title = activityTitle(named('2024-05-01T07:00:00Z', { sport: 'running' }), 'en-GB');
    expect(title).toMatch(/^Run on 1 May 2024, \d{2}:\d{2}$/);
    expect(title).not.toContain('T07');
  });

  it('says activity when the sport is not known', () => {
    expect(activityTitle(named('2024-05-01T07:00:00Z'), 'en-GB')).toMatch(/^Activity on 1 May 2024/);
  });

  it('uses the start time when there is no name, and stays untitled with neither', () => {
    expect(activityTitle(named(undefined, { sport: 'cycling', startTime: new Date('2024-06-02T09:30:00Z') }), 'en-GB')).toMatch(
      /^Ride on 2 Jun 2024/,
    );
    expect(activityTitle(named(undefined, { startTime: undefined }))).toBe('Untitled activity');
  });
});
