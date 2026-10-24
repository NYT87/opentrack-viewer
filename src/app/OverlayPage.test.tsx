import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The viewer mounts a map once an activity loads, and jsdom has no WebGL.
vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, ScaleControl: class { setUnit() {} }, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {}, ScaleControl: class { setUnit() {} },
    setWorkerUrl,
  };
});

const { App } = await import('./App');
const { useOverlayStore } = await import('../state/overlayStore');
const { useActivityStore } = await import('../state/activityStore');
const { useInteractionStore } = await import('../state/interactionStore');
const { readBinaryFixture, readFixture } = await import('../test/helpers/fixtures');
const { makeActivity } = await import('../test/helpers/activity');

const useActivityFixture = () =>
  makeActivity(Array.from({ length: 6 }, (_, i) => ({ lat: 10 + i * 0.001, lon: 20 + i * 0.002 })));
const heroVideo = () =>
  new File([readBinaryFixture('hero8.mp4')], 'GH010042.mp4', { type: 'video/mp4' });
const gpxFile = () =>
  new File([readFixture('simple-route.gpx')], 'morning-run.gpx', { type: 'application/gpx+xml' });

/**
 * Extraction stands in for the real thing, as it does for the extraction
 * page's own tests: the committed GoPro clip has no satellite fix, so the
 * happy path needs `hero7.raw`, which does (AV-904).
 */
function mockExtractionFrom(fixture: string | 'none') {
  vi.doMock('../parsers/gopro/extractGpmf', async () => {
    const { ActivityError } = await import('../domain/errors');
    return {
      extractGpmf: (_file: File, options?: { onProgress?: (fraction: number) => void }) => {
        if (fixture === 'none') {
          return Promise.reject(
            new ActivityError('no_telemetry_track', 'This video carries no GoPro telemetry track.'),
          );
        }
        options?.onProgress?.(1);
        return Promise.resolve({
          rawData: new Uint8Array(readBinaryFixture(fixture)),
          timing: {
            videoDurationSeconds: 17,
            frameIntervalSeconds: 1 / 30,
            start: new Date('2024-05-04T10:00:00Z'),
            samples: [],
          },
        });
      },
    };
  });
}

/**
 * Waits for a text in a slot, finding the slot afresh each time: once a video
 * is held, the files move into the workspace's column and are drawn anew.
 */
const inSlot = (name: 'Video' | 'Activity', text: string | RegExp, timeout = 30_000) =>
  waitFor(() => expect(within(screen.getByRole('region', { name })).getByText(text)).toBeInTheDocument(), { timeout });

beforeEach(() => {
  useOverlayStore.getState().clear();
  useOverlayStore.setState({ controls: useOverlayStore.getInitialState().controls });
  useActivityStore.getState().clear();
  window.location.hash = '';
  vi.resetModules();
  vi.doUnmock('../parsers/gopro/extractGpmf');
});

const goToTool = async (label: string) => {
  await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
  await userEvent.click(screen.getByRole('menuitem', { name: label }));
};

