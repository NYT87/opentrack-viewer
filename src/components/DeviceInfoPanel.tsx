import {
  hasDisplayableDevice,
  type ActivityDeviceInfo,
} from '../domain/activity';
import { MISSING } from '../domain/units';

export interface DeviceInfoPanelProps {
  device: ActivityDeviceInfo | undefined;
}

interface DeviceRow {
  label: string;
  value: string | undefined;
}

/**
 * AV-405. Shows the device the activity came from, when the file says so.
 *
 * Stable identifiers are never rendered — not hidden behind a toggle, simply
 * not put on screen (plan §5). A serial number identifies a person's hardware
 * across every file they own, and nothing in this viewer needs it.
 *
 * Ordering follows the plan: manufacturer, then model/name, then versions.
 */
export function DeviceInfoPanel({ device }: DeviceInfoPanelProps) {
  // Missing device information is normal, not an error: render nothing.
  if (!hasDisplayableDevice(device)) return null;

  const rows: DeviceRow[] = [
    { label: 'Manufacturer', value: device.manufacturer },
    { label: 'Model', value: device.model ?? device.product },
    // The GPX creator names whatever wrote the file — a device or an app — so
    // it is labelled for what it is rather than presented as a model.
    { label: 'Recorded with', value: device.name },
    { label: 'Software', value: device.softwareVersion ?? device.firmwareVersion },
  ].filter((row) => Boolean(row.value));

  return (
    <section className="device" aria-label="Device">
      <h3 className="device__title">Device</h3>
      <dl className="device__list">
        {rows.map((row) => (
          <div className="device__row" key={row.label}>
            <dt className="device__label">{row.label}</dt>
            <dd className="device__value">{row.value ?? MISSING}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
