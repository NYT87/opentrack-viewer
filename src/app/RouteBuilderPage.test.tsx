import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

import { App } from './App';
import { draftFromActivity } from '../domain/routeDraft';
import { computeStreams } from '../domain/activity';
import { useRouteDraftStore } from '../state/routeDraftStore';
import { metadataForRoute } from './seo';
import { ROUTES } from './routes';

beforeEach(() => {
  useRouteDraftStore.getState().clear();
  window.location.hash = '';
});

const openFromTools = async () => {
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Route Builder' }));
};

describe('Route Builder page (AV-1102)', () => {
  it('is offered in the Tools menu and routes to its own page', async () => {
    await openFromTools();
    expect(await screen.findByRole('heading', { name: 'Route Builder' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/route-builder');
  });

  it('offers to start a new route when entered directly, and shows the empty draft', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);

    expect(await screen.findByRole('region', { name: 'Start a route' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start a new route' }));

    const current = screen.getByRole('region', { name: 'Current route' });
    expect(current).toHaveTextContent('Points');
    expect(current).toHaveTextContent('0');
    expect(screen.queryByRole('region', { name: 'Start a route' })).not.toBeInTheDocument();
  });

  it('shows a draft handed over from elsewhere, and lets the user start over', async () => {
    const points = [
      { index: 0, lat: 42, lon: -8 },
      { index: 1, lat: 42.001, lon: -8 },
    ];
    const draft = draftFromActivity({
      id: 'a',
      source: { format: 'gpx', parserVersion: 't' },
      metadata: { name: 'Handed over' },
      points,
      streams: computeStreams(points),
      warnings: [],
    });
    useRouteDraftStore.getState().setDraft(draft);
    window.location.hash = '#/route-builder';
    render(<App />);

    const current = await screen.findByRole('region', { name: 'Current route' });
    expect(current).toHaveTextContent('Handed over');
    expect(current).toHaveTextContent('2');

    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('region', { name: 'Start a route' })).toBeInTheDocument();
  });

  it('starts empty after a reload, because nothing is stored', async () => {
    useRouteDraftStore.getState().startBlank();
    // A reload is a fresh module state; clearing models it.
    useRouteDraftStore.getState().clear();
    window.location.hash = '#/route-builder';
    render(<App />);
    expect(await screen.findByRole('region', { name: 'Start a route' })).toBeInTheDocument();
  });

  it('has its own title and a description that names no route', () => {
    const metadata = metadataForRoute(ROUTES.routeBuilder);
    expect(metadata.title).toMatch(/route/i);
    expect(metadata.description).toMatch(/never uploaded|nothing is uploaded/i);
  });

  it('keeps Settings reachable on the page', async () => {
    window.location.hash = '#/route-builder';
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /settings/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('Create Custom Track (AV-1103)', () => {
  const load = async (fixture: string) => {
    const { readFixture } = await import('../test/helpers/fixtures');
    const { useActivityStore } = await import('../state/activityStore');
    const { parseGpx } = await import('../parsers/gpx/parseGpx');
    const activity = await parseGpx(readFixture(fixture), { fileName: fixture });
    useActivityStore.getState().setActivity(activity);
    return { activity, useActivityStore };
  };

  it('opens Route Builder with a copy, leaving the activity as it was', async () => {
    const { activity, useActivityStore } = await load('simple-route.gpx');
    const snapshot = JSON.stringify(activity);
    window.location.hash = '#/viewer';
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Create Custom Track' }));

    expect(await screen.findByRole('region', { name: 'Current route' })).toBeInTheDocument();
    const draft = useRouteDraftStore.getState().draft!;
    expect(draft.points.length).toBe(activity.points.length);
    expect(draft.origin.kind).toBe('activity');
    expect(JSON.stringify(useActivityStore.getState().activity)).toBe(snapshot);

    // Going back finds the activity still open.
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'File viewer' }));
    expect(await screen.findByRole('button', { name: 'Create Custom Track' })).toBeInTheDocument();
  });

  it('is disabled, with the reason, when the activity has no route', async () => {
    const { useActivityStore } = await load('simple-route.gpx');
    const noRoute = {
      ...useActivityStore.getState().activity!,
      points: [{ index: 0 }],
      streams: { ...useActivityStore.getState().activity!.streams, hasLocation: false },
    };
    useActivityStore.getState().setActivity(noRoute);
    window.location.hash = '#/viewer';
    render(<App />);

    expect(await screen.findByRole('button', { name: 'Create Custom Track' })).toBeDisabled();
    expect(screen.getByText(/no GPS coordinates, so there is no route to copy/)).toBeInTheDocument();
  });
});
