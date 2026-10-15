import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverlayPreview } from './OverlayPreview';
import { makeActivity } from '../test/helpers/activity';
import type { OverlayVideo } from '../state/overlayStore';

const T0 = new Date('2024-01-01T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

/** One point a second for ten seconds: speed in m/s equals the second. */
const activity = (extra: (i: number) => object = () => ({})) =>
  makeActivity(
    Array.from({ length: 11 }, (_, i) => ({
      time: at(i),
      lat: 10 + i * 0.001,
      lon: 20 + i * 0.001,
      distanceMeters: i * 10,
      speedMetersPerSecond: i,
      ...extra(i),
    })),
  );

const video: OverlayVideo = {
  file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
  timing: { durationSeconds: 10, frameIntervalSeconds: 1 / 30 },
};

/** jsdom plays nothing: give the element the clock a browser's would have. */
function stubMedia() {
  const state = { time: 0, paused: true };
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: () => state.time,
    set: (value: number) => {
      state.time = value;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => state.paused,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
    configurable: true,
    get: () => 10,
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    state.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    state.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  return state;
}

function Harness(props: { source?: ReturnType<typeof activity> | null }) {
  // `null` is no activity; leaving it out is the default one (a default
  // parameter would swallow `undefined`).
  const source = props.source === null ? undefined : (props.source ?? activity());
  const [offset, setOffset] = useState(0);
  return (
    <OverlayPreview
      video={video}
      activity={source}
      offsetSeconds={offset}
      onOffsetChange={setOffset}
      units="metric"
    />
  );
}

const layer = () => screen.getByTestId('overlay-layer');
const seekTo = (seconds: number) => {
  const media = screen.getByTestId('overlay-video') as HTMLVideoElement;
  media.currentTime = seconds;
  fireEvent(media, new Event('seeked'));
};

let frames: FrameRequestCallback[];
let clock: ReturnType<typeof stubMedia>;

beforeEach(() => {
  clock = stubMedia();
  frames = [];
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:clip', revokeObjectURL: () => {} }));
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('overlay preview synchronization (AV-1004)', () => {
  it('draws the overlay for the current video time', () => {
    render(<Harness />);
    expect(within(layer()).getByText('0.0 km/h')).toBeInTheDocument();
    expect(within(layer()).getByText('0:00')).toBeInTheDocument();
  });

  it('follows a seek of the video', () => {
    render(<Harness />);
    act(() => seekTo(5));
    expect(within(layer()).getByText('18.0 km/h')).toBeInTheDocument();
    expect(within(layer()).getByText('50 m')).toBeInTheDocument();
    act(() => seekTo(2.5));
    expect(within(layer()).getByText('9.0 km/h')).toBeInTheDocument();
  });

  it('moves the overlay at once when the reader scrubs, and moves the video with it', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('slider', { name: 'Video position' }), {
      target: { value: '4' },
    });
    expect(clock.time).toBe(4);
    expect(within(layer()).getByText('14.4 km/h')).toBeInTheDocument();
    expect(screen.getByLabelText('Current time')).toHaveTextContent('0:04 / 0:10');
  });

  it('keeps up with playback frame by frame, and stops when paused', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    clock.time = 3;
    act(() => frames.shift()?.(0));
    expect(within(layer()).getByText('10.8 km/h')).toBeInTheDocument();
    clock.time = 6;
    act(() => frames.shift()?.(0));
    expect(within(layer()).getByText('21.6 km/h')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('prefers the per-frame video callback where the browser has one', async () => {
    const callbacks: (() => void)[] = [];
    const request = vi.fn((callback: () => void) => callbacks.push(callback));
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: request,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      value: () => {},
    });
    try {
      render(<Harness />);
      await userEvent.click(screen.getByRole('button', { name: 'Play' }));
      expect(request).toHaveBeenCalled();
      expect(window.requestAnimationFrame).not.toHaveBeenCalled();
      clock.time = 8;
      act(() => callbacks.shift()?.());
      expect(within(layer()).getByText('28.8 km/h')).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
      Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
    }
  });
});

describe('overlay preview offset (AV-1004)', () => {
  it('delays the telemetry for a positive offset and advances it for a negative one', async () => {
    render(<Harness />);
    act(() => seekTo(5));
    expect(within(layer()).getByText('18.0 km/h')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '+1 s' }));
    expect(within(layer()).getByText('14.4 km/h')).toBeInTheDocument(); // telemetry of t = 4

    await userEvent.click(screen.getByRole('button', { name: '−1 s' }));
    await userEvent.click(screen.getByRole('button', { name: '−1 s' }));
    expect(within(layer()).getByText('21.6 km/h')).toBeInTheDocument(); // t = 6

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(within(layer()).getByText('18.0 km/h')).toBeInTheDocument();
  });

  it('takes a typed offset without rewriting what is half typed', async () => {
    render(<Harness />);
    act(() => seekTo(5));
    const field = screen.getByRole('spinbutton');
    await userEvent.clear(field);
    await userEvent.type(field, '2');
    expect(field).toHaveValue(2);
    expect(within(layer()).getByText('10.8 km/h')).toBeInTheDocument(); // t = 3
    await userEvent.tab();
    expect(field).toHaveValue(2);
  });
});

