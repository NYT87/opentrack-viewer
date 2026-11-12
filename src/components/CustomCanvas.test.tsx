import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomCanvas } from './CustomCanvas';
import { makeActivity } from '../test/helpers/activity';
import type { Activity } from '../domain/activity';
import { LAYOUT_FILE_MAX_BYTES } from '../overlay/staticImage';
import { usePersonalStore } from '../state/personalStore';
import { buildOverlayTimeline } from '../overlay/timeline';

const T0 = Date.parse('2026-09-24T08:00:00Z');
const ride = (extra: (i: number) => object = () => ({})): Activity =>
  makeActivity(Array.from({ length: 61 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 46 + (i * 5) / 111_320, lon: 7, ...extra(i) })));

let saved: Blob[] = [];

beforeEach(() => {
  saved = [];
  usePersonalStore.getState().clear();
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
// The names, not the Remove beside each.
const names = () =>
  elements() ? within(elements()!).getAllByRole('button').filter((button) => button.hasAttribute('aria-pressed')).map((button) => button.textContent) : [];
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
  it('links to the component documentation, in a new tab that cannot reach this page (AV-1017)', () => {
    setup();
    const link = within(region()).getByRole('link', { name: /Write your own component \(documentation\)/ });
    expect(link).toHaveAttribute('href', 'https://github.com/NYT87/opentrack-viewer/blob/main/docs/components/README.md');
    expect(link).toHaveAttribute('target', '_blank');
    const rel = link.getAttribute('rel')!.split(/\s+/);
    expect(rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    // Said to a screen reader too, not only seen.
    expect(link).toHaveAccessibleName(/opens in a new tab/);
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

  it('removes an element from its row in the list, keeping the selection on another', async () => {
    setup();
    await add('Speed');
    await add('Rounded rectangle');
    expect(names()).toEqual(['Speed', 'Rounded rectangle']);

    await userEvent.click(within(elements()!).getByRole('button', { name: 'Remove Speed' }));
    expect(names()).toEqual(['Rounded rectangle']);
    expect(within(elements()!).getByRole('button', { name: 'Rounded rectangle' })).toHaveAttribute('aria-pressed', 'true');

    // One step, so one Undo puts it back.
    await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
    expect(names()).toEqual(['Speed', 'Rounded rectangle']);
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

  describe('predefined components and smoothing (AV-1016)', () => {
    const cyclist = () => ride((i) => ({ powerWatts: 150 + 2 * i, elevationMeters: 100 + i, cyclingCadenceRpm: 80 }));

    it('groups the registry by sport, and lists one the activity lacks as disabled, with its reason', () => {
      setup(cyclist());
      const add = within(region()).getByLabelText('Add');
      const group = (name: string) => within(add).getByRole('group', { name });
      expect(within(group('Cycling')).getByRole('option', { name: 'Power, 3 s average' })).toBeEnabled();
      expect(within(group('Cycling')).getByRole('option', { name: 'Gradient (not in this activity)' })).toBeDisabled();
      expect(within(group('Running')).getByRole('option', { name: 'Running cadence (Running) (not in this activity)' })).toBeDisabled();
      expect(within(group('Any sport')).getByRole('option', { name: 'Progress bar (Any sport)' })).toBeEnabled();
      expect(within(region()).getByRole('list', { name: 'Not in this activity' })).toHaveTextContent('Gradient: This activity has no gradient.');
    });

    it('adds a predefined entry as an ordinary component, with its smoothing, saved in the layout', async () => {
      setup(cyclist());
      await add('Power, 3 s average');
      expect(names()).toEqual(['Power 3s']);
      expect(editor()).toHaveAccessibleName('Selected: Power 3s');
      expect(field('Smoothing (s)').value).toBe('3');
      expect((await layoutJson()).template.components[0]).toMatchObject({ type: 'text', source: { kind: 'metric', metric: 'power' }, smoothing: { windowSeconds: 3 }, display: { label: 'Power 3s' } });
    });

    it('changes or turns off the smoothing of a figure, with a hint that 0 turns it off, and hides it for a total', async () => {
      setup(cyclist());
      await add('Power');
      expect(field('Smoothing (s)').value).toBe('0');
      expect(field('Smoothing (s)')).toHaveAccessibleDescription('0 turns it off');
      fireEvent.change(field('Smoothing (s)'), { target: { value: '45' } });
      expect((await layoutJson()).template.components[0]).toMatchObject({ smoothing: { windowSeconds: 30 } });
      fireEvent.change(field('Smoothing (s)'), { target: { value: '0' } });
      expect((await layoutJson()).template.components[0]).not.toHaveProperty('smoothing');
      // A gauge can be smoothed; a total so far cannot.
      await add('Speed gauge');
      expect(field('Smoothing (s)')).toBeInTheDocument();
      await add('Distance');
      expect(within(editor()).queryByLabelText('Smoothing (s)')).not.toBeInTheDocument();
      await add('Climb so far');
      expect(within(editor()).queryByLabelText('Smoothing (s)')).not.toBeInTheDocument();
    });

    it('starts from the Cycling or Running layout, built from the activity’s own streams, and takes it back', async () => {
      setup(cyclist());
      await userEvent.selectOptions(within(region()).getByLabelText('Start from'), 'cycling');
      await userEvent.click(within(region()).getByRole('button', { name: 'Use this layout' }));
      // No gradient in this ride, so climb so far stands in; the profile closes the row.
      expect(names()).toEqual(['Speed', 'Power 3s', 'Cadence', 'Climb so far', 'Elevation profile']);
      await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
      expect(elements()).not.toBeInTheDocument();
      await userEvent.selectOptions(within(region()).getByLabelText('Start from'), 'running');
      await userEvent.click(within(region()).getByRole('button', { name: 'Use this layout' }));
      // No heart rate or running cadence in this ride: the rest close up.
      expect(names()).toEqual(['Pace', 'Distance', 'Elevation profile']);
    });
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

  it('shows the distance so far, or so far of the total, and offers that for distance alone (TD-080)', async () => {
    setup();
    await add('Distance');
    expect(field('Show')).toHaveValue('so-far');
    await userEvent.selectOptions(field('Show'), 'total');
    expect((await layoutJson()).template.components[0]).toMatchObject({ display: { ofTotal: true } });
    await userEvent.selectOptions(field('Show'), 'so-far');
    expect((await layoutJson()).template.components[0]).not.toMatchObject({ display: { ofTotal: true } });
    await add('Speed');
    expect(screen.queryByLabelText('Show')).not.toBeInTheDocument();
  });

  describe('a figure’s label and value, styled apart (AV-1015, TD-083)', () => {
    type Saved = { rect: { x: number; y: number; width: number; height: number }; style: { textColor?: string; fontScale?: number; backgroundOpacity?: number }; figure?: Record<string, unknown> };
    const saved0 = async () => (await layoutJson()).template.components[0] as unknown as Saved;
    const pickColour = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
    const type = (label: string, value: string) => {
      fireEvent.change(field(label), { target: { value } });
      fireEvent.blur(field(label));
    };

    it('offers a switch, two sizes, two colours, spacing, alignment and a halo, and no single text size or colour', async () => {
      setup();
      await add('Speed');
      expect(field('Show the label')).toBeChecked();
      for (const label of ['Label size (%)', 'Value size (%)', 'Spacing (% of width)', 'Halo (%)', 'Label colour', 'Value colour', 'Halo colour']) expect(field(label)).toBeInTheDocument();
      expect(field('Alignment')).toHaveValue('left');
      expect(within(editor()).queryByLabelText('Text size (%)')).not.toBeInTheDocument();
      expect(within(editor()).queryByLabelText('Text colour')).not.toBeInTheDocument();
      // A gauge has them too; the still image's texts keep the one size and the one colour.
      await add('Speed gauge');
      expect(field('Label size (%)')).toBeInTheDocument();
      await add('Text');
      expect(field('Text size (%)')).toBeInTheDocument();
      expect(field('Text colour')).toBeInTheDocument();
      expect(within(editor()).queryByLabelText('Label size (%)')).not.toBeInTheDocument();
    });

    it('saves nothing of its own for a figure left alone, and shows today’s values', async () => {
      setup();
      await add('Speed');
      expect(field('Label size (%)').value).toBe('100');
      expect(field('Value size (%)').value).toBe('100');
      expect(field('Halo (%)').value).toBe('80');
      expect(field('Halo colour')).toHaveValue('#000000');
      expect(field('Label colour')).toHaveValue('#ffffff');
      expect(Number(field('Spacing (% of width)').value)).toBeCloseTo(0.2, 5);
      expect(await saved0()).not.toHaveProperty('figure');
    });

    it('sets the value colour as the text colour, and the label colour apart, shown as the text colour until it is set', async () => {
      setup();
      await add('Speed');
      pickColour('Value colour', '#00ff00');
      expect(field('Label colour')).toHaveValue('#00ff00');
      pickColour('Label colour', '#ff0000');
      expect(await saved0()).toMatchObject({ style: { textColor: '#00ff00' }, figure: { labelColor: '#ff0000' } });
      pickColour('Value colour', '#0000ff');
      expect(field('Label colour')).toHaveValue('#ff0000');
    });

    it('sizes each line as a share of the figure’s text size, and a layout saved at 150 % reads 150 % for both', async () => {
      setup();
      await add('Speed');
      type('Label size (%)', '200');
      type('Value size (%)', '50');
      expect(await saved0()).toMatchObject({ figure: { labelScale: 2, valueScale: 0.5 } });
      type('Label size (%)', '100');
      expect((await saved0()).figure).toEqual({ valueScale: 0.5 });
      type('Value size (%)', '100');
      expect(await saved0()).not.toHaveProperty('figure');

    });

    it('reads a layout saved at a text size of 150 % as 150 % for both lines, and writes sizes against it', async () => {
      setup();
      await add('Speed');
      const layout = await layoutJson();
      (layout.template.components[0] as { style: object }).style = { fontScale: 1.5 };
      const file = new File([JSON.stringify({ kind: 'opentrack-overlay-layout', version: 1, ...layout })], 'older.json', { type: 'application/json' });
      fireEvent.change(screen.getByTestId('canvas-layout-input'), { target: { files: [file] } });
      await userEvent.click(await within(region()).findByRole('button', { name: 'Speed' }));
      expect(field('Label size (%)').value).toBe('150');
      expect(field('Value size (%)').value).toBe('150');
      type('Label size (%)', '300');
      expect(await saved0()).toMatchObject({ style: { fontScale: 1.5 }, figure: { labelScale: 2 } });
    });

    it('sets the spacing in frame widths with one decimal, and the alignment', async () => {
      setup();
      await add('Speed');
      type('Spacing (% of width)', '1.5');
      expect(field('Spacing (% of width)').value).toBe('1.5');
      await userEvent.selectOptions(field('Alignment'), 'center');
      expect(await saved0()).toMatchObject({ figure: { gap: 0.015, align: 'center' } });
      await userEvent.selectOptions(field('Alignment'), 'left');
      expect((await saved0()).figure).toEqual({ gap: 0.015 });
      type('Spacing (% of width)', '90');
      expect((await saved0()).figure).toMatchObject({ gap: 0.2 });
    });

    it('hides the label with a switch and keeps its text, so switching it back on restores it', async () => {
      setup();
      await add('Speed');
      await userEvent.type(field('Label'), 'Pace');
      await userEvent.click(field('Show the label'));
      expect(field('Show the label')).not.toBeChecked();
      expect(await saved0()).toMatchObject({ figure: { showLabel: false }, display: { label: 'Pace' } });
      expect(field('Label')).toHaveValue('Pace');
      await userEvent.click(field('Show the label'));
      expect(await saved0()).not.toHaveProperty('figure');
      expect(await saved0()).toMatchObject({ display: { label: 'Pace' } });
    });

    it('sets the halo’s colour and opacity, at 0 % meaning none, and says when the background hides it', async () => {
      setup();
      await add('Speed');
      type('Background (%)', '0');
      expect(within(editor()).queryByText(/halo is drawn under the text when the background is under 30/)).not.toBeInTheDocument();
      pickColour('Halo colour', '#336699');
      expect((await saved0()).figure).toEqual({ halo: { color: '#336699', opacity: 0.8 } });
      type('Halo (%)', '0');
      expect((await saved0()).figure).toEqual({ halo: { color: '#336699', opacity: 0 } });
      type('Background (%)', '50');
      expect(within(editor()).getByText(/halo is drawn under the text when the background is under 30/)).toBeInTheDocument();
    });

    it('grows the box to hold the text when a size, the spacing, the label or its text changes, and Undo takes it back in one step', async () => {
      setup();
      await add('Speed');
      type('Width (%)', '5');
      type('Height (%)', '3');
      const before = await saved0();
      type('Value size (%)', '400');
      const grown = await saved0();
      expect(grown.rect.x).toBe(before.rect.x);
      expect(grown.rect.y).toBe(before.rect.y);
      expect(grown.rect.width).toBeGreaterThan(before.rect.width);
      expect(grown.rect.height).toBeGreaterThan(before.rect.height);
      expect(field('Width (%)').value).toBe(String(Math.round(grown.rect.width * 10_000) / 100));

      await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
      expect((await saved0()).rect).toEqual(before.rect);
      expect((await saved0()).figure).toBeUndefined();

      // The label's text, and the units, grow it too; a colour does not.
      await userEvent.type(field('Label'), 'A very long label for a speed figure');
      expect((await saved0()).rect.width).toBeGreaterThan(before.rect.width);
    });

    it('never shrinks the box, and grows no further than the frame’s edge', async () => {
      setup();
      await add('Speed');
      type('Width (%)', '9');
      type('Height (%)', '9');
      type('From the left (%)', '90');
      type('From the top (%)', '90');
      type('Value size (%)', '1000');
      const grown = await saved0();
      expect(grown.rect.x + grown.rect.width).toBeLessThanOrEqual(1);
      expect(grown.rect.y + grown.rect.height).toBeLessThanOrEqual(1);
      expect(grown.rect.x).toBeCloseTo(0.9, 6);
      type('Value size (%)', '100');
      expect((await saved0()).rect).toEqual(grown.rect);
    });

    it('leaves a box alone when only a colour or the halo changes', async () => {
      setup();
      await add('Speed');
      type('Width (%)', '2');
      type('Height (%)', '2');
      const before = await saved0();
      pickColour('Label colour', '#ff0000');
      pickColour('Halo colour', '#ff0000');
      type('Halo (%)', '10');
      type('Background (%)', '10');
      expect((await saved0()).rect).toEqual(before.rect);
    });
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
    // AV-1012. The export panel offers the transparent video itself, where the browser can record one.
    expect(region()).not.toHaveTextContent(/Transparent WebM is not made by this app yet/);
  });

  describe('zones (AV-1018, TD-086)', () => {
    const athlete = () => ride((i) => ({ heartRateBpm: 110 + i, powerWatts: 120 + 4 * i, distanceMeters: i * 5 }));
    const fresh = async () => {
      setup(athlete());
      await add('Heart rate zones');
    };
    const saveWithFigures = async () => {
      await userEvent.click(within(region()).getByLabelText('Include my maximum heart rate and FTP'));
      return layoutJson();
    };

    it('adds heart rate zones and power zones with their defaults, and the registry’s own, from the Add list', async () => {
      setup(athlete());
      await add('Heart rate zones');
      await add('Power zones');
      await add('Heart rate zones (Cycling)');
      expect(names()).toEqual(['Heart rate zones', 'Power zones', 'Heart rate zones']);
      const components = (await layoutJson()).template.components as { type: string; zones: { source: string; zones: unknown[] }; smoothing?: unknown }[];
      expect(components.map((component) => [component.type, component.zones.source, component.zones.zones.length, component.smoothing])).toEqual([
        ['zones', 'heartRate', 5, undefined],
        ['zones', 'power', 7, { windowSeconds: 3 }],
        ['zones', 'heartRate', 5, undefined],
      ]);
    });

    it('is not offered for an activity without heart rate or power, and says why', () => {
      setup();
      expect(within(region()).getByRole('option', { name: 'Heart rate zones (not in this activity)' })).toBeDisabled();
      expect(within(region()).getByRole('list', { name: 'Not in this activity' })).toHaveTextContent('Power zones: This activity has no power.');
    });

    it('says it needs the maximum heart rate, offers the activity’s highest as such, and then stops asking', async () => {
      await fresh();
      expect(within(editor()).getByRole('status')).toHaveTextContent('Enter your maximum heart rate to draw these zones');
      expect(field('My maximum heart rate (bpm)').value).toBe('');
      // The ride's highest heart rate is 170 bpm; it is offered as that, not guessed.
      await userEvent.click(within(editor()).getByRole('button', { name: 'Use this activity’s highest: 170 bpm' }));
      expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 170 });
      expect(within(editor()).queryByRole('status')).not.toBeInTheDocument();
      expect(field('My maximum heart rate (bpm)').value).toBe('170');
      await userEvent.click(within(editor()).getByRole('button', { name: 'Forget my maximum heart rate' }));
      expect(usePersonalStore.getState().personal).toEqual({});
      expect(within(editor()).getByRole('status')).toBeInTheDocument();
    });

    it('takes a figure typed in, keeps it inside its limits, and asks for the FTP of power zones', async () => {
      await fresh();
      fireEvent.change(field('My maximum heart rate (bpm)'), { target: { value: '188' } });
      expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 188 });
      fireEvent.change(field('My maximum heart rate (bpm)'), { target: { value: '900' } });
      expect(usePersonalStore.getState().personal.maxHeartRate).toBe(230);
      await add('Power zones');
      expect(within(editor()).getByRole('status')).toHaveTextContent('Enter your FTP to draw these zones');
      expect(field('My FTP (W)')).toHaveAccessibleDescription(/50 to 600/);
      fireEvent.change(field('My FTP (W)'), { target: { value: '250' } });
      expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 230, ftp: 250 });
    });

    it('needs no figure for bounds in absolute values', async () => {
      await fresh();
      await userEvent.selectOptions(field('Bounds are') as unknown as HTMLElement, 'value');
      expect(within(editor()).queryByRole('status')).not.toBeInTheDocument();
      expect(within(editor()).queryByLabelText('My maximum heart rate (bpm)')).not.toBeInTheDocument();
      expect((await layoutJson()).template.components[0]).toMatchObject({ zones: { basis: 'value' } });
    });

    it('edits each zone’s name, colour and bound, adds and removes zones, and resets them', async () => {
      await fresh();
      expect(field('Zone 1 name').value).toBe('Recovery');
      fireEvent.change(field('Zone 1 name'), { target: { value: 'Easy' } });
      fireEvent.change(field('Zone 2 colour'), { target: { value: '#123456' } });
      fireEvent.change(field('Zone 3 starts at (%)'), { target: { value: '72' } });
      let zones = ((await layoutJson()).template.components[0] as { zones: { zones: { name: string; color: string; from: number }[] } }).zones.zones;
      expect(zones[0]).toMatchObject({ name: 'Easy', from: 50 });
      expect(zones[1]!.color).toBe('#123456');
      expect(zones[2]!.from).toBe(72);

      await userEvent.click(within(editor()).getByRole('button', { name: 'Add a zone' }));
      expect(field('Zone 6 name').value).toBe('Zone 6');
      expect(field('Zone 6 starts at (%)').value).toBe('100');
      await userEvent.click(within(editor()).getByRole('button', { name: 'Remove the last zone' }));
      await userEvent.click(within(editor()).getByRole('button', { name: 'Remove the last zone' }));
      await userEvent.click(within(editor()).getByRole('button', { name: 'Remove the last zone' }));
      await userEvent.click(within(editor()).getByRole('button', { name: 'Remove the last zone' }));
      expect(within(editor()).getByRole('button', { name: 'Remove the last zone' })).toBeDisabled();
      zones = ((await layoutJson()).template.components[0] as { zones: { zones: typeof zones } }).zones.zones;
      expect(zones.map((zone) => zone.name)).toEqual(['Easy', 'Endurance']);
      for (let i = 0; i < 8; i += 1) await userEvent.click(within(editor()).getByRole('button', { name: 'Add a zone' }));
      expect(within(editor()).getByRole('button', { name: 'Add a zone' })).toBeDisabled();
      await userEvent.click(within(editor()).getByRole('button', { name: 'Reset the zones' }));
      expect(field('Zone 1 name').value).toBe('Recovery');
      expect(within(editor()).queryByLabelText('Zone 6 name')).not.toBeInTheDocument();
    });

    it('keeps a typed bound above the zone before it, and gives every control a name', async () => {
      await fresh();
      fireEvent.change(field('Zone 3 starts at (%)'), { target: { value: '10' } });
      const from = (((await layoutJson()).template.components[0] as { zones: { zones: { from: number }[] } }).zones.zones.map((zone) => zone.from));
      expect(from).toEqual([50, 60, 61, 80, 90]);
      // Each zone is a group of named fields.
      expect(within(editor()).getByRole('group', { name: 'Zone 4' })).toContainElement(field('Zone 4 name'));
      for (const control of within(editor()).getAllByRole('textbox')) expect(control).toHaveAccessibleName();
      for (const control of within(editor()).getAllByRole('spinbutton')) expect(control).toHaveAccessibleName();
      for (const control of within(editor()).getAllByRole('combobox')) expect(control).toHaveAccessibleName();
      for (const control of within(editor()).getAllByRole('checkbox')) expect(control).toHaveAccessibleName();
    });

    it('sets the shape and what is shown, and the smoothing, and keeps them in the layout', async () => {
      await fresh();
      await userEvent.selectOptions(within(editor()).getByLabelText('Shape'), 'arc');
      await userEvent.click(within(editor()).getByLabelText('The zone’s name'));
      await userEvent.click(within(editor()).getByLabelText('The time in each zone so far'));
      fireEvent.change(field('Smoothing (s)'), { target: { value: '4' } });
      expect((await layoutJson()).template.components[0]).toMatchObject({
        zones: { shape: 'arc', show: { number: true, name: false, value: true, timeInZone: true } },
        smoothing: { windowSeconds: 4 },
      });
    });

    it('offers the usual position, size, colours, text sizes and halo', async () => {
      await fresh();
      for (const label of ['From the left (%)', 'From the top (%)', 'Width (%)', 'Height (%)', 'Value colour', 'Label colour', 'Accent colour', 'Background (%)', 'Label size (%)', 'Value size (%)', 'Spacing (% of width)', 'Alignment', 'Halo colour', 'Halo (%)']) {
        expect(within(editor()).getByLabelText(label), label).toBeInTheDocument();
      }
    });

    it('switches the source, giving it its own zones and smoothing', async () => {
      await fresh();
      await userEvent.selectOptions(within(editor()).getByLabelText('Zones of'), 'power');
      expect(editor()).toHaveAccessibleName('Selected: Power zones');
      expect(field('Zone 7 name').value).toBe('Neuromuscular');
      expect(field('Smoothing (s)').value).toBe('3');
      expect((await layoutJson()).template.components[0]).toMatchObject({ source: { metric: 'power' }, zones: { source: 'power' } });
    });

    it('leaves the reader’s figures out of a saved layout unless the box is ticked, which it is not by default', async () => {
      await fresh();
      fireEvent.change(field('My maximum heart rate (bpm)'), { target: { value: '187' } });
      const box = within(region()).getByLabelText('Include my maximum heart rate and FTP') as HTMLInputElement;
      expect(box.checked).toBe(false);
      const plain = await layoutJson();
      expect(JSON.stringify(plain)).not.toContain('187');
      expect(JSON.stringify(plain)).not.toContain('personal');
      expect(within(region()).getByRole('status', { name: 'Layout file result' })).toHaveTextContent('Your maximum heart rate and FTP are not in it.');
      const included = await saveWithFigures();
      expect(included.template.components[0]).toMatchObject({ zones: { personal: { maxHeartRate: 187 } } });
      expect(within(region()).getByRole('status', { name: 'Layout file result' })).toHaveTextContent('It holds the maximum heart rate and FTP you asked to include');
    });

    it('shows the box only when there are zones to hold the figures', async () => {
      setup(athlete());
      expect(within(region()).queryByLabelText('Include my maximum heart rate and FTP')).not.toBeInTheDocument();
      await add('Speed');
      expect(within(region()).queryByLabelText('Include my maximum heart rate and FTP')).not.toBeInTheDocument();
      await add('Heart rate zones');
      expect(within(region()).getByLabelText('Include my maximum heart rate and FTP')).toBeInTheDocument();
    });

    it('opens a layout with figures in it, offers to use them, and uses them only when told to', async () => {
      await fresh();
      fireEvent.change(field('My maximum heart rate (bpm)'), { target: { value: '187' } });
      const json = await saveWithFigures();
      usePersonalStore.getState().clear();
      await userEvent.click(within(region()).getByRole('button', { name: 'Undo' }));
      await userEvent.upload(screen.getByTestId('canvas-layout-input'), new File([JSON.stringify(json)], 'shared.json', { type: 'application/json' }));
      expect(await within(region()).findByText('Opened the layout in shared.json.')).toBeInTheDocument();
      // Not taken on its own: the session stays as the reader had it.
      expect(usePersonalStore.getState().personal).toEqual({});
      const offer = within(region()).getByRole('group', { name: 'Figures in this layout' });
      expect(offer).toHaveTextContent('a maximum heart rate of 187 bpm');
      await userEvent.click(within(offer).getByRole('button', { name: 'Use the figures in this layout' }));
      expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 187 });
      expect(within(region()).queryByRole('group', { name: 'Figures in this layout' })).not.toBeInTheDocument();
    });

    it('opens a layout without figures as it opens any, with nothing to offer', async () => {
      await fresh();
      const json = await layoutJson();
      await userEvent.upload(screen.getByTestId('canvas-layout-input'), new File([JSON.stringify(json)], 'plain.json', { type: 'application/json' }));
      expect(await within(region()).findByText('Opened the layout in plain.json.')).toBeInTheDocument();
      expect(within(region()).queryByRole('group', { name: 'Figures in this layout' })).not.toBeInTheDocument();
    });

    it('a layout that held the figures does not keep them when saved again unticked', async () => {
      await fresh();
      fireEvent.change(field('My maximum heart rate (bpm)'), { target: { value: '187' } });
      const json = await saveWithFigures();
      usePersonalStore.getState().clear();
      await userEvent.click(within(region()).getByLabelText('Include my maximum heart rate and FTP'));
      await userEvent.upload(screen.getByTestId('canvas-layout-input'), new File([JSON.stringify(json)], 'shared.json', { type: 'application/json' }));
      await within(region()).findByText('Opened the layout in shared.json.');
      expect(JSON.stringify(await layoutJson())).not.toContain('187');
    });

    it('opens a layout whose zones cannot be read, with the component kept and the defaults offered', async () => {
      await fresh();
      const json = await layoutJson();
      (json.template.components[0] as { zones: { zones: unknown[] } }).zones.zones = [];
      await userEvent.upload(screen.getByTestId('canvas-layout-input'), new File([JSON.stringify(json)], 'broken.json', { type: 'application/json' }));
      expect(await within(region()).findByText('Opened the layout in broken.json.')).toBeInTheDocument();
      expect(names()).toEqual(['Heart rate zones']);
      await userEvent.click(within(elements()!).getByRole('button', { name: 'Heart rate zones' }));
      expect(within(editor()).getByRole('status')).toHaveTextContent('These zones could not be read');
      await userEvent.click(within(editor()).getByRole('button', { name: 'Use the default zones' }));
      expect(field('Zone 1 name').value).toBe('Recovery');
    });

    it('leaves zones out of a layout opened in a still, such as the map image, and says so', async () => {
      const activity = athlete();
      const host = { title: 'Figures', intro: 'x', frame: { width: 1280, height: 720 }, timeline: buildOverlayTimeline(activity, { video: { durationSeconds: 60 } }), seconds: 0, onSeek: () => {}, onComponentsChange: () => {}, still: true };
      render(<CustomCanvas activity={activity} offsetSeconds={0} units="metric" readerTimeZone="UTC" host={host} />);
      expect(within(screen.getByRole('region', { name: 'Figures' })).queryByRole('option', { name: 'Heart rate zones' })).not.toBeInTheDocument();
      const json = { kind: 'opentrack-overlay-layout', version: 1, image: { width: 1280, height: 720 }, template: { version: 2, name: 'x', style: {}, components: [{ id: 'z', type: 'zones', visible: true, rect: { x: 0, y: 0, width: 0.3, height: 0.2 }, unitMode: 'auto', style: {}, source: { kind: 'metric', metric: 'heartRate' } }] } };
      await userEvent.upload(screen.getByTestId('canvas-layout-input'), new File([JSON.stringify(json)], 'z.json', { type: 'application/json' }));
      expect(await screen.findByText('Zones were left out: this picture shows no moment of the activity.')).toBeInTheDocument();
    });

    it('stores nothing on the device: the figures are in memory for the session, and not in any storage', async () => {
      await fresh();
      fireEvent.change(field('My maximum heart rate (bpm)'), { target: { value: '187' } });
      await saveWithFigures();
      expect(usePersonalStore.getState().personal).toEqual({ maxHeartRate: 187 });
      const everything = [...Object.keys(localStorage), ...Object.keys(sessionStorage)].map((key) => `${key}=${localStorage.getItem(key) ?? sessionStorage.getItem(key)}`);
      expect(everything.filter((entry) => !entry.startsWith('opentrack-viewer:theme'))).toEqual([]);
      expect(JSON.stringify(everything)).not.toContain('187');
    });
  });
});
