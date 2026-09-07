import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The viewer mounts a map once an activity loads, and jsdom has no WebGL.
vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {},
    setWorkerUrl,
  };
});

const { App } = await import('./App');
const { CANONICAL_URL, DEFAULT_METADATA, SITE_NAME, SITE_URL, metadataForRoute } =
  await import('./seo');
const { ROUTES } = await import('./routes');
const { useActivityStore } = await import('../state/activityStore');
const { fixtureFile, readFixture } = await import('../test/helpers/fixtures');

const metaContent = (selector: string) =>
  document.head.querySelector<HTMLMetaElement>(selector)?.content ?? '';

const canonical = () =>
  document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '';

beforeEach(() => {
  useActivityStore.getState().clear();
  window.location.hash = '';
  document.head.querySelectorAll('meta[name], meta[property], link[rel="canonical"]').forEach(
    (element) => element.remove(),
  );
});

describe('route metadata (AV-013)', () => {
  it('gives every route its own title and description', () => {
    const seen = new Set<string>();

    for (const path of Object.values(ROUTES)) {
      const { title, description } = metadataForRoute(path);
      expect(title).toContain(SITE_NAME);
      expect(description.length).toBeGreaterThan(50);
      seen.add(`${title}|${description}`);
    }

    // Distinct, not one string reused three times.
    expect(seen.size).toBe(Object.values(ROUTES).length);
  });

  it('agrees with the build about where the app is deployed', async () => {
    const { DEFAULT_SITE_URL } = await import('../../base-path');
    const { SITE_URL } = await import('./seo');

    // The build injects this value, so seo.ts's literal is a fallback that
    // nothing exercises — and could drift unnoticed. It is the confirmed
    // deployment URL, and both copies must stay that.
    expect(SITE_URL).toBe(DEFAULT_SITE_URL);
    expect(SITE_URL).toBe('https://nyt87.github.io/opentrack-viewer/');
    expect(SITE_URL.endsWith('/')).toBe(true);
  });

  it('falls back to the site default for an unknown route', () => {
    expect(metadataForRoute('/nowhere')).toEqual(DEFAULT_METADATA);
  });

  it('applies the homepage metadata on load', async () => {
    render(<App />);

    await waitFor(() => {
      expect(document.title).toBe(metadataForRoute(ROUTES.home).title);
    });
    expect(metaContent('meta[name="description"]')).toBe(
      metadataForRoute(ROUTES.home).description,
    );
    expect(canonical()).toBe(CANONICAL_URL);
  });

  it('writes Open Graph and Twitter tags', async () => {
    render(<App />);

    await waitFor(() => expect(metaContent('meta[property="og:title"]')).not.toBe(''));

    expect(metaContent('meta[property="og:site_name"]')).toBe(SITE_NAME);
    expect(metaContent('meta[property="og:type"]')).toBe('website');
    expect(metaContent('meta[property="og:url"]')).toBe(CANONICAL_URL);
    expect(metaContent('meta[property="og:image"]')).toMatch(/icon-512\.png$/);
    expect(metaContent('meta[property="og:description"]')).toBe(DEFAULT_METADATA.description);

    expect(metaContent('meta[name="twitter:card"]')).toBe('summary');
    expect(metaContent('meta[name="twitter:title"]')).toBe(DEFAULT_METADATA.title);
    expect(metaContent('meta[name="twitter:image"]')).toMatch(/icon-512\.png$/);
  });

  it('updates on navigation, without a reload', async () => {
    render(<App />);
    await waitFor(() => expect(document.title).toBe(metadataForRoute(ROUTES.home).title));

    // The footer repeats these links, so take the first deliberately.
    await userEvent.click(screen.getAllByRole('link', { name: /terms/i })[0]!);

    await waitFor(() => {
      expect(document.title).toBe(metadataForRoute(ROUTES.terms).title);
    });
    expect(metaContent('meta[name="description"]')).toBe(
      metadataForRoute(ROUTES.terms).description,
    );
    expect(metaContent('meta[property="og:title"]')).toContain('Terms and Conditions');
  });

  it('points every route at one canonical URL, because the router uses a hash', () => {
    // `#/viewer` is a fragment of this page, not a resource a crawler fetches.
    expect(CANONICAL_URL).not.toContain('#');
    for (const path of Object.values(ROUTES)) {
      expect(metadataForRoute(path)).toBeDefined();
    }
  });
});

describe('metadata never describes the loaded activity (TD-016)', () => {
  it('says nothing about a file once one is open', async () => {
    render(<App />);
    await userEvent.click(screen.getAllByRole('link', { name: 'Open an activity' })[0]!);

    const input = await screen.findByTestId('file-input');
    await userEvent.upload(input, fixtureFile('route-with-elevation.gpx'));
    await screen.findByText('Elevation Route');

    const head = document.head.innerHTML + document.title;

    // The file's name, the activity's name, and a coordinate from its track.
    for (const secret of ['route-with-elevation', 'Elevation Route', '51.5']) {
      expect(head).not.toContain(secret);
    }
    // The viewer route's own description is what is shown instead.
    expect(document.title).toBe(metadataForRoute(ROUTES.viewer).title);
  });

  it('says nothing about a device, its serial, or any sensor value', async () => {
    render(<App />);
    await userEvent.click(screen.getAllByRole('link', { name: 'Open an activity' })[0]!);

    const input = await screen.findByTestId('file-input');
    await userEvent.upload(input, fixtureFile('device-metadata.gpx'));
    // Wait for the device panel's own content, so the assertion below cannot
    // pass merely because the file never loaded.
    // Wait for the device panel's own content, so the assertion below cannot
    // pass merely because the file never loaded.
    await screen.findByText('Edge 530');

    const head = document.head.innerHTML + document.title;
    // The serial the file states and the app parses, but never displays — and
    // must never write into a tag that outlives the tab.
    expect(readFixture('device-metadata.gpx')).toContain('3939123456');
    expect(head).not.toContain('3939123456');
  });
});

describe('project metadata', () => {
  it('never hard-codes the site URL in index.html', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf-8');

    // The build substitutes `__SITE_URL__`. A literal URL here would survive a
    // deployment elsewhere and tell a crawler something the sitemap contradicts.
    expect(html).toContain('__SITE_URL__');
    expect(html).not.toContain('https://nyt87.github.io');
    expect(html).not.toMatch(/(?:canonical|og:url|og:image|twitter:image)[^>]*https?:\/\//);
  });

  it('points package.json at the same repository the footer links to', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { GITHUB_URL, ISSUES_URL } = await import('../components/SiteFooter');

    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { repository: { url: string }; bugs: { url: string }; homepage: string };

    // npm writes a `git+` prefix and a `.git` suffix; the link a reader clicks
    // has neither, so compare the repository they both name.
    expect(manifest.repository.url).toBe(`git+${GITHUB_URL}.git`);
    expect(manifest.bugs.url).toBe(ISSUES_URL);
    expect(manifest.homepage).toBe(SITE_URL);
  });
});