/** The viewer's own regions, none of which belong on this page. */
const expectNoViewerPanels = () => {
  expect(screen.queryByRole('region', { name: 'Route map' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Activity charts' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Export activity' })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Activity summary' })).not.toBeInTheDocument();
};

describe('reaching the tool (AV-1002)', () => {
  it('is offered in the Tools menu, and routes to its own page', async () => {
    render(<App />);

    await goToTool('Overlays');

    expect(await screen.findByRole('heading', { name: 'Overlays' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/overlays');
  });

  it('says plainly that nothing is uploaded', async () => {
    render(<App />);
    await goToTool('Overlays');

    expect(screen.getByText(/Draw what a video's telemetry says/i)).toHaveTextContent(
      /never uploaded/i,
    );
  });
});

describe('arriving with nothing (AV-1002)', () => {
  it('shows an empty state that asks for the files again', async () => {
    // Opened directly, or after a reload: the store starts empty.
    window.location.hash = '#/overlays';
    render(<App />);

    const empty = await screen.findByRole('region', { name: 'Nothing to overlay yet' });
    expect(empty).toHaveTextContent(/does not survive a reload/i);
    expect(empty).toHaveTextContent(/choose the files again/i);

    // Both intakes are there to do so.
    expect(screen.getByTestId('overlay-video-input')).toHaveAttribute('accept', '.mp4,.mov');
    expect(screen.getByTestId('overlay-activity-input')).toHaveAttribute(
      'accept',
      '.gpx,.fit,.tcx,.kml',
    );
  });

  it('renders none of the viewer', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await screen.findByRole('heading', { name: 'Overlays' });

    expectNoViewerPanels();
  });
});

describe('handed over from Video telemetry (AV-1002)', () => {
  it('receives the video, the activity, its streams and the clock', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    // The fresh module graph has its own store instance.
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    render(<Fresh />);
    await goToTool('Video telemetry');
    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());

    await userEvent.click(
      await screen.findByRole('button', { name: 'Create overlays' }, { timeout: 30_000 }),
    );

    await waitFor(() => expect(window.location.hash).toBe('#/overlays'));
    const video = await screen.findByRole('region', { name: 'Video' });
    expect(within(video).getByText('GH010042.mp4')).toBeInTheDocument();
    expect(within(video).getByText('0:17')).toBeInTheDocument();

    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getByText('GH010042.mp4')).toBeInTheDocument();
    // The camera's other streams travel inside the activity (AV-905).
    expect(within(activity).getByText(/Acceleration/)).toBeInTheDocument();

    const { source } = freshStore.getState();
    expect(source.video?.file.name).toBe('GH010042.mp4');
    expect(source.video?.timing?.start?.toISOString()).toBe('2024-05-04T10:00:00.000Z');
    expect(source.video?.timing?.durationSeconds).toBe(17);
    expect(source.activity?.source.format).toBe('gopro');
    expect(source.activity?.sensorStreams?.length).toBeGreaterThan(0);

    // And still nothing of the viewer.
    expectNoViewerPanels();
  }, 60_000);

  it('does not overrule an activity already chosen by hand on the overlay page', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);
    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
    await screen.findByText('morning-run.gpx');

    await goToTool('Video telemetry');
    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create overlays' }, { timeout: 30_000 }),
    );

    const video = await screen.findByRole('region', { name: 'Video' });
    expect(within(video).getByText('GH010042.mp4')).toBeInTheDocument();
    // The watch's track the reader chose first is still the activity (TD-040).
    expect(
      within(screen.getByRole('region', { name: 'Activity' })).getByText('morning-run.gpx'),
    ).toBeInTheDocument();
  }, 60_000);

  it('does not disturb the viewer handoff: the viewer stays empty', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    const { useActivityStore: freshActivity } = await import('../state/activityStore');
    render(<Fresh />);
    await goToTool('Video telemetry');
    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create overlays' }, { timeout: 30_000 }),
    );
    await screen.findByRole('region', { name: 'Video' });

    expect(freshActivity.getState().activity).toBeUndefined();
  }, 60_000);
});

