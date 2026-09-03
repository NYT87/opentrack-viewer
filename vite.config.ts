import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolveBasePath } from './base-path.ts';

/**
 * Deployed under a repository sub-path on GitHub Pages, so every emitted asset
 * URL has to be prefixed. Applied in dev too, so the dev server exercises the
 * same paths the deployment uses.
 */
const base = resolveBasePath();

export default defineConfig({
  base,
  plugins: [react()],
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
