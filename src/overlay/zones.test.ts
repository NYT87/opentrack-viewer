import { describe, expect, it, vi } from 'vitest';
import {
  PERSONAL_LIMITS,
  ZONE_LIMITS,
  ZONE_RAMP,
  activityHighest,
  addZone,
  changeBasis,
  cleanPersonal,
  defaultZones,
  defaultZonesSetting,
  effectivePersonal,
  rampColors,
  removeLastZone,
  setZone,
  withinZone,
  zoneBounds,
  zoneIndex,
  zoneTimesFor,
} from './zones';
import {
  componentsForLayoutFile,
  parseOverlayTemplate,
  personalHeldBy,
  resolveOverlayComponent,
  serializeOverlayTemplate,
  type OverlayComponent,
  type OverlayZonesSetting,
} from './template';
import { canvasTemplate, newZonesComponent } from './customCanvas';
import { createOverlayRenderer, type OverlayContext2D } from './export/drawOverlay';
import { buildOverlayTimeline } from './timeline';
import { makeActivity } from '../test/helpers/activity';

/** AV-1018 (TD-086). Zones: lookup, defaults, the reader's figures, parsing, time in zone. */

const T0 = Date.parse('2026-09-24T08:00:00Z');
const FRAME = { width: 1920, height: 1080 };
const zonesOf = (source: 'heartRate' | 'power', over: Partial<OverlayComponent> = {}): OverlayComponent => ({
  ...newZonesComponent(canvasTemplate([]), source, FRAME),
  ...over,
});

describe('which zone a value is in', () => {
  const bounds = [95, 114, 133, 152, 171];

  it('is the last zone whose bound is at or under the value', () => {
    expect(zoneIndex(114, bounds)).toBe(1);
    expect(zoneIndex(113.999, bounds)).toBe(0);
    expect(zoneIndex(133, bounds)).toBe(2);
    expect(zoneIndex(151.9, bounds)).toBe(2);
    expect(zoneIndex(152, bounds)).toBe(3);
    expect(zoneIndex(171, bounds)).toBe(4);
  });

  it('counts a value under the floor in the first zone, and one over the top in the last', () => {
    expect(zoneIndex(0, bounds)).toBe(0);
    expect(zoneIndex(94.9, bounds)).toBe(0);
    expect(zoneIndex(95, bounds)).toBe(0);
    expect(zoneIndex(500, bounds)).toBe(4);
    expect(zoneIndex(-10, bounds)).toBe(0);
  });

  it('works at every bound of the default heart rate zones of a maximum of 190', () => {
    const hr = zoneBounds(defaultZonesSetting('heartRate'), { maxHeartRate: 190 })!;
    // 60 % of 190 is exactly 114, not 113.99999999999999: the bound belongs to the zone that starts there.
    expect(hr).toEqual([95, 114, 133, 152, 171]);
    hr.forEach((bound, i) => {
      expect(zoneIndex(bound, hr)).toBe(i);
      if (i > 0) expect(zoneIndex(bound - 0.01, hr)).toBe(i - 1);
    });
  });

  it('works at every bound of Coggan’s seven power zones of an FTP of 250, and of 200', () => {
    const power = zoneBounds(defaultZonesSetting('power'), { ftp: 250 })!;
    expect(power).toEqual([0, 140, 190, 227.5, 265, 302.5, 377.5]);
    power.forEach((bound, i) => {
      expect(zoneIndex(bound, power)).toBe(i);
      if (i > 0) expect(zoneIndex(bound - 0.01, power)).toBe(i - 1);
    });
    const ftp200 = zoneBounds(defaultZonesSetting('power'), { ftp: 200 })!;
    expect(ftp200).toEqual([0, 112, 152, 182, 212, 242, 302]);
    expect(zoneIndex(111, ftp200)).toBe(0);
    expect(zoneIndex(112, ftp200)).toBe(1);
    expect(zoneIndex(1000, ftp200)).toBe(6);
  });

  it('works on custom bounds in absolute values, which need no reference', () => {
    const setting: OverlayZonesSetting = {
      ...defaultZonesSetting('heartRate'),
      basis: 'value',
      zones: [
        { name: 'Easy', color: '#00ff00', from: 100 },
        { name: 'Hard', color: '#ff0000', from: 150 },
        { name: 'Max', color: '#0000ff', from: 180 },
      ],
    };
    const custom = zoneBounds(setting, undefined)!;
    expect(custom).toEqual([100, 150, 180]);
    expect([99, 100, 149.99, 150, 179, 180, 250].map((value) => zoneIndex(value, custom))).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });

  it('works with two zones and with ten', () => {
    expect(zoneIndex(5, [0, 10])).toBe(0);
    expect(zoneIndex(10, [0, 10])).toBe(1);
    const ten = Array.from({ length: 10 }, (_, i) => i * 10);
    expect(zoneIndex(95, ten)).toBe(9);
    expect(zoneIndex(0, ten)).toBe(0);
  });

  it('places the value inside its zone, the last zone as wide as the one before', () => {
    expect(withinZone(124, 1, [95, 114, 133])).toBeCloseTo(10 / 19);
    expect(withinZone(114, 1, [95, 114, 133])).toBe(0);
    expect(withinZone(90, 0, [95, 114, 133])).toBe(0);
    // The last zone: 133 + (133 - 114) = 152.
    expect(withinZone(142.5, 2, [95, 114, 133])).toBeCloseTo(0.5);
    expect(withinZone(900, 2, [95, 114, 133])).toBe(1);
  });
});

