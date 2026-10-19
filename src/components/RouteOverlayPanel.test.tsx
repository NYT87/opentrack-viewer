import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouteOverlayPanel } from './RouteOverlayPanel';
import { RouteImageError, type RouteImagePlan } from '../overlay/routeImage';
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
  const renderPng = vi.fn((plan: RouteImagePlan) => {
    plans.push(plan);
    return Promise.resolve(new Blob([new Uint8Array(2048)], { type: 'image/png' }));
  });
  const save = vi.fn();
  render(<RouteOverlayPanel activity={ride} renderPng={renderPng} save={save} {...props} />);
  return { renderPng, save, plans };
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
    expect(screen.getByRole('region', { name: 'Route image' })).toHaveTextContent(/whole activity/);
    expect(screen.getByRole('region', { name: 'Route image' })).toHaveTextContent(/No map is drawn/);
    unmount();
    render(<RouteOverlayPanel activity={ride} focusedSection />);
    expect(screen.getByRole('region', { name: 'Route image' })).toHaveTextContent(/focused section/);
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
