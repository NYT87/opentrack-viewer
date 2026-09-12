import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const { useActivityStore } = await import('../state/activityStore');
const { readBinaryFixture } = await import('../test/helpers/fixtures');

const heroVideo = () =>
  new File([readBinaryFixture('hero8.mp4')], 'GH010042.mp4', { type: 'video/mp4' });

/**
 * A payload that normalizes cleanly, standing in for the extraction of a real
 * video. The GPMF that GoPro ships is from an indoor clip with no satellite
 * fix, so the happy path needs a payload that actually has one — `hero7.raw`,
 * the same one `AV-904` normalizes.
 */
function mockExtractionFrom(fixture: string) {
  vi.doMock('../parsers/gopro/extractGpmf', () => ({
    extractGpmf: (_file: File, options?: { onProgress?: (fraction: number) => void }) => {
      options?.onProgress?.(0.5);
      options?.onProgress?.(1);
      return Promise.resolve({
        rawData: new Uint8Array(readBinaryFixture(fixture)),
        timing: { videoDurationSeconds: 12, frameDurationMs: 33, samples: [] },
      });
    },
  }));
}

beforeEach(() => {
  useActivityStore.getState().clear();
  window.location.hash = '';
  vi.resetModules();
  vi.doUnmock('../parsers/gopro/extractGpmf');
});

const goToTool = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Video telemetry' }));
};

describe('reaching the tool (AV-907)', () => {
  it('is offered in the Tools menu, and routes to its own page', async () => {
    render(<App />);

    await goToTool();

    expect(await screen.findByRole('heading', { name: 'Video telemetry' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/video-telemetry');
  });

  it('says plainly that the video stays on the device', async () => {
    render(<App />);
    await goToTool();

    // The footer says it too, so scope to the page's own introduction.
    expect(screen.getByText(/GoPro cameras record where they were/i)).toHaveTextContent(
      /never uploaded/i,
    );
  });

  it('accepts videos here, not the formats the viewer takes', async () => {
    render(<App />);
    await goToTool();

    const input = (await screen.findByTestId('file-input')) as HTMLInputElement;
    expect(input.accept).toBe('.mp4,.mov');
  });
});

describe('before a video has been read (AV-907)', () => {
  it('shows none of the viewer: no map, no charts, no export', async () => {
    render(<App />);
    await goToTool();

    expect(screen.queryByRole('region', { name: 'Route map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Activity charts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Export activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Activity summary' })).not.toBeInTheDocument();
  });
});

describe('reading a video, and handing it over (AV-907)', () => {
  it('reports progress, then summarizes what it found', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    render(<Fresh />);
    await goToTool();

    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());

    const summary = await screen.findByRole('region', { name: 'Extraction result' }, {
      timeout: 30_000,
    });
    expect(within(summary).getByText('Telemetry found')).toBeInTheDocument();
    expect(within(summary).getByText('Hero7 Black')).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Open in viewer' })).toBeInTheDocument();
  }, 60_000);

  it('opens the extracted activity in the viewer', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    // From the same fresh graph: `vi.resetModules()` means the App above holds
    // a different store instance than this file's top-level import.
    const { useActivityStore: freshStore } = await import('../state/activityStore');
    render(<Fresh />);
    await goToTool();
    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());

    await userEvent.click(
      await screen.findByRole('button', { name: 'Open in viewer' }, { timeout: 30_000 }),
    );

    // The viewer's own UI, rendering an activity it never parsed itself.
    await waitFor(() => expect(window.location.hash).toBe('#/viewer'));
    expect(await screen.findByRole('region', { name: 'Activity summary' })).toBeInTheDocument();
    expect(freshStore.getState().activity?.source.format).toBe('gopro');
  }, 60_000);

  it('explains a video it cannot read, and offers another go', async () => {
    render(<App />);
    await goToTool();

    // A file that is not a video at all: the extractor rejects it.
    await userEvent.upload(
      await screen.findByTestId('file-input'),
      new File(['not a video'], 'lies.mp4', { type: 'video/mp4' }),
    );

    const failed = await screen.findByRole('region', { name: 'Extraction failed' }, {
      timeout: 30_000,
    });
    expect(within(failed).getByRole('alert')).toBeInTheDocument();
    expect(within(failed).getByRole('button', { name: 'Try another video' })).toBeInTheDocument();
  }, 60_000);
});

describe('the handoff is memory only (AV-907)', () => {
  it('leaves the viewer empty when opened without one', async () => {
    // What a reload looks like: the store starts empty, so the viewer shows
    // its normal upload state rather than a stale activity.
    window.location.hash = '#/viewer';
    render(<App />);

    expect(await screen.findByTestId('file-input')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Activity summary' })).not.toBeInTheDocument();
  });

  it('stores nothing on the device', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    render(<Fresh />);
    await goToTool();
    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());
    await screen.findByRole('button', { name: 'Open in viewer' }, { timeout: 30_000 });

    // The theme is the one thing this app persists (§17); nothing about a
    // video, its telemetry or its name joins it.
    expect(Object.keys(localStorage).filter((key) => key !== 'opentrack-viewer:theme')).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  }, 60_000);
});
