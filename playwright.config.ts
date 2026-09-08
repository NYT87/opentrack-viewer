import { defineConfig, devices } from '@playwright/test';
import { resolveBasePath } from './base-path.ts';

// Tests run against the same sub-path the deployment uses, so a base-path
// mistake fails here rather than in production.
const baseURL = `http://localhost:4173${resolveBasePath()}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // One retry in CI absorbs transient network flakes without hiding real ones.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    // Navigate with './', not '/': the latter resolves to the origin root.
    baseURL,
    /*
     * Pinned, because units now default from the browser locale: without this
     * the same suite passes in Paris and fails in New York, since a US context
     * would render miles where these tests assert kilometres. Tests that care
     * about the locale create their own context and say so.
     */
    locale: 'en-GB',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
