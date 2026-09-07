/**
 * Single source of truth for the deployment sub-path, shared by the Vite build,
 * the Playwright config and the browser tests. Keeping one definition means a
 * repository rename cannot leave the build and the tests disagreeing.
 *
 * The app is served from the confirmed deployment URL
 * https://nyt87.github.io/opentrack-viewer/; override with VITE_BASE_PATH (CI
 * derives it from the repository name).
 */
export const DEFAULT_BASE_PATH = '/opentrack-viewer/';

export function resolveBasePath(): string {
  const value = process.env.VITE_BASE_PATH ?? DEFAULT_BASE_PATH;
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * Where the app is published. Used for canonical URLs, Open Graph tags,
 * `robots.txt` and `sitemap.xml` (AV-013), and derived from the same GitHub
 * Pages deployment the workflow performs. Override with VITE_SITE_URL when
 * publishing elsewhere; the value must end in a slash.
 */
export const DEFAULT_SITE_URL = 'https://nyt87.github.io/opentrack-viewer/';

export function resolveSiteUrl(): string {
  const value = process.env.VITE_SITE_URL ?? DEFAULT_SITE_URL;
  return value.endsWith('/') ? value : `${value}/`;
}
