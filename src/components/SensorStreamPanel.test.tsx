import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SensorStreamPanel } from './SensorStreamPanel';
import type { ActivitySensorStream } from '../domain/activity';

const streams: ActivitySensorStream[] = [
  {
    key: 'ACCL',
    label: 'Acceleration',
    unit: 'm/s²',
    display: 'chart',
    sampleRateHz: 200,
    sourceSampleCount: 2_567,
    valuesByPoint: [9.8],
  },
  // Declared by the listing pass and never parsed, so there is nothing to
  // count and no rate to state.
  { key: 'CORI', label: 'Camera orientation', display: 'hidden' },
  // Read, but no sample fell inside a point window, so it was not charted.
  {
    key: 'GYRO',
    label: 'Rotation rate',
    unit: 'rad/s',
    display: 'hidden',
    sampleRateHz: 199.8,
    sourceSampleCount: 2_192,
  },
];

const panel = () => screen.getByRole('region', { name: 'Other telemetry in this file' });

describe('declaring what else the file carries (AV-905)', () => {
  it('names the streams the charts do not show', () => {
    render(<SensorStreamPanel streams={streams} />);

    expect(panel()).toHaveTextContent('Camera orientation');
    expect(panel()).toHaveTextContent('Rotation rate');
  });

  it('does not repeat a stream that already has a chart', () => {
    render(<SensorStreamPanel streams={streams} />);

    expect(panel()).not.toHaveTextContent('Acceleration');
  });

  it('gives the unit and rate the file established, and no more', () => {
    render(<SensorStreamPanel streams={streams} />);

    expect(panel()).toHaveTextContent('rad/s · 200 Hz · 2,192 samples');
    // Nothing was parsed for this one, so nothing is invented about it either.
    expect(panel()).not.toHaveTextContent(/Camera orientation\s*·/);
  });

  it('says these are neither charted nor exported', () => {
    render(<SensorStreamPanel streams={streams} />);

    expect(panel()).toHaveTextContent(/not charted/i);
    expect(panel()).toHaveTextContent(/None is written to any file you export/i);
  });

  it('renders nothing for a file with no streams beside its route', () => {
    const { container } = render(<SensorStreamPanel streams={[streams[0]!]} />);

    // A GPX file has none of this, and an empty heading would be noise on
    // every activity that is not a video.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no sensor streams at all', () => {
    const { container } = render(<SensorStreamPanel />);

    expect(container).toBeEmptyDOMElement();
  });
});