describe('choosing the files by hand (AV-1002)', () => {
  it('reads an activity file through the viewer intake, without a video', async () => {
    window.location.hash = '#/overlays';
    render(<App />);

    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());

    const activity = await screen.findByRole('region', { name: 'Activity' });
    expect(await within(activity).findByText('morning-run.gpx')).toBeInTheDocument();
    // Without a video, the activity becomes a standalone route image.
    expect(screen.getByRole('region', { name: 'Overlay image' })).toBeInTheDocument();
    // The video slot still waits for one.
    expect(screen.getByTestId('overlay-video-input')).toBeInTheDocument();
    expectNoViewerPanels();
  });

  it('reads a video and takes its telemetry as the activity', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    await userEvent.upload(await screen.findByTestId('overlay-video-input'), heroVideo());

    await inSlot('Activity', 'GH010042.mp4');
    // Both files, so the workspace: the preview and the exports are there.
    expect(screen.getByRole('region', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Export overlay' })).toBeInTheDocument();
  }, 60_000);

  it('keeps a hand-picked activity when a video with its own telemetry follows', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);
    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
    await screen.findByText('morning-run.gpx');

    await userEvent.upload(await screen.findByTestId('overlay-video-input'), heroVideo());

    await inSlot('Video', 'GH010042.mp4');
    // The reader chose this activity; the video does not overrule them.
    expect(within(screen.getByRole('region', { name: 'Activity' })).getByText('morning-run.gpx')).toBeInTheDocument();
  }, 60_000);

  it("lets a new video's telemetry replace the previous video's, but never a hand-picked file", async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    // Video A brings its own track.
    await userEvent.upload(await screen.findByTestId('overlay-video-input'), heroVideo());
    await waitFor(() => expect(freshStore.getState().source.activityOrigin).toBe('video'), { timeout: 30_000 });

    // Removing A takes A's track with it: it was A's, not the reader's.
    await userEvent.click(within(screen.getByRole('region', { name: 'Video' })).getByRole('button', { name: 'Remove' }));
    expect(freshStore.getState().source.activity).toBeUndefined();
    expect(screen.getByTestId('overlay-activity-input')).toBeInTheDocument();

    // Video B's track fills the empty slot.
    const videoB = new File([readBinaryFixture('hero8.mp4')], 'GH010043.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByTestId('overlay-video-input'), videoB);
    await inSlot('Activity', 'GH010043.mp4');

    // A hand-picked file, though, survives a video swap. "Choose another"
    // replaces in place: the file held stays until the new one is read.
    await userEvent.upload(screen.getByTestId('overlay-activity-input'), gpxFile());
    await screen.findByText('morning-run.gpx');
    await userEvent.upload(screen.getByTestId('overlay-video-input'), heroVideo());
    await waitFor(() => expect(freshStore.getState().source.video?.file.name).toBe('GH010042.mp4'), { timeout: 30_000 });
    expect(screen.getByText('morning-run.gpx')).toBeInTheDocument();
    expect(freshStore.getState().source.activityOrigin).toBe('hand');
  }, 60_000);

  it('keeps a video that carries no telemetry, and asks for an activity', async () => {
    mockExtractionFrom('none');
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    await userEvent.upload(await screen.findByTestId('overlay-video-input'), heroVideo());

    await inSlot('Video', 'GH010042.mp4');
    const video = screen.getByRole('region', { name: 'Video' });
    // The reason it supplies no activity is said once, beside the video.
    expect(within(video).getByText(/no GoPro telemetry track/)).toBeInTheDocument();
    expect(screen.getByTestId('overlay-activity-input')).toBeInTheDocument();
  });

  it('keeps a video whose track has no satellite fix, with its clock and the reason', async () => {
    // The real HERO8 clip, read for real: telemetry, but recorded indoors.
    // The extraction page refuses it; here it is a video a watch's file can
    // still be drawn over.
    //
    // A fresh graph, because `vi.resetModules()` ran: the page's lazily
    // imported parser would otherwise throw an `ActivityError` from a second
    // copy of the errors module, which the first copy's `instanceof` rejects.
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    await userEvent.upload(await screen.findByTestId('overlay-video-input'), heroVideo());

    await inSlot('Video', 'GH010042.mp4');
    const video = screen.getByRole('region', { name: 'Video' });
    // 12.65 seconds, rounded as the viewer rounds durations.
    expect(within(video).getByText('0:13')).toBeInTheDocument();
    expect(within(video).getByText(/usable satellite fix/)).toBeInTheDocument();
    expect(screen.getByTestId('overlay-activity-input')).toBeInTheDocument();
    expect(freshStore.getState().source.video?.timing?.durationSeconds).toBeCloseTo(12.6, 0);
  }, 60_000);

  it('refuses a file that is not a video at all', async () => {
    window.location.hash = '#/overlays';
    render(<App />);

    await userEvent.upload(
      await screen.findByTestId('overlay-video-input'),
      new File(['not a video'], 'lies.mp4', { type: 'video/mp4' }),
    );

    // Said in the video's own slot, naming the file (TD-059).
    const alert = await within(screen.getByRole('region', { name: 'Video' })).findByRole('alert');
    expect(alert).toHaveTextContent('Could not open lies.mp4');
    expect(alert).toHaveTextContent(/not an MP4 or MOV container/i);
    expect(useOverlayStore.getState().source.video).toBeUndefined();
  });

  it('stops the read when the page is left', async () => {
    let seen: AbortSignal | undefined;
    vi.doMock('../parsers/gopro/extractGpmf', () => ({
      extractGpmf: (_file: File, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        // Never settles on its own: only the abort can end it.
        return new Promise(() => {});
      },
    }));
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);
    await userEvent.upload(await screen.findByTestId('overlay-video-input'), heroVideo());
    await screen.findByRole('region', { name: 'Reading the video' });

    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'File viewer' }));

    await waitFor(() => expect(seen?.aborted).toBe(true));
  });

  it('explains a file it cannot read, and offers another go', async () => {
    window.location.hash = '#/overlays';
    render(<App />);

    await userEvent.upload(
      await screen.findByTestId('overlay-activity-input'),
      new File(['<gpx>'], 'broken.gpx', { type: 'application/gpx+xml' }),
    );

    const slot = screen.getByRole('region', { name: 'Activity' });
    const alert = await within(slot).findByRole('alert');
    expect(alert).toHaveTextContent('Could not open broken.gpx');
    // The drop zone stays beside the error, and the rest of the page with it.
    expect(screen.getByTestId('overlay-activity-input')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Video' })).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(slot).queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(within(slot).getByRole('button', { name: /^Drop a GPX/ })).toHaveFocus());
  });

  it('starts over, and forgets both files', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
    await screen.findByText('morning-run.gpx');

    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByRole('region', { name: 'Nothing to overlay yet' })).toBeInTheDocument();
    expect(useOverlayStore.getState().source).toEqual({});

    // And it can be taken back (TD-059).
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('morning-run.gpx')).toBeInTheDocument();
    expect(useOverlayStore.getState().source.activity).toBeDefined();
  });

  it('keeps the activity it has when a replacement fails to read (TD-059)', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
    await screen.findByText('morning-run.gpx');
    const before = useOverlayStore.getState().source.activity;

    await userEvent.upload(
      screen.getByTestId('overlay-activity-input'),
      new File(['<gpx>'], 'broken.gpx', { type: 'application/gpx+xml' }),
    );
    const slot = screen.getByRole('region', { name: 'Activity' });
    expect(await within(slot).findByRole('alert')).toHaveTextContent('Could not open broken.gpx');
    expect(useOverlayStore.getState().source.activity).toBe(before);
    expect(within(slot).getByText('morning-run.gpx')).toBeInTheDocument();
  });
});

