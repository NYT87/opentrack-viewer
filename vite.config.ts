import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';
import { resolveBasePath, resolveSiteUrl } from './base-path.ts';

/**
 * Deployed under a repository sub-path on GitHub Pages, so every emitted asset
 * URL has to be prefixed. Applied in dev too, so the dev server exercises the
 * same paths the deployment uses.
 */
const base = resolveBasePath();
const siteUrl = resolveSiteUrl();

/**
 * AV-013. Emits `robots.txt` and `sitemap.xml` from the same site URL the app
 * uses for its canonical tag, so a deployment elsewhere cannot leave the two
 * disagreeing. They are generated rather than committed for that reason.
 *
 * The sitemap lists one URL. The app uses `HashRouter`, so `#/viewer` and
 * `#/terms` are fragments of this page rather than resources a crawler can
 * fetch — listing them would claim pages that do not exist as far as a search
 * engine is concerned.
 *
 * It also substitutes `__SITE_URL__` in `index.html`, whose canonical and
 * Open Graph tags would otherwise be the one place still naming the default
 * deployment — leaving an alternate deployment telling a crawler two different
 * things about where it lives.
 */
function seoFiles(): Plugin {
  return {
    name: 'opentrack-seo-files',
    // Not build-only: the dev server must substitute the placeholder too, or
    // the tags read `__SITE_URL__` while developing.
    transformIndexHtml(html) {
      return html.replaceAll('__SITE_URL__', siteUrl);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: ['User-agent: *', 'Allow: /', '', `Sitemap: ${siteUrl}sitemap.xml`, ''].join('\n'),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          '  <url>',
          `    <loc>${siteUrl}</loc>`,
          '  </url>',
          '</urlset>',
          '',
        ].join('\n'),
      });
    },
  };
}

export default defineConfig({
  base,
  // AV-013. The app's canonical URL, from the one definition in base-path.ts.
  define: { 'import.meta.env.VITE_SITE_URL': JSON.stringify(siteUrl) },
  plugins: [
    react(),
    seoFiles(),
    /**
     * AV-802. Precaches the app shell so a return visit works offline.
     *
     * `manifest: false` because the app already ships
     * `public/manifest.webmanifest` with `./`-relative URLs that follow the
     * deployment sub-path; letting the plugin generate a second one would give
     * the page two competing manifests.
     *
     * There is no runtime caching at all. Activity files never travel over the
     * network — they are read from a `File` — so there is nothing of the user's
     * to cache, and map tiles are deliberately left uncached: caching a tile
     * provider's responses would store a record of where the user has looked
     * (plan §5). Offline map tiles remain a separate project (TD-005).
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false,
      workbox: {
        // Everything the build emits is first-party and static, including the
        // lazily loaded map chunk and its worker — so route-only mode keeps
        // working offline (AV-803).
        globPatterns: ['**/*.{js,css,html,webmanifest,png,svg,mjs}'],
        // The map chunk is around a megabyte; the default 2 MiB cap would
        // silently drop it from the precache.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // MapLibre constructs its worker with `{ type: 'module' }`, so Vite must emit
  // an ES worker rather than the default IIFE bundle.
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
