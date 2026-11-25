import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverlayBurnInExport } from './OverlayBurnInExport';
import { harness, recordedWebm, rendererFor, settle, type Harness } from '../test/helpers/burnInHarness';

let saved: { fileName: string; blob: Blob }[] = [];

beforeEach(() => {
  saved = [];
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, 'createObjectURL', {
    value: (blob: Blob) => {
      const url = `blob:test/${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ fileName: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => {
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
  vi.restoreAllMocks();
});

const VIDEO = { duration: 4, width: 640, height: 360 };

function mount(h: Harness, over: { video?: typeof VIDEO; onBusyChange?: (b: boolean) => void } = {}) {
  const { renderer, calls } = rendererFor(h);
  const view = render(
    <OverlayBurnInExport
      file={new File(['v'], 'private-name.mp4', { type: 'video/mp4' })}
      renderer={renderer}
      offsetSeconds={0}
      video={over.video ?? VIDEO}
      onBusyChange={over.onBusyChange}
      env={h.env}
    />,
  );
  return { ...view, calls };
}

const save = () => screen.getByRole('button', { name: 'Save video with overlay' });

/** Lets the export load its video, as the browser would. */
async function loaded(h: Harness) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    h.video.readyState = 1;
    h.video.fire('loadedmetadata');
  });
}
const tick = (h: Harness, t: number) => act(async () => { h.video.tick(t); await new Promise((r) => setTimeout(r, 0)); });

describe('Save video with overlay panel (AV-1007)', () => {
  it('defaults to the video\'s own size, rate of 30 and length, and says what it will cost', () => {
    mount(harness());
    expect(screen.getByLabelText('Video width')).toHaveValue(640);
    expect(screen.getByLabelText('Video height')).toHaveValue(360);
    expect(screen.getByLabelText('Video from')).toHaveValue(0);
    expect(screen.getByLabelText('Video to')).toHaveValue(4);
    expect(screen.getByText(/Takes about 4 s, and makes a file of about/)).toBeInTheDocument();
    expect(screen.getByText(/takes as long as the clip/i)).toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  it('says plainly when the browser cannot do it, and offers no button that would fail', () => {
    mount(harness({ supported: false }));
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot record video from a page/);
    expect(save()).toBeDisabled();
  });

  it('says so when it can record no format it can save', () => {
    mount(harness({ mimes: [] }));
    expect(screen.getByRole('alert')).toHaveTextContent(/format it can save/);
    expect(save()).toBeDisabled();
  });

  it('follows the settings in the estimate, and names a setting that is wrong', async () => {
    // Full HD, where quality makes a difference: a small picture sits at the minimum bitrate either way.
    mount(harness(), { video: { duration: 4, width: 1920, height: 1080 } });
    const before = screen.getByText(/Takes about/).textContent;
    await userEvent.selectOptions(screen.getByLabelText('Video quality'), 'high');
    expect(screen.getByText(/Takes about/).textContent).not.toBe(before);

    await userEvent.clear(screen.getByLabelText('Video to'));
    await userEvent.type(screen.getByLabelText('Video to'), '2');
    expect(screen.getByText(/Takes about 2 s/)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Video to'));
    await userEvent.type(screen.getByLabelText('Video to'), '9');
    expect(screen.getByRole('alert')).toHaveTextContent(/only 4\.0 seconds long/);
    expect(save()).toBeDisabled();
  });

  it('refuses a clip longer than a sensible export, saying why', async () => {
    mount(harness(), { video: { duration: 3600, width: 640, height: 360 } });
    expect(screen.getByRole('alert')).toHaveTextContent(/video's own speed/);
    expect(save()).toBeDisabled();
  });

  it('records, shows progress, and saves a named file', async () => {
    const h = harness();
    const busy: boolean[] = [];
    mount(h, { onBusyChange: (b) => busy.push(b) });
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 1);

    expect(screen.getByRole('progressbar', { name: 'Recording progress' })).toBeInTheDocument();
    expect(screen.getByText(/Recorded 1 s of 4 s/)).toBeInTheDocument();
    expect(screen.getByText(/Keep this tab in view/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    // Nothing can be changed mid-way.
    expect(screen.getByLabelText('Video width')).toBeDisabled();

    await tick(h, 2);
    await tick(h, 4);
    expect(await screen.findByText(/Saved/)).toHaveTextContent('video-with-overlay.webm');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.fileName).toBe('video-with-overlay.webm');
    // The length is in the file, and it is named for what it is, not for the source.
    expect(saved[0]!.blob.size).toBe(recordedWebm.length + 11);
    expect(saved[0]!.fileName).not.toMatch(/private-name/);
    expect(busy).toEqual([true, false]);
    expect(save()).toBeEnabled();
  });

  it('can be stopped, and saves nothing', async () => {
    const h = harness();
    const busy: boolean[] = [];
    mount(h, { onBusyChange: (b) => busy.push(b) });
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 1);

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await tick(h, 1.1);
    expect(await screen.findByText(/Stopped\. Nothing was saved\./)).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    expect(h.recorders[0]!.state).toBe('inactive');
    expect(busy).toEqual([true, false]);
  });

  it('says it is waiting when the tab is hidden, and carries on when it returns', async () => {
    const h = harness();
    mount(h);
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 1);

    act(() => h.setHidden(true));
    expect(await screen.findByText(/Paused — bring this tab back to the front/)).toBeInTheDocument();
    act(() => h.setHidden(false));
    await tick(h, 2);
    expect(screen.getByText(/Recorded 2 s of 4 s/)).toBeInTheDocument();
    await tick(h, 4);
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });

  it('leaves the sound out when asked, and says when there turned out to be none', async () => {
    const h = harness({ hasAudio: false });
    mount(h);
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 4);
    expect(await screen.findByText(/It has no sound/)).toBeInTheDocument();
  });

  it('records without sound when the box is cleared', async () => {
    const h = harness();
    mount(h);
    await userEvent.click(screen.getByLabelText(/Include the video's sound/));
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 4);
    await screen.findByText(/Saved/);
    expect(h.recorders[0]!.settings.mimeType).toBe('video/webm;codecs=vp9');
    // Asked not to, so there is nothing to apologise for.
    expect(screen.queryByText(/It has no sound/)).not.toBeInTheDocument();
  });

  it('says what went wrong, and what to try', async () => {
    const h = harness();
    mount(h);
    await userEvent.click(save());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      h.video.fire('error');
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/cannot play that video/);
    expect(alert).toHaveTextContent(/Try a recent|different/i);
    expect(save()).toBeEnabled();
    expect(saved).toHaveLength(0);
  });

  it('stops recording if the page is left mid-export', async () => {
    const h = harness();
    const { unmount } = mount(h);
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 1);
    unmount();
    await act(async () => {
      h.video.tick(1.1);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.recorders[0]!.state).toBe('inactive');
    expect(saved).toHaveLength(0);
    expect(h.revoked).toEqual(['blob:fake/1']);
  });

  it('plays the source video only: it makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const h = harness();
    mount(h);
    await userEvent.click(save());
    await loaded(h);
    await settle(h);
    await tick(h, 4);
    await screen.findByText(/Saved/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
