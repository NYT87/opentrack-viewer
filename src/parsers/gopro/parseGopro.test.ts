import { describe, expect, it } from 'vitest';
import { parseGopro, GOPRO_PARSER_VERSION } from './parseGopro';
import { extractGpmf } from './extractGpmf';
import { readBinaryFixture } from '../../test/helpers/fixtures';
import { DISPLAYABLE_DEVICE_FIELDS } from '../../domain/activity';
import { buildSeries } from '../../domain/series';
import { activityToRouteGeoJSON } from '../../domain/geojson';
import { sliceActivity } from '../../domain/activitySlice';
import { exportActivity, getExportAvailability } from '../../exporters';

/**
 * The `.raw` fixtures are GPMF payloads without their container, which is what
 * `AV-903` would have handed over. Interpretation is what is under test here,
 * so the payloads are used directly — and they cost 75 KB each instead of the
 * megabytes a video would.
 */
const fromRaw = (fixture: string, fileName: string) =>
  parseGopro(
    {
      // `readBinaryFixture` hands back an ArrayBuffer; the payload is bytes.
      rawData: new Uint8Array(readBinaryFixture(fixture)),
      timing: { videoDurationSeconds: 0, frameDurationMs: 0, samples: [] },
    },
    { fileName, idFactory: () => 'fixed-id' },
  );

describe('GPS5 telemetry, from a HERO7 (AV-904)', () => {
  it('normalizes position, altitude, speed and time', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    expect(activity.points.length).toBeGreaterThan(100);
    const first = activity.points[0]!;
    // Galicia, where this ride was recorded.
    expect(first.lat).toBeCloseTo(42.34, 1);
    expect(first.lon).toBeCloseTo(-8.75, 1);
    expect(first.elevationMeters).toBeGreaterThan(0);
    expect(first.speedMetersPerSecond).toBeGreaterThanOrEqual(0);
    expect(first.time).toBeInstanceOf(Date);
  }, 60_000);

  it('records where it came from, and the camera model only', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    expect(activity.source).toMatchObject({
      format: 'gopro',
      fileName: 'GH010042.mp4',
      parserVersion: GOPRO_PARSER_VERSION,
    });
    expect(activity.metadata.device?.name).toBe('Hero7 Black');
    expect(activity.metadata.device?.source).toBe('gopro_device');

    // A camera model is a display field; nothing identifying the camera itself
    // reaches the model at all (TD-020).
    expect(activity.metadata.device?.serialNumber).toBeUndefined();
    for (const field of DISPLAYABLE_DEVICE_FIELDS) {
      expect(String(activity.metadata.device?.[field] ?? '')).not.toMatch(/\d{6,}/);
    }
  }, 60_000);

  it('says nothing about the sport, because a camera does not know', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    expect(activity.metadata.sport).toBe('unknown');
  }, 60_000);
});

describe('GPS9 telemetry, from a HERO11 (AV-904)', () => {
  it('reads the newer layout, where quality lives in the sample itself', async () => {
    // GPS9 appends days, seconds, DOP and fix to the value array and carries no
    // `sticky` at all — the same measurements in a different shape.
    const activity = await fromRaw('hero11.raw', 'GX010042.mp4');

    expect(activity.points.length).toBeGreaterThan(50);
    expect(activity.metadata.device?.name).toBe('HERO11 Black');
    const first = activity.points[0]!;
    expect(first.lat).toBeCloseTo(42.42, 1);
    expect(first.lon).toBeCloseTo(-8.64, 1);
    expect(first.time).toBeInstanceOf(Date);
  }, 60_000);

  it('keeps its points in time order', async () => {
    const activity = await fromRaw('hero11.raw', 'GX010042.mp4');

    const times = activity.points.map((point) => point.time!.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }, 60_000);
});

describe('GPS quality decides what is plotted (AV-904)', () => {
  it('refuses a recording that never had a satellite fix', async () => {
    // GoPro's own HERO8 sample was recorded indoors: all 231 of its samples
    // report fix 0 and precision 9999, and every one of them lands in the
    // North Pacific at nine kilometres altitude. Plotting that would be worse
    // than showing nothing.
    const payload = await extractGpmf(new File([readBinaryFixture('hero8.mp4')], 'GH010042.mp4'));

    await expect(parseGopro(payload, { fileName: 'GH010042.mp4' })).rejects.toMatchObject({
      code: 'no_location_stream',
      message: expect.stringMatching(/usable satellite fix/i),
    });
  }, 120_000);

  it('keeps the good points and counts the rest', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    // Every surviving point is somewhere a receiver actually was.
    expect(activity.points.every((point) => Math.abs(point.lat!) <= 90)).toBe(true);
    expect(activity.points.every((point) => (point.elevationMeters ?? 0) < 5000)).toBe(true);
    expect(activity.points.every((point) => Math.abs(point.lon!) <= 180)).toBe(true);

    const warning = activity.warnings.find((entry) => entry.code === 'gopro_samples_without_fix');
    if (warning) expect(warning.message).toMatch(/without a usable fix/i);
  }, 60_000);
});

