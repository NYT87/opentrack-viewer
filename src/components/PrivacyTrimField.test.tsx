import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrivacyTrimField } from './PrivacyTrimField';
import type { PrivacyTrim } from '../overlay/privacyTrim';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';

// 10 km of road: 1 % of it is 100 m.
const road = activityThrough(straightNorth(10_000, 100, 5));

function Harness({ initial, onTrim, units = 'metric', activity = road }: { initial?: PrivacyTrim; onTrim?: (trim: PrivacyTrim | undefined) => void; units?: 'metric' | 'imperial'; activity?: typeof road }) {
  const [trim, setTrim] = useState<PrivacyTrim | undefined>(initial);
  return (
    <PrivacyTrimField
      trim={trim}
      activity={activity}
      units={units}
      onChange={(next) => {
        setTrim(next);
        onTrim?.(next);
      }}
    />
  );
}

const startHandle = () => screen.getByRole('slider', { name: 'Start of the route kept' }) as HTMLInputElement;
const endHandle = () => screen.getByRole('slider', { name: 'End of the route kept' }) as HTMLInputElement;
const startInput = () => screen.getByLabelText('Hide from the start (%)') as HTMLInputElement;
const endInput = () => screen.getByLabelText('Hide from the end (%)') as HTMLInputElement;

describe('the privacy trim field (AV-1022, TD-091)', () => {
  it('starts with nothing hidden: two handles at the ends and two zeros', () => {
    render(<Harness />);
    expect(startHandle()).toHaveValue('0');
    expect(endHandle()).toHaveValue('100');
    expect(startInput()).toHaveValue(0);
    expect(endInput()).toHaveValue(0);
    expect(screen.queryByRole('button', { name: 'Show the whole route' })).toBeNull();
  });

  it('writes the distance each share hides beside it, in the reader’s units', () => {
    const { unmount } = render(<Harness initial={{ start: 0.08, end: 0.125 }} />);
    expect(startInput()).toHaveAccessibleDescription('8 % — 800 m');
    expect(endInput()).toHaveAccessibleDescription('12.5 % — 1.25 km');
    unmount();
    render(<Harness initial={{ start: 0.08, end: 0 }} units="imperial" />);
    expect(startInput()).toHaveAccessibleDescription('8 % — 0.50 mi');
  });

  it('moves a handle when a percentage is typed, and the percentage when a handle is moved by keyboard', async () => {
    const user = userEvent.setup();
    const onTrim = vi.fn();
    render(<Harness onTrim={onTrim} />);

    await user.clear(startInput());
    await user.type(startInput(), '12.5');
    expect(startHandle()).toHaveValue('12.5');
    expect(onTrim).toHaveBeenLastCalledWith({ start: 0.125, end: 0 });

    await user.type(endInput(), '8');
    expect(endHandle()).toHaveValue('92');

    // A handle moved, as a drag or an arrow key moves a range input (the browser tests press the keys).
    fireEvent.change(startHandle(), { target: { value: '12.7' } });
    expect(startHandle()).toHaveValue('12.7');
    expect(startInput()).toHaveValue(12.7);
    // The end handle sits at the share kept, so moving it left hides more.
    fireEvent.change(endHandle(), { target: { value: '91.7' } });
    expect(endHandle()).toHaveValue('91.7');
    expect(endInput()).toHaveValue(8.3);
    expect(onTrim).toHaveBeenLastCalledWith({ start: 0.127, end: 0.083 });
  });

  it('holds each end to 45 %, so the two handles never cross', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(startInput());
    await user.type(startInput(), '80');
    expect(startHandle()).toHaveValue('45');
    await user.clear(endInput());
    await user.type(endInput(), '99');
    expect(endHandle()).toHaveValue('55');
    await user.tab();
    expect(startInput()).toHaveValue(45);
    expect(endInput()).toHaveValue(45);
    // Each handle's own range is its limit, and the field holds a value past it.
    fireEvent.change(startHandle(), { target: { value: '60' } });
    expect(startHandle()).toHaveValue('45');
    expect(startHandle()).toHaveAttribute('max', '45');
    expect(endHandle()).toHaveAttribute('min', '55');
  });

  it('says what the handles hold to a screen reader, and names every control', () => {
    render(<Harness initial={{ start: 0.08, end: 0.2 }} />);
    expect(startHandle()).toHaveAttribute('aria-valuetext', 'Hiding the first 8 % — 800 m');
    expect(endHandle()).toHaveAttribute('aria-valuetext', 'Hiding the last 20 % — 2.00 km');
    expect(screen.getByRole('group', { name: 'The part of the route kept' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Privacy trim' })).toBeInTheDocument();
  });

  it('says why nothing is drawn when less than 100 m would be left, in the reader’s units', () => {
    const short = activityThrough(straightNorth(150, 10, 5));
    const { unmount } = render(<Harness initial={{ start: 0.2, end: 0.2 }} activity={short} />);
    expect(screen.getByRole('status')).toHaveTextContent('Less than 100 m of the route would be left, so it is not drawn.');
    unmount();
    render(<Harness initial={{ start: 0.2, end: 0.2 }} activity={short} units="imperial" />);
    expect(screen.getByRole('status')).toHaveTextContent('Less than 330 ft of the route would be left, so it is not drawn.');
  });

  it('says nothing of the sort while enough is left', () => {
    render(<Harness initial={{ start: 0.2, end: 0.2 }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('clears the trim with one button, and a trim typed back to 0 is no trim', async () => {
    const user = userEvent.setup();
    const onTrim = vi.fn();
    render(<Harness initial={{ start: 0.1, end: 0.1 }} onTrim={onTrim} />);
    await user.click(screen.getByRole('button', { name: 'Show the whole route' }));
    expect(onTrim).toHaveBeenLastCalledWith(undefined);
    expect(startInput()).toHaveValue(0);
    await user.type(startInput(), '5');
    expect(onTrim).toHaveBeenLastCalledWith({ start: 0.05, end: 0 });
    await user.clear(startInput());
    await user.type(startInput(), '0');
    expect(onTrim).toHaveBeenLastCalledWith(undefined);
  });
});
