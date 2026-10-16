import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BurnedInExportPanel } from './BurnedInExportPanel';
import { OverlayExportError } from '../overlay/export/errors';
import type { ExportJob, ExportOutput } from '../overlay/export/client';
import type { ArchiveStorage, BurnSourceInfo } from '../overlay/export/protocol';
import { DEFAULT_OVERLAY_CONTROLS } from '../overlay/presets';
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

const goodInfo: BurnSourceInfo = {
  video: { codec: 'avc', width: 1920, height: 1080, canDecode: true },
  audio: { codec: 'aac', canDecode: true },
  canEncode: true,
};

/** A promise that has already answered, so a test sees the settled panel without waiting. */
const answered = <T,>(value: T) => ({ then: (ok: (v: T) => void) => ok(value) }) as unknown as Promise<T>;

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

function setup(props: Partial<React.ComponentProps<typeof BurnedInExportPanel>> = {}, info: BurnSourceInfo = goodInfo) {
  const jobs: ReturnType<typeof controlledJob>[] = [];
  const progress: ((fraction: number, seconds: number) => void)[] = [];
  const start = vi.fn((_request: unknown, onProgress: (fraction: number, seconds: number) => void) => {
    const next = controlledJob();
    jobs.push(next);
    progress.push(onProgress);
    return next.job;
  });
  const inspect = vi.fn(() => answered(info));
  const common = {
    video,
    activity,
    controls: DEFAULT_OVERLAY_CONTROLS,
    offsetSeconds: 0,
    units: 'metric' as const,
    media,
    start: start as never,
    inspect: inspect as never,
    probeStorage: () => answered<ArchiveStorage>('opfs'),
    freeSpace: () => answered<number | undefined>(100_000_000_000),
    support: { supported: true },
  };
  const utils = render(<BurnedInExportPanel {...common} {...props} />);
  return { ...utils, start, inspect, jobs, progress, common };
}

