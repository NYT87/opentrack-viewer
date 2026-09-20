import type {
  ActivitySensorStream,
  ActivityWarning,
  SensorStreamDisplay,
} from '../../domain/activity';

/**
 * A sample as `gopro-telemetry` emits it for a non-GPS stream. `value` is a
 * scalar for some streams and a vector for others, which is why the catalog
 * below states how each one is reduced.
 */
export interface GoproStreamSample {
  value?: number | number[];
  cts?: number;
  sticky?: Record<string, unknown>;
}

export interface GoproStream {
  name?: string;
  units?: string | string[];
  samples?: GoproStreamSample[];
}

/**
 * The GPMF key camera temperature is reported under. On a HERO5/6 it is a
 * stream of its own; from the HERO8 on it rides along as a sticky value on the
 * IMU streams. Both end up here, under one key, because to a reader they are
 * the same measurement.
 */
const TEMPERATURE_KEY = 'TMPC';

/** The sticky field the IMU streams carry it in. */
const STICKY_TEMPERATURE = 'temperature [°C]';

/**
 * The one caveat in this file that changes what a number *means*. A GoPro
 * measures the temperature of its own sensor board, which sits behind a lens in
 * a sealed plastic body in the sun: the HERO11 fixture reads 52 °C on a
 * September afternoon in Galicia. It is a useful signal about the camera — and
 * it is not the weather. It is therefore never written to
 * `ActivityPoint.temperatureCelsius`, which the viewer labels "Temperature" and
 * a reader would take for air temperature.
 */
const CAMERA_TEMPERATURE_NOTE =
  'The camera measuring itself, not the air: a body in the sun reads far above ambient.';

/**
 * How long a recording may be before its IMU streams are declared rather than
 * charted.
 *
 * A GoPro writes acceleration and rotation at ~200 Hz. Grouping reduces what is
 * *kept* to roughly one value per activity point, but the library builds every
 * sample before it groups them, so the transient cost still rises with the
 * length of the video: twenty minutes is around 240,000 samples per stream, and
 * an hour is three times that — on the main thread, in a tab that also holds
 * the route and the map.
 *
 * So there is a limit, and past it these two streams are treated like the other
 * uncharted ones: named, with a warning saying why. The route, elevation and
 * every other chart are unaffected, because they come from the GPS pass. The
 * limit can rise when extraction moves into a worker of our own (`TD-025`).
 */
const MAX_SENSOR_SPAN_MS = 20 * 60 * 1_000;

/**
 * Whether the high-rate streams are worth reading, and when not, why not.
 *
 * The two reasons are different situations and want different words, so the
 * decision carries which one it is rather than leaving the caller to guess
 * from a `false`.
 *
 * **Both spans matter.** The GPS points establish one, and it is the honest
 * measure when the camera had a fix throughout. But a fix can come and go: a
 * two-hour ride that only held satellites for five minutes has a five-minute
 * point span and two hours of accelerometer behind it, and judging on the
 * points alone would wave through 1.4 million samples. So the longer of the
 * two is what counts.
 */
export type SensorReadDecision =
  | { read: true }
  | { read: false; reason: 'no_camera_clock' }
  | { read: false; reason: 'too_long'; minutes: number };

export function decideSensorRead(
  pointCtsMs: number[] | undefined,
  videoDurationSeconds: number | undefined,
): SensorReadDecision {
  // Without a clock there is nothing to align the samples to, so reading them
  // would produce a stream of values with nowhere to put them.
  if (!pointCtsMs) return { read: false, reason: 'no_camera_clock' };

  const durationMs = Number.isFinite(videoDurationSeconds)
    ? (videoDurationSeconds as number) * 1_000
    : 0;
  const spanMs = Math.max(telemetrySpanMs(pointCtsMs), durationMs);

  if (spanMs > MAX_SENSOR_SPAN_MS) {
    return { read: false, reason: 'too_long', minutes: Math.round(spanMs / 60_000) };
  }
  return { read: true };
}

/** Vector streams collapse to one number; scalar streams already are one. */
type Reduction = 'magnitude' | 'scalar';

interface StreamSpec {
  label: string;
  unit?: string;
  display: SensorStreamDisplay;
  note?: string;
  /** Required when `display` is `chart`; ignored otherwise. */
  reduce?: Reduction;
}

