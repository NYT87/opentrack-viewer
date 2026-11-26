import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FontField } from './FontField';
import { ensureFamily, isLoaded } from '../overlay/fonts';
import { fontFile, stubFonts } from '../test/helpers/fonts';

/** The font store, in memory: what is kept, and whether the switch is on. */
const store = vi.hoisted(() => ({ kept: new Map<string, ArrayBuffer>(), on: false, full: false, listeners: new Set<() => void>() }));
vi.mock('../overlay/fontStore', () => ({
  keepsFonts: () => store.on,
  setKeepsFonts: (on: boolean) => {
    store.on = on;
  },
  keepFont: vi.fn(async (family: string, bytes: ArrayBuffer) => {
    if (store.full) return { ok: false as const, reason: `${family} was not kept: the kept fonts would pass 50 MB. Remove one first.` };
    store.kept.set(family, bytes);
    store.listeners.forEach((listener) => listener());
    return { ok: true as const };
  }),
  listKeptFonts: vi.fn(async () => [...store.kept].map(([family, bytes]) => ({ family, size: bytes.byteLength }))),
  removeKeptFont: vi.fn(async (family: string) => {
    store.kept.delete(family);
    store.listeners.forEach((listener) => listener());
  }),
  subscribeKept: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
  readKeptFont: vi.fn(async (family: string) => store.kept.get(family)),
}));

let fonts: ReturnType<typeof stubFonts>;
beforeEach(() => {
  fonts = stubFonts();
  store.kept.clear();
  store.on = false;
  store.full = false;
});
afterEach(() => fonts.unstub());

function setup() {
  const onChange = vi.fn();
  render(<FontField label="Layout font" manage value={undefined} onChange={onChange} />);
  return { onChange, select: () => screen.getByLabelText('Layout font') as HTMLSelectElement };
}
const load = async (file: File) => {
  fireEvent.change(screen.getByLabelText('Layout font: font file'), { target: { files: [file] } });
};
const live = () => screen.getByLabelText('Layout font').parentElement!.querySelector('p[aria-live="assertive"]')!.textContent;

describe('keeping the reader’s fonts in this browser (AV-1031, TD-103)', () => {
  it('keeps nothing while the switch is off, which is how it starts, and says where fonts go', async () => {
    const { onChange } = setup();
    const keep = screen.getByRole('checkbox', { name: 'Keep loaded fonts in this browser' });
    expect(keep).not.toBeChecked();
    expect(screen.getByText(/Turning it off does not delete fonts already kept: each has its own Remove/)).toBeTruthy();
    expect(screen.getByText(/kept in this browser only .* and nothing is sent anywhere/)).toBeTruthy();
    await load(fontFile('Fira Sans.ttf'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Fira Sans'));
    expect(store.kept.size).toBe(0);
    expect(screen.queryByRole('list', { name: 'Fonts kept in this browser' })).toBeNull();
  });

  it('keeps a font loaded with the switch on, lists it, and removes it; the font stays loaded for the visit', async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keep loaded fonts in this browser' }));
    await load(fontFile('Fira Sans.ttf'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Fira Sans'));
    const list = await screen.findByRole('list', { name: 'Fonts kept in this browser' });
    expect(within(list).getByText(/Fira Sans \(1 KB\)/)).toBeTruthy();
    expect([...store.kept.keys()]).toEqual(['Fira Sans']);
    await userEvent.click(within(list).getByRole('button', { name: 'Remove Fira Sans' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Fonts kept in this browser' })).toBeNull());
    expect(store.kept.size).toBe(0);
    expect(isLoaded('Fira Sans')).toBe(true);
  });

  it('turning the switch off deletes nothing already kept', async () => {
    store.kept.set('Old Sans', new ArrayBuffer(10));
    setup();
    const keep = screen.getByRole('checkbox', { name: 'Keep loaded fonts in this browser' });
    await userEvent.click(keep);
    await userEvent.click(keep);
    expect(store.kept.has('Old Sans')).toBe(true);
    expect(await screen.findByRole('list', { name: 'Fonts kept in this browser' })).toBeTruthy();
  });

  it('refuses to keep past the limit, with the reason, and uses the font for this visit all the same', async () => {
    store.full = true;
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Keep loaded fonts in this browser' }));
    await load(fontFile('Big.ttf'));
    await waitFor(() => expect(live()).toBe('Big is loaded for this visit only. Big was not kept: the kept fonts would pass 50 MB. Remove one first.'));
    expect(onChange).toHaveBeenCalledWith('Big');
    expect(store.kept.size).toBe(0);
  });

  it('offers a kept font before it is loaded, and loads it from the store when it is chosen or a layout asks', async () => {
    store.kept.set('Old Sans', Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]).buffer);
    const { onChange, select } = setup();
    await waitFor(() => expect([...select().options].map((option) => option.textContent)).toContain('Old Sans'));
    expect(isLoaded('Old Sans')).toBe(false);
    await userEvent.selectOptions(select(), 'Old Sans');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Old Sans'));
    expect(isLoaded('Old Sans')).toBe(true);
    expect(fonts.registered).toEqual([{ family: 'Old Sans', weight: '400' }]);
    // A layout naming a kept font finds it too.
    store.kept.set('Other Sans', Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]).buffer);
    expect(await ensureFamily('Other Sans')).toEqual({ ok: true });
  });

  it('lists a font kept through another field in this one too, and the newest pick wins over a slower one', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <>
        <FontField label="Layout font" manage value={undefined} onChange={() => undefined} />
        <FontField label="Font" inherit value={undefined} onChange={onChange} />
      </>,
    );
    store.on = true;
    fireEvent.change(screen.getByLabelText('Font: font file'), { target: { files: [fontFile('Fira Sans.ttf')] } });
    const list = await screen.findByRole('list', { name: 'Fonts kept in this browser' });
    expect(within(list).getByText(/Fira Sans/)).toBeTruthy();
    rerender(<></>);
    // A slow pick, then the system font: the slow one must not override the later choice.
    const second = vi.fn();
    render(<FontField label="Slow font" value={undefined} onChange={second} />);
    const select = screen.getByLabelText('Slow font') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Inter' } });
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(second).toHaveBeenCalledWith(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.mock.calls.map(([family]) => family)).not.toContain('Inter');
  });
});
