import { describe, expect, it } from 'vitest';
import { getChartAvailability, getVisibleCharts, VISIBLE_CHART_KINDS } from './charts';
import { makeActivity } from '../test/helpers/activity';
import type { Activity, ActivitySport } from './activity';

function makeRun(points: Parameters<typeof makeActivity>[0], sport: ActivitySport = 'running'): Activity {
  const activity = makeActivity(points);
  activity.metadata.sport = sport;
  return activity;
}

const runPoints = [
  { lat: 0, lon: 0.0001, elevationMeters: 10, cadenceRpm: 170, time: new Date('2024-01-01T10:00:00Z') },
  { lat: 0.01, lon: 0.0001, elevationMeters: 20, cadenceRpm: 172, time: new Date('2024-01-01T10:05:00Z') },
];

const availabilityOf = (activity: Activity, kind: string) =>
  getChartAvailability(activity).find((entry) => entry.kind === kind)!;

describe('getChartAvailability (AV-507)', () => {
  it('offers elevation whenever elevation data exists', () => {
    expect(availabilityOf(makeRun(runPoints), 'elevation').available).toBe(true);
    expect(
      availabilityOf(makeRun([{ lat: 0, lon: 0.0001 }, { lat: 0.01, lon: 0.0001 }]), 'elevation'),
    ).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/elevation/i) });
  });

  it('offers pace only for runs with usable distance and time', () => {
    expect(availabilityOf(makeRun(runPoints), 'pace').available).toBe(true);

    // Same data, different sport.
    expect(availabilityOf(makeRun(runPoints, 'cycling'), 'pace')).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/running/i),
    });

    // A run with no timestamps cannot produce pace.
    const noTime = makeRun([
      { lat: 0, lon: 0.0001, elevationMeters: 10 },
      { lat: 0.01, lon: 0.0001, elevationMeters: 20 },
    ]);
    expect(availabilityOf(noTime, 'pace')).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/distance and timestamps/i),
    });
  });

  it('offers cadence only for runs that recorded it', () => {
    expect(availabilityOf(makeRun(runPoints), 'cadence').available).toBe(true);

    const noCadence = makeRun([
      { lat: 0, lon: 0.0001, time: new Date('2024-01-01T10:00:00Z') },
      { lat: 0.01, lon: 0.0001, time: new Date('2024-01-01T10:05:00Z') },
    ]);
    expect(availabilityOf(noCadence, 'cadence')).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/no cadence data/i),
    });
  });

  it('reports the x-axis modes each chart supports', () => {
    const entry = availabilityOf(makeRun(runPoints), 'elevation');

    expect(entry.supportedXAxisModes).toEqual(['distance', 'time']);
    expect(entry.defaultXAxisMode).toBe('distance');
  });

  it('defaults to the time axis when distance is unavailable', () => {
    const indoor = makeRun([
      { cadenceRpm: 170, time: new Date('2024-01-01T10:00:00Z') },
      { cadenceRpm: 172, time: new Date('2024-01-01T10:05:00Z') },
    ]);

    expect(availabilityOf(indoor, 'cadence').defaultXAxisMode).toBe('time');
    expect(availabilityOf(indoor, 'cadence').supportedXAxisModes).toEqual(['time']);
  });

  it('decides from the normalized activity, not the source format', () => {
    const asFit = makeRun(runPoints);
    asFit.source.format = 'fit';

    expect(getChartAvailability(asFit).map((entry) => entry.available)).toEqual(
      getChartAvailability(makeRun(runPoints)).map((entry) => entry.available),
    );
  });
});

describe('getVisibleCharts', () => {
  it('returns the guardrail set in display order', () => {
    expect(getVisibleCharts(makeRun(runPoints)).map((entry) => entry.kind)).toEqual(
      VISIBLE_CHART_KINDS,
    );
  });

  it('keeps unavailable charts so the UI can explain them', () => {
    const charts = getVisibleCharts(makeRun(runPoints, 'cycling'));

    expect(charts).toHaveLength(3);
    expect(charts.find((entry) => entry.kind === 'pace')?.available).toBe(false);
  });
});
