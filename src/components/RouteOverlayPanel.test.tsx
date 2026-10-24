import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouteOverlayPanel } from './RouteOverlayPanel';
import { RouteImageError, type RouteImagePlan } from '../overlay/routeImage';
import type { StillImagePlan } from '../overlay/staticImage';
import { makeActivity } from '../test/helpers/activity';

const ride = makeActivity(
  Array.from({ length: 20 }, (_, i) => ({ lat: 10 + i * 0.001, lon: 20 + i * 0.002 })),
);

let contexts: { clearRect: ReturnType<typeof vi.fn> }[];

beforeEach(() => {
  contexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    const ctx = new Proxy(
      { clearRect: vi.fn() },
      {
        get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : () => undefined),
        set: () => true,
      },
    );
    contexts.push(ctx);
    return ctx;
  }) as never);
});

afterEach(() => vi.restoreAllMocks());

function setup(props: Partial<React.ComponentProps<typeof RouteOverlayPanel>> = {}) {
  const plans: RouteImagePlan[] = [];
  const stills: StillImagePlan[] = [];
  // The route's own plan inside the still image's, where AV-1009's figures are.
  const renderPng = vi.fn((still: StillImagePlan) => {
    stills.push(still);
    const route = still.items.find((item) => item.kind === 'route');
    const plan = route?.kind === 'route' ? route.plan : (undefined as unknown as RouteImagePlan);
    plans.push(plan);
    return Promise.resolve(new Blob([new Uint8Array(2048)], { type: 'image/png' }));
  });
  const save = vi.fn();
  render(<RouteOverlayPanel activity={ride} renderPng={renderPng} save={save} {...props} />);
  return { renderPng, save, plans, stills };
}

const field = (name: RegExp | string) => screen.getByLabelText(name) as HTMLInputElement;

