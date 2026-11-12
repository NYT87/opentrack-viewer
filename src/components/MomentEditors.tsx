import type { ReactNode } from 'react';
import { CHART_METRICS, DIAL_METRICS } from '../overlay/customCanvas';
import { DEFAULT_COMPASS } from '../overlay/compass';
import { DEFAULT_DIAL, DIAL_LIMITS, activityRange } from '../overlay/dial';
import {
  DEFAULT_GRADIENT,
  GRADIENT_BAND_LIMITS,
  GRADIENT_FROM_LIMITS,
  addGradientBand,
  removeLastGradientBand,
  setGradientBand,
} from '../overlay/gradient';
import { STORED_UNITS } from '../overlay/contract';
import {
  CHART_WINDOW_MAX,
  DEFAULT_CHART,
  type ChartAxis,
  type OverlayChartSetting,
  type OverlayCompassSetting,
  type OverlayComponent,
  type OverlayDialSetting,
  type OverlayGradientSetting,
} from '../overlay/template';
import { dataSourceId, type OverlayDataSource, type OverlayMetricKey, type OverlayTimeline } from '../overlay/timeline';
import { ColorField } from './ColorField';
import { PercentField } from './RouteOverlayPanel';

/**
 * AV-1019 (TD-087). The settings of the four components that came with it, one
 * editor each, in the way ZonesEditor holds a zones component's: every control
 * is a labelled field of the page's own kind (a select, a number, a colour, a
 * checkbox), so it is reachable and named for a screen reader and moves by the
 * keyboard, and a value that cannot be used is kept as typed until it can.
 */

type Patch = (change: (current: OverlayComponent) => OverlayComponent) => void;

const FIGURE_NAMES: Record<string, string> = {
  speed: 'Speed',
  pace: 'Pace',
  heartRate: 'Heart rate',
  power: 'Power',
  cyclingCadence: 'Cycling cadence',
  runningCadence: 'Running cadence',
  elevation: 'Elevation',
  grade: 'Grade',
  temperature: 'Temperature',
};

/** The figures a dial or chart can be of: the offered ones the activity has, and the one the component already reads. */
function sourceChoices(
  offered: readonly OverlayMetricKey[],
  current: OverlayDataSource | undefined,
  timeline: OverlayTimeline,
): { value: string; label: string; disabled: boolean }[] {
  const choices = offered.map((metric) => ({
    value: `metric:${metric}`,
    label: FIGURE_NAMES[metric] ?? metric,
    disabled: !timeline.available.has(`metric:${metric}`),
  }));
  if (current && !choices.some((choice) => choice.value === dataSourceId(current))) {
    choices.unshift({
      value: dataSourceId(current),
      label: current.kind === 'metric' ? (FIGURE_NAMES[current.metric] ?? current.metric) : (timeline.sensorLabels.get(dataSourceId(current))?.label ?? current.key),
      disabled: false,
    });
  }
  return choices;
}

const sourceOf = (value: string): OverlayDataSource =>
  value.startsWith('sensor:') ? { kind: 'sensor', key: value.slice('sensor:'.length) } : { kind: 'metric', metric: value.slice('metric:'.length) as OverlayMetricKey };

