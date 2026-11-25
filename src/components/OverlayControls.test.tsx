import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen } from '@testing-library/react';
import { OverlayControls } from './OverlayControls';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, type OverlayControls as Controls } from '../overlay/presets';
import { buildOverlayTimeline } from '../overlay/timeline';
import { activityThrough, straightNorth } from '../test/helpers/mapVideoRoutes';

// 2 km, a point every 100 m: 1 % of it is 20 m.
const ride = activityThrough(straightNorth(2000, 100, 5));
const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 400 } });

function setup(controls: Partial<Controls> = {}, units: 'metric' | 'imperial' = 'metric') {
  const onChange = vi.fn();
  const shown = { ...DEFAULT_OVERLAY_CONTROLS, presetId: 'route-inset' as const, ...controls };
  render(<OverlayControls controls={shown} timeline={timeline} onChange={onChange} activity={ride} units={units} />);
  return { onChange, shown };
}

describe('the overlay controls’ privacy trim (AV-1022, TD-091)', () => {
  it('is offered with the route, and not when the route is switched off', () => {
    const { unmount } = render(
      <OverlayControls controls={{ ...DEFAULT_OVERLAY_CONTROLS, presetId: 'route-inset', enabled: { route: false } }} timeline={timeline} onChange={() => {}} activity={ride} />,
    );
    expect(screen.queryByRole('group', { name: 'Privacy trim' })).toBeNull();
    unmount();
    setup();
    expect(screen.getByRole('group', { name: 'Privacy trim' })).toBeInTheDocument();
  });

  it('reports a change as the two shares, and the distance each hides is in the reader’s units', () => {
    const { onChange } = setup({ privacyTrim: { start: 0.1, end: 0 } });
    expect(screen.getByLabelText('Hide from the start (%)')).toHaveAccessibleDescription('10 % — 200 m');
    fireEvent.change(screen.getByLabelText('Hide from the end (%)'), { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith({ privacyTrim: { start: 0.1, end: 0.05 } });
    fireEvent.change(screen.getByRole('slider', { name: 'Start of the route kept' }), { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith({ privacyTrim: undefined });
  });

  it('is in the template the controls build, and a reset of the settings takes it away', () => {
    const { shown } = setup({ privacyTrim: { start: 0.1, end: 0.2 } });
    expect(buildOverlay(shown, timeline).template.privacyTrim).toEqual({ start: 0.1, end: 0.2 });
    expect('privacyTrim' in DEFAULT_OVERLAY_CONTROLS).toBe(false);
  });

  it('is cleared by Reset overlay settings as the store merges it, and Undo reset brings it back', async () => {
    let controls: Controls = { ...DEFAULT_OVERLAY_CONTROLS, presetId: 'route-inset', privacyTrim: { start: 0.2, end: 0.2 } };
    const merge = (patch: Partial<Controls>) => {
      controls = { ...controls, ...patch };
      view.rerender(<OverlayControls controls={controls} timeline={timeline} onChange={merge} activity={ride} />);
    };
    const view = render(<OverlayControls controls={controls} timeline={timeline} onChange={merge} activity={ride} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset overlay settings' }));
    expect(controls.privacyTrim).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Undo reset' }));
    expect(controls.privacyTrim).toEqual({ start: 0.2, end: 0.2 });
  });

  it('says why nothing is drawn when too little would be left', () => {
    const small = activityThrough(straightNorth(150, 10, 5));
    render(
      <OverlayControls
        controls={{ ...DEFAULT_OVERLAY_CONTROLS, presetId: 'route-inset', privacyTrim: { start: 0.2, end: 0.2 } }}
        timeline={buildOverlayTimeline(small, { video: { durationSeconds: 30 } })}
        onChange={() => {}}
        activity={small}
        units="imperial"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Less than 330 ft of the route would be left, so it is not drawn.');
  });
});
