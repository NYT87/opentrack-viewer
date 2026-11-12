import { describe, expect, it } from 'vitest';
import {
  PREDEFINED_ENTRIES,
  START_LAYOUTS,
  componentsFromSportLayout,
  predefinedAvailability,
  predefinedEntry,
} from './predefined';
import { canvasElementChoices, canvasTemplate, componentsFromStart, newCanvasComponent, newCanvasComponents } from './customCanvas';
import { parseOverlayTemplate, serializeOverlayTemplate, type OverlayComponent, type OverlayRect } from './template';
import { buildOverlayTimeline } from './timeline';
import { extractRoute } from './routeImage';
import { makeActivity } from '../test/helpers/activity';
import type { Activity, ActivityPoint } from '../domain/activity';

const T0 = Date.parse('2026-09-24T08:00:00Z');
/** A full ride: positions, speed, power, both cadences, heart rate, grade and a climb. */
const full = (drop: (keyof ActivityPoint)[] = []): Activity =>
  makeActivity(
    Array.from({ length: 61 }, (_, i) => {
      const point: Partial<ActivityPoint> = {
        time: new Date(T0 + i * 1000),
        lat: 46 + (i * 5) / 111_320,
        lon: 7,
        elevationMeters: 100 + i,
        speedMetersPerSecond: 4 + 0.1 * i,
        powerWatts: 150 + 2 * i,
        cyclingCadenceRpm: 80 + (i % 5),
        runningCadenceSpm: 160,
        heartRateBpm: 120 + i / 2,
        gradePercent: 3 + (i % 3),
      };
      for (const key of drop) delete point[key];
      return point;
    }),
  );
const timelineOf = (activity: Activity) => buildOverlayTimeline(activity, { video: { durationSeconds: 60 } });
const still = (activity: Activity) => ({ activity, route: extractRoute(activity), units: 'metric' as const, readerTimeZone: 'UTC' });
const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
  { width: 1080, height: 1080 },
  // The most the canvas allows either way: 25.6:1 and 1:25.6.
  { width: 4096, height: 160 },
  { width: 160, height: 4096 },
];

const overlaps = (a: OverlayRect, b: OverlayRect) =>
  a.x < b.x + b.width - 1e-9 && b.x < a.x + a.width - 1e-9 && a.y < b.y + b.height - 1e-9 && b.y < a.y + a.height - 1e-9;

