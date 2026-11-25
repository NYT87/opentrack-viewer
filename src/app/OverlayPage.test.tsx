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
const { usePersonalStore } = await import('../state/personalStore');
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
/** With an activity alone the still image takes the files' place: the line under it names the file. */
const madeFrom = (fileName: string) => screen.findByText(new RegExp(`Made from ${fileName.replace(/\./g, '\\.')}`));
/** The custom canvas keeps the file slots, for the tests that work in them. */
const showFileSlots = () => userEvent.click(screen.getByRole('radio', { name: 'A custom video overlay, with no video' }));

const inSlot = (name: 'Video' | 'Activity', text: string | RegExp, timeout = 30_000) =>
  waitFor(() => expect(within(screen.getByRole('group', { name })).getByText(text)).toBeInTheDocument(), { timeout });

beforeEach(() => {
  useOverlayStore.getState().clear();
  const { controls, canvasMode, canvasDraft } = useOverlayStore.getInitialState();
  useOverlayStore.setState({ controls, canvasMode, canvasDraft });
  useActivityStore.getState().clear();
  usePersonalStore.getState().clear();
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
  it('opens on the one input, empty (AV-1014)', async () => {
    // Opened directly, or after a reload: the store starts empty, and the
    // input is the whole page below the introduction.
    window.location.hash = '#/overlays';
    render(<App />);

    expect(await screen.findByRole('region', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Video' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
    const input = screen.getByTestId('overlay-file-input');
    expect(input).toHaveAttribute('accept', '.mp4,.mov,.gpx,.fit,.tcx,.kml');
    expect(input).toHaveAttribute('multiple');
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
    const video = await screen.findByRole('group', { name: 'Video' });
    expect(within(video).getByText('GH010042.mp4')).toBeInTheDocument();
    expect(within(video).getByText('0:17')).toBeInTheDocument();

    const activity = screen.getByRole('group', { name: 'Activity' });
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
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');

    await goToTool('Video telemetry');
    await userEvent.upload(await screen.findByTestId('file-input'), heroVideo());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create overlays' }, { timeout: 30_000 }),
    );

    const video = await screen.findByRole('group', { name: 'Video' });
    expect(within(video).getByText('GH010042.mp4')).toBeInTheDocument();
    // The watch's track the reader chose first is still the activity (TD-040).
    expect(
      within(screen.getByRole('group', { name: 'Activity' })).getByText('morning-run.gpx'),
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
    await screen.findByRole('group', { name: 'Video' });

    expect(freshActivity.getState().activity).toBeUndefined();
  }, 60_000);
});

describe('choosing the files by hand (AV-1002)', () => {
  it('reads an activity file through the viewer intake, without a video', async () => {
    window.location.hash = '#/overlays';
    render(<App />);

    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());

    expect(await madeFrom('morning-run.gpx')).toBeInTheDocument();
    // Without a video, the activity becomes a standalone route image, and the
    // file slots give way to it: Start over, below it, is the way to other files.
    const image = screen.getByRole('region', { name: 'Overlay image' });
    expect(screen.queryByRole('group', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('overlay-file-input')).not.toBeInTheDocument();
    const startOver = screen.getByRole('button', { name: 'Start over' });
    expect(image.compareDocumentPosition(startOver) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The custom canvas works with the files, so it shows them again.
    await showFileSlots();
    expect(await screen.findByRole('group', { name: 'Activity' })).toHaveTextContent('morning-run.gpx');
    expect(screen.getByTestId('overlay-file-input')).toBeInTheDocument();
    expectNoViewerPanels();
  });

  it('reads a video and takes its telemetry as the activity', async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());

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
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    // From the still image, only the video slot comes back.
    await userEvent.click(screen.getByRole('button', { name: 'Add a video' }));
    expect(screen.queryByRole('group', { name: 'Activity' })).not.toBeInTheDocument();

    await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());

    await inSlot('Video', 'GH010042.mp4');
    // The reader chose this activity; the video does not overrule them.
    expect(within(screen.getByRole('group', { name: 'Activity' })).getByText('morning-run.gpx')).toBeInTheDocument();
  }, 60_000);

  it("lets a new video's telemetry replace the previous video's, but never a hand-picked file", async () => {
    mockExtractionFrom('hero7.raw');
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    // Video A brings its own track.
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());
    await waitFor(() => expect(freshStore.getState().source.activityOrigin).toBe('video'), { timeout: 30_000 });

    // Removing A takes A's track with it: it was A's, not the reader's.
    await userEvent.click(within(screen.getByRole('group', { name: 'Video' })).getByRole('button', { name: 'Remove' }));
    expect(freshStore.getState().source.activity).toBeUndefined();
    expect(screen.getByTestId('overlay-file-input')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Video' })).not.toBeInTheDocument();

    // Video B's track fills the empty slot.
    const videoB = new File([readBinaryFixture('hero8.mp4')], 'GH010043.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByTestId('overlay-file-input'), videoB);
    await inSlot('Activity', 'GH010043.mp4');

    // A hand-picked file, though, survives a video swap. "Choose another"
    // replaces in place: the file held stays until the new one is read.
    await userEvent.upload(screen.getByTestId('overlay-activity-replace'), gpxFile());
    await inSlot('Activity', 'morning-run.gpx');
    await userEvent.upload(screen.getByTestId('overlay-video-replace'), heroVideo());
    await waitFor(() => expect(freshStore.getState().source.video?.file.name).toBe('GH010042.mp4'), { timeout: 30_000 });
    expect(screen.getByText('morning-run.gpx')).toBeInTheDocument();
    expect(freshStore.getState().source.activityOrigin).toBe('hand');
  }, 60_000);

  it('keeps a video that carries no telemetry, and asks for an activity', async () => {
    mockExtractionFrom('none');
    const { App: Fresh } = await import('./App');
    window.location.hash = '#/overlays';
    render(<Fresh />);

    await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());

    await inSlot('Video', 'GH010042.mp4');
    const video = screen.getByRole('group', { name: 'Video' });
    // The reason it supplies no activity is said once, beside the video.
    expect(within(video).getByText(/no GoPro telemetry track/)).toBeInTheDocument();
    expect(screen.getByTestId('overlay-file-input')).toBeInTheDocument();
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

    await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());

    await inSlot('Video', 'GH010042.mp4');
    const video = screen.getByRole('group', { name: 'Video' });
    // 12.65 seconds, rounded as the viewer rounds durations.
    expect(within(video).getByText('0:13')).toBeInTheDocument();
    expect(within(video).getByText(/usable satellite fix/)).toBeInTheDocument();
    expect(screen.getByTestId('overlay-file-input')).toBeInTheDocument();
    expect(freshStore.getState().source.video?.timing?.durationSeconds).toBeCloseTo(12.6, 0);
  }, 60_000);

  it('refuses a file that is not a video at all', async () => {
    window.location.hash = '#/overlays';
    render(<App />);

    await userEvent.upload(
      await screen.findByTestId('overlay-file-input'),
      new File(['not a video'], 'lies.mp4', { type: 'video/mp4' }),
    );

    // Said in the Files section, naming the file (TD-059).
    const alert = await within(screen.getByRole('region', { name: 'Files' })).findByRole('alert');
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
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());
    await screen.findByRole('region', { name: 'Reading the video' });

    await userEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'File viewer' }));

    await waitFor(() => expect(seen?.aborted).toBe(true));
  });

  it('explains a file it cannot read, and offers another go', async () => {
    window.location.hash = '#/overlays';
    render(<App />);

    await userEvent.upload(
      await screen.findByTestId('overlay-file-input'),
      new File(['<gpx>'], 'broken.gpx', { type: 'application/gpx+xml' }),
    );

    const slot = screen.getByRole('region', { name: 'Files' });
    const alert = await within(slot).findByRole('alert');
    expect(alert).toHaveTextContent('Could not open broken.gpx');
    // The drop zone stays beside the error, and the rest of the page with it.
    expect(screen.getByTestId('overlay-file-input')).toBeInTheDocument();
    // Focus went to what went wrong: its button.
    await waitFor(() => expect(within(alert).getByRole('button', { name: 'Dismiss' })).toHaveFocus());
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(slot).queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(slot).getByRole('button', { name: /^Drop a video, an activity/ })).toHaveFocus(),
    );
  });

  it('brings back only the video slot from the still image, and lets it go again on Cancel', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    expect(screen.queryByTestId('overlay-file-input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add a video' }));
    const slot = await screen.findByRole('region', { name: 'Files' });
    // Focus goes to where the video is dropped, and Start over stays beside the way back.
    await waitFor(() =>
      expect(within(slot).getByRole('button', { name: /^Drop a video to draw over/ })).toHaveFocus(),
    );
    // Videos only, and no line for the activity the still image already names.
    expect(screen.getByTestId('overlay-file-input')).toHaveAttribute('accept', '.mp4,.mov');
    expect(screen.queryByRole('group', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overlay image' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a video' })).toBeInTheDocument();
    expect(useOverlayStore.getState().source.activity).toBeDefined();
  });

  it('starts over, and forgets both files', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');

    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));

    expect(await screen.findByTestId('overlay-file-input')).toBeInTheDocument();
    expect(screen.queryByText(/Made from/)).not.toBeInTheDocument();
    expect(useOverlayStore.getState().source).toEqual({});

    // And it can be taken back (TD-059).
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await madeFrom('morning-run.gpx')).toBeInTheDocument();
    expect(useOverlayStore.getState().source.activity).toBeDefined();
  });

  it('lets the maximum heart rate and FTP go with the files, and Undo puts them back (AV-1020, TD-089)', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    act(() => {
      usePersonalStore.getState().setFigure('maxHeartRate', 185);
      usePersonalStore.getState().setFigure('ftp', 250);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Started over: both files, and your maximum heart rate and FTP, were let go. Your overlay settings are kept.',
    );
    expect(usePersonalStore.getState().personal).toEqual({});

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await madeFrom('morning-run.gpx')).toBeInTheDocument();
    expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 185, ftp: 250 });
  });

  it('keeps a figure typed between Start over and Undo (AV-1020, TD-089)', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    act(() => {
      usePersonalStore.getState().setFigure('maxHeartRate', 185);
      usePersonalStore.getState().setFigure('ftp', 250);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    act(() => usePersonalStore.getState().setFigure('ftp', 280));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await madeFrom('morning-run.gpx');
    expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 185, ftp: 280 });
  });

  it('names only the figure that was set, and says nothing of them when there were none (AV-1020)', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Started over: both files were let go. Your overlay settings are kept.');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await madeFrom('morning-run.gpx');
    act(() => usePersonalStore.getState().setFigure('ftp', 250));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('status')).toHaveTextContent('both files, and your FTP, were let go');
  });

  it('keeps the activity it has when a replacement fails to read (TD-059)', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    await showFileSlots();
    const before = useOverlayStore.getState().source.activity;

    await userEvent.upload(
      screen.getByTestId('overlay-file-input'),
      new File(['<gpx>'], 'broken.gpx', { type: 'application/gpx+xml' }),
    );
    const slot = screen.getByRole('group', { name: 'Activity' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open broken.gpx');
    expect(useOverlayStore.getState().source.activity).toBe(before);
    expect(within(slot).getByText('morning-run.gpx')).toBeInTheDocument();
  });
});