describe('the handoff is memory only (AV-1002)', () => {
  it('stores nothing on the device', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
    await screen.findByText('morning-run.gpx');

    // The theme is the one thing this app persists (§17); nothing about a
    // video, an activity or their names joins it.
    expect(Object.keys(localStorage).filter((key) => key !== 'opentrack-viewer:theme')).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});

describe('the preview on the page (AV-1004)', () => {
  it('appears once there is a video, and its offset is forgotten when the video is replaced', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} }));
    try {
      window.location.hash = '#/overlays';
      render(<App />);
      expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();

      act(() => {
        useOverlayStore.getState().setVideo({
          file: heroVideo(),
          timing: { durationSeconds: 17, frameIntervalSeconds: 1 / 30 },
        });
        useOverlayStore.getState().setOffsetSeconds(2.5);
      });
      expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
      expectNoViewerPanels();

      // A different video disagrees with the activity differently.
      act(() => useOverlayStore.getState().setVideo(undefined));
      expect(useOverlayStore.getState().offsetSeconds).toBe(0);
      expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the reader\'s template and style for the session, Start over included', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} }));
    try {
      window.location.hash = '#/overlays';
      render(<App />);
      act(() => {
        useOverlayStore.getState().setVideo({
          file: heroVideo(),
          timing: { durationSeconds: 17, frameIntervalSeconds: 1 / 30 },
        });
      });
      await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
      const controls = await screen.findByRole('region', { name: 'Overlay controls' });
      await userEvent.click(within(controls).getByRole('radio', { name: /Compact HUD/ }));
      fireEvent.change(within(controls).getByLabelText('Accent colour'), { target: { value: '#00ff00' } });

      // Away to another page and back: nothing is stored, but the session remembers.
      await goToTool('Video telemetry');
      await goToTool('Overlays');
      const back = await screen.findByRole('region', { name: 'Overlay controls' });
      expect(within(back).getByRole('radio', { name: /Compact HUD/ })).toBeChecked();
      expect(within(back).getByLabelText('Accent colour')).toHaveValue('#00ff00');
      expect(window.localStorage.getItem('opentrack-viewer:overlay')).toBeNull();

      // Start over lets go of the files, and keeps the reader's settings: they
      // are the reader's, not the files' (TD-043, TD-059).
      await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
      expect(useOverlayStore.getState().source).toEqual({});
      expect(useOverlayStore.getState().controls.presetId).toBe('compact-hud');
      expect(useOverlayStore.getState().controls.accentColor).toBe('#00ff00');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the workspace by keyboard (TD-059)', () => {
  it('skips past the files and settings to the exports, and puts a reset of the settings back', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} }));
    try {
      window.location.hash = '#/overlays';
      render(<App />);
      act(() => {
        useOverlayStore.getState().setVideo({
          file: heroVideo(),
          timing: { durationSeconds: 17, frameIntervalSeconds: 1 / 30 },
        });
      });
      await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
      const controls = await screen.findByRole('region', { name: 'Overlay controls' });

      // Sync comes first, and the files it is done with are a line each below it.
      const sync = screen.getByRole('region', { name: 'Sync' });
      const videoSlot = screen.getByRole('region', { name: 'Video' });
      expect(sync.compareDocumentPosition(videoSlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(screen.getByRole('region', { name: 'Activity' })).getByText('Details')).toBeInTheDocument();

      Element.prototype.scrollIntoView ??= () => {};
      await userEvent.click(screen.getByRole('button', { name: 'Skip to export' }));
      expect(screen.getByRole('heading', { name: 'Export overlay' })).toHaveFocus();

      await userEvent.click(within(controls).getByRole('radio', { name: /Compact HUD/ }));
      await userEvent.click(within(controls).getByRole('button', { name: 'Reset overlay settings' }));
      expect(useOverlayStore.getState().controls.presetId).toBe('metric-strip');
      await userEvent.click(within(controls).getByRole('button', { name: 'Undo reset' }));
      expect(useOverlayStore.getState().controls.presetId).toBe('compact-hud');
      expect(within(controls).getByRole('button', { name: 'Reset overlay settings' })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the route image without a video (AV-1009)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never);
  });

  it('offers a route image for an activity chosen by hand, with no video', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    expect(screen.queryByRole('region', { name: 'Overlay image' })).not.toBeInTheDocument();

    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());

    const panel = await screen.findByRole('region', { name: 'Overlay image' });
    expect(within(panel).getByTestId('route-image-preview')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Download PNG' })).toBeEnabled();
    expect(panel).toHaveTextContent(/whole activity/);
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Export overlay' })).not.toBeInTheDocument();
  });

  it('is not offered for a video alone, and gives way to the video overlays when one is added', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    act(() => useOverlayStore.getState().setActivity(useActivityFixture(), 'hand'));
    expect(await screen.findByRole('region', { name: 'Overlay image' })).toBeInTheDocument();

    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} }));
    try {
      act(() =>
        useOverlayStore.getState().setVideo({
          file: heroVideo(),
          timing: { durationSeconds: 17, frameIntervalSeconds: 1 / 30 },
        }),
      );
      expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Overlay image' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('explains an activity with no route instead of drawing nothing', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    const { makeActivity } = await import('../test/helpers/activity');
    act(() => useOverlayStore.getState().setActivity(makeActivity([{ elevationMeters: 1 }, { elevationMeters: 2 }]), 'hand'));
    const panel = await screen.findByRole('region', { name: 'Overlay image' });
    expect(within(panel).getByRole('alert')).toHaveTextContent(/no locations/);
    expect(within(panel).getByRole('button', { name: 'Download PNG' })).toBeDisabled();
  });
});

