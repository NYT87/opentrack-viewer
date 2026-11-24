/**
 * Route paths, kept in one place so links and tests never drift from the
 * router definition. Settings is deliberately absent: it is modal state, not a
 * route, so opening it never navigates away from a loaded activity (AV-007).
 */
export const ROUTES = {
  home: '/',
  viewer: '/viewer',
  /** A routed page, not a modal: legal documents need a stable link (AV-008). */
  terms: '/terms',
  /**
   * AV-907. Video telemetry has a route of its own rather than sharing the
   * viewer's drop zone: reading a multi-gigabyte file needs progress and a way
   * to stop, and the viewer has nowhere to put either.
   */
  videoTelemetry: '/video-telemetry',
  /**
   * AV-1102. Editing a planned route is a page of its own, not a mode of the
   * viewer: the viewer shows what was recorded and must stay unable to change it.
   */
  routeBuilder: '/route-builder',
} as const;

/**
 * AV-012: the header's Tools menu. No Home entry — the brand is the link home
 * (AV-010) — and no standalone Viewer button, which this menu replaces.
 */
export const TOOLS_ITEMS = [
  { to: ROUTES.viewer, label: 'File viewer' },
  { to: ROUTES.videoTelemetry, label: 'Video telemetry' },
  { to: ROUTES.routeBuilder, label: 'Route Builder' },
] as const;