const panel = () => screen.getByRole('region', { name: 'Burned-in export' });
const renderButton = () => screen.getByRole('button', { name: 'Render video with overlay' });

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mp4'), revokeObjectURL: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the burned-in export panel (AV-1007)', () => {
  it('says what will be made, that the original is untouched, and that nothing is uploaded', () => {
    setup();
    expect(panel()).toHaveTextContent(/copy of your video with the overlay drawn into the picture/);
    expect(panel()).toHaveTextContent(/original file is only read, never changed/);
    expect(panel()).toHaveTextContent(/nothing is uploaded/);
    expect(panel()).toHaveTextContent(/Desktop browsers only/);
  });

  it('does not promise the original sound outright: it points to what will happen to this video\'s', () => {
    setup({}, { ...goodInfo, audio: { codec: 'pcm-s16', canDecode: true } });
    const intro = panel().querySelector('p')!;
    expect(intro).toHaveTextContent(/carrying your video's sound over where it can/);
    expect(intro).toHaveTextContent(/what will happen to yours is said below/);
    expect(intro).not.toHaveTextContent(/original sound/);
    // And below it, the conditional statement for a sound that cannot simply be copied.
    expect(screen.getByRole('list', { name: 'About this render' })).toHaveTextContent(
      /copied unchanged if an MP4 can hold it as it is/,
    );
  });

  it('shows the plan: size, codec, bitrate, file size and how long it will take', () => {
    setup();
    const plan = screen.getByTestId('burn-plan');
    expect(plan).toHaveTextContent('1920 × 1080, H.264 at about 7.5 Mbps');
    expect(plan).toHaveTextContent(/roughly 10 MB/);
    expect(plan).toHaveTextContent(/Rendering takes roughly 0:02 for 0:10 of video \(about 4\.5× faster than playing it\)/);
  });

  it('says what happens to the sound, from what the video has', () => {
    setup();
    expect(screen.getByRole('list', { name: 'About this render' })).toHaveTextContent('copied from your video unchanged');
  });

  it('says so when the sound is not AAC, or there is none', () => {
    setup({}, { ...goodInfo, audio: { codec: 'pcm-s16', canDecode: true } });
    expect(screen.getByRole('list', { name: 'About this render' })).toHaveTextContent(/converted where this browser can, and left out where it cannot/);
    document.body.innerHTML = '';
    setup({}, { ...goodInfo, audio: undefined });
    expect(screen.getByRole('list', { name: 'About this render' })).toHaveTextContent('This video has no sound.');
  });

  it('offers the video\'s size first, and a few others', () => {
    setup();
    const options = within(within(panel()).getByLabelText('Picture size')).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Same as the video (1920 × 1080)',
      '720p (1280 × 720)',
      '2160p (3840 × 2160)',
    ]);
  });

  it('looks at the video again, at the new size, when the size changes', async () => {
    const { inspect } = setup();
    expect(inspect).toHaveBeenLastCalledWith(video.file, expect.objectContaining({ width: 1920, height: 1080 }));
    await userEvent.selectOptions(within(panel()).getByLabelText('Picture size'), '720');
    expect(inspect).toHaveBeenLastCalledWith(video.file, expect.objectContaining({ width: 1280, height: 720 }));
    expect(screen.getByTestId('burn-plan')).toHaveTextContent('1280 × 720');
  });

  it('asks about the encoder at the rate the video has', () => {
    const { inspect } = setup();
    expect(inspect).toHaveBeenCalledWith(
      video.file,
      expect.objectContaining({ frameRate: 30, bitrate: expect.any(Number) }),
    );
  });

  it('starts the render with the file, the size, the template, the offset and the units', async () => {
    const { start } = setup({ offsetSeconds: 1.5, units: 'imperial' });
    await userEvent.click(renderButton());
    expect(start).toHaveBeenCalledTimes(1);
    const request = start.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({
      file: video.file,
      width: 1920,
      height: 1080,
      frameRate: 30,
      videoDurationSeconds: 10,
      offsetSeconds: 1.5,
      units: 'imperial',
      activity,
    });
    expect(request.bitrate).toBeGreaterThan(1_000_000);
    expect((request.template as { name: string }).name).toBe('Metric strip');
  });

  it('shows progress, and stops on request without saving anything', async () => {
    const { jobs, progress } = setup();
    await userEvent.click(renderButton());
    act(() => progress[0]!(0.42, 4.2));
    expect(screen.getByText(/42% — 0:04 of 0:10/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Render progress' })).toHaveAttribute('value', '42');
    expect(within(panel()).getByLabelText('Picture size')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Stop render' }));
    expect(jobs[0]!.cancel).toHaveBeenCalled();
    await act(async () => jobs[0]!.reject(new OverlayExportError('cancelled', 'The export was stopped.')));
    expect(screen.getByRole('status')).toHaveTextContent('Render stopped. Nothing was saved.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(renderButton()).toBeEnabled();
  });

  it('offers the rendered video as a download named for the original, and passes on notes', async () => {
    const { jobs } = setup();
    await userEvent.click(renderButton());
    await act(async () =>
      jobs[0]!.resolve({
        file: new Blob(['mp4']),
        bytes: 12_000_000,
        frameCount: 300,
        notes: ['The sound could not be carried over, so the rendered video has none.'],
        dispose: async () => undefined,
      }),
    );
    const link = screen.getByRole('link', { name: /GH010042-with-overlay\.mp4/ });
    expect(link).toHaveAttribute('href', 'blob:mp4');
    expect(link).toHaveAttribute('download', 'GH010042-with-overlay.mp4');
    expect(panel()).toHaveTextContent('Done: 12 MB.');
    expect(panel()).toHaveTextContent('The sound could not be carried over');
  });

  it('shows why a render failed, and can be tried again', async () => {
    const { jobs } = setup();
    await userEvent.click(renderButton());
    await act(async () => jobs[0]!.reject(new OverlayExportError('render_failed', 'The video could not be rendered.')));
    expect(screen.getByRole('alert')).toHaveTextContent('The video could not be rendered.');
    expect(renderButton()).toBeEnabled();
  });

  it('recovers when the render cannot even be started', async () => {
    const { start } = setup();
    start.mockImplementationOnce(() => {
      throw new Error('Worker blocked by policy');
    });
    await userEvent.click(renderButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Worker blocked by policy');
    expect(screen.queryByRole('button', { name: 'Stop render' })).not.toBeInTheDocument();
    await userEvent.click(renderButton());
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('frees the stored video when a new render replaces it, and when the page is left', async () => {
    const { jobs, unmount } = setup();
    await userEvent.click(renderButton());
    const first = vi.fn(async () => undefined);
    await act(async () => jobs[0]!.resolve({ file: new Blob(['a']), bytes: 1, frameCount: 1, dispose: first }));
    await userEvent.click(renderButton());
    expect(first).toHaveBeenCalledTimes(1);
    const second = vi.fn(async () => undefined);
    await act(async () => jobs[1]!.resolve({ file: new Blob(['b']), bytes: 1, frameCount: 1, dispose: second }));
    unmount();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops a render in progress when the page is left', async () => {
    const { jobs, unmount } = setup();
    await userEvent.click(renderButton());
    unmount();
    expect(jobs[0]!.cancel).toHaveBeenCalled();
  });

  describe('a finished render that the page has moved on from', () => {
    it.each([
      ['the template', { controls: { ...DEFAULT_OVERLAY_CONTROLS, presetId: 'compact-hud' as const } }],
      ['the offset', { offsetSeconds: 2 }],
      ['the units', { units: 'imperial' as const }],
    ])('is flagged when %s changes, and clears when it is put back', async (_name, change) => {
      const utils = setup();
      await userEvent.click(renderButton());
      await act(async () => utils.jobs[0]!.resolve({ file: new Blob(['a']), bytes: 1, frameCount: 1, dispose: async () => undefined }));
      expect(screen.queryByText(/rendered with earlier settings/)).not.toBeInTheDocument();
      utils.rerender(<BurnedInExportPanel {...utils.common} {...change} />);
      expect(screen.getByText(/rendered with earlier settings/)).toBeInTheDocument();
      expect(screen.getByRole('link')).toBeInTheDocument();
      utils.rerender(<BurnedInExportPanel {...utils.common} />);
      expect(screen.queryByText(/rendered with earlier settings/)).not.toBeInTheDocument();
    });

    it('is flagged when the picture size changes', async () => {
      const utils = setup();
      await userEvent.click(renderButton());
      await act(async () => utils.jobs[0]!.resolve({ file: new Blob(['a']), bytes: 1, frameCount: 1, dispose: async () => undefined }));
      await userEvent.selectOptions(within(panel()).getByLabelText('Picture size'), '720');
      expect(screen.getByText(/rendered with earlier settings/)).toBeInTheDocument();
    });
  });

  describe('when the render cannot be offered', () => {
    const blocked = () => {
      expect(renderButton()).toBeDisabled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    };

    it('says a browser without the right APIs, or a phone, cannot, and offers nothing', () => {
      const { start, inspect } = setup({ support: { supported: false, reason: 'Burned-in video export is available on desktop browsers only.' } });
      expect(screen.getByRole('alert')).toHaveTextContent('desktop browsers only');
      expect(screen.queryByRole('button', { name: 'Render video with overlay' })).not.toBeInTheDocument();
      expect(inspect).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    it('refuses a video this browser cannot decode', () => {
      setup({}, { ...goodInfo, video: { codec: 'hevc', width: 3840, height: 2160, canDecode: false } });
      blocked();
      expect(screen.getByRole('alert')).toHaveTextContent(/cannot decode this video \(HEVC \(H\.265\), 3840 × 2160\)/);
    });

    it('refuses where H.264 cannot be encoded at this size', () => {
      setup({}, { ...goodInfo, canEncode: false });
      blocked();
      expect(screen.getByRole('alert')).toHaveTextContent(/cannot encode H\.264 video at this size/);
    });

    it('does not present the encoder as confirmed hardware: the time is said to assume one', () => {
      setup();
      expect(screen.getByTestId('burn-plan')).toHaveTextContent(/roughly/);
      expect(screen.getByRole('list', { name: 'About this render' })).toHaveTextContent(
        /assumes this browser uses a hardware video encoder, which it is asked for but cannot confirm/,
      );
      expect(panel()).not.toHaveTextContent(/has a hardware/i);
    });

    it('refuses a picture larger than 4K', async () => {
      setup({ media: { width: 7680, height: 4320, durationSeconds: 10 } }, goodInfo);
      blocked();
      expect(screen.getByRole('alert')).toHaveTextContent(/larger than this export can handle/);
    });

    it('refuses where the worker has no file to write to', () => {
      setup({ probeStorage: () => answered<ArchiveStorage>('memory') });
      blocked();
      expect(screen.getByRole('alert')).toHaveTextContent(/too big to hold in memory/);
    });

    it('refuses when there is not room on the device, with the figures', () => {
      setup({ freeSpace: () => answered<number | undefined>(5_000_000) });
      blocked();
      expect(screen.getByRole('alert')).toHaveTextContent(/not enough free space/);
    });

    it('does not refuse for want of knowing the free space', () => {
      setup({ freeSpace: () => answered<number | undefined>(undefined) });
      expect(renderButton()).toBeEnabled();
    });

    it('waits, with nothing offered, until the video has been looked at', () => {
      setup({ inspect: (() => new Promise(() => undefined)) as never });
      expect(screen.getByRole('status')).toHaveTextContent(/Checking what this browser can do with this video/);
      expect(screen.queryByRole('button', { name: 'Render video with overlay' })).not.toBeInTheDocument();
    });

    it('says why a video could not be looked at', async () => {
      setup({
        inspect: (() => Promise.reject(new OverlayExportError('render_failed', 'This file is not a video this export can read.'))) as never,
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('not a video this export can read');
      expect(screen.queryByRole('button', { name: 'Render video with overlay' })).not.toBeInTheDocument();
    });

    it('waits for the video to say how big and how long it is', () => {
      const { inspect } = setup({ media: undefined, video: { ...video, timing: undefined } });
      expect(screen.getByRole('status')).toHaveTextContent(/Waiting for the video to load/);
      expect(inspect).not.toHaveBeenCalled();
    });

    it('has nothing to draw when every component is off', () => {
      const off = Object.fromEntries(['speed', 'distance', 'elapsed', 'elevation', 'heartRate', 'route', 'progress'].map((key) => [key, false]));
      setup({ controls: { ...DEFAULT_OVERLAY_CONTROLS, enabled: off } });
      expect(screen.getByRole('status')).toHaveTextContent(/nothing to draw/);
      expect(renderButton()).toBeDisabled();
    });
  });

  it('draws nothing for an activity that cannot be lined up with the video', () => {
    const { container } = setup({ activity: makeActivity([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }]) });
    expect(container).toBeEmptyDOMElement();
  });
});
