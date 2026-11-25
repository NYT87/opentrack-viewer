import { useId } from 'react';
import type { Activity } from '../domain/activity';
import {
  CLEANUP_STRENGTH_LIMITS,
  smoothingLabel,
  type CleanupSummary,
  type SmoothingMethod,
} from '../domain/cleanup';
import { formatDistance, formatDuration, formatElevation, formatSpeed, type UnitSystem } from '../domain/units';
import { useCleanupReport, useCleanupStore } from '../state/cleanupStore';
import { useNumberDraft } from './useNumberDraft';

interface CleanupPanelProps {
  /** The activity as the file gave it: the clean-up is a view of it, and this is the before. */
  activity: Activity;
  units: UnitSystem;
}

const SPEED_LIMITS = [0, 5] as const;
const MIN_STOP_LIMITS = [0, 600] as const;

const METHODS: { value: SmoothingMethod; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'movingAverage', label: 'Moving average' },
  { value: 'kalman', label: 'Kalman filter' },
];

function NumberField({
  id,
  label,
  value,
  decimals,
  range,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  decimals: number;
  range: readonly [number, number];
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const draft = useNumberDraft(value, decimals, onChange, range);
  return (
    <div className="export__field">
      <label className="export__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input cleanup__number"
        type="number"
        inputMode="decimal"
        min={range[0]}
        max={range[1]}
        step={step}
        disabled={disabled}
        {...draft}
      />
    </div>
  );
}

/**
 * AV-1024 (TD-093). The telemetry clean-up: a switch, the outlier filter, the pause setting
 * (a speed threshold and a minimum stop), a smoothing method and its strength, what was dropped,
 * and what it changed in the headline figures. The clean-up is a view: this panel is where its
 * settings live for every page, and turning it off restores the activity exactly as it was read.
 */
export function CleanupPanel({ activity, units }: CleanupPanelProps) {
  const id = useId();
  const settings = useCleanupStore((state) => state.settings);
  const update = useCleanupStore((state) => state.update);
  const report = useCleanupReport(activity);
  const { enabled, outliers, pause, smoothing } = settings;
  const smoothed = smoothing.method !== 'none';

  const dropped = report?.dropped;
  const droppedText = !enabled
    ? ''
    : !outliers
      ? 'The outlier filter is off: no points were dropped.'
      : dropped && dropped.total > 0
        ? `Dropped ${dropped.total} point${dropped.total === 1 ? '' : 's'}: ${dropped.speed} for an implausible speed, ${dropped.elevation} for an elevation spike.`
        : 'No points were dropped.';

  return (
    <div className="export cleanup" data-testid="cleanup-panel">
      <h2 className="export__title">Telemetry clean-up</h2>
      <p className="export__body">
        Drops impossible points, decides what counts as a stop and smooths speed, grade and the route, for the
        charts, the figures, the overlay, the map video and the exports. The file is never changed, and turning
        this off restores the activity exactly as it was read. Nothing is stored.
      </p>

      <div className="export__controls">
        <label className="export__choice" htmlFor={`${id}-enabled`}>
          <input
            id={`${id}-enabled`}
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          Clean up the telemetry
        </label>
        <label className="export__choice" htmlFor={`${id}-outliers`}>
          <input
            id={`${id}-outliers`}
            type="checkbox"
            checked={outliers}
            disabled={!enabled}
            onChange={(event) => update({ outliers: event.target.checked })}
          />
          Drop impossible points
        </label>
      </div>

      <div className="export__controls cleanup__settings">
        <NumberField
          id={`${id}-speed`}
          label="Stopped below (m/s)"
          value={pause.speedThresholdMps}
          decimals={2}
          range={SPEED_LIMITS}
          step={0.1}
          disabled={!enabled}
          onChange={(speedThresholdMps) => update({ pause: { speedThresholdMps } })}
        />
        <NumberField
          id={`${id}-min-stop`}
          label="Shortest stop (s)"
          value={pause.minStopSeconds}
          decimals={0}
          range={MIN_STOP_LIMITS}
          step={1}
          disabled={!enabled}
          onChange={(minStopSeconds) => update({ pause: { minStopSeconds } })}
        />
        <div className="export__field">
          <label className="export__label" htmlFor={`${id}-method`}>
            Smoothing
          </label>
          <select
            id={`${id}-method`}
            className="select"
            value={smoothing.method}
            disabled={!enabled}
            onChange={(event) => update({ smoothing: { method: event.target.value as SmoothingMethod } })}
          >
            {METHODS.map((method) => (
              <option key={method.value} value={method.value}>
                {method.label}
              </option>
            ))}
          </select>
        </div>
        {smoothed && (
          <NumberField
            id={`${id}-strength`}
            label={smoothing.method === 'movingAverage' ? 'Window (seconds, 0 to 30)' : 'Strength (0 to 30)'}
            value={smoothing.strength}
            decimals={1}
            range={[CLEANUP_STRENGTH_LIMITS.min, CLEANUP_STRENGTH_LIMITS.max]}
            step={1}
            disabled={!enabled}
            onChange={(strength) => update({ smoothing: { strength } })}
          />
        )}
      </div>
      <p className="export__note">
        A stop shorter than the shortest stop counts as moving. Moving time, the overlay's stops and its
        pauses all follow these two settings.
      </p>

      <p className="export__saved cleanup__dropped" aria-live="polite" aria-atomic="true" data-testid="cleanup-dropped">
        {droppedText}
      </p>

      {enabled && report?.before && report.after && (
        <table className="cleanup__table" data-testid="cleanup-table">
          <caption className="export__note">
            Raw and cleaned figures, smoothing: {smoothingLabel(smoothing)}
          </caption>
          <thead>
            <tr>
              <th scope="col">Figure</th>
              <th scope="col">Raw</th>
              <th scope="col">Cleaned</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.format(report.before!, units)}</td>
                <td>{row.format(report.after!, units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const ROWS: { label: string; format: (summary: CleanupSummary, units: UnitSystem) => string }[] = [
  { label: 'Distance', format: (s, u) => formatDistance(s.distanceMeters, u) },
  { label: 'Moving time', format: (s) => formatDuration(s.movingDurationSeconds) },
  { label: 'Average speed', format: (s, u) => formatSpeed(s.averageSpeedMetersPerSecond, u) },
  { label: 'Maximum speed', format: (s, u) => formatSpeed(s.maxSpeedMetersPerSecond, u) },
  { label: 'Elevation gain', format: (s, u) => formatElevation(s.elevationGainMeters, u) },
];

/**
 * AV-1024. One line on the pages that read the cleaned activity but do not hold its settings: the
 * overlay page and the map video page; `exporting` words it for an export panel. Says nothing for an activity that was
 * not cleaned.
 */
export function CleanupNote({ activity, exporting = false }: { activity: Activity | undefined; exporting?: boolean }) {
  const cleanup = activity?.cleanup;
  if (!cleanup) return null;
  const { total } = cleanup.dropped;
  const dropped = `${total} point${total === 1 ? '' : 's'} dropped`;
  const smoothing = cleanup.smoothing.method !== 'none' && cleanup.smoothing.strength > 0 ? `, smoothing ${smoothingLabel(cleanup.smoothing)}` : '';
  return (
    <p className="export__note cleanup-note" data-testid="cleanup-note">
      {exporting
        ? `This export holds cleaned telemetry: ${dropped}${smoothing}.`
        : `Telemetry clean-up is on: ${dropped}${smoothing}. It was cleaned in the viewer, where its settings are; change them there and hand the activity over again.`}
    </p>
  );
}