describe('the registry of predefined components (AV-1016)', () => {
  it('holds each entry once, by a stable id, with a sport, the data it needs and a reason', () => {
    const ids = PREDEFINED_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of PREDEFINED_ENTRIES) {
      expect(entry.id.startsWith(`${entry.sport}.`)).toBe(true);
      expect(['cycling', 'running', 'any']).toContain(entry.sport);
      // Something to say when the activity cannot supply it, unless it needs nothing.
      if (entry.needs.length > 0) expect(entry.missing).not.toBe('');
    }
    expect(PREDEFINED_ENTRIES.filter((entry) => entry.sport === 'cycling').map((entry) => entry.name)).toEqual([
      'Speed',
      'Speed gauge',
      'Power',
      'Power, 3 s average',
      'Cadence',
      'Gradient indicator',
      'Speedometer',
      'Cadence dial',
      'Power zones',
      'Heart rate zones',
      'Climb so far',
      'Elevation profile',
    ]);
    expect(PREDEFINED_ENTRIES.filter((entry) => entry.sport === 'running').map((entry) => entry.name)).toEqual([
      'Pace',
      'Heart rate',
      'Heart rate zones',
      'Running cadence',
      'Distance of the total',
    ]);
    expect(PREDEFINED_ENTRIES.filter((entry) => entry.sport === 'any').map((entry) => entry.name)).toEqual([
      'Speed against time',
      'Heart rate against time',
      'Compass',
      'Elevation profile',
      'Progress bar',
      'Route inset',
    ]);
  });

  it('builds valid components for every entry, at every shape, that survive a layout file', () => {
    const activity = full();
    const timeline = timelineOf(activity);
    for (const size of SIZES) {
      for (const entry of PREDEFINED_ENTRIES) {
        expect(predefinedAvailability(entry, timeline), entry.id).toBe(true);
        const built = entry.build(canvasTemplate([]), size, timeline);
        expect(built.length, entry.id).toBeGreaterThan(0);
        const template = canvasTemplate(built);
        for (const component of template.components) {
          expect(component.rect.x + component.rect.width, entry.id).toBeLessThanOrEqual(1 + 1e-9);
          expect(component.rect.y + component.rect.height, entry.id).toBeLessThanOrEqual(1 + 1e-9);
          expect(component.visible).toBe(true);
        }
        // What is saved reads back the same, with nothing dropped.
        expect(parseOverlayTemplate(serializeOverlayTemplate(template)), entry.id).toEqual({ ok: true, template, warnings: [] });
      }
    }
  });

  it('gives each entry its default look and smoothing', () => {
    const timeline = timelineOf(full());
    const one = (id: string) => predefinedEntry(id)!.build(canvasTemplate([]), SIZES[0]!, timeline)[0]!;
    const window = (id: string) => one(id).smoothing?.windowSeconds;
    expect(window('cycling.speed')).toBe(2);
    expect(window('cycling.speed-gauge')).toBe(2);
    expect(window('cycling.power')).toBeUndefined();
    expect(window('cycling.power-3s')).toBe(3);
    expect(window('cycling.cadence')).toBe(3);
    expect(window('cycling.gradient')).toBe(5);
    expect(window('running.pace')).toBe(5);
    expect(window('running.cadence')).toBe(3);
    expect(window('running.heart-rate')).toBeUndefined();
    // Totals are never smoothed.
    expect(window('cycling.climb')).toBeUndefined();
    expect(window('running.distance-total')).toBeUndefined();
    expect(one('cycling.power-3s').display?.label).toBe('Power 3s');
    // AV-1019. The gradient indicator replaces the plain figure under its id; the dials, charts and the compass join it.
    expect(one('cycling.gradient')).toMatchObject({ type: 'gradient', source: { metric: 'grade' } });
    expect(window('cycling.speedometer')).toBe(2);
    expect(window('cycling.cadence-dial')).toBe(3);
    expect(window('any.compass')).toBe(3);
    expect(one('cycling.speedometer')).toMatchObject({ type: 'dial', source: { metric: 'speed' } });
    expect(one('cycling.cadence-dial')).toMatchObject({ type: 'dial', source: { metric: 'cyclingCadence' }, display: { label: 'Cadence' } });
    expect(one('any.speed-chart')).toMatchObject({ type: 'chart', source: { metric: 'speed' }, chart: { axis: 'time' } });
    expect(one('any.heart-rate-chart')).toMatchObject({ type: 'chart', source: { metric: 'heartRate' } });
    expect(one('any.compass')).toMatchObject({ type: 'compass', source: { metric: 'heading' }, compass: { style: 'rose', labels: true } });
    expect(window('any.speed-chart')).toBeUndefined();
    expect(one('running.distance-total').display?.ofTotal).toBe(true);
    expect(one('cycling.speed-gauge')).toMatchObject({ type: 'gauge', source: { metric: 'speed' } });
    // The gauge's range comes from the activity's top speed, as a plain gauge's does.
    expect(one('cycling.speed-gauge').range).toEqual(newCanvasComponent(canvasTemplate([]), 'gauge:speed', SIZES[0]!, timeline).range);
    // AV-1018. Zones: their own zones, power smoothed over 3 s and heart rate not at all.
    expect(window('cycling.power-zones')).toBe(3);
    expect(window('cycling.heart-rate-zones')).toBeUndefined();
    expect(window('running.heart-rate-zones')).toBeUndefined();
    expect(one('cycling.power-zones')).toMatchObject({ type: 'zones', source: { metric: 'power' }, zones: { source: 'power', basis: 'percent', shape: 'horizontal' } });
    expect(one('cycling.power-zones').zones!.zones).toHaveLength(7);
    expect(one('running.heart-rate-zones').zones!.zones).toHaveLength(5);
    expect(one('cycling.climb').source).toEqual({ kind: 'metric', metric: 'climb' });
    expect(one('any.elevation-profile').type).toBe('elevationProfile');
  });

  it('builds through the canvas’s own adding, with a fresh id each time', () => {
    const timeline = timelineOf(full());
    const first = newCanvasComponents(canvasTemplate([]), 'predefined:cycling.power-3s', SIZES[0]!, timeline);
    const second = newCanvasComponents(canvasTemplate(first), 'predefined:cycling.power-3s', SIZES[0]!, timeline);
    expect(first[0]!.id).not.toBe(second[0]!.id);
    expect(newCanvasComponent(canvasTemplate([]), 'predefined:cycling.power-3s', SIZES[0]!, timeline).smoothing).toEqual({ windowSeconds: 3 });
    expect(newCanvasComponents(canvasTemplate([]), 'metric:speed', SIZES[0]!, timeline)).toHaveLength(1);
  });

  it('offers each entry under its sport, and one the activity lacks disabled with its reason', () => {
    const activity = full(['powerWatts', 'gradePercent', 'elevationMeters']);
    const choices = canvasElementChoices(timelineOf(activity), still(activity));
    const of = (id: string) => choices.find((choice) => choice.key === `predefined:${id}`)!;
    expect(choices.filter((choice) => choice.group === 'Cycling')).toHaveLength(12);
    expect(choices.filter((choice) => choice.group === 'Running')).toHaveLength(5);
    expect(choices.filter((choice) => choice.group === 'Any sport')).toHaveLength(6);
    expect(of('cycling.speed')).toMatchObject({ available: true, group: 'Cycling' });
    expect(of('cycling.power-3s')).toMatchObject({ available: false, reason: 'This activity has no power.' });
    expect(of('cycling.gradient')).toMatchObject({ available: false, reason: expect.stringContaining('This activity has no gradient') });
    expect(of('cycling.climb')).toMatchObject({ available: false, reason: 'This activity has no elevation.' });
    expect(of('any.elevation-profile')).toMatchObject({ available: false, reason: 'This activity has no elevation.' });
    expect(of('any.progress').available).toBe(true);
    expect(of('running.distance-total').available).toBe(true);
    // The same reason the plain figure gives.
    expect(choices.find((choice) => choice.key === 'metric:power')!.reason).toBe(of('cycling.power').reason);
    // Every option reads differently, so a reader (and a test) can tell them apart.
    const labels = choices.map((choice) => choice.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(of('cycling.speed').label).toBe('Speed (Cycling)');
    // AV-1018. Zones are in the registry and in the plain list; the registry's are told apart by sport.
    expect(of('cycling.heart-rate-zones')).toMatchObject({ available: true, label: 'Heart rate zones (Cycling)' });
    expect(of('running.heart-rate-zones').label).toBe('Heart rate zones (Running)');
    expect(of('cycling.power-zones')).toMatchObject({ available: false, reason: 'This activity has no power.' });
    expect(choices.find((choice) => choice.key === 'zones:heartRate')).toMatchObject({ available: true, label: 'Heart rate zones', group: 'Live figures' });
    expect(choices.find((choice) => choice.key === 'zones:power')).toMatchObject({ available: false, reason: 'This activity has no power.' });
    expect(of('cycling.power-3s').label).toBe('Power, 3 s average');
  });

  it('offers nothing when the timeline cannot sample', () => {
    const none = buildOverlayTimeline(makeActivity([{ lat: 1, lon: 1 }]));
    for (const entry of PREDEFINED_ENTRIES) expect(predefinedAvailability(entry, none), entry.id).toBe(false);
  });
});

