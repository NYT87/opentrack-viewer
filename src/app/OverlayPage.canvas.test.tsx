import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * AV-1011. The custom canvas on the overlay page: its layout kept through Sync
 * and a change of mode, and a finished export of either kind guarded by Start
 * over. The exporters are stand-ins that finish on a press: their own tests
 * and the browser tests render for real.
 */
vi.mock('maplibre-gl', async () => {
  const { FakeMap, setWorkerUrl } = await import('../test/helpers/maplibreMock');
  return {
    default: { Map: FakeMap, NavigationControl: class {}, ScaleControl: class { setUnit() {} }, setWorkerUrl },
    Map: FakeMap,
    NavigationControl: class {},
    ScaleControl: class { setUnit() {} },
    setWorkerUrl,
  };
});
vi.mock('../components/BurnedInExportPanel', async () => {
  const { useEffect, useState } = await import('react');
  // The real panel's contract: it reports whether its file is finished, and that it is not as it goes.
  function BurnedInExportPanel({ onFinishedChange }: { onFinishedChange?: (finished: boolean) => void }) {
    const [finished, setFinished] = useState(false);
    useEffect(() => {
      onFinishedChange?.(finished);
      return () => onFinishedChange?.(false);
    }, [finished, onFinishedChange]);
    return (
      <section aria-label="Export video with the overlay">
        <button type="button" onClick={() => setFinished(true)}>
          Finish the video
        </button>
      </section>
    );
  }
  return { BurnedInExportPanel };
});

const { App } = await import('./App');
const { useOverlayStore } = await import('../state/overlayStore');
const { makeActivity } = await import('../test/helpers/activity');

const T0 = Date.parse('2026-09-24T08:00:00Z');
const ride = () =>
  makeActivity(Array.from({ length: 30 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + (i * 5) / 111_320, lon: 7 })));

beforeEach(() => {
  useOverlayStore.getState().clear();
  const { controls, canvasMode, canvasDraft } = useOverlayStore.getInitialState();
  useOverlayStore.setState({ controls, canvasMode, canvasDraft });
  window.location.hash = '#/overlays';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() =>
    new Proxy({}, { get: (_target, key) => (key === 'measureText' ? () => ({ width: 40 }) : () => undefined), set: () => true })) as never);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function canvasOverVideo() {
  render(<App />);
  act(() => {
    useOverlayStore.getState().setVideo({
      file: new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' }),
      timing: { durationSeconds: 30, frameIntervalSeconds: 1 / 30, start: new Date(T0) },
    });
    useOverlayStore.getState().setActivity(ride(), 'hand');
  });
  await userEvent.click(await screen.findByRole('radio', { name: 'A custom canvas over the video' }));
  return screen.getByRole('region', { name: 'Custom canvas' });
}

async function addSpeed(canvas: HTMLElement) {
  await userEvent.selectOptions(within(canvas).getByLabelText('Add'), within(canvas).getByRole('option', { name: 'Speed' }));
  await userEvent.click(within(canvas).getByRole('button', { name: 'Add to the canvas' }));
}

describe('the custom canvas on the page (AV-1011)', () => {
  it('keeps its layout, size and undo through Sync and the other mode', async () => {
    let canvas = await canvasOverVideo();
    await userEvent.selectOptions(within(canvas).getByLabelText('Size'), '1080x1920');
    await addSpeed(canvas);
    await userEvent.click(within(canvas).getByRole('button', { name: 'Snap to bottom right' }));

    await userEvent.click(within(canvas).getByRole('button', { name: 'Change where the video starts' }));
    expect(screen.queryByRole('region', { name: 'Custom canvas' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'A custom canvas over the video' }));

    canvas = screen.getByRole('region', { name: 'Custom canvas' });
    expect(within(canvas).getByRole('group', { name: /^Canvas preview, 1080 by 1920/ })).toBeInTheDocument();
    expect(within(canvas).getByRole('list', { name: 'Elements on the canvas' })).toHaveTextContent('Speed');
    expect(Number((within(canvas).getByLabelText('From the left (%)') as HTMLInputElement).value)).toBeGreaterThan(50);
    // Undo still has the snap, then the add.
    await userEvent.click(within(canvas).getByRole('button', { name: 'Undo' }));
    expect((within(canvas).getByLabelText('From the left (%)') as HTMLInputElement).value).toBe('4');
  });

  it('keeps the layout through Start over, as it keeps the template settings', async () => {
    const canvas = await canvasOverVideo();
    await addSpeed(canvas);
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    act(() => useOverlayStore.getState().setActivity(ride(), 'hand'));
    expect(within(screen.getByRole('region', { name: 'Custom canvas' })).getByRole('list', { name: 'Elements on the canvas' })).toHaveTextContent('Speed');
  });

  it('asks before Start over throws away a finished burned-in video from the canvas', async () => {
    const canvas = await canvasOverVideo();
    await addSpeed(canvas);
    await userEvent.click(within(canvas).getByRole('button', { name: 'Finish the video' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('button', { name: 'Start over anyway' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Custom canvas' })).toBeInTheDocument();
  });

  it('forgets a finished export once its panel is gone, and does not ask then', async () => {
    const canvas = await canvasOverVideo();
    await addSpeed(canvas);
    await userEvent.click(within(canvas).getByRole('button', { name: 'Finish the video' }));
    // Deleting the only element takes the exports away, and the finished video with them.
    await userEvent.click(within(canvas).getByRole('button', { name: 'Delete' }));
    expect(within(canvas).queryByRole('region', { name: 'Export video with the overlay' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByRole('button', { name: 'Start over anyway' })).not.toBeInTheDocument();
  });

  it('learns the size and length of a video added, or replaced, while the canvas is open', async () => {
    render(<App />);
    act(() => useOverlayStore.getState().setActivity(ride(), 'hand'));
    await userEvent.click(await screen.findByRole('radio', { name: 'A custom video overlay, with no video' }));
    await addSpeed(screen.getByRole('region', { name: 'Custom canvas' }));

    /** The canvas's own video loads, as a browser would say it had. */
    const load = (width: number, height: number, duration: number) => {
      const element = screen.getByTestId('canvas-video');
      Object.defineProperties(element, {
        videoWidth: { value: width, configurable: true },
        videoHeight: { value: height, configurable: true },
        duration: { value: duration, configurable: true },
      });
      fireEvent(element, new Event('loadedmetadata'));
    };
    const video = (name: string) => ({
      file: new File([new Uint8Array(8)], name, { type: 'video/mp4' }),
      timing: { durationSeconds: 30, frameIntervalSeconds: 1 / 30, start: new Date(T0) },
    });

    act(() => useOverlayStore.getState().setVideo(video('first.mp4')));
    const canvas = screen.getByRole('region', { name: 'Custom canvas' });
    expect(useOverlayStore.getState().media).toBeUndefined();
    load(848, 480, 30);
    expect(useOverlayStore.getState().media).toEqual({ width: 848, height: 480, durationSeconds: 30 });
    expect(within(canvas).getByRole('option', { name: 'Same as the video (848 × 480)' })).toBeInTheDocument();
    expect(within(canvas).getByRole('region', { name: 'Export video with the overlay' })).toBeInTheDocument();

    act(() => useOverlayStore.getState().setVideo(video('second.mp4')));
    expect(useOverlayStore.getState().media).toBeUndefined();
    load(1280, 720, 30);
    expect(useOverlayStore.getState().media).toEqual({ width: 1280, height: 720, durationSeconds: 30 });
    expect(within(canvas).getByRole('option', { name: 'Same as the video (1280 × 720)' })).toBeInTheDocument();
  });
});
