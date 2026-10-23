import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OverlayLayer } from './OverlayLayer';
import { DEFAULT_OVERLAY_CONTROLS, buildOverlay, overlayCatalog, type OverlayControls } from '../overlay/presets';
import { buildOverlayTimeline } from '../overlay/timeline';
import { parseGpx } from '../parsers/gpx/parseGpx';
import { readFixture } from '../test/helpers/fixtures';

/**
 * AV-1008. The preview's overlay at fixed timestamps of the committed ride,
 * against committed goldens: the markup the reader sees, with the numbers
 * rounded so that a different JavaScript engine's last digit is not a diff.
 * See `drawOverlay.golden.test.ts` for the canvas half and for how to update.
 */
const ride = parseGpx(readFixture('overlay-ride.gpx'), { fileName: 'overlay-ride.gpx', idFactory: () => 'ride' });
const timeline = buildOverlayTimeline(ride, { video: { durationSeconds: 6 } });
const everything = Object.fromEntries(overlayCatalog(timeline).map((entry) => [entry.key, true]));

function markup(controls: Partial<OverlayControls>, at: number): string {
  const { template } = buildOverlay({ ...DEFAULT_OVERLAY_CONTROLS, ...controls }, timeline, 16 / 9);
  const { container } = render(
    <OverlayLayer
      template={template}
      timeline={timeline}
      sample={timeline.sampleAt(at)}
      activity={ride}
      units="metric"
      frameAspect={16 / 9}
    />,
  );
  return (
    container.innerHTML
      // Rounded: the goldens are about what is drawn, not about floating-point noise.
      .replace(/-?\d+\.\d{3,}/g, (n) => String(Math.round(Number(n) * 100) / 100))
      .replace(/></g, '>\n<') + '\n'
  );
}

const snapshot = (name: string) => `./__golden__/${name}.html`;

describe('overlay preview goldens (AV-1008)', () => {
  it.each([0, 2.5, 5])('metric strip at %s s', async (seconds) => {
    await expect(markup({}, seconds)).toMatchFileSnapshot(snapshot(`layer-metric-strip-t${String(seconds).replace('.', '_')}`));
  });

  it('every component, at 5 s', async () => {
    await expect(markup({ enabled: everything }, 5)).toMatchFileSnapshot(snapshot('layer-everything-t5'));
  });

  it('compact HUD with a changed accent, size and background, at 5 s', async () => {
    await expect(
      markup({ presetId: 'compact-hud', accentColor: '#00aa88', scale: 1.25, backgroundOpacity: 0.6 }, 5),
    ).toMatchFileSnapshot(snapshot('layer-compact-hud-styled-t5'));
  });

  it('draws nothing at all outside the ride', () => {
    const html = markup({}, 99);
    expect(html).toContain('data-testid="overlay-layer"');
    expect(html).not.toContain('overlay-item');
  });

  it('shows the figures the formulae give at 5 s', () => {
    const html = markup({}, 5);
    expect(html).toContain('18.0 km/h');
    expect(html).toContain('105 bpm');
    expect(html).toContain('0:05');
  });
});

describe('figures on a clear background (TD-059)', () => {
  it('carry a dark halo of their own below the halo opacity, and none above it', () => {
    expect(markup({ backgroundOpacity: 0 }, 5)).toMatch(/text-shadow: 0 0 0\.2em/);
    expect(markup({ backgroundOpacity: 0.35 }, 5)).not.toMatch(/text-shadow/);
  });
});
