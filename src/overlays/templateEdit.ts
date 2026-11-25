import type { UnitSystem } from '../domain/units';
import {
  METRIC_INFO,
  type DataBinding,
  type GaugeComponent,
  type OverlayBox,
  type OverlayComponent,
  type OverlayStyle,
  type OverlayTemplate,
} from './template';
import { MAX_COMPONENTS, isAcceptableColor } from './templateIO';

/**
 * AV-1005. Changes to a template, as pure functions.
 *
 * Every function returns a new template and leaves its argument alone, so an
 * edit can be compared, undone or discarded, and the built-in templates (which
 * are rebuilt from a factory each time) can never be altered by editing a copy.
 * Anything out of range is clamped or refused here, so the controls above this
 * layer cannot put the renderer into a state `parseProject` would reject.
 */

const MIN_SIZE = 0.02;
const MIN_FONT_SCALE = 0.25;
const MAX_FONT_SCALE = 4;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function mapComponent(
  template: OverlayTemplate,
  id: string,
  change: (component: OverlayComponent) => OverlayComponent,
): OverlayTemplate {
  if (!template.components.some((component) => component.id === id)) return template;
  return {
    ...template,
    components: template.components.map((component) =>
      component.id === id ? change(component) : component,
    ),
  };
}

export function setUnits(template: OverlayTemplate, units: UnitSystem): OverlayTemplate {
  return template.units === units ? template : { ...template, units };
}

export function setVisible(template: OverlayTemplate, id: string, visible: boolean): OverlayTemplate {
  return mapComponent(template, id, (component) => ({ ...component, visible }));
}

/**
 * Moves or resizes a component, keeping it entirely inside the frame: a box
 * dragged past an edge stops at the edge, and growing one near an edge pushes
 * it back in rather than letting it hang off the picture.
 */
export function setBox(template: OverlayTemplate, id: string, change: Partial<OverlayBox>): OverlayTemplate {
  return mapComponent(template, id, (component) => {
    const requested = { ...component.box, ...change };
    if (![requested.x, requested.y, requested.width, requested.height].every(Number.isFinite)) {
      return component;
    }
    const width = clamp(requested.width, MIN_SIZE, 1);
    const height = clamp(requested.height, MIN_SIZE, 1);
    return {
      ...component,
      box: {
        width,
        height,
        x: clamp(requested.x, 0, 1 - width),
        y: clamp(requested.y, 0, 1 - height),
      },
    };
  });
}

export function setStyle(template: OverlayTemplate, id: string, change: Partial<OverlayStyle>): OverlayTemplate {
  return mapComponent(template, id, (component) => {
    const next = { ...component.style };
    for (const key of ['color', 'accentColor', 'backgroundColor'] as const) {
      const value = change[key];
      // A colour the project file would refuse is refused here too.
      if (value !== undefined && isAcceptableColor(value)) next[key] = value.trim();
    }
    if (change.fontScale !== undefined && Number.isFinite(change.fontScale)) {
      next.fontScale = clamp(change.fontScale, MIN_FONT_SCALE, MAX_FONT_SCALE);
    }
    return { ...component, style: next };
  });
}

/** A dial's range. Refused unless it is a real, non-empty range. */
export function setGaugeRange(template: OverlayTemplate, id: string, min: number, max: number): OverlayTemplate {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) return template;
  return mapComponent(template, id, (component) =>
    component.type === 'gauge' ? { ...component, min, max } : component,
  );
}

export function setRouteOptions(
  template: OverlayTemplate,
  id: string,
  change: { lineWidth?: number; showMarker?: boolean },
): OverlayTemplate {
  return mapComponent(template, id, (component) => {
    if (component.type !== 'route') return component;
    return {
      ...component,
      lineWidth:
        change.lineWidth !== undefined && Number.isFinite(change.lineWidth)
          ? clamp(change.lineWidth, 0.5, 50)
          : component.lineWidth,
      showMarker: change.showMarker ?? component.showMarker,
    };
  });
}

export function setChartWindow(template: OverlayTemplate, id: string, windowSeconds: number): OverlayTemplate {
  if (!Number.isFinite(windowSeconds)) return template;
  return mapComponent(template, id, (component) =>
    component.type === 'chart' ? { ...component, windowSeconds: clamp(windowSeconds, 5, 600) } : component,
  );
}

export function setLabel(template: OverlayTemplate, id: string, label: string | undefined): OverlayTemplate {
  return mapComponent(template, id, (component) => {
    if (component.type !== 'text' && component.type !== 'gauge') return component;
    const { label: _previous, ...rest } = component;
    void _previous;
    const trimmed = label?.slice(0, 80);
    return (trimmed === undefined ? rest : { ...rest, label: trimmed }) as OverlayComponent;
  });
}

export function removeComponent(template: OverlayTemplate, id: string): OverlayTemplate {
  const components = template.components.filter((component) => component.id !== id);
  return components.length === template.components.length ? template : { ...template, components };
}