/**
 * AV-905. Every non-GPS stream this app knows about, and what it does with it.
 *
 * `chart` is deliberately short. A stream earns a chart by telling a reader
 * something about the *activity* — how roughly it went, how sharply it turned,
 * how hot the camera got. The rest describe the picture rather than the ride:
 * white balance, scene classification and predominant hue belong to a colourist,
 * and a per-frame orientation quaternion is an input to a renderer (`E10`), not
 * a line on a chart. Those are declared, so a reader knows the video holds them,
 * and left at that.
 *
 * Nothing here is export-only: GPX, TCX and FIT have nowhere to put a camera
 * quaternion, so the exporters carry none of it rather than inventing
 * extensions no other tool would read (`TD-019`).
 */
const CATALOG: Record<string, StreamSpec> = {
  ACCL: {
    label: 'Acceleration',
    unit: 'm/s²',
    display: 'chart',
    reduce: 'magnitude',
    note: 'Total acceleration the camera felt, gravity included: about 9.8 m/s² while still.',
  },
  GYRO: {
    label: 'Rotation rate',
    unit: 'rad/s',
    display: 'chart',
    reduce: 'magnitude',
    note: 'How fast the camera was turning, about all three axes at once.',
  },
  [TEMPERATURE_KEY]: {
    label: 'Camera temperature',
    unit: '°C',
    display: 'chart',
    reduce: 'scalar',
    note: CAMERA_TEMPERATURE_NOTE,
  },

  // Orientation and motion, kept for `E10` overlays rather than for charts.
  GRAV: { label: 'Gravity vector', display: 'hidden' },
  CORI: { label: 'Camera orientation', display: 'hidden' },
  IORI: { label: 'Image orientation', display: 'hidden' },
  MAGN: { label: 'Magnetometer', unit: 'µT', display: 'hidden' },

  // Exposure and colour: about the picture, not the activity.
  SHUT: { label: 'Shutter speed', unit: 's', display: 'hidden' },
  ISOE: { label: 'Sensor ISO', display: 'hidden' },
  ISOG: { label: 'Sensor ISO gain', display: 'hidden' },
  WBAL: { label: 'White balance', unit: 'K', display: 'hidden' },
  WRGB: { label: 'White balance gains', display: 'hidden' },
  UNIF: { label: 'Image uniformity', display: 'hidden' },
  YAVG: { label: 'Average luminance', display: 'hidden' },
  SCEN: { label: 'Scene classification', display: 'hidden' },
  HUES: { label: 'Predominant hue', display: 'hidden' },
  SROT: { label: 'Sensor readout time', display: 'hidden' },

  // Audio and capture housekeeping.
  AALP: { label: 'Audio level', unit: 'dBFS', display: 'hidden' },
  WNDM: { label: 'Wind processing', display: 'hidden' },
  MWET: { label: 'Microphone wet', display: 'hidden' },
  MSKP: { label: 'Frame skip', display: 'hidden' },
  LSKP: { label: 'Frame skip, low-resolution copy', display: 'hidden' },

  /**
   * Where faces were in the frame. Hidden and never exported, and not because
   * it is uninteresting: it locates people, and nothing in this app has any
   * business plotting that.
   */
  FACE: { label: 'Face detection', display: 'hidden' },

  /** Moments the user tagged with the button, or the camera tagged for them. */
  HLMT: { label: 'Highlight tags', display: 'hidden' },
};

/** The route itself, read by `parseGopro`; not a sensor stream. */
const GPS_KEYS = new Set(['GPS5', 'GPS9', 'GPSF', 'GPSP', 'GPSU', 'GPSA']);

/**
 * `FACE1`, `FACE2` … are one stream per detected face. They are the same
 * measurement, so they are declared once.
 */
function catalogKey(streamKey: string): string {
  return /^FACE\d+$/.test(streamKey) ? 'FACE' : streamKey;
}

export interface SensorStreamResult {
  sensorStreams: ActivitySensorStream[];
  warnings: ActivityWarning[];
}

/**
 * AV-905. Which of the declared streams are worth parsing.
 *
 * Called before the payload is interpreted, against the cheap key-and-name
 * listing, so that everything else is skipped during parsing rather than built
 * and then thrown away. On a long recording that is the difference between
 * holding a few thousand samples and holding a million: a GoPro writes
 * acceleration at ~200 Hz, so an hour of video is 720,000 samples of three
 * floats in a stream nobody charts.
 */
export function chartableStreamKeys(declared: Record<string, string>): string[] {
  return Object.keys(declared).filter((key) => CATALOG[catalogKey(key)]?.display === 'chart');
}

