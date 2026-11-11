import type { Page } from '@playwright/test';
import { solidPng } from './png';

/**
 * AV-1210. The map video's browser tests never ask a live map provider:
 * OpenFreeMap is answered here with tiles made on the spot, and any other
 * request leaving the page is stopped and recorded, so a test that would have
 * reached one fails instead (`forbidLiveProviders`).
 */

/** The fixture basemap's one colour: a slate blue that neither the route, the marker nor the figures use. */
export const TILE_RGB: [number, number, number] = [0x30, 0x50, 0x70];

const OWN_ORIGIN = 'http://localhost:4173';

/**
 * Every request to another origin, stopped and recorded. Registered first, so
 * a test's own `page.route` (registered later, and so asked first) still
 * answers the hosts it means to.
 */
export async function forbidLiveProviders(page: Page): Promise<string[]> {
  const live: string[] = [];
  await page.route(
    (url) => url.origin !== OWN_ORIGIN,
    (route) => {
      live.push(route.request().url());
      return route.abort('blockedbyclient');
    },
  );
  return live;
}

/**
 * OpenFreeMap, served locally: any of its styles is a raster source of one
 * colour, its tiles 256 px squares of `TILE_RGB`. Returns every URL asked.
 */
export async function serveFixtureTiles(page: Page): Promise<string[]> {
  const asked: string[] = [];
  const tile = solidPng(256, TILE_RGB);
  await page.route('https://tiles.openfreemap.org/**', (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.includes('/styles/')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          sources: { fixture: { type: 'raster', tiles: ['https://tiles.openfreemap.org/fixture/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19 } },
          layers: [{ id: 'fixture', type: 'raster', source: 'fixture' }],
        }),
      });
    }
    return route.fulfill({ contentType: 'image/png', body: tile, headers: { 'access-control-allow-origin': '*' } });
  });
  return asked;
}

/**
 * OpenFreeMap as MapLibre sees it, for counting what an export asks of it: a
 * vector source of 512 px tiles to zoom 14, drawn larger beyond it, each tile
 * empty. Returns every tile URL asked, in order (the style is not counted).
 */
export async function serveVectorFixture(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route('https://tiles.openfreemap.org/**', (route) => {
    const url = route.request().url();
    if (url.includes('/styles/')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          sources: { openmaptiles: { type: 'vector', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
          layers: [
            { id: 'ground', type: 'background', paint: { 'background-color': `rgb(${TILE_RGB.join(' ')})` } },
            { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#224466' } },
          ],
        }),
      });
    }
    asked.push(url);
    return route.fulfill({ contentType: 'application/x-protobuf', body: Buffer.alloc(0), headers: { 'access-control-allow-origin': '*' } });
  });
  return asked;
}