describe('the defaults', () => {
  it('are five heart rate zones from 50 to 90 % with their names', () => {
    const zones = defaultZones('heartRate');
    expect(zones.map((zone) => [zone.name, zone.from])).toEqual([
      ['Recovery', 50],
      ['Endurance', 60],
      ['Tempo', 70],
      ['Threshold', 80],
      ['Maximum', 90],
    ]);
  });

  it('are Coggan’s seven zones of FTP: 0, 56, 76, 91, 106, 121 and 151 %', () => {
    const zones = defaultZones('power');
    expect(zones.map((zone) => zone.from)).toEqual([0, 56, 76, 91, 106, 121, 151]);
    expect(zones.map((zone) => zone.name)).toEqual(['Active recovery', 'Endurance', 'Tempo', 'Threshold', 'VO2 max', 'Anaerobic', 'Neuromuscular']);
  });

  it('are coloured from cool to hot with one palette, each colour a #rrggbb', () => {
    for (const source of ['heartRate', 'power'] as const) {
      const colors = defaultZones(source).map((zone) => zone.color);
      expect(new Set(colors).size).toBe(colors.length);
      for (const color of colors) expect(ZONE_RAMP).toContain(color);
    }
    expect(ZONE_RAMP.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    expect(rampColors(2)).toEqual([ZONE_RAMP[0], ZONE_RAMP[ZONE_RAMP.length - 1]]);
    expect(rampColors(10)).toEqual([...ZONE_RAMP]);
  });

  it('start a horizontal bar showing the zone, the value and the name, in percent', () => {
    expect(defaultZonesSetting('power')).toMatchObject({
      source: 'power',
      basis: 'percent',
      shape: 'horizontal',
      show: { number: true, name: true, value: true, timeInZone: false },
    });
  });

  it('a new component has power smoothed over 3 s, and heart rate not at all', () => {
    expect(zonesOf('power').smoothing).toEqual({ windowSeconds: 3 });
    expect(zonesOf('heartRate').smoothing).toBeUndefined();
    expect(zonesOf('heartRate').source).toEqual({ kind: 'metric', metric: 'heartRate' });
  });
});

describe('the reader’s figures', () => {
  it('are kept inside their limits and whole, and the unusable left out', () => {
    expect(cleanPersonal({ maxHeartRate: 190.4, ftp: 250 })).toEqual({ maxHeartRate: 190, ftp: 250 });
    expect(cleanPersonal({ maxHeartRate: 20, ftp: 5000 })).toEqual({ maxHeartRate: PERSONAL_LIMITS.maxHeartRate.min, ftp: PERSONAL_LIMITS.ftp.max });
    expect(cleanPersonal({ maxHeartRate: 'abc', ftp: NaN })).toEqual({});
    expect(cleanPersonal(null)).toEqual({});
    expect(cleanPersonal('x')).toEqual({});
  });

  it('the session’s count, and a layout’s only where the session has none', () => {
    const setting = { personal: { maxHeartRate: 180, ftp: 300 } };
    expect(effectivePersonal(undefined, setting)).toEqual({ maxHeartRate: 180, ftp: 300 });
    expect(effectivePersonal({ maxHeartRate: 190 }, setting)).toEqual({ maxHeartRate: 190, ftp: 300 });
    expect(effectivePersonal({ maxHeartRate: 190, ftp: 250 }, setting)).toEqual({ maxHeartRate: 190, ftp: 250 });
    expect(effectivePersonal({}, undefined)).toEqual({});
  });

  it('offers the activity’s own highest reading', () => {
    const activity = makeActivity([
      { time: new Date(T0), heartRateBpm: 120, powerWatts: 200 },
      { time: new Date(T0 + 1000), heartRateBpm: 171.4, powerWatts: 480 },
      { time: new Date(T0 + 2000) },
    ]);
    expect(activityHighest(activity, 'heartRate')).toBe(171);
    expect(activityHighest(activity, 'power')).toBe(480);
    expect(activityHighest(makeActivity([{ time: new Date(T0) }]), 'power')).toBeUndefined();
  });
});

describe('a zones component drawn, or not, at a moment (needs your figures)', () => {
  const activity = makeActivity(
    Array.from({ length: 21 }, (_, i) => ({ time: new Date(T0 + i * 1000), heartRateBpm: 100 + 4 * i, powerWatts: 100 + 10 * i, distanceMeters: i * 5 })),
  );
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 20 } });
  const template = canvasTemplate([]);
  const resolve = (component: OverlayComponent, t: number, personal?: { maxHeartRate?: number; ftp?: number }) =>
    resolveOverlayComponent(template, component, timeline.sampleAt(t), timeline, 'metric', personal);

  it('is not drawn while the reference is missing, and says why', () => {
    expect(resolve(zonesOf('heartRate'), 10)).toEqual({ status: 'hidden', reason: 'needs_reference', componentId: 'heart-rate-zones-1' });
    expect(resolve(zonesOf('heartRate'), 10, { ftp: 250 })).toMatchObject({ status: 'hidden', reason: 'needs_reference' });
    expect(resolve(zonesOf('power'), 10, { maxHeartRate: 190 })).toMatchObject({ status: 'hidden', reason: 'needs_reference' });
  });

  it('is drawn once the figure is given: the zone, the bounds and where in the zone', () => {
    const ready = resolve(zonesOf('heartRate'), 10, { maxHeartRate: 200 });
    // 140 bpm of 200: bounds 100, 120, 140, 160, 180, so zone 3 (0-based 2), at its start.
    expect(ready).toMatchObject({ status: 'ready', text: '140 bpm', zones: { index: 2, bounds: [100, 120, 140, 160, 180], value: 140, unit: 'bpm', within: 0 } });
  });

  it('needs no reference for bounds in absolute values', () => {
    const setting: OverlayZonesSetting = { ...defaultZonesSetting('power'), basis: 'value', zones: [{ name: 'Low', color: '#00ff00', from: 0 }, { name: 'High', color: '#ff0000', from: 150 }] };
    const ready = resolve(zonesOf('power', { zones: setting, smoothing: undefined }), 10);
    expect(ready).toMatchObject({ status: 'ready', zones: { index: 1, bounds: [0, 150], value: 200 } });
  });

  it('uses the layout’s own figure only where the session has none', () => {
    const held = zonesOf('heartRate');
    held.zones = { ...held.zones!, personal: { maxHeartRate: 200 } };
    expect(resolve(held, 10)).toMatchObject({ status: 'ready', zones: { bounds: [100, 120, 140, 160, 180] } });
    expect(resolve(held, 10, { maxHeartRate: 220 })).toMatchObject({ status: 'ready', zones: { bounds: [110, 132, 154, 176, 198] } });
  });

  it('is not drawn where the value is missing, or the zones cannot be read, or the source differs', () => {
    expect(resolve(zonesOf('heartRate'), 100, { maxHeartRate: 190 })).toMatchObject({ status: 'hidden', reason: 'no_data' });
    const broken = zonesOf('heartRate');
    delete broken.zones;
    expect(resolve(broken, 10, { maxHeartRate: 190 })).toMatchObject({ status: 'hidden', reason: 'no_zones' });
    expect(resolve({ ...zonesOf('heartRate'), source: { kind: 'metric', metric: 'power' } }, 10, { maxHeartRate: 190 })).toMatchObject({ status: 'hidden', reason: 'no_zones' });
    expect(resolve({ ...zonesOf('heartRate'), visible: false }, 10, { maxHeartRate: 190 })).toMatchObject({ status: 'hidden', reason: 'disabled' });
  });

  it('smooths the value the zone is read from', () => {
    const power = zonesOf('power');
    // 400 W at the end, rising 10 W a second: a 3 s mean is 15 W under the moment's own.
    const personal = { ftp: 250 };
    const raw = resolve({ ...power, smoothing: undefined }, 20, personal);
    const smoothed = resolve(power, 20, personal);
    expect(raw).toMatchObject({ zones: { value: 300 } });
    expect(smoothed).toMatchObject({ status: 'ready' });
    if (smoothed.status === 'ready') expect(smoothed.zones!.value).toBeCloseTo(285, 1);
    // A flicker over a bound: the zone follows the mean, not the instant.
    const flicker = makeActivity(
      Array.from({ length: 21 }, (_, i) => ({ time: new Date(T0 + i * 1000), powerWatts: i === 10 ? 200 : 140 })),
    );
    const flickerTimeline = buildOverlayTimeline(flicker, { video: { durationSeconds: 20 } });
    const at = (component: OverlayComponent) => resolveOverlayComponent(template, component, flickerTimeline.sampleAt(10), flickerTimeline, 'metric', { ftp: 250 });
    expect(at({ ...power, smoothing: undefined })).toMatchObject({ zones: { index: 2 } });
    expect(at(power)).toMatchObject({ zones: { index: 1 } });
  });

  it('holds through a stop as the figure does (TD-080): power is zero and in the first zone, heart rate holds', () => {
    const stop = makeActivity([
      { time: new Date(T0), heartRateBpm: 150, powerWatts: 250, distanceMeters: 0 },
      { time: new Date(T0 + 1000), heartRateBpm: 150, powerWatts: 250, distanceMeters: 5 },
      // 60 s of nothing, with no distance across it: a stop.
      { time: new Date(T0 + 61_000), heartRateBpm: 120, powerWatts: 0, distanceMeters: 5 },
    ]);
    const stopped = buildOverlayTimeline(stop, { video: { durationSeconds: 61 } });
    const at = (component: OverlayComponent, t: number) => resolveOverlayComponent(template, { ...component, smoothing: undefined }, stopped.sampleAt(t), stopped, 'metric', { maxHeartRate: 200, ftp: 250 });
    expect(at(zonesOf('power'), 1)).toMatchObject({ zones: { value: 250, index: 3 } });
    expect(at(zonesOf('power'), 30)).toMatchObject({ zones: { value: 0, index: 0 } });
    expect(at(zonesOf('heartRate'), 30)).toMatchObject({ zones: { value: 150, index: 2 } });
  });
});