describe('handed over from the viewer (AV-1009)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
      new Proxy({}, { get: () => () => undefined, set: () => true })) as never);
  });

  const openInViewer = async () => {
    window.location.hash = '#/viewer';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('file-input'), gpxFile());
    return screen.findByRole('button', { name: 'Create route overlay' });
  };

  it('takes the whole activity to the overlay page and previews its route', async () => {
    await userEvent.click(await openInViewer());

    const panel = await screen.findByRole('region', { name: 'Overlay image' });
    expect(window.location.hash).toBe('#/overlays');
    expect(within(panel).getByTestId('route-image-preview')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/whole activity/);
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getByText('morning-run.gpx')).toBeInTheDocument();
    expect(within(activity).queryByText('Focused section only')).not.toBeInTheDocument();
  });

  it('opens the route image even when a video was held here before', async () => {
    act(() =>
      useOverlayStore.getState().setVideo({
        file: heroVideo(),
        timing: { durationSeconds: 17, frameIntervalSeconds: 1 / 30 },
      }),
    );
    await userEvent.click(await openInViewer());

    const panel = await screen.findByRole('region', { name: 'Overlay image' });
    expect(within(panel).getByTestId('route-image-preview')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Download PNG' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Preview' })).not.toBeInTheDocument();
    expect(useOverlayStore.getState().source.video).toBeUndefined();
  });

  it('takes only the focused section when it was chosen on purpose', async () => {
    const button = await openInViewer();
    const total = useActivityStore.getState().activity!.points.length;
    act(() => useInteractionStore.getState().setSelectedRange({ startIndex: 1, endIndex: 2 }));
    expect(total).toBeGreaterThan(2);

    await userEvent.click(await screen.findByRole('checkbox', { name: /Use only the selected section/ }));
    await userEvent.click(button);

    const panel = await screen.findByRole('region', { name: 'Overlay image' });
    expect(panel).toHaveTextContent(/focused section/);
    const activity = screen.getByRole('region', { name: 'Activity' });
    expect(within(activity).getByText('Focused section only')).toBeInTheDocument();
    expect(useOverlayStore.getState().source.activity!.points.map((point) => point.index)).toEqual([1, 2]);
    // The viewer's own activity is untouched.
    expect(useActivityStore.getState().activity!.points).toHaveLength(total);
  });

  it('forgets that it was a section when another activity is chosen', async () => {
    await userEvent.click(await openInViewer());
    act(() => useOverlayStore.getState().setActivity(useActivityFixture(), 'hand', { focusedSection: true }));
    expect(await screen.findByText('Focused section only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose another activity' }));
    await userEvent.upload(await screen.findByTestId('overlay-activity-input'), gpxFile());
    await screen.findByRole('region', { name: 'Overlay image' });
    expect(screen.queryByText('Focused section only')).not.toBeInTheDocument();
  });
});
