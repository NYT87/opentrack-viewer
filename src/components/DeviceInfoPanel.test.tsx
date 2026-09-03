import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeviceInfoPanel } from './DeviceInfoPanel';
import { hasDisplayableDevice } from '../domain/activity';

const value = (label: string) =>
  screen.getByText(label).parentElement?.querySelector('dd')?.textContent;

describe('hasDisplayableDevice (AV-405)', () => {
  it('ignores a device that carries only identifiers', () => {
    // A serial alone is never shown, so it is not worth rendering a panel for.
    expect(hasDisplayableDevice({ serialNumber: '3939123456' })).toBe(false);
    expect(hasDisplayableDevice({})).toBe(false);
    expect(hasDisplayableDevice(undefined)).toBe(false);
  });

  it('accepts any user-friendly field', () => {
    expect(hasDisplayableDevice({ manufacturer: 'Garmin' })).toBe(true);
    expect(hasDisplayableDevice({ name: 'StravaGPX Android' })).toBe(true);
    expect(hasDisplayableDevice({ firmwareVersion: '4.10' })).toBe(true);
  });
});

describe('DeviceInfoPanel (AV-405)', () => {
  it('shows manufacturer, model and software version', () => {
    render(
      <DeviceInfoPanel
        device={{ manufacturer: 'Garmin', model: 'Edge 530', softwareVersion: '9.75' }}
      />,
    );

    expect(value('Manufacturer')).toBe('Garmin');
    expect(value('Model')).toBe('Edge 530');
    expect(value('Software')).toBe('9.75');
  });

  it('never renders a serial number', () => {
    const { container } = render(
      <DeviceInfoPanel
        device={{ manufacturer: 'Garmin', model: 'Edge 530', serialNumber: '3939123456' }}
      />,
    );

    expect(container.textContent).not.toContain('3939123456');
    expect(screen.queryByText(/serial/i)).not.toBeInTheDocument();
  });

  it('labels the GPX creator for what it is, not as a model', () => {
    // "StravaGPX Android" is an app, not hardware; the label must not claim it.
    render(<DeviceInfoPanel device={{ name: 'StravaGPX Android', source: 'gpx_creator' }} />);

    expect(value('Recorded with')).toBe('StravaGPX Android');
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });

  it('falls back through product and firmware', () => {
    render(<DeviceInfoPanel device={{ product: 'Forerunner 255', firmwareVersion: '18.26' }} />);

    expect(value('Model')).toBe('Forerunner 255');
    expect(value('Software')).toBe('18.26');
  });

  it('renders nothing at all when there is no device information', () => {
    const { container } = render(<DeviceInfoPanel device={undefined} />);
    expect(container).toBeEmptyDOMElement();

    // Missing information is normal, not an error.
    const identifiersOnly = render(<DeviceInfoPanel device={{ serialNumber: '123' }} />);
    expect(identifiersOnly.container).toBeEmptyDOMElement();
  });

  it('omits rows the file did not provide', () => {
    render(<DeviceInfoPanel device={{ manufacturer: 'Wahoo' }} />);

    expect(screen.getByText('Manufacturer')).toBeInTheDocument();
    expect(screen.queryByText('Software')).not.toBeInTheDocument();
  });

  it('works the same whatever parser produced it', () => {
    // The component reads the normalized shape only (TD-002).
    render(<DeviceInfoPanel device={{ manufacturer: 'Wahoo', source: 'fit_device_info' }} />);

    expect(value('Manufacturer')).toBe('Wahoo');
  });
});
