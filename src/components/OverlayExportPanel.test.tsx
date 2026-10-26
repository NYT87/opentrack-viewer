import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverlayExportPanel } from './OverlayExportPanel';
import { OverlayExportError } from '../overlay/export/errors';
import { highestFittingFrameRate } from '../overlay/export/plan';
import type { ArchiveStorage } from '../overlay/export/protocol';
import type { ExportJob, ExportOutput } from '../overlay/export/client';
import { DEFAULT_SHAPE, DEFAULT_OVERLAY_STYLE as DEFAULT_OVERLAY_TEMPLATE_STYLE } from '../overlay/template';
import { DEFAULT_OVERLAY_CONTROLS, type OverlayControls } from '../overlay/presets';
import type { OverlayMedia, OverlayVideo } from '../state/overlayStore';
import { makeActivity } from '../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const activity = makeActivity(
  Array.from({ length: 11 }, (_, i) => ({
    time: at(i),
    lat: 10 + i * 0.001,
    lon: 20 + i * 0.001,
    distanceMeters: i * 10,
    speedMetersPerSecond: i,
  })),
);

const video: OverlayVideo = {
  file: new File(['x'], 'GH010042.mp4', { type: 'video/mp4' }),
  timing: { durationSeconds: 10, frameIntervalSeconds: 1 / 30 },
};
const media: OverlayMedia = { width: 1920, height: 1080, durationSeconds: 10 };

/**
 * A storage probe that has already answered — a thenable that calls back at
 * once — so a test sees the settled panel without waiting for a microtask. The
 * panel only ever calls `.then` on it.
 */
const syncProbe = (storage: ArchiveStorage) => () =>
  ({ then: (ok: (value: ArchiveStorage) => void) => ok(storage) }) as unknown as Promise<ArchiveStorage>;

/** A job the test settles by hand. */
function controlledJob() {
  let resolve!: (output: ExportOutput) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<ExportOutput>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const cancel = vi.fn();
  return { job: { cancel, done } satisfies ExportJob, resolve, reject, cancel };
}

function setup(props: Partial<React.ComponentProps<typeof OverlayExportPanel>> = {}) {
  const jobs: ReturnType<typeof controlledJob>[] = [];
  const progress: ((done: number, total: number) => void)[] = [];
  const start = vi.fn((_request: unknown, onProgress: (done: number, total: number) => void) => {
    const next = controlledJob();
    jobs.push(next);
    progress.push(onProgress);
    return next.job;
  });
  const utils = render(
    <OverlayExportPanel
      video={video}
      activity={activity}
      controls={DEFAULT_OVERLAY_CONTROLS}
      offsetSeconds={0}
      units="metric"
      media={media}
      start={start as never}
      support={{ supported: true }}
      probeStorage={syncProbe('opfs')}
      {...props}
    />,
  );
  return { ...utils, start, jobs, progress };
}

/**
 * A page that redraws on every report and hands the panel a new listener each
 * time, as a page with an inline callback does: the reports must settle.
 */
function Reporting({ panel }: { panel: (onFinishedChange: (finished: boolean) => void) => React.ReactNode }) {
  const [reports, setReports] = useState<boolean[]>([]);
  const [shown, setShown] = useState(true);
  return (
    <>
      {shown && panel((finished) => setReports((current) => [...current, finished]))}
      <output data-testid="reports">{reports.join(',')}</output>
      <button type="button" onClick={() => setShown(false)}>
        Take the panel away
      </button>
    </>
  );
}

