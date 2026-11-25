import type { UnitSystem } from '../domain/units';
import {
  MISSING,
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  formatTemperature,
  paceUnitLabel,
  speedUnitLabel,
  toDisplayPace,
  toDisplaySpeed,
} from '../domain/units';
import type { OverlayMetric, OverlayTimeline } from './timeline';

/**
 * AV-1003. What an overlay looks like, as data.
 *
 * A template is plain JSON-able values and nothing else — no functions, no
 * canvas, no references — because it has to be saved to a file (AV-1003's
 * project JSON), restored from one, and rendered the same way by the preview
 * and by the exporter. Everything that *draws* lives elsewhere and reads this.
 *
 * Positions and sizes are fractions of the frame (0 to 1), not pixels, so one
 * template fits a 1080p video, a 4K video and a vertical phone clip alike.
 */

/** A rectangle in frame fractions: `x`/`y` is the top-left corner. */
export interface OverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayStyle {
  /** Main text and line colour. Any CSS colour. */
  color: string;
  /** Needle, marker and highlight colour. */
  accentColor: string;
  /** Panel behind the component; `transparent` for none. */
  backgroundColor: string;
  /** Multiplies the component's base text size. */
  fontScale: number;
}

/**
 * Where a component's number comes from. A built-in measurement, or a camera
 * stream by its key (`AV-905`), so a gauge can show a sensor with no special
 * case in the template.
 */
export type DataBinding =
  | { kind: 'metric'; metric: OverlayMetric }
  | { kind: 'sensor'; key: string };

interface ComponentBase {
  /** Unique within a template; the handle for hiding, moving and warning about it. */
  id: string;
  /** The user's switch. A visible component with no data is still hidden (see `resolveTemplate`). */
  visible: boolean;
  box: OverlayBox;
  style: OverlayStyle;
}

/** A labelled number: `SPEED  24.3 km/h`. */
export interface TextComponent extends ComponentBase {
  type: 'text';
  binding: DataBinding;
  /** Overrides the default label. Empty string shows the value alone. */
  label?: string;
}

/** A dial between `min` and `max`, in display units of the bound metric. */
export interface GaugeComponent extends ComponentBase {
  type: 'gauge';
  binding: DataBinding;
  min: number;
  max: number;
  label?: string;
}

/** The whole route, with a dot for where the video is now. */
export interface RouteComponent extends ComponentBase {
  type: 'route';
  lineWidth: number;
  showMarker: boolean;
}

/** How far through the telemetry the video is. */
export interface ProgressComponent extends ComponentBase {
  type: 'progress';
}

/** The last few seconds of a measurement as a line. */
export interface ChartComponent extends ComponentBase {
  type: 'chart';
  binding: DataBinding;
  windowSeconds: number;
}

export type OverlayComponent =
  | TextComponent
  | GaugeComponent
  | RouteComponent
  | ProgressComponent
  | ChartComponent;

export type OverlayComponentType = OverlayComponent['type'];

export interface OverlayTemplate {
  name: string;
  /** Units the numbers are shown in. */
  units: UnitSystem;
  components: OverlayComponent[];
}

// ---------------------------------------------------------------- metrics

interface MetricInfo {
  label: string;
  /** What a camera or watch must have recorded for the metric to exist. */
  needs: string;
}

export const METRIC_INFO: Record<OverlayMetric, MetricInfo> = {
  speed: { label: 'Speed', needs: 'GPS positions with timestamps' },
  pace: { label: 'Pace', needs: 'GPS positions with timestamps' },
  distance: { label: 'Distance', needs: 'GPS positions' },
  elapsed: { label: 'Time', needs: 'timestamps' },
  elevation: { label: 'Elevation', needs: 'altitude readings' },
  heartRate: { label: 'Heart rate', needs: 'a heart-rate sensor' },
  cadence: { label: 'Cadence', needs: 'a running cadence sensor' },
  cyclingCadence: { label: 'Pedal cadence', needs: 'a cycling cadence sensor' },
  power: { label: 'Power', needs: 'a power meter' },
  temperature: { label: 'Temperature', needs: 'a temperature sensor' },
  grade: { label: 'Grade', needs: 'a grade reading' },
};

export interface MetricDisplay {
  /** The finished text, with its unit: `24.3 km/h`. */
  text: string;
  /** The unit alone, for a gauge's dial. */
  unit: string;
  /** The value in display units, for placing a needle. Absent when there is no reading. */
  value?: number;
}

