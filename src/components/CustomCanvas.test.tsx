import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomCanvas } from './CustomCanvas';
import { makeActivity } from '../test/helpers/activity';
import type { Activity } from '../domain/activity';
import { LAYOUT_FILE_MAX_BYTES } from '../overlay/staticImage';

const T0 = Date.parse('2026-09-24T08:00:00Z');
const ride = (extra: (i: number) => object = () => ({})): Activity =>
  makeActivity(Array.from({ length: 61 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + (i * 5) / 111_320, lon: 7, ...extra(i) })));

let saved: Blob[] = [];

beforeEach(() => {
  saved = [];
  // jsdom draws nothing: a context that answers every call, so the renderer runs,
  // and measures a text in proportion to its font, as a browser does.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => {
    let font = '16px sans-serif';
    return new Proxy(
      {},
      {
        get: (_target, key: string) =>
          key === 'font'
            ? font
            : key === 'measureText'
              ? (text: string) => ({ width: text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 16) * 0.55 })
              : () => undefined,
        set: (_target, key: string, value: unknown) => {
          if (key === 'font') font = String(value);
          return true;
        },
      },
    );
  }) as never);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => (saved.push(blob), 'blob:x'), revokeObjectURL: () => {} }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const setup = (activity: Activity = ride()) =>
  render(<CustomCanvas activity={activity} offsetSeconds={0} units="metric" readerTimeZone="UTC" />);
const region = () => screen.getByRole('region', { name: 'Custom canvas' });
const elements = () => within(region()).queryByRole('list', { name: 'Elements on the canvas' });
const names = () => (elements() ? within(elements()!).getAllByRole('button').map((button) => button.textContent) : []);
const add = async (label: string) => {
  await userEvent.selectOptions(within(region()).getByLabelText('Add'), within(region()).getByRole('option', { name: label }));
  await userEvent.click(within(region()).getByRole('button', { name: 'Add to the canvas' }));
};
const editor = () => within(region()).getByRole('group', { name: /^Selected:/ });
const field = (label: string) => within(editor()).getByLabelText(label) as HTMLInputElement;
const layoutJson = async () => {
  await userEvent.click(within(region()).getByRole('button', { name: 'Save layout' }));
  return JSON.parse(await saved.at(-1)!.text()) as { image: { width: number; height: number }; template: { components: Record<string, unknown>[] } };
};

