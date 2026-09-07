import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  CANONICAL_URL,
  PREVIEW_IMAGE,
  SITE_NAME,
  metadataForRoute,
} from './seo';

/** Creates the tag on first use, so `index.html` need not predeclare each one. */
function upsertMeta(attribute: 'name' | 'property', key: string, content: string): void {
  const selector = `meta[${attribute}="${key}"]`;
  let element = document.head.querySelector<HTMLMetaElement>(selector);

  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.setAttribute('content', content);
}

function upsertCanonical(href: string): void {
  let element = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');

  if (!element) {
    element = document.createElement('link');
    element.rel = 'canonical';
    document.head.append(element);
  }
  element.href = href;
}

/**
 * AV-013. Keeps the document's title and social metadata in step with the
 * route, without a page reload.
 *
 * Everything written here comes from the static table in `seo.ts`. The hook
 * takes no activity argument and reads no store, so there is no path by which a
 * loaded file's name, route or device could reach a `<meta>` tag (TD-016).
 */
export function useRouteMetadata(): void {
  const { pathname } = useLocation();

  useEffect(() => {
    const { title, description } = metadataForRoute(pathname);

    document.title = title;
    upsertMeta('name', 'description', description);

    upsertMeta('property', 'og:site_name', SITE_NAME);
    upsertMeta('property', 'og:type', 'website');
    upsertMeta('property', 'og:title', title);
    upsertMeta('property', 'og:description', description);
    upsertMeta('property', 'og:url', CANONICAL_URL);
    upsertMeta('property', 'og:image', PREVIEW_IMAGE);

    upsertMeta('name', 'twitter:card', 'summary');
    upsertMeta('name', 'twitter:title', title);
    upsertMeta('name', 'twitter:description', description);
    upsertMeta('name', 'twitter:image', PREVIEW_IMAGE);

    upsertCanonical(CANONICAL_URL);
  }, [pathname]);
}
