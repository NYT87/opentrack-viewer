/**
 * Route paths, kept in one place so links and tests never drift from the
 * router definition. Settings is deliberately absent: it is modal state, not a
 * route, so opening it never navigates away from a loaded activity (AV-007).
 */
export const ROUTES = {
  home: '/',
  viewer: '/viewer',
} as const;

export const NAV_LINKS = [
  { to: ROUTES.home, label: 'Home' },
  { to: ROUTES.viewer, label: 'Viewer' },
] as const;