function SourceSelect({
  id,
  component,
  offered,
  timeline,
  onChoose,
}: {
  id: string;
  component: OverlayComponent;
  offered: readonly OverlayMetricKey[];
  timeline: OverlayTimeline;
  onChoose: (source: OverlayDataSource) => void;
}) {
  const current = component.source;
  return (
    <div className="overlay-controls__field">
      <label htmlFor={id}>Figure</label>
      <select id={id} className="select" value={current ? dataSourceId(current) : ''} onChange={(event) => onChoose(sourceOf(event.target.value))}>
        {sourceChoices(offered, current, timeline).map((choice) => (
          <option key={choice.value} value={choice.value} disabled={choice.disabled}>
            {choice.label}
            {choice.disabled ? ' (not in this activity)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/** A dial: the figure, the range, the arc and its ticks, the pointer and the colours. */
export function DialEditor({ id, component, timeline, smoothingField, onChange }: { id: string; component: OverlayComponent; timeline: OverlayTimeline; smoothingField: ReactNode; onChange: Patch }) {
  const setting = component.dial ?? DEFAULT_DIAL;
  const source = component.source;
  const unit = source?.kind === 'metric' ? STORED_UNITS[source.metric] : timeline.sensorLabels.get(source ? dataSourceId(source) : '')?.unit;
  const own = source ? activityRange(timeline, source) : undefined;
  const range = component.range ?? own ?? { min: 0, max: 100 };
  const withDial = (patch: Partial<OverlayDialSetting>) => onChange((current) => ({ ...current, dial: { ...(current.dial ?? DEFAULT_DIAL), ...patch } }));
  const setRange = (next: { min: number; max: number }) => onChange((current) => ({ ...current, range: next }));
  return (
    <>
      <SourceSelect
        id={`${id}-dial-source`}
        component={component}
        offered={DIAL_METRICS}
        timeline={timeline}
        onChoose={(next) =>
          onChange((current) => {
            const found = activityRange(timeline, next);
            const changed: OverlayComponent = { ...current, source: next };
            if (found) changed.range = found;
            return changed;
          })
        }
      />
      <PercentField
        id={`${id}-dial-min`}
        label={`Range starts at${unit ? ` (${unit})` : ''}`}
        hint="Below the end. A value outside the range sits at its end."
        value={String(round(range.min, 3))}
        min={-100000}
        max={100000}
        step={0.1}
        onCommit={(value) => value < range.max && setRange({ min: value, max: range.max })}
      />
      <PercentField
        id={`${id}-dial-max`}
        label={`Range ends at${unit ? ` (${unit})` : ''}`}
        value={String(round(range.max, 3))}
        min={-100000}
        max={100000}
        step={0.1}
        onCommit={(value) => value > range.min && setRange({ min: range.min, max: value })}
      />
      <p className="video__actions">
        <button type="button" className="button" disabled={!own} onClick={() => own && setRange(own)}>
          Use this activity’s range
        </button>
      </p>
      <PercentField
        id={`${id}-dial-sweep`}
        label="Sweep (degrees)"
        hint={`${DIAL_LIMITS.sweep.min} to ${DIAL_LIMITS.sweep.max}. The arc is centred at the top.`}
        value={String(setting.sweep)}
        min={DIAL_LIMITS.sweep.min}
        max={DIAL_LIMITS.sweep.max}
        onCommit={(value) => withDial({ sweep: Math.min(DIAL_LIMITS.sweep.max, Math.max(DIAL_LIMITS.sweep.min, Math.round(value))) })}
      />
      <PercentField
        id={`${id}-dial-major`}
        label={`Major tick every${unit ? ` (${unit})` : ''}`}
        hint="0 finds a step that suits the range."
        value={String(setting.majorStep ?? 0)}
        min={0}
        max={100000}
        step={0.1}
        onCommit={(value) =>
          onChange((current) => {
            const dial = { ...(current.dial ?? DEFAULT_DIAL) };
            if (value > 0) dial.majorStep = value;
            else delete dial.majorStep;
            return { ...current, dial };
          })
        }
      />
      <PercentField
        id={`${id}-dial-minor`}
        label="Minor ticks between major ones"
        value={String(setting.minorTicks)}
        min={DIAL_LIMITS.minorTicks.min}
        max={DIAL_LIMITS.minorTicks.max}
        onCommit={(value) => withDial({ minorTicks: Math.min(DIAL_LIMITS.minorTicks.max, Math.max(DIAL_LIMITS.minorTicks.min, Math.round(value))) })}
      />
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-dial-pointer`}>Pointer</label>
        <select id={`${id}-dial-pointer`} className="select" value={setting.pointer} onChange={(event) => withDial({ pointer: event.target.value === 'marker' ? 'marker' : 'needle' })}>
          <option value="needle">Needle</option>
          <option value="marker">Marker on the arc</option>
        </select>
      </div>
      <ColorField id={`${id}-dial-track`} label="Track colour" value={setting.trackColor} onChange={(trackColor) => withDial({ trackColor })} />
      <ColorField id={`${id}-dial-fill`} label="Filled part colour" value={setting.fillColor} onChange={(fillColor) => withDial({ fillColor })} />
      <ColorField id={`${id}-dial-needle`} label="Needle colour" value={setting.needleColor} onChange={(needleColor) => withDial({ needleColor })} />
      {smoothingField}
    </>
  );
}

/** A chart: the figure, the axis, the window, the colours and the labels. */
export function ChartEditor({ id, component, timeline, onChange }: { id: string; component: OverlayComponent; timeline: OverlayTimeline; onChange: Patch }) {
  const setting = component.chart ?? DEFAULT_CHART;
  const withChart = (patch: Partial<OverlayChartSetting>) => onChange((current) => ({ ...current, chart: { ...(current.chart ?? DEFAULT_CHART), ...patch } }));
  const hasDistance = timeline.available.has('metric:distance');
  const windowUnit = setting.axis === 'distance' ? 'metres' : 'seconds';
  return (
    <>
      <SourceSelect id={`${id}-chart-source`} component={component} offered={CHART_METRICS} timeline={timeline} onChoose={(next) => onChange((current) => ({ ...current, source: next }))} />
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-chart-axis`}>Along</label>
        <select id={`${id}-chart-axis`} className="select" value={setting.axis} onChange={(event) => {
            const axis = event.target.value as ChartAxis;
            // A window's number is seconds on one axis and metres on the other: it takes the new axis' usual one.
            withChart({ axis, ...(setting.window !== undefined && axis !== setting.axis ? { window: axis === 'distance' ? 500 : 30 } : {}) });
          }}>
          <option value="time">Time</option>
          <option value="distance" disabled={!hasDistance && setting.axis !== 'distance'}>
            Distance{hasDistance || setting.axis === 'distance' ? '' : ' (this activity has none)'}
          </option>
        </select>
      </div>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-chart-span`}>Shows</label>
        <select
          id={`${id}-chart-span`}
          className="select"
          value={setting.window === undefined ? 'whole' : 'window'}
          onChange={(event) =>
            onChange((current) => {
              const chart = { ...(current.chart ?? DEFAULT_CHART) };
              if (event.target.value === 'whole') delete chart.window;
              else chart.window = chart.axis === 'distance' ? 500 : 30;
              return { ...current, chart };
            })
          }
        >
          <option value="whole">The whole activity</option>
          <option value="window">A window either side of now</option>
        </select>
      </div>
      {setting.window !== undefined && (
        <PercentField
          id={`${id}-chart-window`}
          label={`Window either side of now (${windowUnit})`}
          hint="The cursor stays in the middle."
          value={String(round(setting.window))}
          min={1}
          max={CHART_WINDOW_MAX}
          step={1}
          onCommit={(value) => value > 0 && withChart({ window: Math.min(CHART_WINDOW_MAX, value) })}
        />
      )}
      <ColorField id={`${id}-chart-line`} label="Line colour" value={setting.lineColor} onChange={(lineColor) => withChart({ lineColor })} />
      <ColorField id={`${id}-chart-fill`} label="Fill colour" value={setting.fillColor} onChange={(fillColor) => withChart({ fillColor })} />
      <PercentField
        id={`${id}-chart-fill-opacity`}
        label="Fill opacity (%)"
        value={String(Math.round(setting.fillOpacity * 100))}
        onCommit={(value) => withChart({ fillOpacity: Math.min(1, Math.max(0, value / 100)) })}
      />
      <label className="overlay-controls__choice">
        <input type="checkbox" checked={setting.labels} onChange={(event) => withChart({ labels: event.target.checked })} />
        <span>Axis labels</span>
      </label>
    </>
  );
}

/** The gradient indicator: its bands, each with where it starts and its colour, and the glyph. */
export function GradientEditor({ id, component, smoothingField, onChange }: { id: string; component: OverlayComponent; smoothingField: ReactNode; onChange: Patch }) {
  const setting = component.gradient ?? DEFAULT_GRADIENT;
  const withGradient = (change: (current: OverlayGradientSetting) => OverlayGradientSetting) =>
    onChange((current) => ({ ...current, gradient: change(current.gradient ?? DEFAULT_GRADIENT) }));
  return (
    <>
      <label className="overlay-controls__choice">
        <input type="checkbox" checked={setting.glyph} onChange={(event) => withGradient((current) => ({ ...current, glyph: event.target.checked }))} />
        <span>Show the up or down glyph</span>
      </label>
      <div role="group" aria-label="Colour bands" className="zones-editor">
        {setting.bands.map((band, i) => (
          <div key={i} role="group" aria-label={`Band ${i + 1}`} className="overlay-controls__field">
            {i > 0 ? (
              <PercentField
                id={`${id}-band-${i}-from`}
                label={`Band ${i + 1} starts at (%)`}
                value={String(band.from)}
                min={GRADIENT_FROM_LIMITS.min}
                max={GRADIENT_FROM_LIMITS.max}
                step={0.5}
                onCommit={(from) => withGradient((current) => setGradientBand(current, i, { from }))}
              />
            ) : (
              <p className="overlay-controls__hint">Band 1 is everything below band 2.</p>
            )}
            <ColorField id={`${id}-band-${i}-color`} label={`Band ${i + 1} colour`} value={band.color} onChange={(color) => withGradient((current) => setGradientBand(current, i, { color }))} />
          </div>
        ))}
      </div>
      <p className="video__actions">
        <button type="button" className="button" disabled={addGradientBand(setting) === setting} onClick={() => withGradient(addGradientBand)}>
          Add a band
        </button>
        <button type="button" className="button" disabled={setting.bands.length <= GRADIENT_BAND_LIMITS.min} onClick={() => withGradient(removeLastGradientBand)}>
          Remove the last band
        </button>
        <button type="button" className="button" onClick={() => withGradient((current) => ({ ...DEFAULT_GRADIENT, bands: DEFAULT_GRADIENT.bands.map((band) => ({ ...band })), glyph: current.glyph }))}>
          Reset the bands
        </button>
      </p>
      <p className="overlay-controls__hint">
        {GRADIENT_BAND_LIMITS.min} to {GRADIENT_BAND_LIMITS.max} bands. The grade is the file’s own where it has one, and otherwise the climb over the last 50 m.
      </p>
      {smoothingField}
    </>
  );
}

/** The compass: rose or needle, the cardinal labels and the colours. */
export function CompassEditor({ id, component, smoothingField, onChange }: { id: string; component: OverlayComponent; smoothingField: ReactNode; onChange: Patch }) {
  const setting = component.compass ?? DEFAULT_COMPASS;
  const withCompass = (patch: Partial<OverlayCompassSetting>) => onChange((current) => ({ ...current, compass: { ...(current.compass ?? DEFAULT_COMPASS), ...patch } }));
  return (
    <>
      <div className="overlay-controls__field">
        <label htmlFor={`${id}-compass-style`}>Style</label>
        <select id={`${id}-compass-style`} className="select" value={setting.style} onChange={(event) => withCompass({ style: event.target.value === 'needle' ? 'needle' : 'rose' })}>
          <option value="rose">A rose that turns, heading up</option>
          <option value="needle">A needle on a fixed rose, north up</option>
        </select>
      </div>
      <label className="overlay-controls__choice">
        <input type="checkbox" checked={setting.labels} onChange={(event) => withCompass({ labels: event.target.checked })} />
        <span>Label the cardinal points</span>
      </label>
      <ColorField id={`${id}-compass-rose`} label="Rose colour" value={setting.roseColor} onChange={(roseColor) => withCompass({ roseColor })} />
      <ColorField id={`${id}-compass-needle`} label="Needle colour" value={setting.needleColor} onChange={(needleColor) => withCompass({ needleColor })} />
      {smoothingField}
    </>
  );
}