/**
 * A raw value (metric units, as stored) as it should read on screen, in the
 * template's unit system. One place, built on the formatters the viewer uses,
 * so an overlay never shows a figure the viewer would word differently.
 */
export function displayMetric(
  metric: OverlayMetric,
  raw: number | undefined,
  units: UnitSystem,
): MetricDisplay {
  if (raw === undefined || !Number.isFinite(raw)) return { text: MISSING, unit: unitLabel(metric, units) };

  switch (metric) {
    case 'speed':
      return { text: formatSpeed(raw, units), unit: speedUnitLabel(units), value: toDisplaySpeed(raw, units) };
    case 'pace':
      return { text: formatPace(raw, units), unit: paceUnitLabel(units), value: toDisplayPace(raw, units) };
    case 'distance':
      return { text: formatDistance(raw, units), unit: units === 'imperial' ? 'mi' : 'km', value: units === 'imperial' ? raw / 1609.344 : raw / 1000 };
    case 'elapsed':
      return { text: formatDuration(raw), unit: '', value: raw };
    case 'elevation':
      return { text: formatElevation(raw, units), unit: units === 'imperial' ? 'ft' : 'm', value: units === 'imperial' ? raw / 0.3048 : raw };
    case 'temperature':
      return { text: formatTemperature(raw, units), unit: unitLabel(metric, units), value: units === 'imperial' ? raw * 1.8 + 32 : raw };
    case 'heartRate':
      return { text: `${Math.round(raw)} bpm`, unit: 'bpm', value: raw };
    case 'cadence':
      return { text: `${Math.round(raw)} spm`, unit: 'spm', value: raw };
    case 'cyclingCadence':
      return { text: `${Math.round(raw)} rpm`, unit: 'rpm', value: raw };
    case 'power':
      return { text: `${Math.round(raw)} W`, unit: 'W', value: raw };
    case 'grade':
      return { text: `${raw.toFixed(1)} %`, unit: '%', value: raw };
  }
}

function unitLabel(metric: OverlayMetric, units: UnitSystem): string {
  switch (metric) {
    case 'speed':
      return speedUnitLabel(units);
    case 'pace':
      return paceUnitLabel(units);
    case 'distance':
      return units === 'imperial' ? 'mi' : 'km';
    case 'elevation':
      return units === 'imperial' ? 'ft' : 'm';
    case 'temperature':
      return units === 'imperial' ? '°F' : '°C';
    case 'heartRate':
      return 'bpm';
    case 'cadence':
      return 'spm';
    case 'cyclingCadence':
      return 'rpm';
    case 'power':
      return 'W';
    case 'grade':
      return '%';
    case 'elapsed':
      return '';
  }
}

// ------------------------------------------------------------ availability

/** What the activity behind an overlay can supply. */
export interface OverlayDataAvailability {
  metrics: ReadonlySet<OverlayMetric>;
  sensors: ReadonlySet<string>;
  /** The route can be drawn. */
  hasRoute: boolean;
  /** There is a clock, so time-based components can run. */
  hasTimeline: boolean;
}

/** Works out what a built timeline can supply. */
export function availabilityOf(timeline: OverlayTimeline): OverlayDataAvailability {
  const metrics = new Set<OverlayMetric>(['elapsed']);
  for (const channel of timeline.available) {
    if (channel !== 'lat' && channel !== 'lon') metrics.add(channel);
  }
  return {
    metrics,
    sensors: timeline.availableSensors,
    hasRoute: timeline.available.has('lat') && timeline.available.has('lon'),
    hasTimeline: true,
  };
}

/** For an activity with no clock: a still route is possible, nothing else is. */
export function staticAvailability(hasRoute: boolean): OverlayDataAvailability {
  return { metrics: new Set(), sensors: new Set(), hasRoute, hasTimeline: false };
}

export interface HiddenComponent {
  component: OverlayComponent;
  reason: string;
}

export interface ResolvedTemplate {
  /** What to draw: switched on, and with data to show. */
  components: OverlayComponent[];
  /** Switched on but unable to show anything; the reason is for the user. */
  hidden: HiddenComponent[];
}

const bindingLabel = (binding: DataBinding): string =>
  binding.kind === 'metric' ? METRIC_INFO[binding.metric].label : `The ${binding.key} stream`;

/**
 * Decides what actually gets drawn. A component the user switched off is simply
 * gone. One that is on but has nothing to show — a heart-rate readout for a ride
 * with no heart-rate strap — is *hidden and reported*, so the frame has no
 * broken placeholder and the user is told why a thing they enabled is missing.
 */