// ------------------------------------------------------------------ adding

export type NewComponent =
  | { type: 'text' | 'gauge' | 'chart'; binding: DataBinding }
  | { type: 'route' }
  | { type: 'progress' };

/** Whether another component fits within the project file's limit. */
export const canAddComponent = (template: OverlayTemplate): boolean =>
  template.components.length < MAX_COMPONENTS;

const DEFAULT_STYLE: OverlayStyle = {
  color: '#ffffff',
  accentColor: '#ffd166',
  backgroundColor: 'rgba(11, 15, 20, 0.55)',
  fontScale: 1,
};

/** Sensible starting ranges for a dial, in display units. */
function defaultRange(binding: DataBinding, units: UnitSystem): { min: number; max: number } {
  if (binding.kind === 'sensor') return { min: 0, max: 100 };
  switch (binding.metric) {
    case 'speed':
      return { min: 0, max: units === 'imperial' ? 40 : 60 };
    case 'pace':
      return { min: 0, max: units === 'imperial' ? 20 : 12 };
    case 'heartRate':
      return { min: 40, max: 200 };
    case 'cadence':
      return { min: 0, max: 220 };
    case 'cyclingCadence':
      return { min: 0, max: 140 };
    case 'power':
      return { min: 0, max: 500 };
    case 'elevation':
      return { min: 0, max: units === 'imperial' ? 3300 : 1000 };
    case 'temperature':
      return { min: units === 'imperial' ? 14 : -10, max: units === 'imperial' ? 104 : 40 };
    case 'grade':
      return { min: -20, max: 20 };
    case 'distance':
    case 'elapsed':
      return { min: 0, max: 100 };
  }
}

const DEFAULT_BOX: Record<NewComponent['type'], OverlayBox> = {
  text: { x: 0.03, y: 0.04, width: 0.2, height: 0.06 },
  gauge: { x: 0.04, y: 0.6, width: 0.105, height: 0.2 },
  chart: { x: 0.03, y: 0.7, width: 0.25, height: 0.15 },
  route: { x: 0.74, y: 0.58, width: 0.23, height: 0.3 },
  progress: { x: 0.74, y: 0.9, width: 0.23, height: 0.02 },
};

function uniqueId(template: OverlayTemplate, base: string): string {
  const taken = new Set(template.components.map((component) => component.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Adds a component with sensible defaults, wherever the same kind of thing
 * usually goes. It may overlap another — placement is the user's to adjust —
 * but each one added is nudged down a little so they are not stacked exactly.
 */
export function addComponent(template: OverlayTemplate, spec: NewComponent): OverlayTemplate {
  if (!canAddComponent(template)) return template;
  const stackOffset = (template.components.filter((c) => c.type === spec.type).length % 6) * 0.07;
  const base = DEFAULT_BOX[spec.type];
  const box = { ...base, y: clamp(base.y + stackOffset, 0, 1 - base.height) };
  const common = { visible: true, box, style: { ...DEFAULT_STYLE } };
  const nameOf = (binding: DataBinding) => (binding.kind === 'metric' ? binding.metric : `sensor-${binding.key}`);

  let component: OverlayComponent;
  switch (spec.type) {
    case 'text':
      component = { ...common, id: uniqueId(template, `${nameOf(spec.binding)}-readout`), type: 'text', binding: spec.binding };
      break;
    case 'gauge': {
      const range = defaultRange(spec.binding, template.units);
      component = {
        ...common,
        id: uniqueId(template, `${nameOf(spec.binding)}-gauge`),
        type: 'gauge',
        binding: spec.binding,
        ...range,
      } satisfies GaugeComponent;
      break;
    }
    case 'chart':
      component = {
        ...common,
        id: uniqueId(template, `${nameOf(spec.binding)}-chart`),
        type: 'chart',
        binding: spec.binding,
        windowSeconds: 60,
      };
      break;
    case 'route':
      component = { ...common, id: uniqueId(template, 'route'), type: 'route', lineWidth: 4, showMarker: true };
      break;
    case 'progress':
      component = { ...common, id: uniqueId(template, 'progress'), type: 'progress' };
      break;
  }
  return { ...template, components: [...template.components, component] };
}

/** A short name for a component, for lists and warnings. */
export function describeComponent(component: OverlayComponent): string {
  const bound = (binding: DataBinding) =>
    binding.kind === 'metric' ? METRIC_INFO[binding.metric].label : `${binding.key} stream`;
  switch (component.type) {
    case 'text':
      return `${component.label || bound(component.binding)} readout`;
    case 'gauge':
      return `${component.label || bound(component.binding)} gauge`;
    case 'chart':
      return `${bound(component.binding)} chart`;
    case 'route':
      return 'Route inset';
    case 'progress':
      return 'Progress bar';
  }
}