describe('RouteOverlayPanel (AV-1009)', () => {
  it('previews the route on a transparent canvas at the size it will export', () => {
    setup();
    const preview = screen.getByTestId('route-image-preview') as HTMLCanvasElement;
    expect(preview).toHaveAccessibleName(/1920 by 1080 pixels, transparent background/);
    // Drawn smaller than the file, in the same proportions.
    expect(preview.width).toBe(640);
    expect(preview.height).toBe(360);
    expect(contexts.length).toBeGreaterThan(0);
    expect(screen.getByTestId('route-image-size')).toHaveTextContent('1920 × 1080 px');
  });

  it('says whether it is the whole activity or a focused section, and that no map is drawn', () => {
    const { unmount } = render(<RouteOverlayPanel activity={ride} />);
    expect(screen.getByRole('region', { name: 'Overlay image' })).toHaveTextContent(/whole activity/);
    expect(screen.getByRole('region', { name: 'Overlay image' })).toHaveTextContent(/No map is drawn/);
    unmount();
    render(<RouteOverlayPanel activity={ride} focusedSection />);
    expect(screen.getByRole('region', { name: 'Overlay image' })).toHaveTextContent(/focused section/);
  });

  it('exports at the size, colour, width, padding and markers chosen', async () => {
    const { renderPng, save, plans } = setup();
    await userEvent.selectOptions(field(/Aspect ratio/), '9:16');
    expect([field(/Width/).value, field(/Height/).value]).toEqual(['1080', '1920']);
    fireEvent.change(field(/Route colour/), { target: { value: '#00ff00' } });
    fireEvent.change(field(/Route width/), { target: { value: '20' } });
    fireEvent.change(field(/Padding/), { target: { value: '15' } });
    await userEvent.click(screen.getByRole('checkbox', { name: /Mark the start/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));

    expect(renderPng).toHaveBeenCalledTimes(1);
    const plan = plans[0]!;
    expect([plan.width, plan.height, plan.color, plan.lineWidth]).toEqual([1080, 1920, '#00ff00', 20]);
    expect(plan.start).toBeUndefined();
    expect(save).toHaveBeenCalledWith(expect.any(Blob), 'route-overlay-1080x1920.png');
    expect(await screen.findByRole('status')).toHaveTextContent(/Saved route-overlay-1080x1920\.png \(2\.0 KB\)/);
  });

  it('takes a custom size, and calls it Custom', async () => {
    const { plans } = setup();
    fireEvent.change(field(/Width/), { target: { value: '500' } });
    fireEvent.change(field(/Height/), { target: { value: '300' } });
    expect(field(/Aspect ratio/).value).toBe('custom');
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    expect([plans[0]!.width, plans[0]!.height]).toEqual([500, 300]);
  });

  it.each([
    ['a width that is not a whole number', /Width/, '100.5', /whole numbers/],
    ['an empty width', /Width/, '', /whole numbers/],
    ['a size over the limit', /Height/, '9000', /between 16 and 8192/],
    ['a route width of zero', /Route width/, '0', /route width must be between/],
    ['padding that is too large', /Padding/, '50', /padding must be between/],
  ] as const)('refuses %s, says why, and offers no download', async (_name, label, value, message) => {
    const { renderPng } = setup();
    fireEvent.change(field(label), { target: { value } });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByTestId('route-image-preview')).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Download PNG' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(renderPng).not.toHaveBeenCalled();
  });

  it('explains a route that cannot be drawn: no locations', () => {
    setup({ activity: makeActivity([{ elevationMeters: 3 }, { elevationMeters: 4 }]) });
    expect(screen.getByRole('alert')).toHaveTextContent(/no locations/);
    expect(screen.getByRole('button', { name: 'Download PNG' })).toBeDisabled();
  });

  it('explains a route that cannot be drawn: every coordinate invalid', () => {
    setup({ activity: makeActivity([{ lat: 99, lon: 0 }, { lat: 0, lon: 999 }]) });
    expect(screen.getByRole('alert')).toHaveTextContent(/outside the valid range/);
  });

  it('tells the reader about unusable fixes that were left out, and previews the rest', () => {
    setup({
      activity: makeActivity([
        { lat: 10, lon: 20 },
        { lat: 10.001, lon: 20.001 },
        { lat: 120, lon: 20 },
        { lat: 10.003, lon: 20.003 },
        { lat: 10.004, lon: 20.004 },
      ]),
    });
    expect(screen.getByTestId('route-image-preview')).toBeInTheDocument();
    expect(screen.getByText(/1 location was outside the valid range/)).toBeInTheDocument();
  });

  it('draws a single point, and says so', () => {
    setup({ activity: makeActivity([{ lat: 10, lon: 20 }]) });
    expect(screen.getByTestId('route-image-preview')).toBeInTheDocument();
    expect(screen.getByText(/single place/)).toBeInTheDocument();
  });

  it('shows what went wrong when the image cannot be made, and can try again', async () => {
    const renderPng = vi
      .fn()
      .mockRejectedValueOnce(new RouteImageError('render_failed', 'This browser could not encode an image of this size.'))
      .mockResolvedValue(new Blob([new Uint8Array(10)], { type: 'image/png' }));
    const save = vi.fn();
    render(<RouteOverlayPanel activity={ride} renderPng={renderPng} save={save} />);

    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not encode/);
    expect(save).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Saved/);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('is busy while the image is made, so it cannot be started twice', async () => {
    let finish!: (blob: Blob) => void;
    const renderPng = vi.fn(() => new Promise<Blob>((resolve) => (finish = resolve)));
    render(<RouteOverlayPanel activity={ride} renderPng={renderPng} save={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    const busy = screen.getByRole('button', { name: /Making the image/ });
    expect(busy).toBeDisabled();
    finish(new Blob([new Uint8Array(4)], { type: 'image/png' }));
    expect(await screen.findByRole('button', { name: 'Download PNG' })).toBeEnabled();
  });
});

describe('placing figures, the date and text on the image (AV-1010)', () => {
  const T0 = Date.parse('2026-09-23T23:55:51Z');
  const timed = (offset?: number) => {
    const activity = makeActivity(
      Array.from({ length: 30 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 10 + i * 0.001, lon: 20 + i * 0.002 })),
    );
    return offset === undefined ? activity : { ...activity, metadata: { ...activity.metadata, utcOffsetMinutes: offset } };
  };
  const add = async (label: string) => {
    await userEvent.selectOptions(screen.getByLabelText('Add'), label);
    await userEvent.click(screen.getByRole('button', { name: 'Add to the image' }));
  };
  const editor = () => screen.getByRole('group', { name: /^Selected:/ });
  const lastPlan = (stills: StillImagePlan[]) => stills[stills.length - 1]!;

  it('adds a text, edits it, and exports it beside the route, named as an overlay image', async () => {
    const { stills, save } = setup({ activity: timed() });
    await add('Text');
    const content = screen.getByLabelText('Text') as HTMLTextAreaElement;
    await userEvent.clear(content);
    await userEvent.type(content, 'Day 1 & <b>');
    expect(screen.getByRole('list', { name: 'Elements on the image' })).toHaveTextContent('Text: Day 1 & <b>');

    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    const item = lastPlan(stills).items.find((entry) => entry.kind === 'text');
    expect(item?.kind === 'text' && item.lines[0]!.text).toBe('Day 1 & <b>');
    expect(save).toHaveBeenCalledWith(expect.any(Blob), 'overlay-image-1920x1080.png');
  });

  it('places the selected element by snap, nudge and typed position, always inside the frame', async () => {
    const { stills } = setup({ activity: timed() });
    await add('Distance');
    const x = () => screen.getByLabelText('From the left (%)') as HTMLInputElement;
    const y = () => screen.getByLabelText('From the top (%)') as HTMLInputElement;

    await userEvent.click(within(editor()).getByRole('button', { name: 'Snap to bottom right' }));
    const snapped = [Number(x().value), Number(y().value)];
    expect(snapped[0]).toBeGreaterThan(50);
    expect(snapped[1]).toBeGreaterThan(50);

    await userEvent.click(within(editor()).getByRole('button', { name: 'Move left' }));
    expect(Number(x().value)).toBeCloseTo(snapped[0]! - 1, 1);

    fireEvent.change(x(), { target: { value: '150' } });
    fireEvent.blur(x());
    // Kept inside: the box ends at the right edge, not past it.
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    const box = lastPlan(stills).items.find((entry) => entry.id.startsWith('distance'))!.box;
    // To the pixel: positions are kept to a hundredth of a percent.
    expect(box.x + box.w).toBeCloseTo(1920, 0);

    fireEvent.change(x(), { target: { value: '25' } });
    fireEvent.change(y(), { target: { value: '10' } });
    fireEvent.blur(y());
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    const placed = lastPlan(stills).items.find((entry) => entry.id.startsWith('distance'))!.box;
    expect([placed.x, placed.y]).toEqual([480, 108]);
  });

  it('moves the selected element with the arrow keys on the preview, further with Shift', async () => {
    setup({ activity: timed() });
    await add('Text');
    const x = () => Number((screen.getByLabelText('From the left (%)') as HTMLInputElement).value);
    const start = x();
    const preview = screen.getByRole('group', { name: /^Image preview/ });
    preview.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(x()).toBeCloseTo(start + 1, 1);
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(x()).toBeCloseTo(start + 11, 1);
  });

  it('writes the date in the format chosen, and offers the activity’s zone only when the file states it', async () => {
    const { stills } = setup({ activity: timed(), readerTimeZone: 'Asia/Tokyo' });
    await add('Date');
    await userEvent.selectOptions(screen.getByLabelText('Date format'), '2026-09-24');
    await userEvent.click(screen.getByRole('checkbox', { name: 'With the time' }));
    expect(screen.getByRole('radio', { name: /The activity’s/ })).toBeDisabled();
    expect(editor()).toHaveTextContent(/does not say which time zone/);
    expect(screen.getByRole('radio', { name: 'Your time zone, Asia/Tokyo' })).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    const date = lastPlan(stills).items.find((entry) => entry.id.startsWith('date'));
    expect(date?.kind === 'text' && date.lines.map((line) => line.text)).toEqual(['2026-09-24 08:55']);
  });

  it('uses the zone the file states when asked, and says which it is', async () => {
    const { stills } = setup({ activity: timed(-180), readerTimeZone: 'Asia/Tokyo' });
    await add('Date');
    const own = screen.getByRole('radio', { name: 'The activity’s: UTC−03:00, as the file states' });
    await userEvent.click(own);
    await userEvent.selectOptions(screen.getByLabelText('Date format'), 'Thursday 24 September 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Download PNG' }));
    const date = lastPlan(stills).items.find((entry) => entry.id.startsWith('date'));
    expect(date?.kind === 'text' && date.lines[0]!.text).toBe('Wednesday 23 September 2026');
  });

  it('offers what the activity lacks as unavailable, with the reason', async () => {
    setup(); // positions only: no times
    const options = Array.from((screen.getByLabelText('Add') as HTMLSelectElement).options);
    expect(options.find((option) => option.value === 'moving')).toMatchObject({ disabled: true });
    expect(options.find((option) => option.value === 'date')).toMatchObject({ disabled: true });
    expect(options.find((option) => option.value === 'distance')).toMatchObject({ disabled: false });
    expect(screen.getByRole('list', { name: 'Not in this activity' })).toHaveTextContent(/Moving time: This activity has no moving time/);
  });

  it('saves the layout as JSON, and opens it again', async () => {
    const { save } = setup({ activity: timed() });
    await add('Text');
    const content = screen.getByLabelText('Text') as HTMLTextAreaElement;
    await userEvent.clear(content);
    await userEvent.type(content, 'Shimanami');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Snap to top right' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    const [blob, name] = save.mock.calls.at(-1)! as [Blob, string];
    expect(name).toBe('overlay-layout.json');
    const json = await blob.text();
    expect(json).toContain('"content": "Shimanami"');
    expect(screen.getByRole('status', { name: 'Layout file result' })).toHaveTextContent(/nothing of the activity/);

    await userEvent.click(within(editor()).getByRole('button', { name: 'Remove this element' }));
    expect(screen.getByRole('list', { name: 'Elements on the image' })).not.toHaveTextContent('Shimanami');

    await userEvent.upload(screen.getByTestId('still-layout-input'), new File([json], 'my-layout.json', { type: 'application/json' }));
    expect(await screen.findByRole('status', { name: 'Layout file result' })).toHaveTextContent('Opened the layout in my-layout.json.');
    expect(screen.getByRole('list', { name: 'Elements on the image' })).toHaveTextContent('Text: Shimanami');
  });

  it('refuses a file that is not a layout, saying why, and keeps the layout it has', async () => {
    setup({ activity: timed() });
    await userEvent.upload(screen.getByTestId('still-layout-input'), new File(['{"hello":1}'], 'other.json', { type: 'application/json' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('other.json was not opened. This file is not an OpenTrack overlay layout.');
    expect(screen.getByRole('list', { name: 'Elements on the image' })).toHaveTextContent('Route');
  });
});
