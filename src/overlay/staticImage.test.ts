import { describe, expect, it } from 'vitest';
import {
  DATE_FORMAT_LABELS,
  LAYOUT_FILE_KIND,
  LAYOUT_FILE_MAX_BYTES,
  SNAP_MARGIN,
  dateValue,
  dateZoneChoice,
  defaultStaticLayout,
  formatStillDate,
  formatUtcOffset,
  itemAt,
  moveRect,
  newStillComponent,
  nudgeRect,
  parseOverlayLayout,
  parseStillLayout,
  placedRect,
  planStillImage,
  serializeStillLayout,
  snapRect,
  stillElementChoices,
  summaryValue,
  type MeasureText,
  type StaticImageLayout,
  type StillImageContext,
} from './staticImage';
import { DEFAULT_ROUTE_IMAGE_OPTIONS, extractRoute, planRouteImage } from './routeImage';
import { sanitizeLabel, type OverlayComponent } from './template';
import type { Activity } from '../domain/activity';
import { makeActivity } from '../test/helpers/activity';

const T0 = Date.parse('2026-09-23T23:55:51Z');

/** A ride north: a point a second, 5 m a second, with a stop in the middle. */
const ride = (extra: Partial<Activity['metadata']> = {}): Activity => {
  const activity = makeActivity(
    Array.from({ length: 61 }, (_, i) => ({
      time: new Date(T0 + i * 1000),
      lat: 46 + (Math.min(i, 30) * 5) / 111_320 + (Math.max(0, i - 40) * 5) / 111_320,
      lon: 7,
    })),
  );
  return { ...activity, metadata: { ...activity.metadata, name: 'Ride', ...extra } };
};

/** A fixed width per character, so a layout's arithmetic can be checked by hand. */
const measure: MeasureText = (text, font) => text.length * Number(/([\d.]+)px/.exec(font)![1]) * 0.5;

const contextOf = (activity: Activity, extra: Partial<StillImageContext> = {}): StillImageContext => ({
  activity,
  route: extractRoute(activity),
  units: 'metric',
  readerTimeZone: 'UTC',
  ...extra,
});

const withComponents = (components: OverlayComponent[], width = 1920, height = 1080): StaticImageLayout => {
  const layout = defaultStaticLayout(width, height);
  return { ...layout, template: { ...layout.template, components } };
};

const label = (content: string, rect = { x: 0.1, y: 0.1, width: 0.01, height: 0.01 }, fontScale = 2): OverlayComponent => ({
  id: 'text-1',
  type: 'label',
  visible: true,
  rect,
  unitMode: 'auto',
  style: { textColor: '#ffffff', fontScale },
  content,
  text: { align: 'left', weight: 'bold' },
});