describe('the custom canvas (AV-1011)', () => {
  it('refuses an oversized layout without reading its contents', async () => {
    setup();
    const file = new File(['{}'], 'large.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: LAYOUT_FILE_MAX_BYTES + 1 });
    const read = vi.spyOn(file, 'text');
    fireEvent.change(screen.getByTestId('canvas-layout-input'), { target: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('too large to be a layout');
    expect(read).not.toHaveBeenCalled();
  });
  it('starts empty, adds a live figure and selects it', async () => {
    setup();
    expect(region()).toHaveTextContent('The canvas is empty');
    await add('Speed');
    expect(names()).toEqual(['Speed']);
    expect(editor()).toHaveAccessibleName('Selected: Speed');
    expect(field('From the left (%)').value).toBe('4');
  });

  it('offers what the activity lacks as unavailable, with the reason', () => {
    setup();
    const option = within(region()).getByRole('option', { name: /Heart rate \(not in this activity\)/ });
    expect(option).toBeDisabled();
    expect(within(region()).getByRole('list', { name: 'Not in this activity' })).toHaveTextContent('Heart rate: This activity has no heart rate.');
  });

  it('places by position fields, nudges and arrow keys, and resizes, always inside the frame', async () => {
    setup();
    await add('Distance');
    fireEvent.change(field('From the left (%)'), { target: { value: '200' } });
    fireEvent.blur(field('From the left (%)'));
    expect(Number(field('From the left (%)').value)).toBeLessThan(100);
    fireEvent.change(field('From the left (%)'), { target: { value: '50' } });
    fireEvent.blur(field('From the left (%)'));
    await userEvent.click(within(editor()).getByRole('button', { name: 'Move right' }));
    expect(field('From the left (%)').value).toBe('51');
    within(region()).getByRole('group', { name: /^Canvas preview/ }).focus();
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(field('From the left (%)').value).toBe('41');
    fireEvent.change(field('Width (%)'), { target: { value: '30' } });
    fireEvent.blur(field('Width (%)'));
    expect(field('Width (%)').value).toBe('30');
    fireEvent.change(field('Width (%)'), { target: { value: '90' } });
    fireEvent.blur(field('Width (%)'));
    expect(field('Width (%)').value).toBe('59');
  });

  it('resizes a text by its corner: the words scale, and Undo takes it back', async () => {
    setup();
    await add('Text');
    type Placed = { rect: { x: number; y: number; width: number; height: number }; style: { fontScale?: number } };
    const before = (await layoutJson()).template.components[0] as unknown as Placed;
    // jsdom gives the preview no size, so a pointer's client position is read as a share of the frame.
    const preview = screen.getByTestId('canvas-preview');
    const corner = { clientX: before.rect.x + before.rect.width, clientY: before.rect.y + before.rect.height };
    fireEvent.pointerDown(preview, { button: 0, pointerId: 1, ...corner });
    fireEvent.pointerMove(preview, { pointerId: 1, clientX: corner.clientX + 0.1, clientY: corner.clientY + 0.1 });
    fireEvent.pointerUp(preview, { pointerId: 1 });
    const after = (await layoutJson()).template.components[0] as unknown as Placed;
    expect(after.style.fontScale).toBeGreaterThan(before.style.fontScale ?? 1);
    expect(after.rect.width).toBeGreaterThan(before.rect.width);
    expect(after.rect.height).toBeGreaterThan(before.rect.height);
    expect(Number(field('Text size (%)').value)).toBe(Math.round(after.style.fontScale! * 100));

    await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect((await layoutJson()).template.components[0]).toMatchObject({ style: { fontScale: before.style.fontScale }, rect: before.rect });
  });

  it('orders layers, duplicates and deletes', async () => {
    setup();
    await add('Speed');
    await add('Rounded rectangle');
    expect(names()).toEqual(['Speed', 'Rounded rectangle']);
    await userEvent.click(within(editor()).getByRole('button', { name: 'To the back' }));
    expect(names()).toEqual(['Rounded rectangle', 'Speed']);
    await userEvent.click(within(editor()).getByRole('button', { name: 'Duplicate' }));
    expect(names()).toEqual(['Rounded rectangle', 'Speed', 'Rounded rectangle']);
    await userEvent.click(within(editor()).getByRole('button', { name: 'Delete' }));
    expect(names()).toEqual(['Rounded rectangle', 'Speed']);
    expect(within(region()).queryByRole('group', { name: /^Selected:/ })).not.toBeInTheDocument();
  });

  it('moves a shape with the figures it holds', async () => {
    setup();
    await add('Rounded rectangle');
    await add('Speed');
    await userEvent.selectOptions(field('Held by'), 'shape-1');
    await userEvent.click(within(elements()!).getByRole('button', { name: 'Rounded rectangle' }));
    fireEvent.change(field('From the left (%)'), { target: { value: '30' } });
    fireEvent.change(field('From the top (%)'), { target: { value: '20' } });
    const json = await layoutJson();
    const [card, speed] = json.template.components as { rect: { x: number; y: number } }[];
    expect([card!.rect.x, card!.rect.y]).toEqual([0.3, 0.2]);
    expect([speed!.rect.x, speed!.rect.y]).toEqual([0.3, 0.2]);
  });

  it('takes back a move, and a selection', async () => {
    setup();
    await add('Speed');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Snap to bottom right' }));
    expect(Number(field('From the left (%)').value)).toBeGreaterThan(50);
    await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(field('From the left (%)').value).toBe('4');
    await userEvent.click(within(elements()!).getByRole('button', { name: 'Speed' }));
    expect(within(region()).queryByRole('group', { name: /^Selected:/ })).not.toBeInTheDocument();
    within(region()).getByRole('group', { name: /^Canvas preview/ }).focus();
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(editor()).toHaveAccessibleName('Selected: Speed');
  });

  it('changes resolution by preset or by size, keeps the layout in fractions, and refuses a size it cannot use', async () => {
    setup();
    await add('Speed');
    await userEvent.selectOptions(within(region()).getByLabelText('Size'), '1080x1920');
    expect(within(region()).getByRole('group', { name: /^Canvas preview, 1080 by 1920/ })).toBeInTheDocument();
    expect((await layoutJson()).image).toEqual({ width: 1080, height: 1920 });
    fireEvent.change(within(region()).getByLabelText('Width (px)'), { target: { value: '1081' } });
    expect(within(region()).getByRole('alert')).toHaveTextContent(/even numbers/);
    expect(within(region()).getByRole('button', { name: 'Save layout' })).toBeDisabled();
  });

  it('offers the video’s own size, to even sides, when there is a video', async () => {
    render(<CustomCanvas activity={ride()} media={{ width: 849, height: 480, durationSeconds: 60 }} offsetSeconds={0} units="metric" readerTimeZone="UTC" />);
    await userEvent.selectOptions(within(region()).getByLabelText('Size'), 'video');
    expect(within(region()).getByRole('option', { name: 'Same as the video (850 × 480)' })).toBeInTheDocument();
    expect((within(region()).getByLabelText('Width (px)') as HTMLInputElement).value).toBe('850');
  });

  it('starts from a built-in template’s layout, and can take it back', async () => {
    setup();
    await userEvent.selectOptions(within(region()).getByLabelText('Start from'), 'metric-strip');
    await userEvent.click(within(region()).getByRole('button', { name: 'Use this layout' }));
    expect(names()).toEqual(expect.arrayContaining(['Speed', 'Distance']));
    await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(elements()).not.toBeInTheDocument();
  });

  it('styles a shape: fill and border, their transparency, width and corner', async () => {
    setup();
    await add('Rounded rectangle');
    fireEvent.change(field('Fill colour'), { target: { value: '#ff0000' } });
    fireEvent.change(field('Fill opacity (%)'), { target: { value: '60' } });
    fireEvent.change(field('Border colour'), { target: { value: '#00ff00' } });
    fireEvent.change(field('Border opacity (%)'), { target: { value: '100' } });
    fireEvent.change(field('Border width (px)'), { target: { value: '10.8' } });
    fireEvent.change(field('Corner radius (px)'), { target: { value: '54' } });
    const shape = (await layoutJson()).template.components[0]!.shape;
    expect(shape).toEqual({ kind: 'roundedRect', fill: '#ff0000', fillOpacity: 0.6, stroke: '#00ff00', strokeOpacity: 1, strokeWidth: 0.01, radius: 0.05 });
  });

  it('sets a figure’s label, units and decimal places', async () => {
    setup();
    await add('Distance');
    await userEvent.type(field('Label'), 'Ridden');
    await userEvent.selectOptions(field('Units'), 'imperial');
    await userEvent.selectOptions(field('Decimal places'), '2');
    expect(names()).toEqual(['Ridden']);
    expect((await layoutJson()).template.components[0]).toMatchObject({ unitMode: 'imperial', display: { label: 'Ridden', decimals: 2 } });
  });

  it('saves a layout and opens it again', async () => {
    setup();
    await add('Ellipse');
    await add('Text');
    const json = await layoutJson();
    expect(within(region()).getByRole('status', { name: 'Layout file result' })).toHaveTextContent(/nothing of the activity/);
    await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
    await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(elements()).not.toBeInTheDocument();
    await userEvent.upload(screen.getByTestId('canvas-layout-input'), new File([JSON.stringify(json)], 'mine.json', { type: 'application/json' }));
    expect(await within(region()).findByText('Opened the layout in mine.json.')).toBeInTheDocument();
    expect(names()).toEqual(['Ellipse', 'Text: Text']);
  });

  it('exports at the canvas’s size without a video, and says a burned-in video needs one', async () => {
    setup();
    await add('Speed');
    expect(within(region()).getByRole('region', { name: 'Export overlay' })).toBeInTheDocument();
    expect(region()).toHaveTextContent('A video with the overlay burned in needs a source video');
    expect(region()).toHaveTextContent(/Transparent WebM is not made by this app yet/);
  });
});
