import {
  DEFAULT_OVERLAY_STYLE,
  OVERLAY_TEMPLATE_VERSION,
  type OverlayComponent,
  type OverlayTemplate,
} from './template';

/**
 * AV-1004. The one template the preview draws until `AV-1005` brings a set to
 * choose from: a metric strip along the bottom, the route inset above it, and
 * a progress bar. Components whose data the activity lacks simply do not draw.
 */
const component = (
  c: Pick<OverlayComponent, 'id' | 'type' | 'rect'> & Partial<OverlayComponent>,
): OverlayComponent => ({ visible: true, unitMode: 'auto', style: {}, ...c });

export const PREVIEW_TEMPLATE: OverlayTemplate = {
  version: OVERLAY_TEMPLATE_VERSION,
  name: 'Preview',
  style: DEFAULT_OVERLAY_STYLE,
  components: [
    component({
      id: 'route',
      type: 'routeInset',
      rect: { x: 0.78, y: 0.5, width: 0.2, height: 0.3 },
    }),
    component({
      id: 'speed',
      type: 'text',
      source: { kind: 'metric', metric: 'speed' },
      rect: { x: 0.02, y: 0.84, width: 0.18, height: 0.12 },
    }),
    component({
      id: 'distance',
      type: 'text',
      source: { kind: 'metric', metric: 'distance' },
      rect: { x: 0.22, y: 0.84, width: 0.18, height: 0.12 },
    }),
    component({
      id: 'elapsed',
      type: 'text',
      source: { kind: 'metric', metric: 'elapsed' },
      rect: { x: 0.42, y: 0.84, width: 0.16, height: 0.12 },
    }),
    component({
      id: 'elevation',
      type: 'text',
      source: { kind: 'metric', metric: 'elevation' },
      rect: { x: 0.6, y: 0.84, width: 0.16, height: 0.12 },
    }),
    component({
      id: 'heartRate',
      type: 'gauge',
      source: { kind: 'metric', metric: 'heartRate' },
      range: { min: 50, max: 200 },
      rect: { x: 0.78, y: 0.84, width: 0.2, height: 0.12 },
    }),
    component({
      id: 'progress',
      type: 'progress',
      rect: { x: 0.02, y: 0.97, width: 0.96, height: 0.015 },
    }),
  ],
};
