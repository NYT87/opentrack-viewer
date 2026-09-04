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
} as const;

/**
 * AV-012: the header's Tools menu. No Home entry — the brand is the link home
 * (AV-010) — and no standalone Viewer button, which this menu replaces.
 */
export const TOOLS_ITEMS = [{ to: ROUTES.viewer, label: 'File viewer' }] as const;