const panel = () => screen.getByRole('region', { name: 'Export overlay' });

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:zip'), revokeObjectURL: vi.fn() }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('the export panel (AV-1006)', () => {
  it('says what will be made, and that nothing is uploaded', () => {
    setup();
    expect(panel()).toHaveTextContent(/transparent where nothing is drawn/);
    expect(panel()).toHaveTextContent(/one PNG per frame in a ZIP/);
    expect(panel()).toHaveTextContent(/Your video is not changed/);
    expect(panel()).toHaveTextContent(/nothing is uploaded/i);
  });

  it("starts at the video's own frame rate and size, and shows the plan", () => {
    setup();
    expect(within(panel()).getByLabelText('Frame rate')).toHaveValue('30');
    expect(screen.getByTestId('export-plan')).toHaveTextContent(/300 frames, 1920 × 1080, 0:10 long/);
  });

  it('picks the offered frame rate nearest the video\'s', () => {
    setup({ video: { ...video, timing: { durationSeconds: 10, frameIntervalSeconds: 1 / 24.9 } } });
    expect(within(panel()).getByLabelText('Frame rate')).toHaveValue('25');
  });

  it('offers the NTSC rates, and starts a 29.97 fps clip at 29.97, not at a drifting 30 (TD-059)', () => {
    setup({ video: { ...video, timing: { durationSeconds: 10, frameIntervalSeconds: 1001 / 30000 } } });
    const select = within(panel()).getByLabelText('Frame rate') as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toBe('29.97 fps');
    expect([...select.options].map((option) => option.textContent)).toEqual(
      expect.arrayContaining(['23.976 fps', '29.97 fps', '59.94 fps']),
    );
    // Ten seconds at 30000/1001 is 300 frames, rounded up.
    expect(screen.getByTestId('export-plan')).toHaveTextContent(/300 frames/);
  });

  it('re-plans when the frame rate or size changes', async () => {
    setup();
    await userEvent.selectOptions(within(panel()).getByLabelText('Frame rate'), '60');
    expect(screen.getByTestId('export-plan')).toHaveTextContent(/600 frames/);
    await userEvent.selectOptions(within(panel()).getByLabelText('Picture size'), '2160');
    expect(screen.getByTestId('export-plan')).toHaveTextContent(/3840 × 2160/);
  });

  it('offers the video\'s own size first, and not twice', () => {
    setup();
    const sizes = within(within(panel()).getByLabelText('Picture size')).getAllByRole('option');
    expect(sizes.map((option) => option.textContent)).toEqual([
      'Same as the video (1920 × 1080)',
      '720p (1280 × 720)',
      '2160p (3840 × 2160)',
    ]);
  });

  it('exports with exactly what the preview shows: template, offset, units, clock', async () => {
    const controls: OverlayControls = { ...DEFAULT_OVERLAY_CONTROLS, presetId: 'compact-hud' };
    const { start } = setup({ controls, offsetSeconds: 1.5, units: 'imperial' });
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));

    expect(start).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0]![0] as Record<string, unknown> & {
      template: { name: string; components: { id: string }[] };
    };
    expect(request).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 300,
      videoDurationSeconds: 10,
      offsetSeconds: 1.5,
      units: 'imperial',
      activity,
    });
    expect(request.template.name).toBe('Compact HUD');
    expect(request.template.components.map((component) => component.id)).toEqual([
      'speed',
      'distance',
      'elapsed',
    ]);
  });

  it('shows progress, and stops on request without saving anything', async () => {
    const { jobs, progress } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    act(() => progress[0]!(120, 300));

    expect(screen.getByText('Frame 120 of 300')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Export progress' })).toHaveAttribute('value', '120');
    // The settings are fixed while it runs.
    expect(within(panel()).getByLabelText('Frame rate')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Stop export' }));
    expect(jobs[0]!.cancel).toHaveBeenCalled();
    await act(async () => jobs[0]!.reject(new OverlayExportError('cancelled', 'The export was stopped.')));

    expect(screen.getByRole('status')).toHaveTextContent('Export stopped. Nothing was saved.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
  });

  it('offers the finished archive as a download named for the video and its settings', async () => {
    const { jobs } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    const dispose = vi.fn(async () => undefined);
    await act(async () =>
      jobs[0]!.resolve({ file: new Blob(['zip']), bytes: 12_000_000, frameCount: 300, dispose }),
    );

    const link = screen.getByRole('link', { name: /GH010042-overlay-1920x1080-30fps\.zip/ });
    expect(link).toHaveAttribute('href', 'blob:zip');
    expect(link).toHaveAttribute('download', 'GH010042-overlay-1920x1080-30fps.zip');
    expect(screen.getByRole('status')).toHaveTextContent('Done: 300 frames, 12 MB.');
  });

  it('frees the stored archive when a new export replaces it, and when the page is left', async () => {
    const { jobs, unmount } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    const first = vi.fn(async () => undefined);
    await act(async () => jobs[0]!.resolve({ file: new Blob(['a']), bytes: 1, frameCount: 300, dispose: first }));

    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:zip');

    const second = vi.fn(async () => undefined);
    await act(async () => jobs[1]!.resolve({ file: new Blob(['b']), bytes: 1, frameCount: 300, dispose: second }));
    unmount();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops a running export when the page is left', async () => {
    const { jobs, unmount } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    unmount();
    expect(jobs[0]!.cancel).toHaveBeenCalled();
  });

  it('recovers when the export cannot even be started, instead of staying "running"', async () => {
    const { start } = setup();
    start.mockImplementationOnce(() => {
      throw new Error('Worker blocked by policy');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Worker blocked by policy');
    expect(screen.queryByRole('button', { name: 'Stop export' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(panel()).getByLabelText('Frame rate')).toBeEnabled();

    // And it can be tried again.
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Stop export' })).toBeInTheDocument();
  });

  it('shows why an export failed', async () => {
    const { jobs } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    await act(async () =>
      jobs[0]!.reject(new OverlayExportError('storage_failed', 'Not enough free space.')),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Not enough free space.');
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
  });

  it('explains an unsupported browser and offers no export', () => {
    setup({ support: { supported: false, reason: 'This browser cannot draw images in the background.' } });
    expect(screen.getByRole('alert')).toHaveTextContent('cannot draw images in the background');
    expect(screen.queryByRole('button', { name: 'Export PNG sequence' })).not.toBeInTheDocument();
  });

  it('waits for the video to say how big and how long it is', () => {
    setup({ media: undefined, video: { ...video, timing: undefined } });
    expect(screen.getByRole('status')).toHaveTextContent(/Waiting for the video to load/);
    expect(screen.queryByRole('button', { name: 'Export PNG sequence' })).not.toBeInTheDocument();
  });

  it('takes the length from the video element when the container stated none', () => {
    setup({ video: { ...video, timing: undefined }, media: { ...media, durationSeconds: 4 } });
    expect(screen.getByTestId('export-plan')).toHaveTextContent(/120 frames/);
  });

  it('refuses what a ZIP cannot hold, and offers the frame rate that fits', async () => {
    const long: OverlayMedia = { width: 3840, height: 2160, durationSeconds: 600 };
    const fits = highestFittingFrameRate({ videoDurationSeconds: 600, width: 3840, height: 2160 })!;
    setup({
      media: long,
      video: { ...video, timing: { durationSeconds: 600, frameIntervalSeconds: 1 / 60 } },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/more than one ZIP file can hold/);
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: `Use ${fits} fps` }));
    expect(within(panel()).getByLabelText('Frame rate')).toHaveValue(String(fits));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
  });

  it('plans against what this browser can store, before any frame is drawn', async () => {
    // The worker can only hold the archive in memory, up to 1 GB.
    const limit = 1_000_000_000;
    const long = { video: { ...video, timing: { durationSeconds: 600, frameIntervalSeconds: 1 / 30 } }, media: { width: 1920, height: 1080, durationSeconds: 600 } };
    const fits = highestFittingFrameRate({ videoDurationSeconds: 600, width: 1920, height: 1080, limitBytes: limit })!;
    const { start } = setup({ ...long, probeStorage: syncProbe('memory') });

    expect(screen.getByRole('alert')).toHaveTextContent(/This browser can store about 1\.0 GB of export/);
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeDisabled();
    expect(start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: `Use ${fits} fps` }));
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
  });

  it('waits for the worker to say where it can store the export, and offers nothing before it does', async () => {
    let answer!: (storage: ArchiveStorage) => void;
    setup({ probeStorage: () => new Promise<ArchiveStorage>((resolve) => (answer = resolve)) });
    expect(screen.getByRole('status')).toHaveTextContent(/Checking how this browser can store the export/);
    expect(screen.queryByRole('button', { name: 'Export PNG sequence' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-plan')).not.toBeInTheDocument();

    await act(async () => answer('opfs'));
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
    expect(screen.queryByText(/Checking how this browser/)).not.toBeInTheDocument();
  });

  it('says so, and offers no export, when the export engine cannot be started at all', async () => {
    setup({
      probeStorage: () =>
        Promise.reject(new OverlayExportError('render_failed', 'The export engine could not be started: blocked.')),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The export engine could not be started: blocked.');
    expect(screen.queryByRole('button', { name: 'Export PNG sequence' })).not.toBeInTheDocument();
  });

  it('does not probe a browser that cannot export', () => {
    const probeStorage = vi.fn(syncProbe('opfs'));
    setup({ probeStorage, support: { supported: false, reason: 'No worker.' } });
    expect(probeStorage).not.toHaveBeenCalled();
  });

  it('allows the same export where a file on disk can hold it', () => {
    setup({
      video: { ...video, timing: { durationSeconds: 600, frameIntervalSeconds: 1 / 30 } },
      media: { width: 1920, height: 1080, durationSeconds: 600 },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
  });

  describe('a finished export that the page has moved on from', () => {
    const finish = async (utils: ReturnType<typeof setup>) => {
      await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
      await act(async () =>
        utils.jobs[0]!.resolve({ file: new Blob(['zip']), bytes: 1_000_000, frameCount: 300, dispose: async () => undefined }),
      );
    };
    const stale = () => screen.queryByText(/made with earlier settings/);
    const again = (utils: ReturnType<typeof setup>, props: Partial<React.ComponentProps<typeof OverlayExportPanel>>) =>
      utils.rerender(
        <OverlayExportPanel
          video={video}
          activity={activity}
          controls={DEFAULT_OVERLAY_CONTROLS}
          offsetSeconds={0}
          units="metric"
          media={media}
          start={utils.start as never}
          support={{ supported: true }}
          probeStorage={syncProbe('opfs')}
          {...props}
        />,
      );

    it('is not flagged while it still matches the preview', async () => {
      const utils = setup();
      await finish(utils);
      expect(screen.getByRole('link')).toBeInTheDocument();
      expect(stale()).not.toBeInTheDocument();
    });

    it.each([
      ['the template', { controls: { ...DEFAULT_OVERLAY_CONTROLS, presetId: 'compact-hud' as const } }],
      ['a component', { controls: { ...DEFAULT_OVERLAY_CONTROLS, enabled: { speed: false } } }],
      ['the style', { controls: { ...DEFAULT_OVERLAY_CONTROLS, accentColor: '#00ff00' } }],
      ['the offset', { offsetSeconds: 2 }],
      ['the units', { units: 'imperial' as const }],
    ])('is flagged when %s changes, and clears when it is put back', async (_name, change) => {
      const utils = setup();
      await finish(utils);
      again(utils, change);
      expect(stale()).toBeInTheDocument();
      // The file is still there to download if that is what the reader wants.
      expect(screen.getByRole('link')).toBeInTheDocument();
      again(utils, {});
      expect(stale()).not.toBeInTheDocument();
    });

    it('is flagged when the frame rate or size changes', async () => {
      const utils = setup();
      await finish(utils);
      await userEvent.selectOptions(within(panel()).getByLabelText('Frame rate'), '15');
      expect(stale()).toBeInTheDocument();
      await userEvent.selectOptions(within(panel()).getByLabelText('Frame rate'), '30');
      expect(stale()).not.toBeInTheDocument();
      await userEvent.selectOptions(within(panel()).getByLabelText('Picture size'), '720');
      expect(stale()).toBeInTheDocument();
    });

    it('is flagged when the activity or the video is replaced', async () => {
      const utils = setup();
      await finish(utils);
      again(utils, { activity: makeActivity([...activity.points.map((point) => ({ ...point }))]) });
      expect(stale()).toBeInTheDocument();
      again(utils, {});
      again(utils, { video: { ...video, file: new File(['y'], 'other.mp4') } });
      expect(stale()).toBeInTheDocument();
    });
  });

  it('has nothing to export when every component is off', () => {
    const off = Object.fromEntries(
      ['speed', 'distance', 'elapsed', 'elevation', 'heartRate', 'route', 'progress'].map((key) => [key, false]),
    );
    setup({ controls: { ...DEFAULT_OVERLAY_CONTROLS, enabled: off } });
    expect(screen.getByRole('status')).toHaveTextContent(/nothing to export/);
    expect(screen.getByRole('button', { name: 'Export PNG sequence' })).toBeDisabled();
  });

  it('draws nothing for an activity that cannot be lined up with the video', () => {
    const { container } = setup({ activity: makeActivity([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]) });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('an export that would draw nothing (TD-059)', () => {
  it('waits, and says why, when the activity covers none of the video', () => {
    setup({ video: { ...video, timing: { durationSeconds: 10, frameIntervalSeconds: 1 / 30, start: new Date('2001-01-01T00:00:00Z') } } });
    expect(within(panel()).getByText(/covers none of this video, so nothing would be drawn/)).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Export PNG sequence' })).toBeDisabled();
  });

  it('exports where the activity does not reach when there are shapes or texts for the whole activity, and says what is drawn', () => {
    setup({
      video: { ...video, timing: { durationSeconds: 10, frameIntervalSeconds: 1 / 30, start: new Date('2001-01-01T00:00:00Z') } },
      template: {
      version: 2,
      name: 'Card',
      style: DEFAULT_OVERLAY_TEMPLATE_STYLE,
      components: [{ id: 'card', type: 'shape', visible: true, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 }, unitMode: 'auto', style: {}, shape: DEFAULT_SHAPE }],
    },
    });
    expect(within(panel()).queryByText(/so nothing would be drawn/)).not.toBeInTheDocument();
    expect(within(panel()).getByText(/only the shapes and texts for the whole activity are drawn/)).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Export PNG sequence' })).toBeEnabled();
  });
});

describe('telling the page a file is finished (AV-1011)', () => {
  it('reports a finished archive once, to a page that redraws on every report, and that it is gone with the panel', async () => {
    const { start, jobs, unmount } = setup();
    unmount();
    render(
      <Reporting
        panel={(onFinishedChange) => (
          <OverlayExportPanel
            video={video}
            activity={activity}
            controls={DEFAULT_OVERLAY_CONTROLS}
            offsetSeconds={0}
            units="metric"
            media={media}
            start={start as never}
            support={{ supported: true }}
            probeStorage={syncProbe('opfs')}
            onFinishedChange={onFinishedChange}
          />
        )}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Export PNG sequence' }));
    await act(async () => jobs[0]!.resolve({ file: new Blob(['zip']), bytes: 1, frameCount: 1, dispose: async () => undefined }));
    expect(screen.getByTestId('reports')).toHaveTextContent(/^false,true$/);
    await userEvent.click(screen.getByRole('button', { name: 'Take the panel away' }));
    expect(screen.getByTestId('reports')).toHaveTextContent(/^false,true,false$/);
  });
});

describe('a transparent WebM (AV-1012)', () => {
  /** A WebM probe that has already answered, like `syncProbe`. */
  const webmProbe = (supported: boolean) => () =>
    ({
      then: (ok: (value: { supported: boolean; reason?: string }) => void) =>
        ok(supported ? { supported } : { supported, reason: 'This browser cannot record a transparent video.' }),
    }) as unknown as Promise<{ supported: boolean }>;

  const webmSetup = (supported: boolean) => {
    const recordings: ReturnType<typeof controlledJob>[] = [];
    const startWebm = vi.fn(() => {
      const next = controlledJob();
      recordings.push(next);
      return next.job;
    });
    return { ...setup({ startWebm: startWebm as never, probeWebm: webmProbe(supported) }), startWebm, recordings };
  };

  it('is offered, with the reason, only where the browser keeps the transparency', () => {
    webmSetup(false);
    const choice = within(panel()).getByRole('radio', { name: /Transparent video \(WebM\)/ });
    expect(choice).toBeDisabled();
    expect(panel()).toHaveTextContent(/cannot record a transparent video/);
    expect(within(panel()).getByRole('radio', { name: 'PNG sequence (ZIP)' })).toBeChecked();
  });

  it('says it is recorded in real time, and records it rather than drawing frames', async () => {
    const { start, startWebm } = webmSetup(true);
    await userEvent.click(within(panel()).getByRole('radio', { name: /Transparent video \(WebM\)/ }));

    expect(screen.getByTestId('export-plan')).toHaveTextContent(/300 frames, 1920 × 1080, 0:10 long/);
    expect(screen.getByTestId('export-plan')).toHaveTextContent(/real time, so it takes 0:10: keep this tab open/);
    await userEvent.click(screen.getByRole('button', { name: 'Export transparent video' }));

    expect(start).not.toHaveBeenCalled();
    expect(startWebm).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1920, height: 1080, fps: 30, frameCount: 300 }),
      expect.any(Function),
    );
    // The format cannot change under a recording.
    expect(within(panel()).getByRole('radio', { name: 'PNG sequence (ZIP)' })).toBeDisabled();
  });

  it('offers the finished video as a .webm, with how to place it and anything the reader should know', async () => {
    const { recordings } = webmSetup(true);
    await userEvent.click(within(panel()).getByRole('radio', { name: /Transparent video \(WebM\)/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Export transparent video' }));
    await act(async () =>
      recordings[0]!.resolve({
        file: new Blob(['webm']),
        bytes: 2_000_000,
        frameCount: 300,
        notes: ['The video’s length could not be written into it.'],
        dispose: async () => undefined,
      }),
    );

    expect(screen.getByRole('link', { name: /GH010042-overlay-1920x1080-30fps\.webm/ })).toHaveAttribute(
      'download',
      'GH010042-overlay-1920x1080-30fps.webm',
    );
    expect(panel()).toHaveTextContent(/VP9 with an alpha channel, at 30 fps/);
    expect(panel()).toHaveTextContent(/length could not be written into it/);
    expect(panel()).not.toHaveTextContent(/set the sequence to/);

    // Choosing the other format leaves this file standing, made with earlier settings.
    await userEvent.click(within(panel()).getByRole('radio', { name: 'PNG sequence (ZIP)' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/made with earlier settings/);
  });
});