/**
 * AV-905. Turns the streams beside the GPS track into `ActivitySensorStream`s.
 *
 * `declared` is every stream the file announces, from the cheap listing pass:
 * key to the name the library gives it. `parsed` holds only the ones that were
 * actually read — the chartable ones. A stream in `declared` but not in
 * `parsed` is reported by name alone, which is all it costs to say it is there.
 *
 * `pointCtsMs` is the composition timestamp of the GPS sample each activity
 * point came from — the camera's own clock, in milliseconds from the first
 * frame. Alignment runs on it rather than on wall-clock dates because every
 * stream in the file shares that clock, while the dates are reconstructed from
 * whatever the GPS receiver happened to know.
 */
export function readSensorStreams(
  declared: Record<string, string>,
  parsed: Record<string, GoproStream | undefined>,
  pointCtsMs: number[] | undefined,
): SensorStreamResult {
  const sensorStreams: ActivitySensorStream[] = [];
  const unrecognized: string[] = [];

  for (const [streamKey, name] of Object.entries(declared)) {
    if (GPS_KEYS.has(streamKey)) continue;

    const key = catalogKey(streamKey);
    const spec = CATALOG[key];
    if (!spec) {
      // Named as the file names it, so a reader can look it up rather than
      // being handed four letters.
      const label = name && name !== streamKey ? `${name} (${streamKey})` : streamKey;
      if (!unrecognized.includes(label)) unrecognized.push(label);
      continue;
    }
    // One entry for the whole FACE family; the first one seen declares it.
    if (sensorStreams.some((existing) => existing.key === key)) continue;

    sensorStreams.push(describe(key, spec, parsed[streamKey], pointCtsMs));
  }

  const temperature = readStickyTemperature(parsed, pointCtsMs);
  if (temperature && !sensorStreams.some((stream) => stream.key === TEMPERATURE_KEY)) {
    sensorStreams.push(temperature);
  }

  // Order by what the reader sees first, then by label, so the list is stable
  // whatever order the container happened to write the streams in.
  sensorStreams.sort(
    (a, b) =>
      Number(b.display === 'chart') - Number(a.display === 'chart') ||
      a.label.localeCompare(b.label),
  );

  const warnings: ActivityWarning[] = [];
  if (unrecognized.length > 0) {
    warnings.push({
      code: 'gopro_unrecognized_streams',
      message:
        `This video also carries telemetry this app does not recognize (${unrecognized.join(', ')}). ` +
        'It is left out rather than guessed at.',
      severity: 'info',
    });
  }

  return { sensorStreams, warnings };
}

function describe(
  key: string,
  spec: StreamSpec,
  parsed: GoproStream | undefined,
  pointCtsMs: number[] | undefined,
): ActivitySensorStream {
  const samples = parsed?.samples ?? [];
  const unit = spec.unit ?? (typeof parsed?.units === 'string' ? parsed.units : undefined);
  const rate = sampleRateHz(samples);
  const values =
    spec.display === 'chart' && pointCtsMs
      ? alignToPoints(samples, pointCtsMs, spec.reduce ?? 'scalar')
      : undefined;

  /*
   * A stream the camera clock could not place has no chart to appear on, so
   * calling it charted would make it vanish: the charts would skip it for
   * having no values and the "also in this file" list would skip it for being
   * charted. It is declared instead, which is what it actually is.
   */
  const charted = values?.some((value) => value !== undefined) ?? false;

  return {
    key,
    label: spec.label,
    ...(unit ? { unit } : {}),
    display: charted ? 'chart' : 'hidden',
    ...(spec.note ? { note: spec.note } : {}),
    ...(rate !== undefined ? { sampleRateHz: rate } : {}),
    ...(samples.length > 0 ? { sourceSampleCount: samples.length } : {}),
    ...(charted ? { valuesByPoint: values } : {}),
  };
}

/**
 * Camera temperature as the HERO8 onward reports it: a sticky value on the IMU
 * streams.
 *
 * **Sticky means stated once and implied thereafter** — the same rule the GPS
 * fix follows in `parseGopro`. The HERO11 fixture states it 11 times across
 * 2,192 accelerometer samples, once per payload, and reading it per sample
 * would find a temperature for 11 of them and nothing for the rest.
 */