describe('time in each zone', () => {
  // 0-9 s moving at 5 m/s, 10-14 s standing, 15-19 s moving again. Heart rate 100, then 150, then 180.
  const hr = (i: number) => (i < 5 ? 100 : i < 15 ? 150 : 180);
  const meters = (i: number) => (i <= 10 ? 5 * i : i <= 15 ? 50 : 50 + 5 * (i - 15));
  const activity = makeActivity(
    Array.from({ length: 20 }, (_, i) => ({ time: new Date(T0 + i * 1000), heartRateBpm: hr(i), distanceMeters: meters(i) })),
  );
  const timeline = buildOverlayTimeline(activity, { video: { durationSeconds: 19 } });
  const source = { kind: 'metric', metric: 'heartRate' } as const;
  const bounds = [0, 120, 170];

  it('counts the moving seconds in each zone, as moving time is counted', () => {
    const times = zoneTimesFor(timeline, source, bounds)!;
    expect(times.at(0)).toEqual([0, 0, 0]);
    expect(times.at(2.5)).toEqual([2.5, 0, 0]);
    expect(times.at(5)).toEqual([5, 0, 0]);
    expect(times.at(7)).toEqual([5, 2, 0]);
    // 10 to 15 s the activity stood still: nothing counts, in any zone.
    expect(times.at(12)).toEqual([5, 5, 0]);
    expect(times.at(15)).toEqual([5, 5, 0]);
    expect(times.at(19)).toEqual([5, 5, 4]);
    // The zones add up to the moving time so far, which is what the Moving time figure shows.
    for (const t of [0, 3, 9, 10, 12, 15, 17, 19]) {
      const sum = times.at(t).reduce((a, b) => a + b, 0);
      expect(sum, `at ${t}`).toBeCloseTo(timeline.sampleAt(t)!.values['metric:moving']!, 6);
    }
  });

  it('counts nothing across a new segment or a step with no value', () => {
    const gaps = makeActivity([
      { time: new Date(T0), heartRateBpm: 100, distanceMeters: 0, segmentIndex: 0 },
      { time: new Date(T0 + 1000), heartRateBpm: 100, distanceMeters: 5, segmentIndex: 0 },
      { time: new Date(T0 + 2000), heartRateBpm: 150, distanceMeters: 500, segmentIndex: 1 },
      { time: new Date(T0 + 3000), distanceMeters: 505, segmentIndex: 1 },
      { time: new Date(T0 + 4000), heartRateBpm: 150, distanceMeters: 510, segmentIndex: 1 },
    ]);
    const line = buildOverlayTimeline(gaps, { video: { durationSeconds: 4 } });
    const times = zoneTimesFor(line, source, [0, 120])!;
    // 1 s in zone 1 (segment 0), the jump to a new segment counts for nothing, the step from the
    // point with no heart rate counts in no zone, and the last second is in zone 2.
    expect(times.at(4)).toEqual([1, 1]);
    // A source the activity has no values for has no time in any zone.
    expect(zoneTimesFor(line, { kind: 'metric', metric: 'power' }, [0, 100])).toBeUndefined();
    expect(zoneTimesFor(line, { kind: 'sensor', key: 'nothing' }, [0, 100])).toBeUndefined();
  });

  it('is made once for a timeline, a source and bounds, and looked up after', () => {
    const spy = vi.spyOn(timeline, 'zoneTimes');
    const first = zoneTimesFor(timeline, source, [0, 130, 175]);
    const second = zoneTimesFor(timeline, source, [0, 130, 175]);
    expect(first).toBe(second);
    expect(spy).toHaveBeenCalledTimes(1);
    zoneTimesFor(timeline, source, [0, 131, 175]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('is built once for each of four or more zones components, with a renderer, over many frames (TD-088)', () => {
    const counting = buildOverlayTimeline(activity, { video: { durationSeconds: 19 } });
    const spy = vi.spyOn(counting, 'zoneTimes');
    const components = [100, 110, 120, 130, 140].map((floor, i): OverlayComponent => {
      const base = zonesOf('heartRate');
      const setting = { ...base.zones!, basis: 'value' as const, show: { ...base.zones!.show, timeInZone: true } };
      setting.zones = setting.zones.map((zone, k) => ({ ...zone, from: floor + k * 20 }));
      return { ...base, id: `zones-${i}`, zones: setting };
    });
    const renderer = createOverlayRenderer({ template: canvasTemplate(components), timeline: counting, activity, units: 'metric', ...FRAME });
    const ctx = new Proxy({ measureText: (text: string) => ({ width: text.length * 6 }) } as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : () => undefined),
      set: (target, key: string, value) => ((target[key] = value), true),
    }) as unknown as OverlayContext2D;
    for (let frame = 0; frame < 60; frame += 1) renderer.drawFrame(ctx, (frame * 19) / 59);
    // One accumulator each: five distinct bounds, five passes, and no more however many frames.
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });

  it('is one pass over the points and a search per frame, however long the recording', () => {
    const count = 120_000;
    const long = makeActivity(
      Array.from({ length: count }, (_, i) => ({ time: new Date(T0 + i * 1000), heartRateBpm: 90 + (i % 100), distanceMeters: i * 3 })),
    );
    const longTimeline = buildOverlayTimeline(long, { video: { durationSeconds: count - 1 } });
    const started = performance.now();
    const times = zoneTimesFor(longTimeline, source, [0, 110, 130, 150, 170])!;
    const built = performance.now() - started;
    const frames = performance.now();
    let sum = 0;
    for (let frame = 0; frame < 10_000; frame += 1) sum += times.at((frame * 11.7) % (count - 1))[1]!;
    const looked = performance.now() - frames;
    expect(sum).toBeGreaterThan(0);
    expect(built).toBeLessThan(2000);
    expect(looked).toBeLessThan(500);
    expect(times.at(count - 1).reduce((a, b) => a + b, 0)).toBeCloseTo(count - 1, 6);
  });
});

describe('editing a set of zones', () => {
  const heartRate = defaultZonesSetting('heartRate');

  it('adds a zone a step above the last, up to ten, and takes one off the end, down to two', () => {
    let setting = heartRate;
    for (let i = setting.zones.length; i < ZONE_LIMITS.max; i += 1) setting = addZone(setting);
    expect(setting.zones).toHaveLength(10);
    expect(setting.zones[5]).toMatchObject({ name: 'Zone 6', from: 100 });
    expect(addZone(setting)).toBe(setting);
    for (let i = setting.zones.length; i > ZONE_LIMITS.min; i -= 1) setting = removeLastZone(setting);
    expect(setting.zones).toHaveLength(2);
    expect(removeLastZone(setting)).toBe(setting);
    const froms = (s: OverlayZonesSetting) => s.zones.map((zone) => zone.from);
    expect(froms(addZone(heartRate))).toEqual([50, 60, 70, 80, 90, 100]);
  });

  it('keeps the bounds ascending whatever is typed', () => {
    expect(setZone(heartRate, 2, { from: 10 }).zones.map((zone) => zone.from)).toEqual([50, 60, 61, 80, 90]);
    expect(setZone(heartRate, 2, { from: 500 }).zones.map((zone) => zone.from)).toEqual([50, 60, 79, 80, 90]);
    expect(setZone(heartRate, 4, { from: 9000 }).zones[4]!.from).toBe(500);
    expect(setZone(heartRate, 0, { from: -5 }).zones[0]!.from).toBe(0);
    expect(setZone(heartRate, 1, { name: 'Easy', color: '#123456' }).zones[1]).toMatchObject({ name: 'Easy', color: '#123456', from: 60 });
  });

  it('leaves a bound alone where a file’s neighbours are under 1 apart, and does not add a zone past the limit', () => {
    const tight: OverlayZonesSetting = { ...heartRate, zones: [60, 60.5, 61].map((from, i) => ({ name: `z${i}`, color: '#ffffff', from })) };
    expect(setZone(tight, 1, { from: 70 }).zones.map((zone) => zone.from)).toEqual([60, 60.5, 61]);
    const top: OverlayZonesSetting = { ...heartRate, zones: [{ name: 'a', color: '#ffffff', from: 499 }, { name: 'b', color: '#ffffff', from: 500 }] };
    expect(addZone(top)).toBe(top);
  });

  it('changes basis keeping the same zones, and only the basis without the figure', () => {
    const asValues = changeBasis(heartRate, 'value', { maxHeartRate: 200 });
    expect(asValues.basis).toBe('value');
    expect(asValues.zones.map((zone) => zone.from)).toEqual([100, 120, 140, 160, 180]);
    expect(zoneBounds(asValues, undefined)).toEqual([100, 120, 140, 160, 180]);
    expect(changeBasis(asValues, 'percent', { maxHeartRate: 200 }).zones.map((zone) => zone.from)).toEqual([50, 60, 70, 80, 90]);
    expect(changeBasis(heartRate, 'value', undefined).zones.map((zone) => zone.from)).toEqual([50, 60, 70, 80, 90]);
    expect(changeBasis(heartRate, 'percent', undefined)).toBe(heartRate);
  });
});

describe('zones in a layout file', () => {
  const full = (): OverlayComponent[] => [zonesOf('heartRate'), { ...zonesOf('power'), id: 'power-zones-1' }];

  it('round trips, a component with its zones, shape, what is shown and smoothing', () => {
    const power = zonesOf('power');
    power.zones = { ...power.zones!, shape: 'arc', show: { number: false, name: true, value: false, timeInZone: true } };
    power.figure = { labelColor: '#ff00ff', align: 'center' };
    const template = canvasTemplate([zonesOf('heartRate'), power]);
    expect(parseOverlayTemplate(serializeOverlayTemplate(template))).toEqual({ ok: true, template, warnings: [] });
  });

  it('holds the reader’s figures only when asked: never by default, never from the session unasked', () => {
    const components = full();
    const session = { maxHeartRate: 190, ftp: 250 };
    for (const component of componentsForLayoutFile(components, { include: false, session })) expect(component.zones!.personal).toBeUndefined();
    expect(JSON.stringify(componentsForLayoutFile(components, { include: false, session }))).not.toMatch(/190|250|personal/);
    const included = componentsForLayoutFile(components, { include: true, session });
    for (const component of included) expect(component.zones!.personal).toEqual(session);
    // A layout that held figures loses them again when saved without the tick.
    const held = components.map((component) => ({ ...component, zones: { ...component.zones!, personal: { maxHeartRate: 177 } } }));
    expect(JSON.stringify(componentsForLayoutFile(held, { include: false, session }))).not.toContain('177');
    // With the tick and a session with none, the layout's own are kept.
    expect(componentsForLayoutFile(held, { include: true, session: {} })[0]!.zones!.personal).toEqual({ maxHeartRate: 177 });
    // Nothing else changes, and nothing is mutated.
    expect(components[0]!.zones!.personal).toBeUndefined();
    expect(componentsForLayoutFile([{ ...components[0]!, zones: undefined } as OverlayComponent], { include: true, session })[0]!.zones).toBeUndefined();
  });

  it('round trips the figures when they are included, and reads none when they are not', () => {
    const session = { maxHeartRate: 190, ftp: 250 };
    const without = canvasTemplate(componentsForLayoutFile(full(), { include: false, session }));
    const withIt = canvasTemplate(componentsForLayoutFile(full(), { include: true, session }));
    const readWithout = parseOverlayTemplate(serializeOverlayTemplate(without));
    const readWith = parseOverlayTemplate(serializeOverlayTemplate(withIt));
    expect(readWithout.ok && personalHeldBy(readWithout.template.components)).toEqual({});
    expect(readWith.ok && personalHeldBy(readWith.template.components)).toEqual(session);
    expect(readWith).toEqual({ ok: true, template: withIt, warnings: [] });
    expect(serializeOverlayTemplate(without)).not.toContain('personal');
  });

  it('keeps a figure in a file inside its limits, and drops one that is no number', () => {
    const template = canvasTemplate(full());
    const json = JSON.parse(serializeOverlayTemplate(template));
    json.components[0].zones.personal = { maxHeartRate: 9999, ftp: 'a lot' };
    json.components[1].zones.personal = { ftp: 1 };
    const read = parseOverlayTemplate(JSON.stringify(json));
    expect(read.ok && read.template.components[0]!.zones!.personal).toEqual({ maxHeartRate: PERSONAL_LIMITS.maxHeartRate.max });
    expect(read.ok && read.template.components[1]!.zones!.personal).toEqual({ ftp: PERSONAL_LIMITS.ftp.min });
  });

  describe('is read with care', () => {
    const base = () => JSON.parse(serializeOverlayTemplate(canvasTemplate([zonesOf('heartRate')])));
    const read = (mutate: (json: ReturnType<typeof base>) => void) => {
      const json = base();
      mutate(json);
      return parseOverlayTemplate(JSON.stringify(json));
    };
    const component = (result: ReturnType<typeof parseOverlayTemplate>) => (result.ok ? result.template.components[0] : undefined);

    it('drops names to one short line, and colours to #rrggbb', () => {
      const result = read((json) => {
        json.components[0].zones.zones[0].name = `  ${'x'.repeat(80)}\u0007\n `;
        json.components[0].zones.zones[1].color = 'red';
        json.components[0].zones.zones[2].color = '#ABCDEF';
        json.components[0].zones.zones[3].name = 5;
      });
      const zones = component(result)!.zones!.zones;
      expect(zones[0]!.name).toBe('x'.repeat(24));
      expect(zones[1]!.color).toBe('#ffffff');
      expect(zones[2]!.color).toBe('#abcdef');
      expect(zones[3]!.name).toBe('');
    });

    it('keeps the component but drops the zones when there are too few, too many, or they do not rise', () => {
      for (const mutate of [
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones = json.components[0].zones.zones.slice(0, 1)),
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones = Array.from({ length: 11 }, (_, i) => ({ name: 'z', color: '#ffffff', from: i }))),
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones[2].from = 10),
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones[2].from = json.components[0].zones.zones[1].from),
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones[1].from = 'high'),
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones[1] = null),
        (json: ReturnType<typeof base>) => (json.components[0].zones.zones = 'many'),
        (json: ReturnType<typeof base>) => (json.components[0].zones.source = 'pace'),
        (json: ReturnType<typeof base>) => (json.components[0].zones = 7),
      ]) {
        const result = read(mutate);
        expect(result.ok).toBe(true);
        // Never a crash: the component is there, with no zones, and so draws nothing.
        expect(component(result)).toMatchObject({ type: 'zones', source: { kind: 'metric', metric: 'heartRate' } });
        expect(component(result)!.zones).toBeUndefined();
      }
    });

    it('skips a zones component with neither zones nor a heart rate or power source, as for any other', () => {
      const result = read((json) => {
        delete json.components[0].zones;
        json.components[0].source = { kind: 'metric', metric: 'speed' };
      });
      expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining('missing or invalid data source')] });
      expect(result.ok && result.template.components).toEqual([]);
    });

    it('clamps bounds, and reads an unknown shape and missing show flags as their defaults', () => {
      const result = read((json) => {
        json.components[0].zones.zones[4].from = 9999;
        json.components[0].zones.shape = 'pie';
        json.components[0].zones.basis = 'furlongs';
        json.components[0].zones.show = { timeInZone: true, name: 'no' };
      });
      const setting = component(result)!.zones!;
      expect(setting.zones[4]!.from).toBe(500);
      expect(setting.shape).toBe('horizontal');
      expect(setting.basis).toBe('percent');
      expect(setting.show).toEqual({ number: true, name: true, value: true, timeInZone: true });
    });

    it('lets the zones’ source decide the component’s', () => {
      const result = read((json) => {
        json.components[0].zones.source = 'power';
        json.components[0].source = { kind: 'metric', metric: 'heartRate' };
      });
      expect(component(result)!.source).toEqual({ kind: 'metric', metric: 'power' });
    });

    it('reads a layout made before zones, and says which component an older build skips, unchanged', () => {
      const old = JSON.stringify({ version: 2, name: 'old', style: {}, components: [{ id: 'speed', type: 'text', visible: true, rect: { x: 0, y: 0, width: 0.2, height: 0.1 }, unitMode: 'auto', style: {}, source: { kind: 'metric', metric: 'speed' } }] });
      const result = parseOverlayTemplate(old);
      expect(result).toMatchObject({ ok: true, warnings: [] });
      expect(result.ok && result.template.components[0]!.zones).toBeUndefined();
    });
  });
});
