import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';
import { buildMapVideoModel } from '../mapVideo/model';
import { DEFAULT_MAP_VIDEO_SETTINGS, type MapVideoSettings } from '../mapVideo/project';

/** TD-088 (TD-076). A still and a video are not made at once: while one runs, the other's button is disabled, with its reason. */

const pending: { poster: ((blob: Blob) => void)[]; video: (() => void)[] } = { poster: [], video: [] };
vi.mock('../mapVideo/export/renderMapVideo', () => ({
  renderPoster: () => new Promise<Blob>((resolve) => pending.poster.push(resolve)),
  runMapVideoExport: () =>
    new Promise((_, reject) => {
      pending.video.push(() => reject(new Error('stopped')));
    }),
}));
vi.mock('mediabunny', async (importOriginal) => ({ ...(await importOriginal<typeof import('mediabunny')>()), canEncodeVideo: async () => true }));
vi.mock('./ExportPanel', () => ({ download: () => undefined }));

const { MapVideoExportPanel } = await import('./MapVideoExportPanel');

const ride = parseGpx(readFixture('overlay-ride.gpx'), { fileName: 'overlay-ride.gpx', idFactory: () => 'ride' });
const settings: MapVideoSettings = { ...DEFAULT_MAP_VIDEO_SETTINGS, lengthSeconds: 10, basemap: { ...DEFAULT_MAP_VIDEO_SETTINGS.basemap, source: 'route-only' } };
const built = buildMapVideoModel(ride, settings);
if (!built.ok) throw new Error(built.error);

beforeEach(() => {
  pending.poster = [];
  pending.video = [];
  vi.stubGlobal('VideoEncoder', class {});
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
});
afterEach(() => vi.unstubAllGlobals());

const open = () =>
  render(<MapVideoExportPanel activity={ride} model={built.model} settings={settings} units="metric" maptilerKey="" photoImages={new Map()} pausedAt={1} />);
const still = () => screen.getByRole('button', { name: /^(Save a still|Saving the still)/ });

describe('the still and the video', () => {
  it('cannot be made together: the video waits for a still, and says why', async () => {
    open();
    const video = await screen.findByRole('button', { name: 'Make the video' });
    await waitFor(() => expect(video).toBeEnabled());
    await userEvent.click(still());
    await waitFor(() => expect(pending.poster).toHaveLength(1));
    expect(video).toBeDisabled();
    expect(video).toHaveAccessibleDescription(/The video waits for the still/);
    pending.poster[0]!(new Blob(['png']));
    await waitFor(() => expect(video).toBeEnabled());
  });

  it('cannot be made together: the still waits for a video, and says why', async () => {
    open();
    const video = await screen.findByRole('button', { name: 'Make the video' });
    await waitFor(() => expect(video).toBeEnabled());
    await userEvent.click(video);
    await waitFor(() => expect(pending.video).toHaveLength(1));
    expect(still()).toBeDisabled();
    expect(still()).toHaveAccessibleDescription(/A still waits for the video/);
    expect(pending.poster).toHaveLength(0);
    pending.video[0]!();
    await waitFor(() => expect(still()).toBeEnabled());
  });
});
