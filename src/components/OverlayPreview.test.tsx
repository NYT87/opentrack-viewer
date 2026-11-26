import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VideoTrim } from '../overlay/trim';
import { OverlayPreview } from './OverlayPreview';
import { DEFAULT_OVERLAY_CONTROLS } from '../overlay/presets';
import { makeActivity } from '../test/helpers/activity';
import type { OverlaySpeed, OverlayVideo } from '../state/overlayStore';
import { effectiveWarp } from '../overlay/videoSpeed';
import { buildOverlayTimeline, type VideoTimeWarp } from '../overlay/timeline';

vi.mock('../overlay/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../overlay/timeline')>();
  return { ...actual, buildOverlayTimeline: vi.fn(actual.buildOverlayTimeline) };
});

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

function Harness(props: { source?: ReturnType<typeof activity> | null; cameraWarp?: VideoTimeWarp }) {
  // `null` is no activity; leaving it out is the default one (a default
  // parameter would swallow `undefined`).
  const source = props.source === null ? undefined : (props.source ?? activity());
  const [offset, setOffset] = useState(0);
  const [trim, setTrim] = useState<VideoTrim | undefined>(undefined);
  const [controls, setControls] = useState(DEFAULT_OVERLAY_CONTROLS);
  const [speed, setSpeed] = useState<OverlaySpeed | undefined>(undefined);
  const shown: OverlayVideo = props.cameraWarp ? { ...video, timing: { ...video.timing!, warp: props.cameraWarp } } : video;
  return (
    <OverlayPreview
      video={shown}
      activity={source}
      offsetSeconds={offset}
      onOffsetChange={setOffset}
      videoWarp={effectiveWarp(shown.timing, speed)}
      speed={speed}
      onSpeedChange={setSpeed}
      trim={trim}
      onTrimChange={setTrim}
      units="metric"
      controls={controls}
      onControlsChange={(patch) => setControls((current) => ({ ...current, ...patch }))}
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

describe('overlay preview sync (AV-1004, TD-059)', () => {
  it('starts the video earlier or later in the activity, and goes back to where it was placed', async () => {
    render(<Harness />);
    act(() => seekTo(5));
    expect(within(layer()).getByText('18.0 km/h')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '−1 s, earlier' }));
    expect(within(layer()).getByText('14.4 km/h')).toBeInTheDocument(); // telemetry of t = 4

    await userEvent.click(screen.getByRole('button', { name: '+1 s, later' }));
    await userEvent.click(screen.getByRole('button', { name: '+1 s, later' }));
    expect(within(layer()).getByText('21.6 km/h')).toBeInTheDocument(); // t = 6

    await userEvent.click(screen.getByRole('button', { name: "Back to the activity's start" }));
    expect(within(layer()).getByText('18.0 km/h')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Back to the activity's start" })).not.toBeInTheDocument();
  });

  it('takes a typed start without rewriting what is half typed', async () => {
    render(<Harness />);
    act(() => seekTo(5));
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    await userEvent.clear(field);
    await userEvent.type(field, '-2');
    expect(field).toHaveValue('-2');
    expect(within(layer()).getByText('10.8 km/h')).toBeInTheDocument(); // t = 3
    await userEvent.tab();
    expect(field).toHaveValue('-2');
  });

  it('reads minutes and seconds, and steps by key: a second, ten with Shift', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    await userEvent.clear(field);
    await userEvent.type(field, '-1:30');
    await userEvent.tab();
    // Typed, it is taken as typed, even off the activity.
    expect(field).toHaveValue('-1:30');
    await userEvent.clear(field);
    await userEvent.type(field, '-0:05');
    await userEvent.keyboard('{ArrowUp}');
    expect(field).toHaveValue('-4');
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(field).toHaveValue('6');
    // A step is held to where the video still touches the ten-second activity.
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(field).toHaveValue('10');
  });

  it('lines up the frame shown with a moment of the activity', async () => {
    render(<Harness />);
    act(() => seekTo(5));
    // This frame is the activity's 0:02: the telemetry of t = 2 is shown here.
    const form = screen.getByRole('form', { name: 'Line up this frame' });
    await userEvent.type(within(form).getByRole('textbox'), '0:02');
    await userEvent.click(within(form).getByRole('button', { name: 'Line up' }));
    expect(screen.getByRole('textbox', { name: 'Video starts at' })).toHaveValue('-3');
    expect(within(layer()).getByText('7.2 km/h')).toBeInTheDocument(); // t = 2
  });

  it('refuses a moment that is not a time, or is past the activity, and says why', async () => {
    render(<Harness />);
    const form = screen.getByRole('form', { name: 'Line up this frame' });
    const moment = within(form).getByRole('textbox');
    await userEvent.type(moment, '9:99');
    expect(within(form).getByRole('button', { name: 'Line up' })).toBeDisabled();
    expect(moment).toHaveAccessibleDescription(/"9:99" is not a time/);
    await userEvent.clear(moment);
    await userEvent.type(moment, '0:20');
    expect(within(form).getByRole('button', { name: 'Line up' })).toBeDisabled();
    expect(moment).toHaveAccessibleDescription(/The activity is 0:10 long/);
  });

  it('slides the video along the activity from the bar under the picture, by key', async () => {
    render(<Harness />);
    const bar = within(screen.getByRole('region', { name: 'Preview' })).getByRole('slider', {
      name: 'Where the video starts in the activity',
    });
    expect(bar).toHaveAttribute('aria-valuetext', 'Video at 0:00 to 0:10 of 0:10');
    bar.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('textbox', { name: 'Video starts at' })).toHaveValue('1');
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(screen.getByRole('textbox', { name: 'Video starts at' })).toHaveValue('-9');
    await userEvent.keyboard('{Home}');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
  });

  it('drops a time it refused once the start is set some other way', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    await userEvent.clear(field);
    await userEvent.type(field, 'abc');
    await userEvent.tab();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    screen.getByRole('slider', { name: 'Where the video starts in the activity' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(field).toHaveValue('1');
    expect(field).not.toHaveAttribute('aria-invalid');
  });

  it('holds the bar to where the video still touches the activity', async () => {
    render(<Harness />);
    const bar = screen.getByRole('slider', { name: 'Where the video starts in the activity' });
    bar.focus();
    await userEvent.keyboard('{PageUp}{PageUp}');
    expect(bar).toHaveAttribute('aria-valuenow', '10');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(bar.getAttribute('aria-valuemax')));
  });

  it('keeps focus on the reset button through a reset and its undo', async () => {
    render(<Harness />);
    const reset = screen.getByRole('button', { name: 'Reset overlay settings' });
    reset.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Undo reset' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Reset overlay settings' })).toHaveFocus();
  });

  it('says in the stage when the video is off the activity, with the way back', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    await userEvent.clear(field);
    await userEvent.type(field, '30');
    const stage = screen.getByRole('region', { name: 'Preview' });
    expect(within(stage).getByText(/do not overlap, so nothing is drawn/)).toBeInTheDocument();
    await userEvent.click(within(stage).getByRole('button', { name: "Line up at the activity's start" }));
    expect(field).toHaveValue('0');
    expect(within(stage).queryByText(/do not overlap/)).not.toBeInTheDocument();
  });

  it('answers the transport keys anywhere in the stage, not only on the picture', async () => {
    render(<Harness />);
    screen.getByRole('slider', { name: 'Video position' }).focus();
    await userEvent.keyboard('l');
    expect(screen.getByRole('timer', { name: 'Current time' })).toHaveTextContent(/^0:05/);
    // The scrubber's own arrows step a frame, held to this video's frame.
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.querySelector('video')!.currentTime).toBeCloseTo(5 - 1 / 30, 5);
  });
});