export function resolveTemplate(
  template: OverlayTemplate,
  availability: OverlayDataAvailability,
): ResolvedTemplate {
  const components: OverlayComponent[] = [];
  const hidden: HiddenComponent[] = [];

  for (const component of template.components) {
    if (!component.visible) continue;
    const reason = unavailableReason(component, availability);
    if (reason) hidden.push({ component, reason });
    else components.push(component);
  }
  return { components, hidden };
}

function unavailableReason(
  component: OverlayComponent,
  availability: OverlayDataAvailability,
): string | undefined {
  switch (component.type) {
    case 'route':
      return availability.hasRoute ? undefined : 'This activity has no GPS route to draw.';
    case 'progress':
      return availability.hasTimeline ? undefined : 'This activity has no timestamps to measure progress by.';
    case 'text':
    case 'gauge':
    case 'chart': {
      if (!availability.hasTimeline) {
        return 'This activity has no timestamps, so values cannot follow a video.';
      }
      const { binding } = component;
      if (binding.kind === 'metric') {
        return availability.metrics.has(binding.metric)
          ? undefined
          : `${bindingLabel(binding)} is not in this activity (it needs ${METRIC_INFO[binding.metric].needs}).`;
      }
      return availability.sensors.has(binding.key)
        ? undefined
        : `${bindingLabel(binding)} is not in this recording.`;
    }
  }
}

// ----------------------------------------------------------------- presets

const WHITE = '#ffffff';
const ACCENT = '#ffd166';
const PANEL = 'rgba(11, 15, 20, 0.55)';

const style = (overrides: Partial<OverlayStyle> = {}): OverlayStyle => ({
  color: WHITE,
  accentColor: ACCENT,
  backgroundColor: PANEL,
  fontScale: 1,
  ...overrides,
});

const metric = (m: OverlayMetric): DataBinding => ({ kind: 'metric', metric: m });

/** A small block of readouts in the top-left corner. */
export function compactHudTemplate(units: UnitSystem = 'metric'): OverlayTemplate {
  const row = (id: string, m: OverlayMetric, index: number): TextComponent => ({
    id,
    type: 'text',
    visible: true,
    binding: metric(m),
    box: { x: 0.03, y: 0.04 + index * 0.07, width: 0.2, height: 0.06 },
    style: style(),
  });
  return {
    name: 'Compact HUD',
    units,
    components: [
      row('speed', 'speed', 0),
      row('distance', 'distance', 1),
      row('time', 'elapsed', 2),
      row('elevation', 'elevation', 3),
      { ...row('heart-rate', 'heartRate', 4), visible: false },
    ],
  };
}

/** The route in the bottom-right corner, with a progress bar under it. */
export function routeInsetTemplate(units: UnitSystem = 'metric'): OverlayTemplate {
  return {
    name: 'Route inset',
    units,
    components: [
      {
        id: 'route',
        type: 'route',
        visible: true,
        box: { x: 0.74, y: 0.58, width: 0.23, height: 0.3 },
        style: style({ backgroundColor: 'rgba(11, 15, 20, 0.35)' }),
        lineWidth: 4,
        showMarker: true,
      },
      {
        id: 'progress',
        type: 'progress',
        visible: true,
        box: { x: 0.74, y: 0.9, width: 0.23, height: 0.02 },
        style: style(),
      },
    ],
  };
}

/** Dials along the bottom edge: speed, heart rate, cadence and power. */
export function gaugeDashboardTemplate(units: UnitSystem = 'metric'): OverlayTemplate {
  const dial = (
    id: string,
    m: OverlayMetric,
    index: number,
    min: number,
    max: number,
  ): GaugeComponent => ({
    id,
    type: 'gauge',
    visible: true,
    binding: metric(m),
    min,
    max,
    box: { x: 0.04 + index * 0.115, y: 0.74, width: 0.105, height: 0.2 },
    style: style(),
  });
  const speedMax = units === 'imperial' ? 40 : 60;
  return {
    name: 'Gauge dashboard',
    units,
    components: [
      dial('speed', 'speed', 0, 0, speedMax),
      dial('heart-rate', 'heartRate', 1, 40, 200),
      dial('cadence', 'cyclingCadence', 2, 0, 140),
      dial('power', 'power', 3, 0, 500),
    ],
  };
}

export const BUILT_IN_TEMPLATES = [
  { id: 'compact-hud', label: 'Compact HUD', create: compactHudTemplate },
  { id: 'route-inset', label: 'Route inset', create: routeInsetTemplate },
  { id: 'gauge-dashboard', label: 'Gauge dashboard', create: gaugeDashboardTemplate },
] as const;