describe('a GoPro activity is just an activity (AV-904)', () => {
  it('feeds the map, the charts and the stats with no special casing', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    // Stats.
    expect(activity.derived?.distanceMeters).toBeGreaterThan(0);
    expect(activity.derived?.durationSeconds).toBeGreaterThan(0);
    expect(activity.streams).toMatchObject({ hasLocation: true, hasTime: true, hasElevation: true });

    // The map.
    const route = activityToRouteGeoJSON(activity);
    expect(route.isEmpty).toBe(false);
    expect(route.bounds).toBeDefined();

    // The charts.
    for (const kind of ['elevation', 'speed'] as const) {
      expect(buildSeries(activity, kind, 'distance').isEmpty, kind).toBe(false);
    }
  }, 60_000);

  it('focuses to a range like any other activity', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');
    const sliced = sliceActivity(activity, { startIndex: 0, endIndex: 9 });

    expect(sliced.ok && sliced.activity.points).toHaveLength(10);
  }, 60_000);

  it('exports to every format its data supports', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    // It has position and time, so nothing is unavailable.
    expect(getExportAvailability(activity).every((entry) => entry.available)).toBe(true);

    const gpx = await exportActivity(activity, { format: 'gpx' });
    const xml = await gpx.blob.text();
    expect(xml).toContain('<trkpt');
    expect(gpx.fileName).toBe('GH010042.gpx');
  }, 60_000);
});

describe('the streams beside the route (AV-905)', () => {
  it('charts acceleration and rotation against the same points as the route', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');
    const charted = (activity.sensorStreams ?? []).filter((s) => s.display === 'chart');

    expect(charted.map((s) => s.key).sort()).toEqual(['ACCL', 'GYRO']);
    for (const stream of charted) {
      /*
       * The camera writes these at ~200 Hz against ~28 Hz of GPS, but they
       * never arrive at that rate: the library groups them while interpreting,
       * so what reaches this app is already within a small multiple of the
       * points it will be charted against (TD-034). Asserted as a ceiling
       * because the whole point is that the native rate is never materialized.
       */
      expect(stream.sourceSampleCount).toBeLessThan(activity.points.length * 3);
      expect(stream.valuesByPoint).toHaveLength(activity.points.length);
      expect(stream.valuesByPoint?.filter((v) => v !== undefined).length).toBeGreaterThan(
        activity.points.length / 2,
      );
      expect(stream.unit).toBeTruthy();
    }
  }, 60_000);

  it('reads acceleration as a magnitude around gravity', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');
    const accl = activity.sensorStreams?.find((s) => s.key === 'ACCL');
    const values = (accl?.valuesByPoint ?? []).filter((v): v is number => v !== undefined);

    // A camera on a moving bike, gravity included: near 9.8 m/s², not near 0
    // and not thousands. A reduction that lost a component would fail here.
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(mean).toBeGreaterThan(8);
    expect(mean).toBeLessThan(15);
  }, 60_000);

  it('declares the streams it does not chart, without carrying them', async () => {
    const activity = await fromRaw('hero11.raw', 'GH011234.mp4');
    const hidden = (activity.sensorStreams ?? []).filter((s) => s.display === 'hidden');

    expect(hidden.map((s) => s.key)).toEqual(expect.arrayContaining(['CORI', 'GRAV', 'IORI']));
    for (const stream of hidden) {
      expect(stream.valuesByPoint).toBeUndefined();
      expect(stream.label).toBeTruthy();
      /*
       * And never parsed at all, which is what having no count proves: these
       * come from the listing pass, so their samples were skipped while
       * parsing rather than built and discarded (TD-034). A HERO11's CORI is
       * 274 quaternions in ten seconds; an hour of video would be 100,000.
       */
      expect(stream.sourceSampleCount).toBeUndefined();
      expect(stream.sampleRateHz).toBeUndefined();
    }
  }, 60_000);

  it('recognizes everything these two cameras write', async () => {
    for (const fixture of ['hero7.raw', 'hero11.raw']) {
      const activity = await fromRaw(fixture, 'GH010042.mp4');
      expect(
        activity.warnings.find((w) => w.code === 'gopro_unrecognized_streams'),
      ).toBeUndefined();
    }
  }, 60_000);
});

describe('camera temperature is not the weather (AV-905)', () => {
  it('charts what a HERO11 recorded of its own heat', async () => {
    const activity = await fromRaw('hero11.raw', 'GH011234.mp4');
    const temperature = activity.sensorStreams?.find((s) => s.key === 'TMPC');
    const values = (temperature?.valuesByPoint ?? []).filter((v): v is number => v !== undefined);

    expect(temperature?.label).toBe('Camera temperature');
    // The camera states it about once a second and the GPS writes ten points in
    // that time, so most points are covered only because the last stated value
    // is carried forward — which is what sticky means.
    expect(temperature?.sourceSampleCount).toBeLessThan(activity.points.length / 4);
    expect(values.length).toBeGreaterThan(activity.points.length * 0.8);
    // A sealed black body in September sun in Galicia: the camera reads above
    // 45 °C while the air around it was nowhere near that.
    expect(Math.max(...values)).toBeGreaterThan(45);
  }, 60_000);

  it('never lets it reach the activity temperature the viewer labels', async () => {
    const activity = await fromRaw('hero11.raw', 'GH011234.mp4');

    // The trap this whole separation exists for: `temperatureCelsius` is what
    // the viewer charts as "Temperature", and a reader takes that for the air.
    expect(activity.points.every((point) => point.temperatureCelsius === undefined)).toBe(true);
    expect(activity.streams.hasTemperature).toBe(false);
  }, 60_000);

  it('finds none in a HERO7, which never states one', async () => {
    const activity = await fromRaw('hero7.raw', 'GH010042.mp4');

    expect(activity.sensorStreams?.find((s) => s.key === 'TMPC')).toBeUndefined();
  }, 60_000);
});