describe('a file still being read when the reader lets it go', () => {
  /** A parser that holds each read after the first until told, in a fresh module graph. */
  const holdingParser = () => {
    vi.resetModules();
    const pending: (() => void)[] = [];
    let calls = 0;
    vi.doMock('../parsers', async () => {
      const actual = await vi.importActual<typeof import('../parsers')>('../parsers');
      return {
        ...actual,
        parseActivityFile: (file: File) =>
          (calls += 1) === 1
            ? actual.parseActivityFile(file)
            : new Promise((resolve) => pending.push(() => resolve(actual.parseActivityFile(file)))),
      };
    });
    return () =>
      act(async () => {
        pending.splice(0).forEach((finish) => finish());
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
  };

  it('does not bring an activity back after Start over', async () => {
    const finish = holdingParser();
    try {
      const { App: Fresh } = await import('./App');
      const { useOverlayStore: freshStore } = await import('../state/overlayStore');
      freshStore.setState({ canvasMode: true });
      window.location.hash = '#/overlays';
      render(<Fresh />);
      await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
      await inSlot('Activity', 'morning-run.gpx');

      // A replacement is being read when the reader lets the activity go.
      await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
      // Remove waits for the read; Start over does not.
      expect(within(screen.getByRole('group', { name: 'Activity' })).getByRole('button', { name: 'Remove' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
      expect(freshStore.getState().source.activity).toBeUndefined();

      await finish();
      expect(freshStore.getState().source.activity).toBeUndefined();
    } finally {
      vi.doUnmock('../parsers');
      vi.resetModules();
    }
  });

  it('does not bring a video back after Start over', async () => {
    vi.resetModules();
    const pending: (() => void)[] = [];
    let calls = 0;
    vi.doMock('../parsers/gopro/extractGpmf', () => ({
      extractGpmf: () => {
        const result = {
          rawData: new Uint8Array(readBinaryFixture('hero7.raw')),
          timing: { videoDurationSeconds: 17, frameIntervalSeconds: 1 / 30, start: new Date('2024-05-04T10:00:00Z'), samples: [] },
        };
        // The first read answers; a later one finishes only when told, and ignores the stop.
        return (calls += 1) === 1 ? Promise.resolve(result) : new Promise((resolve) => pending.push(() => resolve(result)));
      },
    }));
    try {
      const { App: Fresh } = await import('./App');
      const { useOverlayStore: freshStore } = await import('../state/overlayStore');
      window.location.hash = '#/overlays';
      render(<Fresh />);
      await userEvent.upload(await screen.findByTestId('overlay-file-input'), heroVideo());
      await inSlot('Video', 'GH010042.mp4');

      // A replacement video is being read when the reader starts over.
      await userEvent.upload(screen.getByTestId('overlay-video-replace'), new File([readBinaryFixture('hero8.mp4')], 'GH010043.mp4', { type: 'video/mp4' }));
      // The reader is loaded on demand: wait until the read is really held.
      await waitFor(() => expect(pending).toHaveLength(1));
      await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
      expect(freshStore.getState().source).toEqual({});

      await act(async () => {
        pending.splice(0).forEach((finish) => finish());
        // Long enough for the telemetry to be parsed and a stale result to land, were it let.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      });
      expect(freshStore.getState().source).toEqual({});
      expect(screen.queryByText('GH010043.mp4')).not.toBeInTheDocument();
    } finally {
      vi.doUnmock('../parsers/gopro/extractGpmf');
      vi.resetModules();
    }
  }, 60_000);
});

describe('the handoff is memory only (AV-1002)', () => {
  it('stores nothing on the device', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');

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
      await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
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
      await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
      const controls = await screen.findByRole('region', { name: 'Overlay controls' });

      // Sync comes first, and the files it is done with are a line each below it.
      const sync = screen.getByRole('region', { name: 'Sync' });
      const videoSlot = screen.getByRole('group', { name: 'Video' });
      expect(sync.compareDocumentPosition(videoSlot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(screen.getByRole('group', { name: 'Activity' })).getByText('Details')).toBeInTheDocument();

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

    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());

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

describe('a custom canvas (AV-1011)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
      new Proxy({}, { get: (_target, key) => (key === 'measureText' ? () => ({ width: 40 }) : () => undefined), set: () => true })) as never);
  });

  it('is offered beside the still image, without a video, and gives the still image back', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    act(() => useOverlayStore.getState().setActivity(useActivityFixture(), 'hand'));
    expect(await screen.findByRole('region', { name: 'Overlay image' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'A custom video overlay, with no video' }));
    expect(screen.getByRole('region', { name: 'Custom canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Overlay image' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'A still image' }));
    expect(screen.queryByRole('region', { name: 'Custom canvas' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overlay image' })).toBeInTheDocument();
  });

  it('is not offered before there is an activity', async () => {
    window.location.hash = '#/overlays';
    render(<App />);
    await screen.findByTestId('overlay-file-input');
    expect(screen.queryByRole('group', { name: 'What to make' })).not.toBeInTheDocument();
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
    expect(await madeFrom('morning-run.gpx')).not.toHaveTextContent(/focused section/);
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
    expect(await madeFrom('morning-run.gpx')).toHaveTextContent('the focused section only');
    expect(useOverlayStore.getState().source.activity!.points.map((point) => point.index)).toEqual([1, 2]);
    // The viewer's own activity is untouched.
    expect(useActivityStore.getState().activity!.points).toHaveLength(total);
  });

  it('forgets that it was a section when another activity is chosen', async () => {
    await userEvent.click(await openInViewer());
    act(() => useOverlayStore.getState().setActivity(useActivityFixture(), 'hand', { focusedSection: true }));
    expect(await screen.findByText(/the focused section only/)).toBeInTheDocument();
    await showFileSlots();
    expect(await screen.findByText('Focused section only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose another activity' }));
    await userEvent.upload(await screen.findByTestId('overlay-file-input'), gpxFile());
    await waitFor(() => expect(useOverlayStore.getState().source.focusedSection).toBeFalsy());
    expect(screen.queryByText('Focused section only')).not.toBeInTheDocument();
  });
});

describe('one input for the video and the activity (AV-1014)', () => {
  const dropzoneTitle = () => within(screen.getByRole('region', { name: 'Files' }));
  const openEmpty = async (Fresh: typeof App = App) => {
    window.location.hash = '#/overlays';
    render(<Fresh />);
    return screen.findByTestId('overlay-file-input');
  };
  const videoNamed = (name: string) =>
    new File([readBinaryFixture('hero8.mp4')], name, { type: 'video/mp4' });

  it('says what it wants from what the page holds', async () => {
    mockExtractionFrom('none');
    const { App: Fresh } = await import('./App');
    await openEmpty(Fresh);
    const files = dropzoneTitle();
    expect(files.getByText('Drop a video, an activity, or both')).toBeInTheDocument();
    expect(files.getByText('MP4 or MOV; GPX, FIT, TCX or KML. Or choose them.')).toBeInTheDocument();

    // A video without telemetry: it asks for the activity.
    await userEvent.upload(screen.getByTestId('overlay-file-input'), heroVideo());
    await inSlot('Video', 'GH010042.mp4');
    expect(files.getByText('Drop the activity for this video')).toBeInTheDocument();
    expect(files.getByText('GPX, FIT, TCX or KML. Or choose one.')).toBeInTheDocument();

    // Both held: the input gives way to the two lines.
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    await inSlot('Activity', 'morning-run.gpx');
    expect(screen.queryByTestId('overlay-file-input')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Video' })).toBeInTheDocument();

    // Remove the video: an activity alone is the still image, and "Add a video" asks for one.
    await userEvent.click(within(screen.getByRole('group', { name: 'Video' })).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Video' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a video' }));
    const adding = dropzoneTitle();
    expect(adding.getByText('Drop a video to draw over')).toBeInTheDocument();
    expect(adding.getByText('MP4 or MOV. Or choose one.')).toBeInTheDocument();
  }, 60_000);

  it('opens a video and an activity dropped together as the overlay, with Sync first', async () => {
    mockExtractionFrom('none');
    const { App: Fresh } = await import('./App');
    await openEmpty(Fresh);

    await userEvent.upload(screen.getByTestId('overlay-file-input'), [heroVideo(), gpxFile()]);

    await inSlot('Activity', 'morning-run.gpx');
    expect(await screen.findByRole('region', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Export overlay' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'An overlay from a template' })).toBeChecked();
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    await waitFor(() => expect(freshStore.getState().source.video).toBeDefined());
    const source = freshStore.getState().source;
    expect(source.video?.file.name).toBe('GH010042.mp4');
    expect(source.activity?.source.fileName).toBe('morning-run.gpx');
    const sync = screen.getByRole('region', { name: 'Sync' });
    const files = screen.getByRole('region', { name: 'Files' });
    expect(sync.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }, 60_000);

  it('opens a video and an activity dropped together in the custom canvas, when that was chosen', async () => {
    mockExtractionFrom('none');
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    freshStore.setState({ canvasMode: true });
    await openEmpty(Fresh);

    await userEvent.upload(screen.getByTestId('overlay-file-input'), [gpxFile(), heroVideo()]);

    expect(await screen.findByRole('region', { name: 'Custom canvas' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'A custom canvas over the video' })).toBeChecked();
    expect(freshStore.getState().source.video).toBeDefined();
  }, 60_000);

  it('opens an activity alone as the still image', async () => {
    await openEmpty();
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    expect(await madeFrom('morning-run.gpx')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Overlay image' })).toBeInTheDocument();
  });

  it('takes the file for what it is by its first bytes, not its name', async () => {
    await openEmpty();
    // A GPX with a video's name: read as an activity.
    await userEvent.upload(
      screen.getByTestId('overlay-file-input'),
      new File([readFixture('simple-route.gpx')], 'ride.mp4', { type: 'video/mp4' }),
    );
    expect(await madeFrom('ride.mp4')).toBeInTheDocument();
    expect(useOverlayStore.getState().source.video).toBeUndefined();
  });

  it('refuses two videos in one drop, naming them, and still takes the activity', async () => {
    await openEmpty();

    await userEvent.upload(screen.getByTestId('overlay-file-input'), [
      videoNamed('a.mp4'),
      videoNamed('b.mp4'),
      gpxFile(),
    ]);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Choose one video at a time: "a.mp4" and "b.mp4" are both videos.');
    expect(await madeFrom('morning-run.gpx')).toBeInTheDocument();
    expect(useOverlayStore.getState().source.video).toBeUndefined();
  });

  it('names a file that is neither, and takes the other', async () => {
    await openEmpty();

    // The input hands on every file (TD-088); the page sorts them, and refuses this one with its own reason.
    await userEvent.upload(
      screen.getByTestId('overlay-file-input'),
      [new File(['hello'], 'notes.txt'), gpxFile()],
      { applyAccept: false },
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"notes.txt" is neither a video nor an activity. Choose an MP4 or MOV video, or a GPX, FIT, TCX or KML activity.',
    );
    expect(await madeFrom('morning-run.gpx')).toBeInTheDocument();
  });

  it.each([['ride.txt'], ['ride']])('takes a GPX by its content when it is named %s (TD-088)', async (name) => {
    await openEmpty();
    await userEvent.upload(
      screen.getByTestId('overlay-file-input'),
      new File([readFixture('simple-route.gpx')], name),
      { applyAccept: false },
    );
    expect(await madeFrom(name)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears a refusal with the next pick', async () => {
    await openEmpty();
    await userEvent.upload(screen.getByTestId('overlay-file-input'), [videoNamed('a.mp4'), videoNamed('b.mp4')]);
    expect(await screen.findByRole('alert')).toHaveTextContent('both videos');

    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());

    await madeFrom('morning-run.gpx');
    expect(screen.queryByText(/both videos/)).not.toBeInTheDocument();
  });

  it('refuses a video dropped while one is read, takes an activity, and keeps its place (TD-059)', async () => {
    let seen: AbortSignal | undefined;
    vi.doMock('../parsers/gopro/extractGpmf', async () => {
      const { ActivityError } = await import('../domain/errors');
      return {
        extractGpmf: (_file: File, options?: { signal?: AbortSignal }) => {
          seen = options?.signal;
          // Held until stopped, as a long read is.
          return new Promise((_resolve, reject) =>
            options?.signal?.addEventListener('abort', () =>
              reject(new ActivityError('extraction_cancelled', 'Stopped.')),
            ),
          );
        },
      };
    });
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    const input = await openEmpty(Fresh);
    await userEvent.upload(input, heroVideo());
    await screen.findByRole('region', { name: 'Reading the video' });

    // The input is the same element through the read, not drawn anew.
    expect(screen.getByTestId('overlay-file-input')).toBe(input);

    await userEvent.upload(screen.getByTestId('overlay-file-input'), videoNamed('second.mp4'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"GH010042.mp4" is still being read; wait for it or cancel it',
    );
    expect(seen?.aborted).toBe(false);

    // An activity may arrive meanwhile.
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    await waitFor(() => expect(freshStore.getState().source.activity).toBeDefined());
    expect(screen.getByTestId('overlay-file-input')).toBe(input);

    // Once cancelled, a video is taken again.
    await userEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Reading the video' })).not.toBeInTheDocument());
    expect(seen?.aborted).toBe(true);
    // The activity alone is the still image again, and "Add a video" brings the input back.
    await userEvent.click(await screen.findByRole('button', { name: 'Add a video' }));
    await userEvent.upload(screen.getByTestId('overlay-file-input'), videoNamed('third.mp4'));
    await screen.findByRole('region', { name: 'Reading the video' });
    expect(screen.queryByText(/"third.mp4" is still being read/)).not.toBeInTheDocument();
  }, 60_000);

  it('reads an activity while a video is read, and says so', async () => {
    vi.doMock('../parsers/gopro/extractGpmf', () => ({
      extractGpmf: () => new Promise(() => {}),
    }));
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    const input = await openEmpty(Fresh);
    await userEvent.upload(input, [heroVideo(), gpxFile()]);
    await screen.findByRole('region', { name: 'Reading the video' });
    await waitFor(() => expect(freshStore.getState().source.activity).toBeDefined());
    // The video is not held until it is read, and the input stays for it, with its progress.
    expect(screen.getByTestId('overlay-file-input')).toBeInTheDocument();
    // The page waits for the video rather than opening the still image for the meantime.
    expect(await screen.findByRole('group', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('Drop another activity to use instead')).toBeInTheDocument();
    expect(screen.queryByText(/Made from morning-run\.gpx/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a video' })).not.toBeInTheDocument();
  }, 60_000);

  it('changes or removes each file without the other', async () => {
    mockExtractionFrom('none');
    const { App: Fresh } = await import('./App');
    const { useOverlayStore: freshStore } = await import('../state/overlayStore');
    const input = await openEmpty(Fresh);
    await userEvent.upload(input, [heroVideo(), gpxFile()]);
    await inSlot('Activity', 'morning-run.gpx');
    await inSlot('Video', 'GH010042.mp4');
    expect(screen.getByTestId('overlay-video-replace')).toHaveAttribute('accept', '.mp4,.mov');
    expect(screen.getByTestId('overlay-activity-replace')).toHaveAttribute('accept', '.gpx,.fit,.tcx,.kml');

    // A new activity replaces the activity and keeps the video.
    const other = new File([readFixture('simple-route.gpx')], 'evening-run.gpx');
    await userEvent.upload(screen.getByTestId('overlay-activity-replace'), other);
    await inSlot('Activity', 'evening-run.gpx');
    expect(freshStore.getState().source.video?.file.name).toBe('GH010042.mp4');

    // A new video replaces the video and keeps the activity chosen by hand.
    await userEvent.upload(screen.getByTestId('overlay-video-replace'), videoNamed('GH010043.mp4'));
    await inSlot('Video', 'GH010043.mp4');
    expect(freshStore.getState().source.activity?.source.fileName).toBe('evening-run.gpx');

    // Removing the activity keeps the video, and the input asks for an activity again.
    await userEvent.click(within(screen.getByRole('group', { name: 'Activity' })).getByRole('button', { name: 'Remove' }));
    expect(freshStore.getState().source.video?.file.name).toBe('GH010043.mp4');
    expect(freshStore.getState().source.activity).toBeUndefined();
    expect(screen.getByText('Drop the activity for this video')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Drop the activity/ })).toHaveFocus());
  }, 60_000);

  it('takes only a video from "Add a video", and names an activity it refuses', async () => {
    await openEmpty();
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    await userEvent.click(screen.getByRole('button', { name: 'Add a video' }));

    await userEvent.upload(
      screen.getByTestId('overlay-file-input'),
      new File([readFixture('simple-route.gpx')], 'other.gpx'),
      { applyAccept: false },
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"other.gpx" is an activity, and only a video is taken here',
    );
    expect(useOverlayStore.getState().source.activity?.source.fileName).toBe('morning-run.gpx');
  });

  it('lets go of a pick still being sorted when the reader starts over', async () => {
    await openEmpty();
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    await userEvent.click(screen.getByRole('button', { name: 'Add a video' }));

    // A video whose first bytes are slow to come: it is still being told apart.
    let release: (bytes: ArrayBuffer) => void = () => {};
    const slow = new File(['x'], 'slow.mp4', { type: 'video/mp4' });
    slow.slice = () =>
      ({ arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (release = resolve)) }) as Blob;
    await userEvent.upload(screen.getByTestId('overlay-file-input'), slow);
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await act(async () => {
      release(new ArrayBuffer(0));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(useOverlayStore.getState().source).toEqual({});
    expect(screen.queryByRole('region', { name: 'Reading the video' })).not.toBeInTheDocument();
  });

  it('does not let an older pick, sorted late, replace a newer one (TD-088)', async () => {
    await openEmpty();
    // Pick A: an activity whose first bytes are slow to come, so it is still being told apart.
    let release: (bytes: ArrayBuffer) => void = () => {};
    const slow = new File([readFixture('simple-route.gpx')], 'older.gpx');
    // Only the first look at its head is held: reading it afterwards, to parse it, is as any file's.
    const ordinary = slow.slice.bind(slow);
    let looked = false;
    slow.slice = ((...args: Parameters<Blob['slice']>) => {
      if (looked) return ordinary(...args);
      looked = true;
      return { arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (release = resolve)) } as Blob;
    }) as Blob['slice'];
    await userEvent.upload(screen.getByTestId('overlay-file-input'), slow);
    // Pick B, made after it, is sorted and read first.
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    await act(async () => {
      release(new TextEncoder().encode(readFixture('simple-route.gpx')).buffer as ArrayBuffer);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(useOverlayStore.getState().source.activity?.source.fileName).toBe('morning-run.gpx');
  });

  it('names an activity that is dropped where only a video is taken, by its bytes', async () => {
    await openEmpty();
    await userEvent.upload(screen.getByTestId('overlay-file-input'), gpxFile());
    await madeFrom('morning-run.gpx');
    await userEvent.click(screen.getByRole('button', { name: 'Add a video' }));

    // Named as a video, but a GPX inside: the page says so, and keeps the activity it has.
    await userEvent.upload(
      screen.getByTestId('overlay-file-input'),
      new File([readFixture('simple-route.gpx')], 'ride.mp4', { type: 'video/mp4' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"ride.mp4" is an activity, and only a video is taken here',
    );
    expect(useOverlayStore.getState().source.activity?.source.fileName).toBe('morning-run.gpx');
  });

  it('puts focus on the way back when Dismiss takes the files away', async () => {
    await openEmpty();
    await userEvent.upload(screen.getByTestId('overlay-file-input'), [
      videoNamed('a.mp4'),
      videoNamed('b.mp4'),
      gpxFile(),
    ]);
    await madeFrom('morning-run.gpx');
    await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a video' })).toHaveFocus());
  });
});
