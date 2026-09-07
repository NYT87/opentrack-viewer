import { ROUTES } from './routes';

/**
 * AV-013 / TD-016. Route metadata, written by hand and never derived from a
 * loaded activity.
 *
 * Every string here is a constant. Nothing in this file reads the activity
 * store, and nothing may: a file name, a coordinate, a timestamp or a device
 * identifier written into a `<meta>` tag would leave the privacy boundary the
 * rest of the app is built around, and would sit in a shared link or a browser
 * history long after the tab was closed.
 */

export const SITE_NAME = 'OpenTrack Viewer';

/** Injected by the build from `resolveSiteUrl()`; see `base-path.ts`. */
export const SITE_URL: string =
  (import.meta.env.VITE_SITE_URL as string | undefined) ??
  'https://nyt87.github.io/opentrack-viewer/';

/**
 * A square app icon, because there is no purpose-made preview image yet. A
 * 1200×630 image would render better in link previews; §17 still asks which.
 */
export const PREVIEW_IMAGE = `${SITE_URL}icons/icon-512.png`;

export interface RouteMetadata {
  /** The full `<title>`, not a fragment: it is what a browser tab shows. */
  title: string;
  description: string;
}

export const DEFAULT_METADATA: RouteMetadata = {
  title: `${SITE_NAME} — open GPX, FIT and TCX activity files in your browser`,
  description:
    'View GPX, FIT and TCX activity files locally in your browser. Routes, elevation, pace, ' +
    'speed, heart rate and laps, with no upload, no account and no backend.',
};

const ROUTE_METADATA: Record<string, RouteMetadata> = {
  [ROUTES.home]: DEFAULT_METADATA,
  [ROUTES.viewer]: {
    title: `Open an activity file — ${SITE_NAME}`,
    // Describes the tool, never the file someone happens to have open.
    description:
      'Open a GPX, FIT or TCX file to see its route, distance, duration, elevation and sensor ' +
      'charts. Parsing happens in this browser tab; your file is never uploaded.',
  },
  [ROUTES.terms]: {
    title: `Terms and Conditions — ${SITE_NAME}`,
    description:
      'How OpenTrack Viewer handles your activity files, what it does not promise, and why ' +
      'map tiles are the one thing that leaves your device.',
  },
};

export function metadataForRoute(pathname: string): RouteMetadata {
  return ROUTE_METADATA[pathname] ?? DEFAULT_METADATA;
}

/**
 * The canonical URL is the site root for every route, because the app uses
 * `HashRouter`: `#/viewer` is a fragment, and a fragment is not a separate
 * resource to a crawler. Pointing each route at its own `#` URL would claim
 * distinct pages that no search engine will ever treat as distinct.
 *
 * Per-route titles still earn their place — they name the browser tab, the
 * bookmark and the history entry, and a shared link keeps its hash — but only
 * one URL here is indexable, which is what `sitemap.xml` lists. This resolves
 * the §17 question about whether the viewer route should be indexed: it cannot
 * be, structurally.
 */
export const CANONICAL_URL = SITE_URL;