describe('overlay preview with missing data (AV-1004)', () => {
  it('draws no heart-rate gauge for an activity without heart rate, and says so', () => {
    render(<Harness />);
    expect(within(layer()).queryByText('Heart rate')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Overlay warnings' })).toHaveTextContent(
      /Heart rate is not in this activity/,
    );
  });

  it('draws a gauge when the data exists', () => {
    render(<Harness source={activity((i) => ({ heartRateBpm: 100 + i }))} />);
    act(() => seekTo(5));
    expect(within(layer()).getByText('105 bpm')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Overlay warnings' })).toBeInTheDocument();
  });

  it('draws nothing, and says why, where the activity does not cover the video', () => {
    render(
      <Harness
        source={makeActivity([
          { time: at(0), distanceMeters: 0, speedMetersPerSecond: 1 },
          { time: at(4), distanceMeters: 4, speedMetersPerSecond: 1 },
        ])}
      />,
    );
    expect(within(layer()).getByText('3.6 km/h')).toBeInTheDocument();
    act(() => seekTo(7));
    expect(layer()).toBeEmptyDOMElement();
    expect(screen.getByRole('status')).toHaveTextContent(/no telemetry for this moment/i);
  });

  it('explains an activity with no timestamps and draws no overlay', () => {
    render(<Harness source={makeActivity([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }])} />);
    expect(screen.queryByTestId('overlay-layer')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/no timestamps/i);
    expect(screen.queryByRole('list', { name: 'Overlay warnings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Telemetry offset' })).not.toBeInTheDocument();
  });

  it('plays the video alone, with a note, when there is no activity yet', () => {
    render(<Harness source={null} />);
    expect(screen.getByTestId('overlay-video')).toBeInTheDocument();
    expect(screen.queryByTestId('overlay-layer')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/no activity to draw yet/i);
    expect(screen.queryByRole('list', { name: 'Overlay warnings' })).not.toBeInTheDocument();
  });

  it("shapes the frame like the video, so a portrait clip is not stretched", () => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1920 });
    try {
      render(<Harness />);
      const frame = layer().parentElement as HTMLElement;
      expect(Number(frame.style.getPropertyValue('--frame-aspect'))).toBeCloseTo(1080 / 1920);
    } finally {
      Reflect.deleteProperty(HTMLVideoElement.prototype, 'videoWidth');
      Reflect.deleteProperty(HTMLVideoElement.prototype, 'videoHeight');
    }
  });

  it('draws the route inset with the current position', () => {
    render(<Harness />);
    const route = layer().querySelector('[data-component="route"] svg');
    expect(route?.querySelectorAll('polyline')).toHaveLength(1);
    expect(route?.querySelectorAll('circle')).toHaveLength(1);
  });
});