function readStickyTemperature(
  parsed: Record<string, GoproStream | undefined>,
  pointCtsMs: number[] | undefined,
): ActivitySensorStream | undefined {
  const source = parsed.ACCL?.samples ?? parsed.GYRO?.samples ?? [];

  const carried: GoproStreamSample[] = [];
  const stated: GoproStreamSample[] = [];
  let current: number | undefined;

  for (const sample of source) {
    const value = sample.sticky?.[STICKY_TEMPERATURE];
    if (typeof value === 'number' && Number.isFinite(value)) {
      current = value;
      stated.push(sample);
    }
    if (current !== undefined) carried.push({ cts: sample.cts, value: current });
  }

  if (stated.length === 0) return undefined;

  const spec = CATALOG[TEMPERATURE_KEY]!;
  const rate = sampleRateHz(stated);
  const values = pointCtsMs ? alignToPoints(carried, pointCtsMs, 'scalar') : undefined;
  const charted = values?.some((value) => value !== undefined) ?? false;

  return {
    key: TEMPERATURE_KEY,
    label: spec.label,
    unit: spec.unit!,
    display: charted ? 'chart' : 'hidden',
    note: spec.note!,
    ...(rate !== undefined ? { sampleRateHz: rate } : {}),
    // What the file stated, not what carrying it forward produced.
    sourceSampleCount: stated.length,
    ...(charted ? { valuesByPoint: values } : {}),
  };
}

/**
 * Reduces a high-rate stream to one value per activity point.
 *
 * Each point owns the interval from its own timestamp up to the next point's,
 * and takes the mean of whatever fell inside it. Mean rather than peak: a peak
 * makes every chart a picket fence of isolated spikes, while the mean of 200 Hz
 * acceleration across a second of riding is the number a reader can compare
 * against the second before it. The last point is given the median interval, so
 * the tail of the file is not silently dropped.
 */
function alignToPoints(
  samples: GoproStreamSample[],
  pointCtsMs: number[],
  reduce: Reduction,
): (number | undefined)[] {
  const values: (number | undefined)[] = new Array(pointCtsMs.length).fill(undefined);
  if (pointCtsMs.length === 0) return values;

  const timed = samples
    .filter((sample): sample is GoproStreamSample & { cts: number } =>
      Number.isFinite(sample.cts),
    )
    .sort((a, b) => a.cts - b.cts);
  if (timed.length === 0) return values;

  const tail = medianInterval(pointCtsMs);
  let cursor = 0;

  for (let i = 0; i < pointCtsMs.length; i += 1) {
    const from = pointCtsMs[i]!;
    const to = i + 1 < pointCtsMs.length ? pointCtsMs[i + 1]! : from + tail;

    // Samples before this point's window belong to an earlier one, or to none.
    while (cursor < timed.length && timed[cursor]!.cts < from) cursor += 1;

    let total = 0;
    let count = 0;
    for (let j = cursor; j < timed.length && timed[j]!.cts < to; j += 1) {
      const scalar = toScalar(timed[j]!.value, reduce);
      if (scalar === undefined) continue;
      total += scalar;
      count += 1;
    }

    if (count > 0) values[i] = total / count;
  }

  return values;
}

function toScalar(value: number | number[] | undefined, reduce: Reduction): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;

  if (reduce === 'scalar') {
    const first = value[0];
    return Number.isFinite(first) ? first : undefined;
  }

  // Magnitude, so the answer does not depend on which axis order the camera
  // happens to write: a HERO7 labels its accelerometer (z,x,y).
  let sum = 0;
  for (const component of value) {
    if (!Number.isFinite(component)) return undefined;
    sum += component * component;
  }
  return Math.sqrt(sum);
}

/**
 * The interval the activity's own points run at, in milliseconds. Used to size
 * the grouping the library applies while interpreting, so a 200 Hz stream is
 * reduced towards the rate of the points it will be charted against rather
 * than arriving whole (TD-034).
 */
export function pointIntervalMs(pointCtsMs: number[]): number {
  return medianInterval(pointCtsMs);
}

/**
 * The span the telemetry covers, in milliseconds — how long the camera was
 * recording, as its own clock saw it.
 */
export function telemetrySpanMs(pointCtsMs: number[]): number {
  const first = pointCtsMs[0];
  const last = pointCtsMs[pointCtsMs.length - 1];
  return first === undefined || last === undefined ? 0 : last - first;
}

function medianInterval(pointCtsMs: number[]): number {
  if (pointCtsMs.length < 2) return 1_000;

  const gaps: number[] = [];
  for (let i = 1; i < pointCtsMs.length; i += 1) {
    const gap = pointCtsMs[i]! - pointCtsMs[i - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 1_000;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/** The rate the samples themselves establish, rather than one taken on trust. */
function sampleRateHz(samples: GoproStreamSample[]): number | undefined {
  const first = samples[0]?.cts;
  const last = samples[samples.length - 1]?.cts;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;

  const seconds = (last! - first!) / 1_000;
  if (seconds <= 0) return undefined;

  const rate = (samples.length - 1) / seconds;
  return Math.round(rate * 10) / 10;
}