describe('a starting layout per sport (AV-1016)', () => {
  const metricsOf = (components: OverlayComponent[]) =>
    components.map((component) => (component.source?.kind === 'metric' ? component.source.metric : component.type));

  it('is offered beside the three templates', () => {
    expect(START_LAYOUTS.map((layout) => layout.name)).toEqual(['Compact HUD', 'Route inset', 'Metric strip', 'Cycling', 'Running']);
  });

  it('lays cycling out from the registry: speed, power 3 s, cadence, gradient, and the profile', () => {
    const components = componentsFromSportLayout('cycling', timelineOf(full()), SIZES[0]!);
    expect(metricsOf(components)).toEqual(['speed', 'power', 'cyclingCadence', 'grade', 'elevationProfile']);
    expect(components.find((component) => component.source?.kind === 'metric' && component.source.metric === 'power')?.smoothing).toEqual({ windowSeconds: 3 });
    expect(componentsFromStart('cycling', timelineOf(full()), SIZES[0]!)).toEqual(components);
  });

  it('lays running out: pace, heart rate, cadence, distance of the total, and the profile', () => {
    const components = componentsFromSportLayout('running', timelineOf(full()), SIZES[0]!);
    expect(metricsOf(components)).toEqual(['pace', 'heartRate', 'runningCadence', 'distance', 'elevationProfile']);
    expect(components.find((component) => component.source?.kind === 'metric' && component.source.metric === 'distance')?.display?.ofTotal).toBe(true);
  });

  it('keeps everything inside the frame, with nothing overlapping, in landscape, portrait and square', () => {
    for (const sport of ['cycling', 'running'] as const) {
      for (const dropped of [[], ['gradePercent'], ['powerWatts', 'heartRateBpm'], ['elevationMeters']] as (keyof ActivityPoint)[][]) {
        const timeline = timelineOf(full(dropped));
        for (const size of SIZES) {
          const components = componentsFromSportLayout(sport, timeline, size);
          const label = `${sport} ${size.width}x${size.height} without ${dropped.join(', ') || 'nothing'}`;
          const ids = components.map((component) => component.id);
          expect(new Set(ids).size, label).toBe(ids.length);
          for (const { rect } of components) {
            expect(rect.x, label).toBeGreaterThanOrEqual(0);
            expect(rect.y, label).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.width, label).toBeLessThanOrEqual(1 + 1e-9);
            expect(rect.y + rect.height, label).toBeLessThanOrEqual(1 + 1e-9);
          }
          components.forEach((a, i) => components.slice(i + 1).forEach((b) => expect(overlaps(a.rect, b.rect), `${label}: ${a.id} / ${b.id}`).toBe(false)));
          // A layout is a saved layout: it reads back whole.
          const template = canvasTemplate(components);
          expect(parseOverlayTemplate(serializeOverlayTemplate(template)), label).toEqual({ ok: true, template, warnings: [] });
        }
      }
    }
  });

  it('puts the figures along the bottom-left and the profile bottom-right in landscape, and a lower third in portrait', () => {
    const timeline = timelineOf(full());
    const landscape = componentsFromSportLayout('cycling', timeline, SIZES[0]!);
    const profile = landscape.find((component) => component.type === 'elevationProfile')!;
    const figures = landscape.filter((component) => component.type === 'text');
    expect(profile.rect.x).toBeGreaterThan(0.5);
    expect(profile.rect.y + profile.rect.height).toBeGreaterThan(0.9);
    for (const { rect } of figures) {
      expect(rect.x + rect.width).toBeLessThan(profile.rect.x);
      expect(rect.y).toBeGreaterThan(0.6);
    }
    const portrait = componentsFromSportLayout('cycling', timeline, SIZES[1]!);
    for (const { rect } of portrait) expect(rect.y).toBeGreaterThan(0.66);
    // A very wide frame still has its bottom: the figures are not pushed to the top.
    const wide = componentsFromSportLayout('cycling', timeline, SIZES[3]!);
    expect(Math.max(...wide.map((component) => component.rect.y + component.rect.height))).toBeGreaterThan(0.85);
    const foot = portrait.find((component) => component.type === 'elevationProfile')!;
    for (const { rect } of portrait.filter((component) => component !== foot)) expect(rect.y + rect.height).toBeLessThanOrEqual(foot.rect.y);
  });

  it('leaves out what the activity cannot supply, falls back to climb without a gradient, and closes up', () => {
    // No positions: no distance, so no derived grade either (AV-1019), but there is still a climb.
    const noGrade = componentsFromSportLayout('cycling', timelineOf(full(['gradePercent', 'lat'])), SIZES[0]!);
    expect(metricsOf(noGrade)).toEqual(['speed', 'power', 'cyclingCadence', 'climb', 'elevationProfile']);
    const noPower = componentsFromSportLayout('cycling', timelineOf(full(['powerWatts', 'cyclingCadenceRpm'])), SIZES[0]!);
    expect(metricsOf(noPower)).toEqual(['speed', 'grade', 'elevationProfile']);
    // The remaining figures stand at the left edge of the first row.
    expect(Math.min(...noPower.map((component) => component.rect.x))).toBeCloseTo(0.04, 6);
    const flat = componentsFromSportLayout('running', timelineOf(full(['elevationMeters', 'heartRateBpm'])), SIZES[0]!);
    expect(metricsOf(flat)).toEqual(['pace', 'runningCadence', 'distance']);
    // Nothing to lay out is an empty layout, not an error.
    expect(componentsFromSportLayout('running', buildOverlayTimeline(undefined), SIZES[0]!)).toEqual([]);
  });
});
