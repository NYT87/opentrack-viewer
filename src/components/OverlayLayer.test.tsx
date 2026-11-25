import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayLayer } from './OverlayLayer';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, type OverlayControls } from '../overlay/presets';
import { buildOverlayTimeline } from '../overlay/timeline';
import { makeActivity } from '../test/helpers/activity';

const T0 = new Date('2024-01-01T10:00:00Z').getTime();
// Eleven points a second apart, about 157 m between them.
const ride = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 10 + i * 0.001, lon: 20 + i * 0.001, distanceMeters: i * 157 })));
const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 10 } });

function inset(controls: Partial<OverlayControls>, at: number, activity = ride) {
  const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS, presetId: 'route-inset', ...controls }, timeline, 16 / 9);
  const { container } = render(
    <OverlayLayer template={template} timeline={timeline} sample={timeline.sampleAt(at)} activity={activity} units="metric" frameAspect={16 / 9} />,
  );
  return {
    lines: container.querySelectorAll('.overlay-item__route polyline'),
    dots: container.querySelectorAll('.overlay-item__route circle'),
    svg: container.querySelector('.overlay-item__route'),
  };
}

describe('the preview’s route inset and the privacy trim (AV-1022, TD-091)', () => {
  const trim = { privacyTrim: { start: 0.3, end: 0.2 } };

  it('shows a dot on the route with no trim, as it always did', () => {
    const drawn = inset({}, 5);
    expect(drawn.lines).toHaveLength(1);
    expect(drawn.dots).toHaveLength(1);
  });

  it('shows the kept route with its dot, and the kept route alone with no dot in a hidden stretch', () => {
    expect(inset(trim, 5).dots).toHaveLength(1);
    for (const hidden of [0, 2, 8.5, 10]) {
      const drawn = inset(trim, hidden);
      expect(drawn.lines, `at ${hidden} s`).toHaveLength(1);
      expect(drawn.dots, `at ${hidden} s`).toHaveLength(0);
    }
  });

  it('draws only the kept part of the line', () => {
    const points = (el: Element | null) => el!.getAttribute('points')!.split(' ').length;
    expect(points(inset(trim, 5).lines[0]!)).toBeLessThan(points(inset({}, 5).lines[0]!));
  });

  it('draws no route, and no dot, when less than 100 m would be left', () => {
    const small = makeActivity(Array.from({ length: 11 }, (_, i) => ({ time: new Date(T0 + i * 1000), lat: 10 + i * 0.0001, lon: 20 })));
    const drawn = inset({ privacyTrim: { start: 0.2, end: 0.2 } }, 5, small);
    expect(drawn.svg).toBeNull();
  });
});
