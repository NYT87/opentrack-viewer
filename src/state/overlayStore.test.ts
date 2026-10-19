import { beforeEach, describe, expect, it } from 'vitest';
import { useOverlayStore } from './overlayStore';
import { makeActivity } from '../test/helpers/activity';

const activity = () => makeActivity([{ lat: 10, lon: 20 }, { lat: 10.001, lon: 20.001 }]);

beforeEach(() => useOverlayStore.getState().clear());

describe('a focused section on the overlay store (AV-1009)', () => {
  it('is recorded when handed over as a section, and not otherwise', () => {
    useOverlayStore.getState().setActivity(activity(), 'hand', { focusedSection: true });
    expect(useOverlayStore.getState().source.focusedSection).toBe(true);
    useOverlayStore.getState().setActivity(activity(), 'hand');
    expect(useOverlayStore.getState().source.focusedSection).toBeUndefined();
  });

  it('survives a video being chosen, since the reader chose the section', () => {
    useOverlayStore.getState().setActivity(activity(), 'hand', { focusedSection: true });
    useOverlayStore.getState().setVideo({ file: new File(['x'], 'a.mp4') });
    expect(useOverlayStore.getState().source.focusedSection).toBe(true);
  });

  it('is dropped with the activity, and never claimed by a video’s own telemetry', () => {
    useOverlayStore.getState().setActivity(activity(), 'hand', { focusedSection: true });
    useOverlayStore.getState().clearActivity();
    expect(useOverlayStore.getState().source.focusedSection).toBeUndefined();

    useOverlayStore.getState().setActivity(activity(), 'video');
    expect(useOverlayStore.getState().source.focusedSection).toBeUndefined();
    useOverlayStore.getState().setVideo(undefined);
    expect(useOverlayStore.getState().source.activity).toBeUndefined();
  });

  it('is forgotten by Start over', () => {
    useOverlayStore.getState().setActivity(activity(), 'hand', { focusedSection: true });
    useOverlayStore.getState().clear();
    expect(useOverlayStore.getState().source).toEqual({});
  });

  it('is set, with no video, by a standalone hand-off', () => {
    useOverlayStore.getState().setVideo({ file: new File(['x'], 'a.mp4') });
    useOverlayStore.getState().setOffsetSeconds(2);
    useOverlayStore.getState().setStandaloneActivity(activity(), { focusedSection: true });
    const state = useOverlayStore.getState();
    expect(state.source.video).toBeUndefined();
    expect(state.source.focusedSection).toBe(true);
    expect(state.source.activityOrigin).toBe('hand');
    expect(state.offsetSeconds).toBe(0);
    useOverlayStore.getState().setStandaloneActivity(activity());
    expect(useOverlayStore.getState().source.focusedSection).toBeUndefined();
  });
});
