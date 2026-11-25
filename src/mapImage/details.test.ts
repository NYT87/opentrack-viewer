import { describe, expect, it } from 'vitest';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';
import { makeActivity } from '../test/helpers/activity';
import { mapImageDetailChoices, mapImagePanelContent } from './details';

const hilly = activityThrough(straightNorth(5000, 20, 5).map((point) => ({ ...point, elevation: 100 + point.north / 50 })));
const flat = activityThrough(straightNorth(5000, 20, 5));

describe('the map image’s details (AV-1013)', () => {
  it('offers a detail the activity lacks disabled, with the reason', () => {
    const choices = mapImageDetailChoices({ activity: flat, shown: flat, units: 'metric', readerTimeZone: 'UTC' });
    const of = (detail: string) => choices.find((choice) => choice.detail === detail)!;
    expect(of('distance').available).toBe(true);
    expect(of('date').available).toBe(true);
    expect(of('heartRate')).toMatchObject({ available: false, reason: expect.stringContaining('heart rate') });
    expect(of('profile')).toMatchObject({ available: false, reason: expect.stringContaining('elevation') });
    expect(of('climb').available).toBe(false);
    const unnamed = { ...flat, metadata: { ...flat.metadata, name: '  ' } };
    expect(mapImageDetailChoices({ activity: unnamed, shown: unnamed, units: 'metric' }).find((choice) => choice.detail === 'name')!.available).toBe(false);
    const untimed = makeActivity([{ lat: 46, lon: 7 }, { lat: 46.01, lon: 7 }]);
    expect(mapImageDetailChoices({ activity: untimed, shown: untimed, units: 'metric' }).find((choice) => choice.detail === 'date')!.available).toBe(false);
  });

  it('holds the chosen details in the panel’s order, in the reader’s units, and leaves out what the activity lacks', () => {
    const content = mapImagePanelContent(['pace', 'heartRate', 'distance', 'name', 'date', 'profile'], { activity: hilly, shown: hilly, units: 'imperial', readerTimeZone: 'UTC' });
    expect(content.title).toBe('Test activity');
    expect(content.date).toBe('Tuesday 10 November 2026, 08:00');
    expect(content.figures.map((figure) => figure.caption)).toEqual(['Distance', 'Avg pace']);
    expect(content.figures[0]!.value).toMatch(/mi$/);
    expect(content.profile).toBe(true);
  });

  it('dates the activity in its own time where the file says it', () => {
    const offset = { ...hilly, metadata: { ...hilly.metadata, utcOffsetMinutes: 120 } };
    expect(mapImagePanelContent(['date'], { activity: offset, shown: offset, units: 'metric', readerTimeZone: 'UTC' }).date).toBe('Tuesday 10 November 2026, 10:00');
  });

  it('reads the profile from the stretch the trim leaves: none there, none offered', () => {
    const flatShown = activityThrough(straightNorth(1000, 20, 5));
    const choices = mapImageDetailChoices({ activity: hilly, shown: flatShown, units: 'metric' });
    expect(choices.find((choice) => choice.detail === 'profile')!.available).toBe(false);
  });
});
