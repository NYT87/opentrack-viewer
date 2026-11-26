import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ShownEditor } from './ShownEditor';

describe('the Shown editor (AV-1029)', () => {
  it('says a time is wrong only once the field is left, not while it is being typed', () => {
    const onChange = vi.fn();
    render(<ShownEditor visibility={{ from: 2, to: 20 }} playhead={() => 0} onChange={onChange} />);
    const to = screen.getByLabelText('To');
    fireEvent.change(to, { target: { value: '1:' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(to, { target: { value: '0:30' } });
    fireEvent.blur(to);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ from: 2, to: 30 });

    fireEvent.change(to, { target: { value: 'soon' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(to);
    expect(screen.getByRole('alert').textContent).toMatch(/is not a time/);
  });

  it('says why the playhead is refused, even where its rounded time would read as accepted', () => {
    const onChange = vi.fn();
    render(<ShownEditor visibility={{ from: 2, to: 12.31 }} playhead={() => 12.34} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set to the playhead, from' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('The playhead, 0:12.3, is not before the end, 0:12.3.');
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('0:02');
  });
});
