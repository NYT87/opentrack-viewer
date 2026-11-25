import type { Activity } from '../domain/activity';
import { createRouteProjector, type RouteProjector, type ScreenPoint } from '../domain/routeProjection';
import {
  METRIC_INFO,
  displayMetric,
  resolveTemplate,
  type ChartComponent,
  type DataBinding,
  type GaugeComponent,
  type OverlayComponent,
  type OverlayDataAvailability,
  type OverlayTemplate,
  type ProgressComponent,
  type ResolvedTemplate,
  type RouteComponent,
  type TextComponent,
} from './template';
import { metricValue, sampleTimeline, type OverlaySample, type OverlayTimeline } from './timeline';

/** The part of a 2D canvas context the overlay draws with. */
export interface OverlayContext2D {
  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  stroke(): void;
  fill(): void;
  save(): void;
  restore(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
}

export interface OverlayRenderInput {
  activity: Activity;
  /** Absent for an activity with no clock: only still components can be drawn. */
  timeline?: OverlayTimeline;
  template: OverlayTemplate;
  availability: OverlayDataAvailability;
}

export interface OverlayRenderer {
  /** What will be drawn and what was hidden for lack of data. */
  resolved: ResolvedTemplate;
  /**
   * Draws one frame. `videoSeconds` and `offsetSeconds` are the same two
   * numbers `sampleTimeline` takes: a frame is a pure function of them, so a
   * frame exported later is identical to the one previewed now.
   */
  render(
    context: OverlayContext2D,
    width: number,
    height: number,
    videoSeconds: number,
    offsetSeconds: number,
    options?: RenderFrameOptions,
  ): void;
}

export interface RenderFrameOptions {
  /**
   * Clear the canvas before drawing (the default), so the frame is the overlay
   * alone on transparency. Burned-in export turns it off: the video frame is
   * already on the canvas and the overlay is drawn over it.
   */
  clear?: boolean;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Enough vertices for a route in a corner of a frame; more is invisible. */
const MAX_ROUTE_VERTICES = 1500;
const CHART_STEPS = 48;
const GAUGE_START = Math.PI * 0.75;
const GAUGE_SWEEP = Math.PI * 1.5;

/** Keeps the first and last point and every segment boundary. */
function decimate(segments: ScreenPoint[][], limit: number): ScreenPoint[][] {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (total <= limit) return segments;
  const stride = Math.ceil(total / limit);
  return segments.map((segment) =>
    segment.filter((_, index) => index % stride === 0 || index === segment.length - 1),
  );
}

interface CachedRoute {
  projector: RouteProjector;
  drawn: ScreenPoint[][];
}

/**
 * AV-1004. Draws overlay frames.
 *
 * Built once per template and activity — which is when the route is projected —
 * and then asked for frames. It owns no canvas and no timer: whoever plays the
 * video (the preview) or steps through it (the exporter) hands it a context and
 * a time.
 *
 * What is missing at a given moment is not drawn at all. A component never
 * shows a dash, a zero or a stale value: if the telemetry has no answer for
 * that second (a gap, a pause, before the recording began) the component is
 * simply absent from that frame.
 */
export function createOverlayRenderer(input: OverlayRenderInput): OverlayRenderer {
  const { activity, timeline, template, availability } = input;
  const resolved = resolveTemplate(template, availability);
  const routes = new Map<string, CachedRoute>();

  const routeFor = (width: number, height: number): CachedRoute | undefined => {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    const cached = routes.get(key);
    if (cached) return cached;
    try {
      const padding = Math.min(width, height) * 0.1;
      const projector = createRouteProjector(activity.points, { width, height, padding });
      const entry = { projector, drawn: decimate(projector.route.segments, MAX_ROUTE_VERTICES) };
      routes.set(key, entry);
      return entry;
    } catch {
      return undefined;
    }
  };

  function render(
    context: OverlayContext2D,
    width: number,
    height: number,
    videoSeconds: number,
    offsetSeconds: number,
    options: RenderFrameOptions = {},
  ): void {
    if (options.clear !== false) context.clearRect(0, 0, width, height);
    const sample = timeline ? sampleTimeline(timeline, videoSeconds, offsetSeconds) : undefined;

    for (const component of resolved.components) {
      const box = {
        x: component.box.x * width,
        y: component.box.y * height,
        width: component.box.width * width,
        height: component.box.height * height,
      };
      context.save();
      try {
        draw(component, box, context, sample, videoSeconds, offsetSeconds);
      } finally {
        context.restore();
      }
    }
  }

  function draw(
    component: OverlayComponent,
    box: Box,
    context: OverlayContext2D,
    sample: OverlaySample | undefined,
    videoSeconds: number,
    offsetSeconds: number,
  ): void {
    switch (component.type) {
      case 'text':
        return drawText(component, box, context, sample);
      case 'gauge':
        return drawGauge(component, box, context, sample);
      case 'route':
        return drawRoute(component, box, context, sample);
      case 'progress':
        return drawProgress(component, box, context, sample);
      case 'chart':
        return drawChart(component, box, context, sample, videoSeconds, offsetSeconds);
    }
  }

  /** The reading a binding has in this sample, in raw (stored) units. */
  function readBinding(binding: DataBinding, sample: OverlaySample | undefined): number | undefined {
    if (!sample || sample.status !== 'ok') return undefined;
    return binding.kind === 'metric' ? metricValue(sample, binding.metric) : sample.sensors[binding.key];
  }

  function bindingLabel(binding: DataBinding): string {
    return binding.kind === 'metric' ? METRIC_INFO[binding.metric].label : binding.key;
  }

  function formatReading(binding: DataBinding, raw: number): { text: string; value: number; unit: string } {
    if (binding.kind === 'metric') {
      const shown = displayMetric(binding.metric, raw, template.units);
      return { text: shown.text, value: shown.value ?? raw, unit: shown.unit };
    }
    return { text: Number(raw.toFixed(2)).toString(), value: raw, unit: '' };
  }

  function panel(component: OverlayComponent, box: Box, context: OverlayContext2D): void {
    if (component.style.backgroundColor === 'transparent') return;
    context.fillStyle = component.style.backgroundColor;
    context.fillRect(box.x, box.y, box.width, box.height);
  }

  /** Shrinks text until it fits `maxWidth`, never below a readable floor. */
  function fit(context: OverlayContext2D, text: string, weight: string, size: number, maxWidth: number): number {
    let current = size;
    context.font = `${weight} ${current}px ${FONT}`;
    while (current > size * 0.4 && context.measureText(text).width > maxWidth) {
      current *= 0.9;
      context.font = `${weight} ${current}px ${FONT}`;
    }
    return current;
  }

  function drawText(
    component: TextComponent,
    box: Box,
    context: OverlayContext2D,
    sample: OverlaySample | undefined,
  ): void {
    const raw = readBinding(component.binding, sample);
    if (raw === undefined) return;
    const reading = formatReading(component.binding, raw);
    const label = component.label ?? bindingLabel(component.binding);
    const pad = box.height * 0.12;
    const scale = component.style.fontScale;

    panel(component, box, context);
    context.textAlign = 'left';
    context.fillStyle = component.style.color;

    if (label !== '') {
      context.textBaseline = 'top';
      fit(context, label, '500', box.height * 0.26 * scale, box.width - 2 * pad);
      context.globalAlpha = 0.75;
      context.fillText(label.toUpperCase(), box.x + pad, box.y + pad);
      context.globalAlpha = 1;
    }
    context.textBaseline = 'alphabetic';
    fit(context, reading.text, '700', box.height * 0.5 * scale, box.width - 2 * pad);
    context.fillText(reading.text, box.x + pad, box.y + box.height - pad);
  }

  function drawGauge(
    component: GaugeComponent,
    box: Box,
    context: OverlayContext2D,
    sample: OverlaySample | undefined,
  ): void {
    const raw = readBinding(component.binding, sample);
    if (raw === undefined) return;
    const reading = formatReading(component.binding, raw);
    const fraction = Math.max(0, Math.min(1, (reading.value - component.min) / (component.max - component.min)));

    panel(component, box, context);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height * 0.52;
    const radius = Math.min(box.width / 2, box.height * 0.52) * 0.82;
    context.lineWidth = radius * 0.2;
    context.lineCap = 'round';

    context.strokeStyle = component.style.color;
    context.globalAlpha = 0.25;
    context.beginPath();
    context.arc(cx, cy, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP);
    context.stroke();

    context.globalAlpha = 1;
    if (fraction > 0) {
      context.strokeStyle = component.style.accentColor;
      context.beginPath();
      context.arc(cx, cy, radius, GAUGE_START, GAUGE_START + GAUGE_SWEEP * fraction);
      context.stroke();
    }

    context.fillStyle = component.style.color;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const scale = component.style.fontScale;
    fit(context, reading.text, '700', radius * 0.55 * scale, radius * 1.5);
    context.fillText(reading.text, cx, cy);
    const label = component.label ?? bindingLabel(component.binding);
    if (label !== '') {
      context.textBaseline = 'top';
      fit(context, label, '500', radius * 0.3 * scale, box.width * 0.9);
      context.globalAlpha = 0.75;
      context.fillText(label.toUpperCase(), cx, cy + radius * 0.75);
    }
  }

  function drawRoute(
    component: RouteComponent,
    box: Box,
    context: OverlayContext2D,
    sample: OverlaySample | undefined,
  ): void {
    const cached = routeFor(box.width, box.height);
    if (!cached) return;
    panel(component, box, context);

    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = component.lineWidth;
    context.strokeStyle = component.style.color;
    for (const segment of cached.drawn) {
      if (segment.length < 2) continue;
      context.beginPath();
      segment.forEach((point, index) =>
        index === 0
          ? context.moveTo(box.x + point.x, box.y + point.y)
          : context.lineTo(box.x + point.x, box.y + point.y),
      );
      context.stroke();
    }

    // A marker only where the video says where it is: not before the recording
    // begins, and not across a gap.
    const { lat, lon } = sample?.values ?? {};
    if (component.showMarker && sample?.status === 'ok' && lat !== undefined && lon !== undefined) {
      const at = cached.projector.toScreen(lat, lon);
      context.fillStyle = component.style.accentColor;
      context.beginPath();
      context.arc(box.x + at.x, box.y + at.y, Math.max(component.lineWidth * 1.6, 4), 0, Math.PI * 2);
      context.fill();
    }
  }

  function drawProgress(
    component: ProgressComponent,
    box: Box,
    context: OverlayContext2D,
    sample: OverlaySample | undefined,
  ): void {
    const progress = sample?.progress;
    if (progress === undefined) return;
    context.fillStyle = component.style.color;
    context.globalAlpha = 0.3;
    context.fillRect(box.x, box.y, box.width, box.height);
    context.globalAlpha = 1;
    context.fillStyle = component.style.accentColor;
    context.fillRect(box.x, box.y, box.width * Math.max(0, Math.min(1, progress)), box.height);
  }

  function drawChart(
    component: ChartComponent,
    box: Box,
    context: OverlayContext2D,
    sample: OverlaySample | undefined,
    videoSeconds: number,
    offsetSeconds: number,
  ): void {
    if (!timeline || !sample || sample.status !== 'ok') return;
    const step = component.windowSeconds / CHART_STEPS;
    const points: { age: number; value: number }[] = [];
    for (let i = CHART_STEPS; i >= 0; i -= 1) {
      const at = videoSeconds - i * step;
      const past = sampleTimeline(timeline, at, offsetSeconds);
      const raw = readBinding(component.binding, past);
      if (raw !== undefined) points.push({ age: i, value: formatReading(component.binding, raw).value });
    }
    if (points.length < 2) return;

    let low = Infinity;
    let high = -Infinity;
    for (const { value } of points) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    const range = high - low || 1;
    const pad = box.height * 0.12;
    const place = (p: { age: number; value: number }): ScreenPoint => ({
      x: box.x + pad + (1 - p.age / CHART_STEPS) * (box.width - 2 * pad),
      y: box.y + pad + (1 - (p.value - low) / range) * (box.height - 2 * pad),
    });

    panel(component, box, context);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(2, box.height * 0.04);
    context.strokeStyle = component.style.color;
    context.beginPath();
    points.forEach((p, index) => {
      const at = place(p);
      if (index === 0) context.moveTo(at.x, at.y);
      else context.lineTo(at.x, at.y);
    });
    context.stroke();

    const last = place(points[points.length - 1]!);
    context.fillStyle = component.style.accentColor;
    context.beginPath();
    context.arc(last.x, last.y, context.lineWidth * 1.5, 0, Math.PI * 2);
    context.fill();
  }

  return { resolved, render };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