describe('cutting the video to the part exported (TD-081)', () => {
  const line = () => within(screen.getByRole('group', { name: 'Part exported' })).getByText(/^Exporting/);

  it('sets the ends at the playhead, steps them by key, and lets the whole video back', async () => {
    render(<Harness />);
    expect(line()).toHaveTextContent('Exporting the whole video.');
    seekTo(3);
    await userEvent.click(screen.getByRole('button', { name: 'Start the export here' }));
    expect(line()).toHaveTextContent('Exporting 0:03 to 0:10 of the video, 0:07.');
    const start = screen.getByRole('slider', { name: 'Export starts at' });
    const end = screen.getByRole('slider', { name: 'Export ends at' });
    expect(start).toHaveAttribute('aria-valuenow', '3');
    expect(end).toHaveAttribute('aria-valuenow', '10');
    end.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(line()).toHaveTextContent('Exporting 0:03 to 0:08 of the video, 0:05.');
    // A handle's keys cut the video; they never slide it along the activity.
    expect(screen.getByRole('slider', { name: 'Where the video starts in the activity' })).toHaveAttribute('aria-valuenow', '0');
    expect(document.querySelector('.overlay-sync__legend')).toHaveTextContent(/Cut/);
    await userEvent.click(screen.getByRole('button', { name: 'Export the whole video' }));
    expect(line()).toHaveTextContent('Exporting the whole video.');
  });

  it('puts no slider inside another, so each is read out, and groups the lanes', () => {
    render(<Harness />);
    for (const slider of screen.getAllByRole('slider')) expect(slider.parentElement!.closest('[role="slider"]')).toBeNull();
    const lanes = screen.getByRole('group', { name: 'Timeline: the activity and the video' });
    expect(within(lanes).getAllByRole('slider').map((slider) => slider.getAttribute('aria-label'))).toEqual([
      'Where the video starts in the activity',
      'Export starts at',
      'Export ends at',
    ]);
  });

  it('says each end’s real bounds: a second short of the other end', async () => {
    render(<Harness />);
    seekTo(3);
    await userEvent.click(screen.getByRole('button', { name: 'Start the export here' }));
    seekTo(8);
    await userEvent.click(screen.getByRole('button', { name: 'End the export here' }));
    const start = screen.getByRole('slider', { name: 'Export starts at' });
    const end = screen.getByRole('slider', { name: 'Export ends at' });
    expect([start.getAttribute('aria-valuemin'), start.getAttribute('aria-valuemax')]).toEqual(['0', '7']);
    expect([end.getAttribute('aria-valuemin'), end.getAttribute('aria-valuemax')]).toEqual(['4', '10']);
    // Home takes an end to its own bound, not past the other.
    end.focus();
    await userEvent.keyboard('{Home}');
    expect(end).toHaveAttribute('aria-valuenow', '4');
  });

  it('says in Sync when the activity covers none of the cut, though it covers the video', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    await userEvent.clear(field);
    await userEvent.type(field, '-5');
    await userEvent.tab();
    seekTo(4);
    await userEvent.click(screen.getByRole('button', { name: 'End the export here' }));
    expect(line()).toHaveTextContent('Exporting 0:00 to 0:04 of the video, 0:04. The activity covers none of it');
    seekTo(3);
    await userEvent.click(screen.getByRole('button', { name: 'Start the export here' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export the whole video' }));
    expect(line()).not.toHaveTextContent('covers none');
  });

  it('keeps the ends apart', async () => {
    render(<Harness />);
    seekTo(6);
    await userEvent.click(screen.getByRole('button', { name: 'End the export here' }));
    seekTo(9);
    await userEvent.click(screen.getByRole('button', { name: 'Start the export here' }));
    expect(screen.getByRole('slider', { name: 'Export starts at' })).toHaveAttribute('aria-valuenow', '5');
    expect(screen.getByRole('slider', { name: 'Export ends at' })).toHaveAttribute('aria-valuenow', '6');
  });

  it('slides the video along the activity with its cut, which stays the video’s own', async () => {
    render(<Harness />);
    seekTo(2);
    await userEvent.click(screen.getByRole('button', { name: 'Start the export here' }));
    const bar = screen.getByRole('slider', { name: 'Where the video starts in the activity' });
    bar.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByRole('slider', { name: 'Export starts at' })).toHaveAttribute('aria-valuenow', '2');
  });
});

describe('parsing a typed offset (TD-059)', () => {
  it('reads seconds and clock time, signed, and refuses anything else', async () => {
    const { parseOffset, formatOffset } = await import('./OverlayPreview');
    expect(parseOffset('12.5')).toBe(12.5);
    expect(parseOffset('-90')).toBe(-90);
    expect(parseOffset('-23:00')).toBe(-1380);
    expect(parseOffset('1:02:03')).toBe(3723);
    expect(parseOffset('−0:05')).toBe(-5);
    expect(parseOffset('abc')).toBeUndefined();
    expect(parseOffset('1:2:3:4')).toBeUndefined();
    expect(parseOffset('9:99')).toBeUndefined();
    expect(parseOffset('')).toBeUndefined();
    expect(formatOffset(-1380)).toBe('-23:00');
    expect(formatOffset(3723)).toBe('1:02:03');
    expect(formatOffset(2.5)).toBe('2.5');
  });
});

describe('how the video is lined up (TD-059)', () => {
  it('says what it was lined up by, and draws the bar', () => {
    render(<Harness />);
    expect(screen.getByText(/Lined up/)).toBeInTheDocument();
    expect(document.querySelector('.overlay-sync__bar')).not.toBeNull();
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
    expect(screen.queryByRole('group', { name: 'Video start' })).not.toBeInTheDocument();
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

const item = (key: string) => layer().querySelector<HTMLElement>(`[data-component="${key}"]`);
const controlsRegion = () => screen.getByRole('region', { name: 'Overlay controls' });

describe('overlay template controls (AV-1005)', () => {
  it('switches templates, each drawing its own set', async () => {
    render(<Harness source={activity((i) => ({ heartRateBpm: 100 + i, elevationMeters: 50 + i }))} />);
    // The metric strip is the default: figures, the route and a progress bar.
    expect(item('elevation')).not.toBeNull();
    expect(item('progress')).not.toBeNull();

    await userEvent.click(within(controlsRegion()).getByRole('radio', { name: /Compact HUD/ }));
    expect(item('heartRate')).not.toBeNull();
    expect(item('route')).toBeNull();
    expect(item('elevation')).toBeNull();

    await userEvent.click(within(controlsRegion()).getByRole('radio', { name: /Route inset/ }));
    expect(item('route')).not.toBeNull();
    expect(item('heartRate')).toBeNull();
  });

  it('shows and hides a component from its checkbox', async () => {
    render(<Harness />);
    const speed = within(controlsRegion()).getByRole('checkbox', { name: 'Speed' });
    expect(speed).toBeChecked();
    expect(item('speed')).not.toBeNull();

    await userEvent.click(speed);
    expect(speed).not.toBeChecked();
    expect(item('speed')).toBeNull();
    expect(item('distance')).not.toBeNull();

    await userEvent.click(speed);
    expect(item('speed')).not.toBeNull();
  });

  it('keeps a choice across template switches', async () => {
    render(<Harness source={activity((i) => ({ elevationMeters: 50 + i }))} />);
    await userEvent.click(within(controlsRegion()).getByRole('checkbox', { name: 'Elevation' }));
    await userEvent.click(within(controlsRegion()).getByRole('radio', { name: /Compact HUD/ }));
    await userEvent.click(within(controlsRegion()).getByRole('radio', { name: /Metric strip/ }));
    expect(within(controlsRegion()).getByRole('checkbox', { name: 'Elevation' })).not.toBeChecked();
    expect(item('elevation')).toBeNull();
  });

  it('offers a component the activity has no data for as disabled, and warns about it', () => {
    render(<Harness />);
    const power = within(controlsRegion()).getByRole('checkbox', { name: /Power/ });
    expect(power).toBeDisabled();
    expect(power).not.toBeChecked();
    expect(controlsRegion()).toHaveTextContent(/Power — not in this activity/);
    // Heart rate is on in the default template, so the reader is told it is missing.
    expect(screen.getByRole('list', { name: 'Overlay warnings' })).toHaveTextContent(
      /Heart rate is not in this activity, so it is not shown/,
    );
    expect(item('heartRate')).toBeNull();
  });

  it('shows an unsupported component that is on as on, and lets the reader turn it off', async () => {
    // Elevation is present, so heart rate is the only default the activity lacks.
    render(<Harness source={activity((i) => ({ elevationMeters: 50 + i }))} />);
    const heartRate = within(controlsRegion()).getByRole('checkbox', { name: /Heart rate/ });
    expect(heartRate).toBeChecked();
    expect(heartRate).toBeEnabled();
    expect(screen.getByRole('list', { name: 'Overlay warnings' })).toBeInTheDocument();

    await userEvent.click(heartRate);
    expect(heartRate).not.toBeChecked();
    expect(heartRate).toBeDisabled(); // off and unsupported: it cannot be turned back on
    expect(screen.queryByRole('list', { name: 'Overlay warnings' })).not.toBeInTheDocument();
  });

  it('enables an extra metric once the activity has it, including sensor streams', async () => {
    const streams = [
      { key: 'ACCL', label: 'Acceleration', unit: 'm/s²', display: 'chart' as const, valuesByPoint: Array.from({ length: 11 }, (_, i) => i) },
    ];
    render(<Harness source={{ ...activity((i) => ({ powerWatts: 200 + i })), sensorStreams: streams }} />);
    await userEvent.click(within(controlsRegion()).getByRole('checkbox', { name: 'Power' }));
    await userEvent.click(within(controlsRegion()).getByRole('checkbox', { name: 'Acceleration' }));
    act(() => seekTo(5));
    expect(within(item('power')!).getByText('205 W')).toBeInTheDocument();
    expect(within(item('sensor:ACCL')!).getByText('5 m/s²')).toBeInTheDocument();
  });

  it('applies layout and style choices to the overlay', async () => {
    render(<Harness />);
    const speedTop = () => parseFloat(item('speed')!.style.top);
    expect(speedTop()).toBeGreaterThan(50);
    await userEvent.selectOptions(within(controlsRegion()).getByLabelText('Position'), 'top');
    expect(speedTop()).toBeLessThan(50);

    fireEvent.change(within(controlsRegion()).getByLabelText('Accent colour'), {
      target: { value: '#00ff00' },
    });
    expect(item('speed')!.style.getPropertyValue('--overlay-accent')).toBe('#00ff00');

    fireEvent.change(within(controlsRegion()).getByLabelText('Background'), {
      target: { value: '0.6' },
    });
    expect(item('speed')!.style.background).toContain('0.6');

    const width = () => parseFloat(item('speed')!.style.width);
    const before = width();
    fireEvent.change(within(controlsRegion()).getByLabelText('Size'), { target: { value: '1.5' } });
    expect(width()).toBeGreaterThan(before);

    act(() => seekTo(5));
    await userEvent.selectOptions(within(controlsRegion()).getByLabelText('Units'), 'imperial');
    expect(within(item('speed')!).getByText('11.2 mph')).toBeInTheDocument();
  });

  it('resets everything to the defaults', async () => {
    render(<Harness />);
    await userEvent.click(within(controlsRegion()).getByRole('checkbox', { name: 'Speed' }));
    await userEvent.click(within(controlsRegion()).getByRole('radio', { name: /Compact HUD/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset overlay settings' }));
    expect(within(controlsRegion()).getByRole('radio', { name: /Metric strip/ })).toBeChecked();
    expect(item('speed')).not.toBeNull();
  });

  it('shows no controls without a usable activity', () => {
    render(<Harness source={null} />);
    expect(screen.queryByRole('region', { name: 'Overlay controls' })).not.toBeInTheDocument();
    render(<Harness source={makeActivity([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }])} />);
    expect(screen.queryByRole('region', { name: 'Overlay controls' })).not.toBeInTheDocument();
  });
});

describe('the sync panel (TD-059)', () => {
  const far = (start: Date) => (
    <OverlayPreview
      video={{ ...video, timing: { durationSeconds: 10, frameIntervalSeconds: 1 / 30, start } }}
      activity={activity()}
      offsetSeconds={0}
      onOffsetChange={onFar}
      units="metric"
      controls={DEFAULT_OVERLAY_CONTROLS}
      onControlsChange={() => {}}
    />
  );
  const onFar = vi.fn();

  it('tells clocks days apart as two dates, not an hour count, and lines up in one press', async () => {
    onFar.mockClear();
    render(far(new Date(T0.getTime() - 400 * 86_400_000)));
    const warning = screen.getByText(/are from different times/);
    expect(warning).toHaveTextContent(/the activity starts .+, and the video .+\./);
    expect(warning.textContent).not.toMatch(/\d{3,}:\d\d:\d\d/);
    expect(document.querySelector('.overlay-sync__bar')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: "Line up at the activity's start" }));
    // The offset that puts the activity's first point at video 0.
    expect(onFar).toHaveBeenCalledWith(-400 * 86_400);
  });

  it('draws the activity\'s speed along the bar, to line a sprint up by', () => {
    render(<Harness />);
    expect(document.querySelector('.overlay-sync__trace polyline')?.getAttribute('points')).toMatch(/\d/);
    expect(document.querySelector('.overlay-sync__legend')).toHaveTextContent(/Video exported Speed/);
  });

  it('keeps text that is not a time, and says why, instead of reverting it', async () => {
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    await userEvent.clear(field);
    await userEvent.type(field, 'abc');
    await userEvent.tab();
    expect(field).toHaveValue('abc');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(/"abc" is not a time, so the video still starts at 0/);
  });

  it('shows the slider values beside the sliders', () => {
    render(<Harness />);
    expect(screen.getByRole('slider', { name: 'Size' })).toHaveAttribute('aria-valuetext', expect.stringMatching(/%$/));
    expect(screen.getByRole('combobox', { name: 'Position' })).toBeInTheDocument();
  });

  it('does not rebuild the timeline when the cut moves, only the stopwatch’s zero follows it (AV-1025)', () => {
    const source = activity();
    const props = {
      video,
      activity: source,
      offsetSeconds: 0,
      onOffsetChange: () => {},
      onTrimChange: () => {},
      units: 'metric' as const,
      controls: DEFAULT_OVERLAY_CONTROLS,
      onControlsChange: () => {},
    };
    const { rerender } = render(<OverlayPreview {...props} trim={{ startSeconds: 1 }} />);
    const builds = vi.mocked(buildOverlayTimeline).mock.calls.length;
    rerender(<OverlayPreview {...props} trim={{ startSeconds: 2 }} />);
    rerender(<OverlayPreview {...props} trim={{ startSeconds: 3, endSeconds: 9 }} />);
    expect(vi.mocked(buildOverlayTimeline).mock.calls.length).toBe(builds);
    // A different offset is a different timeline.
    rerender(<OverlayPreview {...props} offsetSeconds={1} trim={{ startSeconds: 3 }} />);
    expect(vi.mocked(buildOverlayTimeline).mock.calls.length).toBe(builds + 1);
  });
});

describe('video speed: time-lapse and TimeWarp footage (AV-1027)', () => {
  const speedGroup = () => screen.getByRole('group', { name: 'Video speed' });
  const choose = (name: string) => userEvent.selectOptions(within(speedGroup()).getByRole('combobox', { name: 'Video runs' }), name);

  it('is real time by default, with no factor field and nothing said about speed', () => {
    render(<Harness />);
    expect(within(speedGroup()).getByRole('combobox', { name: 'Video runs' })).toHaveValue('real');
    expect(within(speedGroup()).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(speedGroup()).queryByRole('option', { name: /camera/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/faster than real time/)).not.toBeInTheDocument();
  });

  it('takes a factor: the overlay shows the activity that much further on, and the sync line says so', async () => {
    render(<Harness />);
    await choose('N× faster');
    const factor = within(speedGroup()).getByRole('spinbutton', { name: 'Times faster' });
    await userEvent.clear(factor);
    await userEvent.type(factor, '2');
    expect(within(speedGroup()).getByText('1 second of video = 2 seconds of activity')).toBeInTheDocument();
    act(() => seekTo(2)); // The activity at 4 s: 4 m/s.
    expect(within(layer()).getByText('14.4 km/h')).toBeInTheDocument();
    expect(screen.getByText('The video runs 2× faster than real time.')).toBeInTheDocument();
    // Back to the activity's own pace.
    await choose('Real time');
    expect(within(layer()).getByText('7.2 km/h')).toBeInTheDocument();
    expect(screen.queryByText(/faster than real time/)).not.toBeInTheDocument();
  });

  it('keeps N× faster chosen while 1 is typed, takes it as real time on leaving, and holds a number out of range as typed, saying why', async () => {
    render(<Harness />);
    await choose('N× faster');
    const factor = within(speedGroup()).getByRole('spinbutton', { name: 'Times faster' });
    await userEvent.clear(factor);
    expect(factor).not.toHaveAttribute('aria-invalid');
    await userEvent.type(factor, '1');
    expect(within(speedGroup()).getByRole('combobox', { name: 'Video runs' })).toHaveValue('factor');
    await userEvent.clear(factor);
    await userEvent.type(factor, '0');
    expect(factor).toHaveAttribute('aria-invalid', 'true');
    expect(within(speedGroup()).getByText(/is not a speed/)).toBeInTheDocument();
    await userEvent.tab();
    expect(factor).toHaveValue(0); // kept as typed, with the reason, like the start field
    await userEvent.clear(factor);
    await userEvent.type(factor, '1');
    await userEvent.tab();
    expect(within(speedGroup()).getByRole('combobox', { name: 'Video runs' })).toHaveValue('real');
  });

  it('offers the camera’s timing where it was detected, makes it the default, and says it was followed', async () => {
    render(<Harness cameraWarp={{ kind: 'map', video: [0, 5, 10], real: [0, 5, 50] }} />);
    const select = within(speedGroup()).getByRole('combobox', { name: 'Video runs' });
    expect(select).toHaveValue('camera');
    expect(within(speedGroup()).getByRole('option', { name: /about 5×, ramps followed/ })).toBeInTheDocument();
    expect(screen.getByText("The video runs 5× faster than real time — the camera's timing, ramps followed.")).toBeInTheDocument();
    // Video 7.5 s is 5 + 2.5 * 9 = 27.5 s: past this ten-second activity, so nothing is drawn; 1 s is real time.
    act(() => seekTo(1));
    expect(within(layer()).getByText('3.6 km/h')).toBeInTheDocument();
    await choose('Real time');
    expect(select).toHaveValue('real');
    expect(screen.queryByText(/faster than real time/)).not.toBeInTheDocument();
  });

  it('holds a step to the video’s mapped length, not its own', async () => {
    render(<Harness />);
    await choose('N× faster');
    const factor = within(speedGroup()).getByRole('spinbutton', { name: 'Times faster' });
    await userEvent.clear(factor);
    await userEvent.type(factor, '3');
    const field = screen.getByRole('textbox', { name: 'Video starts at' });
    field.focus();
    await userEvent.keyboard('{PageDown}');
    expect(field).toHaveValue('-30'); // The video is 30 s long on the activity's clock, not 10.
  });
});