describe('the still image’s route, unchanged from AV-1009 (TD-061)', () => {
  it('draws the default layout’s route exactly as the route image does', () => {
    const activity = ride();
    const planned = planStillImage(defaultStaticLayout(), contextOf(activity), measure);
    if (!planned.ok) throw planned.error;
    const routeOnly = planRouteImage((extractRoute(activity) as { ok: true; route: never }).route, DEFAULT_ROUTE_IMAGE_OPTIONS);
    if (!routeOnly.ok) throw routeOnly.error;
    expect(planned.plan.items).toHaveLength(1);
    const item = planned.plan.items[0]!;
    expect(item.kind === 'route' && item.plan).toEqual(routeOnly.plan);
  });

  it('fits the route into a smaller box, the padding the same number of pixels', () => {
    const layout = defaultStaticLayout();
    const route = { ...layout.template.components[0]!, rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
    const planned = planStillImage(withComponents([route]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const item = planned.plan.items[0]!;
    if (item.kind !== 'route') throw new Error('not a route');
    expect(item.box).toEqual({ x: 960, y: 540, w: 960, h: 540 });
    for (const [x, y] of item.plan.runs.flat()) {
      expect(x).toBeGreaterThanOrEqual(960);
      expect(y).toBeGreaterThanOrEqual(540);
    }
  });
});

describe('figures from the summary (AV-1010)', () => {
  it('writes each in the reader’s units, over moving time where there is one', () => {
    const activity = ride();
    const d = activity.derived!;
    expect(summaryValue('distance', activity, 'metric')).toEqual({ ok: true, caption: 'Distance', value: '250 m' });
    expect(summaryValue('distance', activity, 'imperial')).toEqual({ ok: true, caption: 'Distance', value: '0.16 mi' });
    expect(summaryValue('speed', activity, 'metric')).toMatchObject({ ok: true, caption: 'Avg speed' });
    expect((summaryValue('speed', activity, 'metric') as { value: string }).value).toMatch(/^18\.0 km\/h$/);
    expect(summaryValue('pace', activity, 'imperial')).toMatchObject({ ok: true, caption: 'Avg pace', value: expect.stringMatching(/\/mi$/) });
    expect(summaryValue('elapsed', activity, 'metric')).toEqual({ ok: true, caption: 'Elapsed time', value: '1:00' });
    expect(summaryValue('moving', activity, 'metric')).toEqual({ ok: true, caption: 'Moving time', value: expect.any(String) });
    expect(d.movingDurationSeconds).toBeLessThan(d.durationSeconds!);
  });

  it('says why a figure is missing, never a blank or NaN', () => {
    const noTime = makeActivity([{ lat: 46, lon: 7 }, { lat: 46.001, lon: 7 }]);
    expect(summaryValue('elapsed', noTime, 'metric')).toEqual({ ok: false, reason: expect.stringMatching(/no timestamps/) });
    expect(summaryValue('speed', noTime, 'metric')).toEqual({ ok: false, reason: expect.stringMatching(/needs both a distance and a time/) });
    const noPlace = makeActivity([{ time: new Date(T0) }, { time: new Date(T0 + 1000) }]);
    expect(summaryValue('distance', noPlace, 'metric')).toEqual({ ok: false, reason: expect.stringMatching(/no distance/) });
    const still = makeActivity([{ time: new Date(T0), lat: 46, lon: 7 }, { time: new Date(T0 + 60_000), lat: 46, lon: 7 }]);
    expect(summaryValue('moving', still, 'metric')).toEqual({ ok: false, reason: expect.stringMatching(/no moving time/) });
    for (const stat of ['speed', 'pace', 'distance', 'elapsed', 'moving'] as const) {
      const value = summaryValue(stat, noTime, 'metric');
      if (value.ok) expect(value.value).not.toMatch(/NaN|undefined|—/);
    }
  });

  it('offers every element with whether this activity has it, and why not', () => {
    const noTime = makeActivity([{ lat: 46, lon: 7 }, { lat: 46.001, lon: 7 }]);
    const choices = stillElementChoices(contextOf(noTime));
    expect(choices.find((choice) => choice.key === 'distance')).toMatchObject({ available: true });
    expect(choices.find((choice) => choice.key === 'elapsed')).toMatchObject({ available: false, reason: expect.stringMatching(/no timestamps/) });
    expect(choices.find((choice) => choice.key === 'date')).toMatchObject({ available: false, reason: expect.stringMatching(/no date/) });
    expect(choices.find((choice) => choice.key === 'label')).toMatchObject({ available: true });
  });
});

describe('dates (AV-1010)', () => {
  // 2026-09-23T23:55:51Z is already the 24th in Japan, and still the 23rd in New York.
  const start = new Date(T0);

  it.each([
    ['iso', false, '2026-09-24'],
    ['iso', true, '2026-09-24 08:55'],
    ['medium', false, '24 Sep 2026'],
    ['medium', true, '24 Sep 2026, 08:55'],
    ['numeric', false, '24/09/2026'],
    ['numeric', true, '24/09/2026 08:55'],
    ['long', false, 'Thursday 24 September 2026'],
    ['long', true, 'Thursday 24 September 2026, 08:55'],
  ] as const)('writes %s (with the time: %s) as %s in the file’s own UTC+09:00', (format, withTime, expected) => {
    expect(formatStillDate(start, format, withTime, { kind: 'offset', minutes: 540 })).toBe(expected);
  });

  it('writes the date in the reader’s zone, which can be another day', () => {
    expect(formatStillDate(start, 'long', true, { kind: 'zone', timeZone: 'America/New_York' })).toBe('Wednesday 23 September 2026, 19:55');
    expect(formatStillDate(start, 'iso', true, { kind: 'zone', timeZone: 'Asia/Tokyo' })).toBe('2026-09-24 08:55');
    expect(formatStillDate(start, 'iso', true, { kind: 'zone', timeZone: 'UTC' })).toBe('2026-09-23 23:55');
  });

  it('labels each format by what it writes, the same as it writes it', () => {
    const thursday = new Date('2026-09-24T12:00:00Z');
    for (const [format, example] of Object.entries(DATE_FORMAT_LABELS)) {
      expect(formatStillDate(thursday, format as keyof typeof DATE_FORMAT_LABELS, false, { kind: 'offset', minutes: 0 })).toBe(example);
    }
  });

  it('offers the activity’s own zone only when the file states one, and says which', () => {
    expect(dateZoneChoice('activity', contextOf(ride()))).toEqual({
      ok: false,
      reason: expect.stringMatching(/does not say which time zone/),
    });
    expect(dateZoneChoice('activity', contextOf(ride({ utcOffsetMinutes: 540 })))).toMatchObject({
      ok: true,
      description: 'UTC+09:00, as the file states',
    });
    expect(dateZoneChoice('reader', contextOf(ride(), { readerTimeZone: 'Asia/Tokyo' }))).toMatchObject({
      ok: true,
      description: 'Your time zone, Asia/Tokyo',
    });
    const date: OverlayComponent = { ...label('x'), type: 'date', date: { format: 'iso', withTime: false, timeZone: 'activity' } };
    expect(dateValue(date, contextOf(ride()))).toMatchObject({ ok: false });
    expect(dateValue(date, contextOf(ride({ utcOffsetMinutes: 540 })))).toEqual({ ok: true, caption: 'Date', value: '2026-09-24' });
  });

  it('writes offsets as UTC±hh:mm', () => {
    expect([formatUtcOffset(0), formatUtcOffset(540), formatUtcOffset(-210), formatUtcOffset(345)]).toEqual([
      'UTC',
      'UTC+09:00',
      'UTC−03:30',
      'UTC+05:45',
    ]);
  });
});

describe('laying out text (AV-1010)', () => {
  it('measures a text at its size, and puts it where it was placed', () => {
    const planned = planStillImage(withComponents([label('Hello', { x: 0.25, y: 0.5, width: 0.01, height: 0.01 })]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const item = planned.plan.items[0]!;
    if (item.kind !== 'text') throw new Error('not text');
    const size = 0.022 * 1920 * 2; // fontScale 2 of the video's base type
    expect(item.lines[0]!.size).toBeCloseTo(size, 6);
    expect(item.box.x).toBe(480);
    expect(item.box.y).toBe(540);
    expect(item.box.w).toBeCloseTo(5 * size * 0.5, 6);
    expect(item.box.h).toBeCloseTo(size * 1.2, 6);
    expect(item.lines[0]).toMatchObject({ text: 'Hello', x: 480, y: 540, caption: false });
    expect(item.lines[0]!.font).toMatch(/^700 [\d.]+px system-ui/);
  });

  it('keeps a text inside the frame, wherever it was put', () => {
    const planned = planStillImage(withComponents([label('Hello', { x: 0.99, y: 0.99, width: 0.01, height: 0.01 })]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const { box } = planned.plan.items[0]!;
    expect(box.x + box.w).toBeCloseTo(1920, 6);
    expect(box.y + box.h).toBeCloseTo(1080, 6);
  });

  it('sets a text larger than the frame smaller, and says so', () => {
    const planned = planStillImage(withComponents([label('A very long caption indeed', undefined, 20)]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const { box } = planned.plan.items[0]!;
    expect(box.w).toBeLessThanOrEqual(1920);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(planned.plan.notes).toContain('Text: A very long caption ind… was set smaller than chosen, to fit inside the image.');
  });

  it('anchors each line for its alignment, and puts a figure’s name above its value', () => {
    const figure: OverlayComponent = {
      ...label('x', { x: 0, y: 0, width: 0.01, height: 0.01 }),
      id: 'distance-1',
      type: 'summary',
      summary: { stat: 'distance' },
      text: { align: 'right', weight: 'bold', caption: true },
    };
    const planned = planStillImage(withComponents([figure]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const item = planned.plan.items[0]!;
    if (item.kind !== 'text') throw new Error('not text');
    expect(item.lines.map((line) => [line.text, line.caption])).toEqual([
      ['DISTANCE', true],
      ['250 m', false],
    ]);
    expect(item.lines.every((line) => line.x === item.box.x + item.box.w)).toBe(true);
    expect(item.lines[1]!.y).toBeCloseTo(item.lines[0]!.size * 1.2, 6);
  });

  it('leaves out what the activity lacks, and an empty text, saying why', () => {
    const noTime = makeActivity([{ lat: 46, lon: 7 }, { lat: 46.001, lon: 7 }]);
    const moving: OverlayComponent = { ...label('x'), id: 'moving-1', type: 'summary', summary: { stat: 'moving' } };
    const empty = { ...label('   '), id: 'text-2' };
    const planned = planStillImage(withComponents([defaultStaticLayout().template.components[0]!, moving, empty]), contextOf(noTime), measure);
    if (!planned.ok) throw planned.error;
    expect(planned.plan.items.map((item) => item.id)).toEqual(['route']);
    expect(planned.plan.hidden).toEqual([
      { id: 'moving-1', label: 'Moving time', reason: expect.stringMatching(/no moving time/) },
      { id: 'text-2', label: 'Text', reason: 'This text is empty.' },
    ]);
  });

  it('refuses a layout with nothing to draw, and a route-only one with the route’s own reason', () => {
    const empty = planStillImage(withComponents([]), contextOf(ride()), measure);
    expect(empty).toMatchObject({ ok: false, error: { message: expect.stringMatching(/nothing to draw/) } });
    const noPlace = makeActivity([{ time: new Date(T0) }, { time: new Date(T0 + 1000) }]);
    const routeOnly = planStillImage(defaultStaticLayout(), contextOf(noPlace), measure);
    expect(routeOnly).toMatchObject({ ok: false, error: { code: 'no_location' } });
    // With a figure beside it, the image is still made, and the route is listed as not drawn.
    const withFigure = planStillImage(
      withComponents([defaultStaticLayout().template.components[0]!, { ...label('x'), type: 'summary', summary: { stat: 'elapsed' } }]),
      contextOf(noPlace),
      measure,
    );
    expect(withFigure.ok && withFigure.plan.hidden.map((entry) => entry.label)).toEqual(['Route']);
  });

  it('refuses a size or a text colour it cannot draw', () => {
    expect(planStillImage(withComponents([label('x')], 100.5, 100), contextOf(ride()), measure)).toMatchObject({ ok: false, error: { code: 'invalid_dimensions' } });
    const bad = { ...label('x'), style: { textColor: 'red' } };
    expect(planStillImage(withComponents([bad]), contextOf(ride()), measure)).toMatchObject({ ok: false, error: { code: 'invalid_style' } });
  });
});

describe('placing (AV-1010)', () => {
  const rect = { x: 0.2, y: 0.3, width: 0.25, height: 0.1 };

  it('keeps every move inside the frame', () => {
    expect(moveRect(rect, -1, -1)).toEqual({ ...rect, x: 0, y: 0 });
    expect(moveRect(rect, 2, 2)).toEqual({ ...rect, x: 0.75, y: 0.9 });
    expect(nudgeRect(rect, 0.01, -0.01)).toEqual({ ...rect, x: 0.21, y: 0.29 });
    expect(nudgeRect({ ...rect, x: 0.745 }, 0.01, 0)).toEqual({ ...rect, x: 0.75 });
  });

  it('snaps to each edge, corner and the centre, a margin in from the edges', () => {
    expect(snapRect(rect, 'top-left')).toMatchObject({ x: SNAP_MARGIN, y: SNAP_MARGIN });
    expect(snapRect(rect, 'top-right')).toMatchObject({ x: 1 - 0.25 - SNAP_MARGIN, y: SNAP_MARGIN });
    expect(snapRect(rect, 'bottom-left')).toMatchObject({ x: SNAP_MARGIN, y: 1 - 0.1 - SNAP_MARGIN });
    expect(snapRect(rect, 'bottom-right')).toMatchObject({ x: 0.71, y: 0.86 });
    expect(snapRect(rect, 'center')).toMatchObject({ x: 0.375, y: 0.45 });
    expect(snapRect(rect, 'top')).toMatchObject({ x: 0.375, y: SNAP_MARGIN });
    expect(snapRect(rect, 'left')).toMatchObject({ x: SNAP_MARGIN, y: 0.45 });
    // Something wider than the frame less its margins is put at the edge, not off it.
    expect(snapRect({ ...rect, width: 1 }, 'right')).toMatchObject({ x: 0 });
  });

  it('finds the element under a point, the one drawn last on top, and places by the drawn box', () => {
    const route = defaultStaticLayout().template.components[0]!;
    const planned = planStillImage(withComponents([route, label('Hello', { x: 0.1, y: 0.1, width: 0.01, height: 0.01 })]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    expect(itemAt(planned.plan, 200, 120)).toBe('text-1');
    expect(itemAt(planned.plan, 1800, 1000)).toBe('route');
    const placed = placedRect(planned.plan, label('Hello', { x: 0.1, y: 0.1, width: 0.01, height: 0.01 }));
    expect(placed.width).toBeCloseTo((5 * 84.48 * 0.5) / 1920, 6);
  });

  it('gives each new element an id of its own', () => {
    const layout = defaultStaticLayout();
    const first = newStillComponent(layout.template, 'label', layout);
    const second = newStillComponent({ ...layout.template, components: [...layout.template.components, first] }, 'label', layout);
    expect([first.id, second.id]).toEqual(['text-1', 'text-2']);
    expect(newStillComponent(layout.template, 'distance', layout)).toMatchObject({ type: 'summary', summary: { stat: 'distance' } });
  });
});

describe('the layout file (AV-1010)', () => {
  const layout = (): StaticImageLayout =>
    withComponents([
      defaultStaticLayout().template.components[0]!,
      { ...label('Day 1 <b>&amp;</b> "Imabari"\nShimanami'), rect: { x: 0.04, y: 0.04, width: 0.2, height: 0.08 } },
      {
        ...label('x'),
        id: 'date-1',
        type: 'date',
        content: undefined,
        date: { format: 'long', withTime: true, timeZone: 'activity' },
      },
      { ...label('x'), id: 'speed-1', type: 'summary', content: undefined, summary: { stat: 'speed' }, text: { align: 'center', weight: 'normal', caption: false } },
    ], 1080, 1350);

  it('round-trips: size, every element, every setting, and the text as typed', () => {
    const json = serializeStillLayout(layout());
    expect(JSON.parse(json)).toMatchObject({ kind: LAYOUT_FILE_KIND, version: 1, image: { width: 1080, height: 1350 } });
    const parsed = parseStillLayout(json);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.layout).toEqual(layout());
    // Markup in a text is text: it is kept as typed, never read.
    expect(parsed.layout.template.components[1]!.content).toBe('Day 1 <b>&amp;</b> "Imabari"\nShimanami');
  });

  it('carries nothing of the activity', () => {
    const json = serializeStillLayout(layout());
    expect(json).not.toMatch(/"lat"|"lon"|"time"|46\.0/);
  });

  it('refuses what is not a layout it can read, saying why', () => {
    expect(parseStillLayout('not json')).toEqual({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    expect(parseStillLayout('{"kind":"something-else"}')).toEqual({ ok: false, error: expect.stringMatching(/not an OpenTrack overlay layout/) });
    expect(parseStillLayout(`{"kind":"${LAYOUT_FILE_KIND}","version":9}`)).toEqual({ ok: false, error: expect.stringMatching(/version 9/) });
    expect(parseStillLayout(`{"kind":"${LAYOUT_FILE_KIND}","version":1,"image":{"width":99999,"height":10},"template":{}}`)).toEqual({
      ok: false,
      error: expect.stringMatching(/image size cannot be used/),
    });
    expect(parseStillLayout('x'.repeat(LAYOUT_FILE_MAX_BYTES + 1))).toEqual({ ok: false, error: expect.stringMatching(/too large/) });
  });

  it('leaves out a video’s components and a second route, saying so', () => {
    const json = JSON.parse(serializeStillLayout(layout()));
    json.template.components.push(
      { ...json.template.components[0], id: 'route-2' },
      { id: 'hr', type: 'gauge', visible: true, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: { kind: 'metric', metric: 'heartRate' }, style: {} },
    );
    const parsed = parseStillLayout(JSON.stringify(json));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.layout.template.components.map((component) => component.id)).toEqual(['route', 'text-1', 'date-1', 'speed-1']);
    expect(parsed.warnings).toEqual(['A second route was left out: the image has one route.', 'gauge was left out: it is drawn only on a video.']);
  });

  it('takes control characters out of a text, and keeps it to four lines and 200 characters', () => {
    expect(sanitizeLabel('a\u0000b\u0007c\r\nd\te')).toBe('abc\nde');
    expect(sanitizeLabel('1\n2\n3\n4\n5\n6')).toBe('1\n2\n3\n4');
    expect(sanitizeLabel('x'.repeat(500))).toHaveLength(200);
    const json = JSON.parse(serializeStillLayout(layout()));
    json.template.components[1].content = 'bad\u0000text';
    const parsed = parseStillLayout(JSON.stringify(json));
    expect(parsed.ok && parsed.layout.template.components[1]!.content).toBe('badtext');
  });
});

describe('review round 1 (AV-1010)', () => {
  const routeIn = (rect: OverlayComponent['rect'], lineWidth = 0.01): OverlayComponent => ({
    ...defaultStaticLayout(100, 100).template.components[0]!,
    rect,
    route: { lineWidth, padding: 0, markers: false },
  });

  it('refuses a route box too small to draw in, rather than drawing it larger than its box (R1-C1)', () => {
    const planned = planStillImage(withComponents([routeIn({ x: 0.95, y: 0.95, width: 0.05, height: 0.05 })], 100, 100), contextOf(ride()), measure);
    expect(planned).toMatchObject({ ok: false, error: { code: 'no_room', message: expect.stringMatching(/5 × 5 pixels; it needs at least 16/) } });
  });

  it('keeps a small route’s whole stroke inside its box, and the box inside the image (R1-C1)', () => {
    const planned = planStillImage(withComponents([routeIn({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 })], 100, 100), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const item = planned.plan.items[0]!;
    if (item.kind !== 'route') throw new Error('not a route');
    expect(item.box).toEqual({ x: 80, y: 80, w: 20, h: 20 });
    const half = item.plan.lineWidth / 2;
    for (const [x, y] of item.plan.runs.flat()) {
      expect(x - half).toBeGreaterThanOrEqual(80);
      expect(x + half).toBeLessThanOrEqual(100);
      expect(y - half).toBeGreaterThanOrEqual(80);
      expect(y + half).toBeLessThanOrEqual(100);
    }
  });

  it('saves a text pushed against the right and bottom edges, and reopens it with nothing lost (R1-C2)', () => {
    // An odd width, so the measured box's fractions do not come out round.
    const layout = withComponents(
      [defaultStaticLayout(211, 1080).template.components[0]!, { ...label('Edge', { x: 0.999, y: 0.999, width: 0.01, height: 0.01 }, 1) }],
      211,
      1080,
    );
    const planned = planStillImage(layout, contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    const placed = {
      ...layout,
      template: {
        ...layout.template,
        components: layout.template.components.map((component) => ({ ...component, rect: placedRect(planned.plan, component) })),
      },
    };
    for (const { rect } of placed.template.components) {
      expect(rect.x + rect.width).toBeLessThanOrEqual(1);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1);
    }
    const reopened = parseStillLayout(serializeStillLayout(placed));
    if (!reopened.ok) throw new Error(reopened.error);
    expect(reopened.warnings).toEqual([]);
    expect(reopened.layout.template.components.map((component) => component.id)).toEqual(['route', 'text-1']);
    // And it is drawn where it was: against the same corner, to the hundredth of a pixel.
    const before = planned.plan.items[1]!.box;
    expect(before.x + before.w).toBeCloseTo(211, 6);
    expect(before.y + before.h).toBeCloseTo(1080, 6);
    const again = planStillImage(reopened.layout, contextOf(ride()), measure);
    if (!again.ok) throw again.error;
    const box = again.plan.items[1]!.box;
    expect(box.x).toBeCloseTo(before.x, 2);
    expect(box.y).toBeCloseTo(before.y, 2);
    expect(box.x + box.w).toBeCloseTo(211, 2);
    expect(box.y + box.h).toBeCloseTo(1080, 2);
  });
});

describe('one layout for the still image and the custom canvas (AV-1011)', () => {
  const card: OverlayComponent = {
    id: 'shape-1',
    type: 'shape',
    visible: true,
    rect: { x: 0.04, y: 0.04, width: 0.4, height: 0.3 },
    unitMode: 'auto',
    style: {},
    shape: { kind: 'roundedRect', fill: '#000000', fillOpacity: 0.4, stroke: '#ffffff', strokeOpacity: 0, strokeWidth: 0.004, radius: 0.02 },
  };
  const speed: OverlayComponent = {
    id: 'speed',
    type: 'text',
    visible: true,
    rect: { x: 0.05, y: 0.05, width: 0.2, height: 0.1 },
    unitMode: 'auto',
    style: {},
    source: { kind: 'metric', metric: 'speed' },
    parentId: 'shape-1',
  };
  const held = { ...label('Day 1'), parentId: 'shape-1' };

  it('opens a still-image layout on the canvas with everything in it, unchanged', () => {
    const still = withComponents([defaultStaticLayout().template.components[0]!, card, held], 1080, 1080);
    const opened = parseOverlayLayout(serializeStillLayout(still));
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.warnings).toEqual([]);
    expect(opened.layout).toEqual(still);
  });

  it('opens a canvas layout in the still image: shapes, texts and the route kept, a live figure left out with a warning', () => {
    const canvas = withComponents([card, speed, held], 1920, 1080);
    const opened = parseStillLayout(serializeStillLayout(canvas));
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.layout.template.components.map((component) => component.id)).toEqual(['shape-1', 'text-1']);
    expect(opened.layout.template.components[1]!.parentId).toBe('shape-1');
    expect(opened.warnings).toEqual(['text was left out: it is drawn only on a video.']);
  });

  it('draws a shape on the still image where it was placed', () => {
    const planned = planStillImage(withComponents([card, held]), contextOf(ride()), measure);
    if (!planned.ok) throw planned.error;
    expect(planned.plan.items[0]).toEqual({ kind: 'shape', id: 'shape-1', box: { x: 76.8, y: 43.2, w: 768, h: 324 }, shape: card.shape });
  });
});
